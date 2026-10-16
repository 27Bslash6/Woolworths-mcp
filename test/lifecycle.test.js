// Offline lifecycle tests: puppeteer.launch is stubbed with fake browsers, so no Chrome starts.
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import puppeteer from "puppeteer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeBrowser, createServer } from "../dist/server.js";
import { HOME, deferred, removeCacheDirs, resetServer, stubLaunch } from "./fake-browser.js";

let client;

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, payload: JSON.parse(result.content[0].text) };
}

// Which browser's tab the next API call runs in (its index in `browsers`), read through a stubbed fetch.
async function servingBrowser(t, browsers) {
  t.mock.method(globalThis, "fetch", async () => Response.json({}));
  browsers.forEach((browser) => (browser.page.calls.length = 0));
  assert.equal((await call("woolworths_get_cart")).isError, false);
  return browsers.findIndex((browser) => browser.page.calls.includes("evaluate"));
}

// Lets pending promise callbacks run, so a call reaches its next await.
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(async () => {
  await resetServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  await closeBrowser();
});

after(removeCacheDirs);

test("two concurrent opens launch one browser", async (t) => {
  const launchGate = deferred();
  const { live } = stubLaunch(t.mock, { launchGate });

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
  const { browsers, events, live } = stubLaunch(t.mock, { closeGate });
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
  const { browsers, events, live } = stubLaunch(t.mock);
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
  const { browsers, live } = stubLaunch(t.mock);
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

test("get_cookies whose session is replaced mid-call is an error, and API calls use the new session", async (t) => {
  const { browsers } = stubLaunch(t.mock);
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
  assert.equal(await servingBrowser(t, browsers), 1);
});

test("navigate whose session is replaced mid-goto is an error and never touches the new page", async (t) => {
  const { browsers } = stubLaunch(t.mock);
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

test("an API call whose session is replaced mid-request is an error and never touches the new page", async (t) => {
  const { browsers } = stubLaunch(t.mock);
  await call("woolworths_open_browser", { headless: true });
  const held = deferred();
  t.mock.method(globalThis, "fetch", async () => {
    await held.promise;
    return Response.json({});
  });

  const reading = call("woolworths_get_cart");
  await settle();
  await replaceSession();
  const newPage = browsers[1].page;
  newPage.calls.length = 0;
  held.resolve();
  const { isError, payload } = await reading;

  assert.equal(isError, true);
  assert.match(payload.error, /closed or reopened/);
  assert.deepEqual(newPage.calls, []);
});

test("a session stays usable when nothing replaces it", async (t) => {
  const { browsers } = stubLaunch(t.mock);
  await call("woolworths_open_browser", { headless: true });

  const navigated = await call("woolworths_navigate", { url: `${HOME}/shop/browse/fruit-veg` });
  const captured = await call("woolworths_get_cookies");

  assert.equal(navigated.isError, false);
  assert.equal(captured.isError, false);
  assert.equal(await servingBrowser(t, browsers), 0);
});
