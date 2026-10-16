// Offline tests of the rate gate, the in-tab timeout and the circuit breaker. Time is mocked where the
// breaker's 60-second window and 5-minute timeout are crossed.
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { closeBrowser, limits } from "../dist/server.js";
import { HOME, call, openBrowser as open, removeCacheDirs, resetServer, stubApi, stubLaunch } from "./fake-browser.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

// An upstream that never answers; like Chrome's fetch, it rejects when the request's signal aborts.
const silent = (url, init) =>
  new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
const status = (code) => async () => new Response("", { status: code });
const ok = async () => Response.json({ AvailableItems: [] });

let browsers;
beforeEach(async () => {
  await resetServer();
  ({ browsers } = stubLaunch(mock));
  await open();
});

afterEach(async () => {
  await closeBrowser();
  mock.restoreAll();
});

after(removeCacheDirs);

// Gate

test("concurrent calls reach upstream one at a time, an interval apart", async (t) => {
  Object.assign(limits, { intervalMs: 40, jitterMs: 10 });
  const starts = [];
  let inFlight = 0;
  let maxInFlight = 0;
  stubApi(t.mock, async () => {
    starts.push(Date.now());
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return Response.json({});
  });

  const results = await Promise.all(Array.from({ length: 4 }, () => call("woolworths_get_cart")));

  assert.deepEqual(results.map((r) => r.isError), [false, false, false, false]);
  assert.equal(maxInFlight, 1);
  // Date.now() counts whole milliseconds, and the stub reads it a moment after the gate does.
  const gaps = starts.slice(1).map((start, i) => start - starts[i]);
  t.diagnostic(`start-to-start gaps ${gaps.join(", ")} ms`);
  for (const gap of gaps) {
    assert.ok(gap >= limits.intervalMs - 1, `gap ${gap} ms`);
  }
});

test("a call waiting at the gate when the browser closes fails and sends nothing", async (t) => {
  Object.assign(limits, { intervalMs: 200, jitterMs: 0 });
  const api = stubApi(t.mock, async () => Response.json({}));

  const first = call("woolworths_get_cart");
  const second = call("woolworths_get_cart");
  assert.equal((await first).isError, false);
  await closeBrowser();
  const { isError, payload } = await second;

  assert.equal(isError, true);
  assert.match(payload.error, /closed or reopened/);
  assert.equal(api.mock.callCount(), 1);
});

// Timeout

test("the in-tab fetch carries a timeout signal", async (t) => {
  const api = stubApi(t.mock, async () => Response.json({}));

  await call("woolworths_get_cart");

  const [, init] = api.mock.calls[0].arguments;
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.signal.aborted, false);
});

test("an upstream that never answers is an isError result within the timeout", async (t) => {
  limits.timeoutMs = 50;
  stubApi(t.mock, silent);

  const started = Date.now();
  const { isError, payload } = await call("woolworths_get_cart");

  assert.equal(isError, true);
  assert.match(payload.error, /^Woolworths did not respond in time/);
  assert.ok(Date.now() - started < 2_000);
});

test("a trolley update that times out says it may have been applied", async (t) => {
  limits.timeoutMs = 50;
  stubApi(t.mock, silent);

  const { isError, payload } = await call("woolworths_update_cart_quantity", { stockcode: 1, quantity: 2 });

  assert.equal(isError, true);
  assert.match(payload.error, /^The update may have been applied \(Woolworths did not respond in time/);
  assert.match(payload.error, /check woolworths_get_cart before retrying/);
});

// Circuit breaker

const RATE_LIMITED = /^Woolworths is rate-limiting; retry in \d min$/;

// Mocks Date only: the gate's sleeps and the in-tab timeout still use real timers.
function mockClock(t) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-16T00:00:00Z") });
  return (ms) => t.mock.timers.tick(ms);
}

async function failThrice(name, args = {}) {
  for (let i = 0; i < 3; i++) {
    assert.equal((await call(name, args)).isError, true);
  }
}

for (const { kind, name, args, api } of [
  { kind: "403s", name: "woolworths_get_cart", api: status(403) },
  { kind: "429s", name: "woolworths_get_cart", api: status(429) },
  { kind: "503s", name: "woolworths_get_cart", api: status(503) },
  { kind: "bad-shape 200s", name: "woolworths_get_categories", api: async () => Response.json({ message: "blocked" }) },
  { kind: "non-JSON 200s", name: "woolworths_get_cart", api: async () => new Response("<html>challenge</html>") },
  { kind: "timeouts", name: "woolworths_get_cart", api: silent },
  { kind: "network failures", name: "woolworths_get_cart", api: async () => Promise.reject(new TypeError("Failed to fetch")) },
]) {
  test(`three ${kind} within 60 s open the breaker, and every API tool then sends nothing`, async (t) => {
    mockClock(t);
    limits.timeoutMs = 20;
    const upstream = stubApi(t.mock, api);

    await failThrice(name, args);
    const sent = upstream.mock.callCount();
    for (const [tool, toolArgs] of [
      ["woolworths_get_cart", {}],
      ["woolworths_get_categories", {}],
      ["woolworths_update_cart_quantity", { stockcode: 1, quantity: 2 }],
    ]) {
      const { isError, payload } = await call(tool, toolArgs);
      assert.equal(isError, true, tool);
      assert.match(payload.error, RATE_LIMITED, tool);
    }

    assert.equal(sent, 3);
    assert.equal(upstream.mock.callCount(), 3);
  });
}

