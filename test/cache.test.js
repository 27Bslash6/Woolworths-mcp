// Offline tests of the response shape checks, the store id lookup and the file cache. Each test gets
// a fresh temporary cache directory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { cacheDir, catalogueWeek } from "../dist/cache.js";
import { closeBrowser, createServer, limits, resetState } from "../dist/server.js";
import { removeCacheDirs, resetServer, stubApi, stubLaunch } from "./fake-browser.js";

const readJson = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
const searchFixture = readJson("./fixtures/search-milk.json");
const specialsFixture = readJson("./fixtures/specials-half-price-pantry.json");
const detailFixture = readJson("./fixtures/product-detail-223104.json");
const categoriesFixture = readJson("./fixtures/categories.json");
const trolleyFixture = readJson("./fixtures/trolley.json");

async function call(name, args = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError === true, payload: JSON.parse(result.content[0].text), result };
  } finally {
    await client.close();
  }
}

const open = async () => assert.equal((await call("woolworths_open_browser", { headless: true })).isError, false);

beforeEach(async () => {
  await resetServer();
  stubLaunch(mock);
  await open();
});

afterEach(async () => {
  await closeBrowser();
  mock.restoreAll();
});

after(removeCacheDirs);

// Answers each read endpoint with its recorded fixture.
function fixtureFor(url) {
  const { pathname } = new URL(url);
  if (pathname.endsWith("/Search/products")) return searchFixture;
  if (pathname.startsWith("/apis/ui/product/detail/")) return detailFixture;
  if (pathname.endsWith("/browse/category")) return specialsFixture;
  if (pathname.endsWith("/PiesCategoriesWithSpecials")) return categoriesFixture;
  return trolleyFixture;
}
const fixtures = async (url) => Response.json(fixtureFor(url));

const reads = [
  ["woolworths_search_products", { searchTerm: "milk" }],
  ["woolworths_get_product_details", { stockcode: 223104 }],
  ["woolworths_get_specials", { category: "1_39FD49C", halfPrice: true }],
  ["woolworths_get_categories", {}],
];

// Shape checks

for (const { name, body } of [
  { name: "a body without Products and a non-zero count", body: { SearchResultsCount: 12 } },
  { name: "Products that is not an array", body: { SearchResultsCount: 1, Products: {} } },
  { name: "a group without Products", body: { SearchResultsCount: 2, Products: [searchFixture.Products[0], {}] } },
  { name: "a JSON array", body: [] },
]) {
  test(`search: ${name} is an unexpected response`, async (t) => {
    stubApi(t.mock, async () => Response.json(body));

    const { isError, payload } = await call("woolworths_search_products", { searchTerm: "milk" });

    assert.equal(isError, true);
    assert.match(payload.error, /^Unexpected Woolworths response/);
  });
}

for (const Products of [undefined, null]) {
  test(`search: a zero-hit response with Products ${Products} is an empty success`, async (t) => {
    stubApi(t.mock, async () => Response.json({ SearchResultsCount: 0, Products }));

    const { isError, payload } = await call("woolworths_search_products", { searchTerm: "zzzz" });

    assert.equal(isError, false);
    assert.deepEqual(payload.products, []);
    assert.equal(payload.totalResults, 0);
  });
}

test("product details: a 200 without a Product key is an unexpected response", async (t) => {
  stubApi(t.mock, async () => Response.json({ message: "blocked" }));

  const { isError, payload } = await call("woolworths_get_product_details", { stockcode: 1 });

  assert.equal(isError, true);
  assert.match(payload.error, /^Unexpected Woolworths response/);
});

test("product details: Product: null says no product has the stockcode", async (t) => {
  stubApi(t.mock, async () => Response.json({ Product: null }));

  const { isError, payload } = await call("woolworths_get_product_details", { stockcode: 999 });

  assert.equal(isError, true);
  assert.equal(payload.error, "No product has stockcode 999.");
});

