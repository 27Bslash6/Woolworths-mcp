// Fake browsers for the offline tests: puppeteer.launch is stubbed, so no Chrome starts.
import { EventEmitter } from "node:events";
import puppeteer from "puppeteer";

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
      globalThis.location = new URL(url);
      let pending;
      try {
        pending = fn(arg);
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
