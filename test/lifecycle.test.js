// Offline lifecycle tests: puppeteer.launch is stubbed with fake browsers, so no Chrome starts.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, test } from "node:test";
import puppeteer from "puppeteer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeBrowser, createServer, setSessionCookies } from "../dist/server.js";

const HOME = "https://www.woolworths.com.au";

// A promise with its resolve exposed, to hold a stubbed call open until the test releases it.
function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// A fake page. Set `page.hold.goto` or `page.hold.cookies` to a deferred and that call waits on
// it; goto to the homepage is never held. `calls` records the goto and url calls it receives.
function fakePage() {
  let url = "about:blank";
  return {
    hold: {},
    calls: [],
    async setUserAgent() {},
    async goto(target) {
      this.calls.push("goto");
      if (target !== HOME && this.hold.goto) {
        await this.hold.goto.promise;
      }
      url = target;
    },
    url() {
      this.calls.push("url");
      return url;
    },
    async title() {
      return "Woolworths";
    },
    async cookies() {
      if (this.hold.cookies) {
        await this.hold.cookies.promise;
      }
      return [{ name: "fresh", value: "from-page" }];
    },
  };
}

// Stubs puppeteer.launch; every fake browser it returns is recorded, with whether it is still live.
function stubLaunch(t, { launchGate, closeGate } = {}) {
  const browsers = [];
  const events = [];
  t.mock.method(puppeteer, "launch", async () => {
    if (launchGate) {
      await launchGate.promise;
    }
    const browser = new EventEmitter();
    browser.live = true;
    browser.page = fakePage();
    // Set `closeFailures` to make that many closes reject with Chrome left running.
    browser.closeFailures = 0;
    browser.proc = { exitCode: null, signalCode: null, spawnargs: [] };
    browser.process = () => browser.proc;
    browser.newPage = async () => browser.page;
    browser.close = async () => {
      if (closeGate) {
        await closeGate.promise;
      }
      if (browser.closeFailures > 0) {
        browser.closeFailures--;
        throw new Error("close failed");
      }
      browser.live = false;
      browser.proc.exitCode = 0;
      events.push(`closed ${browsers.indexOf(browser)}`);
    };
    browsers.push(browser);
    events.push(`launched ${browsers.length - 1}`);
    return browser;
  });
  return { browsers, events, live: () => browsers.filter((b) => b.live) };
}

let client;

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, payload: JSON.parse(result.content[0].text) };
}

// The Cookie header the next API call sends, read through a stubbed fetch.
async function sentCookieHeader(t) {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  await call("woolworths_get_cart");
  return fetch.mock.calls.at(-1).arguments[1].headers.Cookie;
}

// Lets pending promise callbacks run, so a call reaches its next await.
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(async () => {
  setSessionCookies([{ name: "session", value: "test" }]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  await closeBrowser();
});

test("two concurrent opens launch one browser", async (t) => {
  const launchGate = deferred();
  const { live } = stubLaunch(t, { launchGate });

  const first = call("woolworths_open_browser", { headless: true });
  const second = call("woolworths_open_browser", { headless: true });
  await settle();
  launchGate.resolve();
  const results = await Promise.all([first, second]);

  assert.equal(puppeteer.launch.mock.callCount(), 1);
  assert.equal(live().length, 1);
  assert.deepEqual(results.map((r) => r.isError).sort(), [false, true]);
  assert.match(results.find((r) => r.isError).payload.error, /already open/);
});

test("an open during a slow close launches only after the close finishes", async (t) => {
  const closeGate = deferred();
  const { browsers, events, live } = stubLaunch(t, { closeGate });
  assert.equal((await call("woolworths_open_browser", { headless: true })).isError, false);

  const closing = call("woolworths_close_browser");
  await settle();
  const reopening = call("woolworths_open_browser", { headless: true });
  await settle();
  closeGate.resolve();
  const [closed, reopened] = await Promise.all([closing, reopening]);

  assert.equal(closed.isError, false);
  assert.equal(reopened.isError, false);
  assert.deepEqual(events, ["launched 0", "closed 0", "launched 1"]);
  assert.deepEqual(live(), [browsers[1]]);
});

test("a browser whose close fails while it runs blocks every launch until it is closed", async (t) => {
  const { browsers, events, live } = stubLaunch(t);
  await call("woolworths_open_browser", { headless: true });
  browsers[0].closeFailures = 2;

  const closed = await call("woolworths_close_browser");
  const refused = await call("woolworths_open_browser", { headless: true });

  assert.equal(closed.isError, true);
  assert.equal(refused.isError, true);
  assert.match(refused.payload.error, /previous browser could not be closed/);
  assert.equal(puppeteer.launch.mock.callCount(), 1);
  assert.deepEqual(live(), [browsers[0]]);

  // Close retries the browser left running; once it is gone, an open launches again.
  assert.equal((await call("woolworths_close_browser")).isError, false);
  assert.equal((await call("woolworths_open_browser", { headless: true })).isError, false);
  assert.deepEqual(events, ["launched 0", "closed 0", "launched 1"]);
  assert.deepEqual(live(), [browsers[1]]);
});

test("a close that fails after Chrome exited does not block the next open", async (t) => {
  const { browsers, live } = stubLaunch(t);
  await call("woolworths_open_browser", { headless: true });
  browsers[0].close = async () => {
    browsers[0].live = false;
    browsers[0].proc.exitCode = 0;
    throw new Error("profile cleanup failed");
  };

  assert.equal((await call("woolworths_close_browser")).isError, true);
  assert.equal((await call("woolworths_open_browser", { headless: true })).isError, false);
  assert.deepEqual(live(), [browsers[1]]);
});

// Closes the open session and opens a new one, while an earlier call is still parked.
async function replaceSession() {
  assert.equal((await call("woolworths_close_browser")).isError, false);
  assert.equal((await call("woolworths_open_browser", { headless: true })).isError, false);
}

test("get_cookies whose session is replaced mid-call is an error and keeps the stored cookies", async (t) => {
  const { browsers } = stubLaunch(t);
  await call("woolworths_open_browser", { headless: true });
  const held = deferred();
  browsers[0].page.hold.cookies = held;

  const capturing = call("woolworths_get_cookies");
  await settle();
  await replaceSession();
  held.resolve();
  const { isError, payload } = await capturing;

  assert.equal(isError, true);
  assert.match(payload.error, /closed or reopened/);
  assert.equal(await sentCookieHeader(t), "session=test");
});

test("navigate whose session is replaced mid-goto is an error and never touches the new page", async (t) => {
  const { browsers } = stubLaunch(t);
  await call("woolworths_open_browser", { headless: true });
  const held = deferred();
  browsers[0].page.hold.goto = held;

  const navigating = call("woolworths_navigate", { url: `${HOME}/shop/browse/fruit-veg` });
  await settle();
  await replaceSession();
  const newPage = browsers[1].page;
  newPage.calls.length = 0;
  held.resolve();
  const { isError, payload } = await navigating;

  assert.equal(isError, true);
  assert.match(payload.error, /closed or reopened/);
  assert.deepEqual(newPage.calls, []);
});

test("a session stays usable when nothing replaces it", async (t) => {
  stubLaunch(t);
  await call("woolworths_open_browser", { headless: true });

  const navigated = await call("woolworths_navigate", { url: `${HOME}/shop/browse/fruit-veg` });
  const captured = await call("woolworths_get_cookies");

  assert.equal(navigated.isError, false);
  assert.equal(captured.isError, false);
  assert.equal(await sentCookieHeader(t), "fresh=from-page");
});