test("product details drop trolley, purchase history and tracking data", async (t) => {
  stubApi(t.mock, fixtures);

  const { isError, payload } = await call("woolworths_get_product_details", { stockcode: 223104 });

  assert.equal(isError, false);
  const keys = [];
  (function walk(value) {
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        keys.push(key);
        walk(child);
      }
    }
  })(payload);
  assert.equal(keys.filter((key) => key.includes("Trolley")).length, 0);
  for (const dropped of ["DiagnosticsData", "RichRelevancePlacements", "Diagnostics", "IsPersonalisedByPurchaseHistory", "HasBeenBoughtBefore"]) {
    assert.ok(!keys.includes(dropped), dropped);
  }
  assert.equal(payload.product.Product.Stockcode, 223104);
  assert.equal(payload.product.Product.DisplayName, detailFixture.Product.DisplayName);
});

// Store id

for (const FulfilmentStoreId of [0, -3, 1.5, "1234", null]) {
  test(`a store id of ${JSON.stringify(FulfilmentStoreId)} fails the lookup as an unexpected response`, async (t) => {
    const api = t.mock.method(globalThis, "fetch", async () => Response.json({ GetDeliveryInfoRequest: { FulfilmentStoreId } }));

    const { isError, payload } = await call("woolworths_search_products", { searchTerm: "milk" });

    assert.equal(isError, true);
    assert.match(payload.error, /^Unexpected Woolworths response/);
    assert.equal(api.mock.callCount(), 1);
  });
}

// Records every request path; the bootstrap answers with `storeIds` in turn (a number, or a status).
function stubBootstrap(t, storeIds) {
  const paths = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const { pathname } = new URL(url);
    paths.push(pathname);
    if (pathname !== "/api/ui/v2/bootstrap") {
      return fixtures(url);
    }
    const next = storeIds.shift();
    return next >= 1000
      ? Response.json({ GetDeliveryInfoRequest: { FulfilmentStoreId: next } })
      : new Response("", { status: next });
  });
  return { bootstraps: () => paths.filter((p) => p === "/api/ui/v2/bootstrap").length, paths };
}

test("the store id is looked up once per session, shared by concurrent calls", async (t) => {
  const { bootstraps } = stubBootstrap(t, [1234]);

  const results = await Promise.all([
    call("woolworths_search_products", { searchTerm: "milk" }),
    call("woolworths_get_product_details", { stockcode: 223104 }),
    call("woolworths_get_specials", { halfPrice: true }),
  ]);
  await call("woolworths_search_products", { searchTerm: "bread" });

  assert.deepEqual(results.map((r) => r.isError), [false, false, false]);
  assert.equal(bootstraps(), 1);
});

test("a failed store id lookup is dropped, so the next call looks it up again", async (t) => {
  const { bootstraps } = stubBootstrap(t, [404, 1234]);

  const failed = await call("woolworths_search_products", { searchTerm: "milk" });
  const retried = await call("woolworths_search_products", { searchTerm: "milk" });

  assert.equal(failed.isError, true);
  assert.equal(retried.isError, false);
  assert.equal(bootstraps(), 2);
});

test("the store id is forgotten when the browser closes", async (t) => {
  const { bootstraps } = stubBootstrap(t, [1234, 1234]);

  await call("woolworths_search_products", { searchTerm: "milk" });
  await closeBrowser();
  await open();
  await call("woolworths_search_products", { searchTerm: "bread" });

  assert.equal(bootstraps(), 2);
});

// Cache

for (const [name, args] of reads) {
  test(`a repeated ${name} is served from the cache with the same result`, async (t) => {
    const api = stubApi(t.mock, fixtures);

    const fresh = await call(name, args);
    const cached = await call(name, args);

    assert.equal(fresh.isError, false);
    assert.deepEqual(cached.result, fresh.result);
    assert.equal(api.mock.callCount(), 1);
  });
}