test("three 404s and three 400s do not open the breaker", async (t) => {
  mockClock(t);
  const upstream = stubApi(t.mock, status(404));
  await failThrice("woolworths_get_product_details", { stockcode: 1 });
  upstream.mock.mockImplementation(status(400));
  await failThrice("woolworths_get_cart");
  upstream.mock.mockImplementation(ok);

  assert.equal((await call("woolworths_get_cart")).isError, false);
  assert.equal(upstream.mock.callCount(), 7);
});

test("a product with Product: null does not count against the breaker", async (t) => {
  mockClock(t);
  const upstream = stubApi(t.mock, async () => Response.json({ Product: null }));
  for (let stockcode = 1; stockcode <= 3; stockcode++) {
    const { isError, payload } = await call("woolworths_get_product_details", { stockcode });
    assert.equal(isError, true);
    assert.match(payload.error, /No product has stockcode/);
  }
  upstream.mock.mockImplementation(ok);

  assert.equal((await call("woolworths_get_cart")).isError, false);
});

test("failures more than 60 s apart do not open the breaker", async (t) => {
  const tick = mockClock(t);
  const upstream = stubApi(t.mock, status(403));
  await call("woolworths_get_cart");
  await call("woolworths_get_cart");
  tick(60_001);
  await call("woolworths_get_cart");
  upstream.mock.mockImplementation(ok);

  assert.equal((await call("woolworths_get_cart")).isError, false);
});

test("calls already waiting at the gate when the breaker opens send nothing", async (t) => {
  mockClock(t);
  const upstream = stubApi(t.mock, status(403));

  const results = await Promise.all(Array.from({ length: 5 }, () => call("woolworths_get_cart")));

  assert.equal(upstream.mock.callCount(), 3);
  assert.deepEqual(
    results.slice(3).map((r) => r.payload.error),
    ["Woolworths is rate-limiting; retry in 5 min", "Woolworths is rate-limiting; retry in 5 min"]
  );
});

test("the retry hint counts down the whole minutes until the breaker half-opens", async (t) => {
  const tick = mockClock(t);
  stubApi(t.mock, status(403));
  await failThrice("woolworths_get_cart");

  const hints = [];
  for (const step of [0, 1, 60_000, 120_000, 60_000, 59_998]) {
    tick(step);
    hints.push((await call("woolworths_get_cart")).payload.error);
  }

  assert.deepEqual(
    hints.map((hint) => hint.match(/retry in (\d) min/)[1]),
    ["5", "5", "4", "2", "1", "1"]
  );
});

test("after 5 minutes one successful probe closes the breaker, and later calls all reach upstream", async (t) => {
  const tick = mockClock(t);
  const upstream = stubApi(t.mock, status(403));
  await failThrice("woolworths_get_cart");
  tick(299_999);
  assert.match((await call("woolworths_get_cart")).payload.error, RATE_LIMITED);
  tick(1);
  upstream.mock.mockImplementation(ok);

  const probe = await call("woolworths_get_cart");
  const next = [await call("woolworths_get_cart"), await call("woolworths_get_cart")];

  assert.equal(probe.isError, false);
  // The half-open lock: with successThreshold above halfOpenMaxCalls these two would be refused.
  assert.deepEqual(next.map((r) => r.isError), [false, false]);
  assert.equal(upstream.mock.callCount(), 6);
});

test("while the probe is in flight, other calls are refused without a request", async (t) => {
  const tick = mockClock(t);
  const upstream = stubApi(t.mock, status(403));
  await failThrice("woolworths_get_cart");
  tick(300_000);
  let release;
  upstream.mock.mockImplementation(async () => {
    await new Promise((resolve) => (release = resolve));
    return Response.json({});
  });

  const probe = call("woolworths_get_cart");
  while (!release) {
    await settle();
  }
  const refused = await call("woolworths_get_categories");
  release();

  assert.match(refused.payload.error, /^Woolworths is rate-limiting; retry in 1 min$/);
  assert.equal((await probe).isError, false);
  assert.equal(upstream.mock.callCount(), 4);
});

test("a failed probe opens the breaker again for 5 minutes", async (t) => {
  const tick = mockClock(t);
  const upstream = stubApi(t.mock, status(403));
  await failThrice("woolworths_get_cart");
  tick(300_000);

  assert.match((await call("woolworths_get_cart")).payload.error, /403/);
  const { payload } = await call("woolworths_get_cart");

  assert.equal(payload.error, "Woolworths is rate-limiting; retry in 5 min");
  assert.equal(upstream.mock.callCount(), 4);
});

