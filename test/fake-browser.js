// Fake browsers for the offline tests: puppeteer.launch is stubbed, so no Chrome starts.
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer";
import { limits, resetState } from "../dist/server.js";

export const HOME = "https://www.woolworths.com.au";

// A promise with its resolve exposed, to hold a stubbed call open until the test releases it.
export function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// A fake page. Set `page.hold.goto` or `page.hold.cookies` to a deferred and that call waits on
// it; goto to the homepage is never held. `calls` records the goto, url and evaluate calls it gets.
// evaluate runs the server's in-tab function in Node, with `location` set to the page's URL for its
// synchronous start, so its `fetch` is the test's stub of globalThis.fetch.
function fakePage() {
  let url = "about:blank";
  return {
    hold: {},
    calls: [],
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
    async evaluate(fn, arg) {
      this.calls.push("evaluate");
      // Rebuilt from its source and given a JSON copy of its argument, as Puppeteer does, so a
      // reference to anything outside the function fails here as it would in Chrome.
      const inPage = (0, eval)(`(${fn.toString()})`);
      globalThis.location = new URL(url);
      let pending;
      try {
        pending = inPage(JSON.parse(JSON.stringify(arg)));
      } finally {
        delete globalThis.location;
      }
      // Puppeteer returns a JSON copy of the result, not the object itself.
      return JSON.parse(JSON.stringify(await pending));
    },
  };
}

// Stubs puppeteer.launch through `mock` (t.mock, or node:test's module mock); every fake browser it
// returns is recorded, with whether it is still live.
export function stubLaunch(mock, { launchGate, closeGate } = {}) {
  const browsers = [];
  const events = [];
  mock.method(puppeteer, "launch", async () => {
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

export const STORE_ID = 1234;

// Stubs globalThis.fetch through `mock`. The store id lookup is answered here with `storeId`; every
// other request goes to `api`, whose mock (returned) records only those requests.
export function stubApi(mock, api, { storeId = STORE_ID } = {}) {
  const stub = mock.fn(api);
  mock.method(globalThis, "fetch", (url, init) =>
    new URL(url).pathname === "/api/ui/v2/bootstrap"
      ? Promise.resolve(Response.json({ GetDeliveryInfoRequest: { FulfilmentStoreId: storeId } }))
      : stub(url, init)
  );
  return stub;
}

const cacheDirs = [];

// Clears the server's gate, breaker, store id and cache, and points the cache at a fresh temporary
// directory, so no test reads another's entries or touches the user's cache. Requests are not paced.
export async function resetServer() {
  const dir = mkdtempSync(join(tmpdir(), "woolworths-mcp-test-"));
  cacheDirs.push(dir);
  process.env.WOOLWORTHS_MCP_CACHE_DIR = dir;
  await resetState();
  Object.assign(limits, { intervalMs: 0, jitterMs: 0, timeoutMs: 15_000 });
}

export async function removeCacheDirs() {
  await resetState();
  for (const dir of cacheDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