// The serializer sorts object keys, so a value read back from disk has the same data in another order.
test("a cached value read back from disk gives the same data as the fresh call", async (t) => {
  // One product without a WasPrice: the disk copy must not gain a field the fresh result lacks.
  const search = structuredClone(searchFixture);
  delete search.Products[0].Products[0].WasPrice;
  const api = stubApi(t.mock, async (url) =>
    Response.json(new URL(url).pathname.endsWith("/Search/products") ? search : fixtureFor(url))
  );
  const fresh = [];
  for (const [name, args] of reads) {
    fresh.push((await call(name, args)).payload);
  }

  // A new cache instance on the same directory has an empty in-memory layer.
  await closeBrowser();
  await resetState();
  await open();
  const cached = [];
  for (const [name, args] of reads) {
    cached.push((await call(name, args)).payload);
  }

  assert.deepEqual(cached, fresh);
  assert.equal(api.mock.callCount(), 4);
});

test("search terms that differ only in case and spacing share one entry, and the normalised term is sent", async (t) => {
  const api = stubApi(t.mock, fixtures);

  await call("woolworths_search_products", { searchTerm: "  Full   Cream Milk " });
  const { payload } = await call("woolworths_search_products", { searchTerm: "full cream milk" });

  assert.equal(api.mock.callCount(), 1);
  assert.equal(JSON.parse(api.mock.calls[0].arguments[1].body).searchTerm, "full cream milk");
  assert.equal(payload.searchTerm, "full cream milk");
});

test("each key argument selects its own entry", async (t) => {
  const api = stubApi(t.mock, fixtures);
  const variants = [
    ["woolworths_search_products", { searchTerm: "milk" }],
    ["woolworths_search_products", { searchTerm: "milk", pageNumber: 2 }],
    ["woolworths_search_products", { searchTerm: "milk", pageSize: 10 }],
    ["woolworths_search_products", { searchTerm: "milk", sortType: "PriceAsc" }],
    ["woolworths_search_products", { searchTerm: "milk", isSpecial: true }],
    ["woolworths_get_product_details", { stockcode: 223104 }],
    ["woolworths_get_product_details", { stockcode: 223105 }],
    ["woolworths_get_specials", { halfPrice: true }],
    ["woolworths_get_specials", { halfPrice: true, pageNumber: 2 }],
    ["woolworths_get_specials", { category: "1_39FD49C" }],
    ["woolworths_get_specials", { category: "1_39FD49C", halfPrice: true }],
  ];

  for (const [name, args] of variants) {
    await call(name, args);
  }

  assert.equal(api.mock.callCount(), variants.length);
});

test("a different store misses the cache", async (t) => {
  const api = stubApi(t.mock, fixtures);
  await call("woolworths_search_products", { searchTerm: "milk" });
  await closeBrowser();
  const other = stubApi(t.mock, fixtures, { storeId: 5678 });
  await open();

  await call("woolworths_search_products", { searchTerm: "milk" });

  assert.equal(api.mock.callCount(), 1);
  assert.equal(other.mock.callCount(), 1);
});

test("a new catalogue week misses the cache for prices, not for categories", async (t) => {
  // Tuesday 2026-10-20 12:00 in Sydney; the next catalogue week starts 12 hours later.
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T01:00:00Z") });
  const api = stubApi(t.mock, fixtures);
  for (const [name, args] of reads) {
    await call(name, args);
  }

  t.mock.timers.tick(12 * 3600_000);
  for (const [name, args] of reads) {
    await call(name, args);
  }

  assert.equal(api.mock.callCount(), 7);
});

for (const { kind, api } of [
  { kind: "a 403", api: async () => new Response("", { status: 403 }) },
  { kind: "a bad-shape 200", api: async () => Response.json({ message: "blocked" }) },
  { kind: "a timeout", api: null },
]) {
  test(`a call that failed with ${kind} caches nothing`, async (t) => {
    limits.timeoutMs = 20;
    const silent = (url, init) =>
      new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    const upstream = stubApi(t.mock, api ?? silent);

    for (const [name, args] of reads) {
      assert.equal((await call(name, args)).isError, true, name);
      // Clears the breaker, so the four failures in a row do not open it; the cache directory stays.
      await resetState();
    }
    upstream.mock.mockImplementation(fixtures);
    for (const [name, args] of reads) {
      assert.equal((await call(name, args)).isError, false, name);
    }

    assert.equal(upstream.mock.callCount(), 8);
  });
}