test("in half-open, calls that send no request leave the breaker half-open", async (t) => {
  const tick = mockClock(t);
  const upstream = stubApi(t.mock, status(403));
  await failThrice("woolworths_get_cart");
  tick(300_000);

  // An off-origin tab, then a closed browser: neither sends anything.
  await browsers[0].page.goto("https://attacker.example/");
  assert.match((await call("woolworths_get_cart")).payload.error, /so nothing was sent/);
  await closeBrowser();
  assert.match((await call("woolworths_get_cart")).payload.error, /woolworths_open_browser/);
  await open();

  // Still half-open: the probe is let through, and its single failure reopens the breaker.
  assert.match((await call("woolworths_get_cart")).payload.error, /403/);
  assert.match((await call("woolworths_get_cart")).payload.error, RATE_LIMITED);
  assert.equal(upstream.mock.callCount(), 4);
});

for (const { kind, arm, error } of [
  { kind: "a browser fault", arm: (page) => (page.fault = new Error("Execution context was destroyed")), error: /^Execution context was destroyed$/ },
  { kind: "a tab that left the origin at the gate", arm: (page) => (page.drift = "https://attacker.example/"), error: /^The browser tab left https:\/\/www\.woolworths\.com\.au while this call waited, so nothing was sent/ },
]) {
  test(`${kind} never counts against the breaker`, async (t) => {
    mockClock(t);
    const upstream = stubApi(t.mock, ok);
    for (let i = 0; i < 4; i++) {
      arm(browsers[0].page);
      assert.match((await call("woolworths_get_cart")).payload.error, error);
      await browsers[0].page.goto(HOME);
    }

    assert.equal((await call("woolworths_get_cart")).isError, false);
    assert.equal(upstream.mock.callCount(), 1);
  });

  test(`in half-open, ${kind} leaves the breaker half-open`, async (t) => {
    const tick = mockClock(t);
    const upstream = stubApi(t.mock, status(403));
    await failThrice("woolworths_get_cart");
    tick(300_000);

    arm(browsers[0].page);
    assert.match((await call("woolworths_get_cart")).payload.error, error);
    await browsers[0].page.goto(HOME);

    // Still half-open: the next call is the probe, and its one 403 reopens the breaker.
    assert.match((await call("woolworths_get_cart")).payload.error, /403/);
    assert.match((await call("woolworths_get_cart")).payload.error, RATE_LIMITED);
    assert.equal(upstream.mock.callCount(), 4);
  });
}

test("a trolley update answered with a 5xx says it may have been applied, and counts", async (t) => {
  mockClock(t);
  let quantity = 0;
  const upstream = stubApi(t.mock, async (url, init) => {
    if (url.endsWith("/apis/ui/Trolley")) {
      return Response.json({ AvailableItems: quantity ? [{ Stockcode: 7, Quantity: quantity }] : [] });
    }
    // The write lands before the gateway gives up.
    quantity = JSON.parse(init.body).items[0].quantity;
    return new Response("", { status: 504, statusText: "Gateway Time-out" });
  });

  const { payload } = await call("woolworths_add_to_cart", { stockcode: 7, quantity: 2 });
  await call("woolworths_update_cart_quantity", { stockcode: 7, quantity: 2 });
  await call("woolworths_update_cart_quantity", { stockcode: 7, quantity: 2 });

  assert.equal(
    payload.error,
    "The update may have been applied (API request failed: 504 Gateway Time-out (text/plain, 0 bytes)); check woolworths_get_cart before retrying."
  );
  // The trolley read, then three writes answered 504: the third opened the breaker.
  assert.equal(upstream.mock.callCount(), 4);
  assert.match((await call("woolworths_get_cart")).payload.error, RATE_LIMITED);
});

for (const { kind, arm, answer, error } of [
  { kind: "a browser fault", arm: (page) => (page.fault = new Error("Target closed")), answer: ok, error: "Target closed" },
  { kind: "a 200 that is not JSON", arm: () => {}, answer: async () => new Response("<html>challenge</html>"), error: "API response was not JSON: 200 (text/plain, 22 bytes)" },
]) {
  test(`a trolley update met by ${kind} says it may have been applied`, async (t) => {
    stubApi(t.mock, answer);
    arm(browsers[0].page);

    const { payload } = await call("woolworths_update_cart_quantity", { stockcode: 7, quantity: 2 });

    assert.equal(payload.error, `The update may have been applied (${error}); check woolworths_get_cart before retrying.`);
  });
}

test("the tab returning home after an off-origin call is served again", async (t) => {
  stubApi(t.mock, ok);
  await browsers[0].page.goto("https://attacker.example/");
  assert.equal((await call("woolworths_get_cart")).isError, true);
  await browsers[0].page.goto(HOME);

  assert.equal((await call("woolworths_get_cart")).isError, false);
});