test("with the breaker open, a primed search is served and an unprimed one is refused", async (t) => {
  const upstream = stubApi(t.mock, fixtures);
  await call("woolworths_search_products", { searchTerm: "milk" });
  upstream.mock.mockImplementation(async () => new Response("", { status: 403 }));
  for (let i = 0; i < 3; i++) {
    await call("woolworths_get_cart");
  }

  const primed = await call("woolworths_search_products", { searchTerm: "milk" });
  const unprimed = await call("woolworths_search_products", { searchTerm: "bread" });

  assert.equal(primed.isError, false);
  assert.equal(unprimed.isError, true);
  assert.match(unprimed.payload.error, /^Woolworths is rate-limiting; retry in 5 min$/);
  assert.equal(upstream.mock.callCount(), 4);
});

test("the trolley is never cached", async (t) => {
  const api = stubApi(t.mock, fixtures);

  await call("woolworths_get_cart");
  await call("woolworths_get_cart");

  assert.equal(api.mock.callCount(), 2);
});

// CacheKit reports its own errors through console.error.
test("filling and reading the cache logs nothing", async (t) => {
  stubApi(t.mock, fixtures);
  const logged = ["error", "warn", "log", "info"].map((level) => t.mock.method(console, level));

  for (const [name, args] of [...reads, ...reads]) {
    assert.equal((await call(name, args)).isError, false);
  }

  assert.deepEqual(logged.map((m) => m.mock.callCount()), [0, 0, 0, 0]);
});

// The test runner itself writes to this process's stdout, so the server runs in its own process.
test("starting the server writes only protocol messages to stdout and one line to stderr", async () => {
  const server = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url))], {
    env: { ...process.env, WOOLWORTHS_MCP_CACHE_DIR: process.env.WOOLWORTHS_MCP_CACHE_DIR },
  });
  let stdout = "";
  let stderr = "";
  server.stderr.on("data", (chunk) => (stderr += chunk));
  const listed = new Promise((resolve) =>
    server.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes('"id":2')) resolve();
    })
  );
  server.stdin.write(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]
      .map((message) => JSON.stringify(message) + "\n")
      .join("")
  );
  await listed;
  server.kill();

  const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.id), [1, 2]);
  assert.equal(stderr, "Woolworths MCP Server running on stdio\n");
});

// Catalogue week and cache location

test("the catalogue week turns over at Wednesday midnight in Sydney, across daylight saving", () => {
  // Sydney moves from UTC+10 to UTC+11 on Sunday 2026-10-04.
  const weeks = [
    ["2026-09-29T13:59:59Z", "2026-09-23"], // Tuesday 23:59:59 AEST
    ["2026-09-29T14:00:00Z", "2026-09-30"], // Wednesday 00:00 AEST
    ["2026-10-06T12:59:59Z", "2026-09-30"], // Tuesday 23:59:59 AEDT, after the change
    ["2026-10-06T13:00:00Z", "2026-10-07"], // Wednesday 00:00 AEDT
  ];
  for (const [instant, week] of weeks) {
    assert.equal(catalogueWeek(new Date(instant)), week, instant);
  }
});

test("the cache directory follows the platform convention and the override", () => {
  assert.equal(cacheDir({ WOOLWORTHS_MCP_CACHE_DIR: "/tmp/ww" }, "linux"), "/tmp/ww");
  assert.equal(cacheDir({ XDG_CACHE_HOME: "/xdg" }, "linux"), join("/xdg", "woolworths-mcp"));
  assert.match(cacheDir({}, "darwin"), /\.cache[\\/]woolworths-mcp$/);
  assert.equal(cacheDir({ LOCALAPPDATA: "C:\\Local" }, "win32"), join("C:\\Local", "woolworths-mcp"));
});
