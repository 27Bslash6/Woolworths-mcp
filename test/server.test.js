// Offline tests: a fake browser's tab runs the in-page request with fetch stubbed, so nothing goes
// to the network. Run `pnpm test` (builds dist/ first).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, mock, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeBrowser, createServer } from "../dist/server.js";
import { stubLaunch } from "./fake-browser.js";

const readJson = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
const toolNames = readJson("./tool-names.json");
// Recorded live responses, cut to a few results, with ad ids and tracking tokens removed.
const searchFixture = readJson("./fixtures/search-milk.json");
// Half-price specials in Pantry (categoryId specialsgroup.3676.1_39FD49C).
const specialsFixture = readJson("./fixtures/specials-half-price-pantry.json");
const detailFixture = readJson("./fixtures/product-detail-223104.json");
// The Specials group and two top-level categories of the category tree.
const categoriesFixture = readJson("./fixtures/categories.json");
// One recorded anonymous trolley holding stockcode 50923 at quantity 1; it carries no session identifiers.
const trolleyFixture = readJson("./fixtures/trolley.json");
const productFields = ["Stockcode", "DisplayName", "Brand", "PackageSize", "Price", "WasPrice", "IsOnSpecial", "CupString", "Unit", "IsAvailable"];
const BASE = "https://www.woolworths.com.au";

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return client;
}

async function call(name, args = {}) {
  const client = await connect();
  try {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError === true, payload: JSON.parse(result.content[0].text) };
  } finally {
    await client.close();
  }
}

// Every test starts with a fake browser open on the Woolworths homepage.
let browsers;
beforeEach(async () => {
  ({ browsers } = stubLaunch(mock));
  assert.equal((await call("woolworths_open_browser", { headless: true })).isError, false);
});

afterEach(async () => {
  await closeBrowser();
  mock.restoreAll();
});

test("tools/list returns the 12 tools", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), toolNames);
});

test("search returns slim products, smaller than the raw ones", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(searchFixture));

  const { isError, payload } = await call("woolworths_search_products", { searchTerm: "milk" });

  assert.equal(isError, false);
  const raw = searchFixture.Products.flatMap((group) => group.Products);
  assert.equal(payload.products.length, raw.length);
  assert.deepEqual(
    payload.products.map((product) => product.Stockcode),
    raw.map((product) => product.Stockcode)
  );
  for (const product of payload.products) {
    assert.deepEqual(Object.keys(product), productFields);
  }
  const rawSize = JSON.stringify(searchFixture.Products).length;
  const slimSize = JSON.stringify(payload.products).length;
  t.diagnostic(`raw Products ${(rawSize / 1024).toFixed(1)} KB, slim products ${(slimSize / 1024).toFixed(1)} KB`);
  assert.ok(slimSize < rawSize);
});

test("specials POST the site's browse request and return slim products", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(specialsFixture));

  const { isError, payload } = await call("woolworths_get_specials", {
    category: "1_39FD49C",
    halfPrice: true,
    pageNumber: 2,
    pageSize: 8,
  });

  assert.equal(isError, false);
  const [url, init] = fetch.mock.calls[0].arguments;
  assert.equal(url, `${BASE}/apis/ui/browse/category`);
  assert.equal(init.method, "POST");
  // The browser sets the user agent, cookies and fetch metadata; only the body's type is ours.
  assert.deepEqual(init.headers, { "Content-Type": "application/json" });
  // The default mode, so Chrome sends Sec-Fetch-Mode: cors as the site's own requests do.
  assert.equal(init.mode, undefined);
  const body = JSON.parse(init.body);
  assert.equal(body.categoryId, "specialsgroup.3676.1_39FD49C");
  assert.equal(body.pageNumber, 2);
  assert.equal(body.pageSize, 8);
  const raw = specialsFixture.Bundles.flatMap((bundle) => bundle.Products);
  assert.equal(payload.totalResults, specialsFixture.TotalRecordCount);
  assert.deepEqual(
    payload.products.map((product) => product.Stockcode),
    raw.map((product) => product.Stockcode)
  );
  for (const product of payload.products) {
    assert.deepEqual(Object.keys(product), productFields);
    assert.equal(product.IsOnSpecial, true);
  }
});

test("specials pick the listing from category and halfPrice", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(specialsFixture));

  await call("woolworths_get_specials", { halfPrice: true });
  await call("woolworths_get_specials", { category: "1_39FD49C" });

  const ids = fetch.mock.calls.map((c) => JSON.parse(c.arguments[1].body).categoryId);
  assert.deepEqual(ids, ["specialsgroup.3676", "1_39FD49C_SPECIALS"]);
});

test("specials need a category or halfPrice, and a NodeId-shaped category", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(specialsFixture));

  const neither = await call("woolworths_get_specials");
  const client = await connect();
  const dotted = await client.callTool({
    name: "woolworths_get_specials",
    arguments: { category: "specialsgroup.3676" },
  });
  await client.close();

  assert.equal(neither.isError, true);
  assert.match(neither.payload.error, /no store-wide listing/);
  // Schema validation fails before the handler, as plain text rather than a JSON payload.
  assert.equal(dotted.isError, true);
  assert.match(dotted.content[0].text, /category/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("product details GET the detail endpoint for the stockcode", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(detailFixture));

  const { isError, payload } = await call("woolworths_get_product_details", { stockcode: 223104 });

  assert.equal(isError, false);
  const [url, init] = fetch.mock.calls[0].arguments;
  assert.equal(url, `${BASE}/apis/ui/product/detail/223104`);
  assert.equal(init.method, "GET");
  assert.deepEqual(init.headers, {});
  assert.equal(init.mode, undefined);
  assert.equal(payload.product.Product.Stockcode, 223104);
});

test("categories return two levels of the tree without the specials listings", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(categoriesFixture));

  const { isError, payload } = await call("woolworths_get_categories");

  assert.equal(isError, false);
  const [url, init] = fetch.mock.calls[0].arguments;
  assert.equal(url, `${BASE}/apis/ui/PiesCategoriesWithSpecials`);
  assert.equal(init.method, "GET");
  assert.deepEqual(
    payload.categories.map((category) => category.NodeId),
    ["1-E5BEE36E", "1_39FD49C"]
  );
  for (const category of payload.categories) {
    assert.deepEqual(Object.keys(category), ["NodeId", "Description", "UrlFriendlyName", "Children"]);
    assert.ok(category.Children.length > 0);
    for (const child of category.Children) {
      assert.deepEqual(Object.keys(child), ["NodeId", "Description", "UrlFriendlyName"]);
      assert.doesNotMatch(child.NodeId, /SPECIALS/);
    }
  }
});

test("a 200 without the array a handler slims is an isError result, not an empty success", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ message: "Access Denied" }));

  const categories = await call("woolworths_get_categories");
  const specials = await call("woolworths_get_specials", { halfPrice: true });

  assert.equal(categories.isError, true);
  assert.match(categories.payload.error, /no Categories array/);
  assert.equal(specials.isError, true);
  assert.match(specials.payload.error, /no Bundles array/);
});

test("a specials bundle without Products is an isError result naming the field", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ Bundles: [{}] }));

  const { isError, payload } = await call("woolworths_get_specials", { halfPrice: true });

  assert.equal(isError, true);
  assert.match(payload.error, /no Bundles\[\]\.Products array/);
});

test("a non-2xx response is an isError result with the status, type and size, not the body", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response("upstream down", { status: 503, statusText: "Service Unavailable" })
  );

  const { isError, payload } = await call("woolworths_get_cart");

  assert.equal(isError, true);
  assert.equal(payload.success, false);
  assert.equal(payload.error, "API request failed: 503 Service Unavailable (text/plain, 13 bytes)");
});

test("a 100 KB HTML block page becomes a short error with no markup", async (t) => {
  const page = `<html><body>${"<p>Access Denied</p>".repeat(6000)}</body></html>`;
  assert.ok(page.length >= 100 * 1024);
  t.mock.method(globalThis, "fetch", async () =>
    new Response(page, { status: 403, statusText: "Forbidden", headers: { "Content-Type": "text/html; charset=utf-8" } })
  );

  const { isError, payload } = await call("woolworths_search_products", { searchTerm: "milk" });

  assert.equal(isError, true);
  assert.ok(payload.error.length < 300, payload.error);
  assert.match(payload.error, /403/);
  assert.match(payload.error, /text\/html/);
  assert.doesNotMatch(payload.error, /[<>]|Access Denied/);
});

test("a 200 that is not JSON is an isError result without the body", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response("<html>challenge</html>", { headers: { "Content-Type": "text/html" } })
  );

  const { isError, payload } = await call("woolworths_get_cart");

  assert.equal(isError, true);
  assert.equal(payload.error, "API response was not JSON: 200 (text/html, 22 bytes)");
});

// Every tool that calls the Woolworths API, with valid arguments.
const apiCalls = [
  ["woolworths_search_products", { searchTerm: "milk" }],
  ["woolworths_get_product_details", { stockcode: 1 }],
  ["woolworths_get_specials", { halfPrice: true }],
  ["woolworths_get_categories", {}],
  ["woolworths_add_to_cart", { stockcode: 1 }],
  ["woolworths_get_cart", {}],
  ["woolworths_remove_from_cart", { stockcode: 1 }],
  ["woolworths_update_cart_quantity", { stockcode: 1, quantity: 2 }],
];

test("with the browser closed, every API tool says to open it and sends nothing", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  await closeBrowser();

  for (const [name, args] of apiCalls) {
    const { isError, payload } = await call(name, args);
    assert.equal(isError, true, name);
    assert.match(payload.error, /woolworths_open_browser/, name);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("with the tab moved off the Woolworths origin, every API tool fails and sends nothing", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({}));

  for (const elsewhere of ["https://attacker.example/", "https://woolworths.com.au/", "http://www.woolworths.com.au/"]) {
    // In-page script navigating the tab, which bypasses woolworths_navigate's checks.
    await browsers[0].page.goto(elsewhere);
    for (const [name, args] of apiCalls) {
      const { isError, payload } = await call(name, args);
      assert.equal(isError, true, `${name} on ${elsewhere}`);
      assert.match(payload.error, /not on https:\/\/www\.woolworths\.com\.au, so nothing was sent/);
    }
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("a thrown non-Error value still fills the error field", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw "socket hang up";
  });

  const { isError, payload } = await call("woolworths_get_product_details", { stockcode: 1 });

  assert.equal(isError, true);
  assert.deepEqual(payload, { success: false, error: "socket hang up" });
});

test("a cart write that fails in flight says it may have been applied", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Failed to fetch");
  });

  const write = await call("woolworths_update_cart_quantity", { stockcode: 1, quantity: 2 });
  const read = await call("woolworths_get_cart");

  assert.equal(write.isError, true);
  assert.equal(
    write.payload.error,
    "The update may have been applied (Failed to fetch); check woolworths_get_cart before retrying."
  );
  assert.equal(read.payload.error, "Failed to fetch");
});

test("closing a browser that is not open is an isError result", async () => {
  await closeBrowser();
  const { isError, payload } = await call("woolworths_close_browser");

  assert.equal(isError, true);
  assert.deepEqual(payload, { success: false, error: "Browser is not open." });
});

// Stubs the trolley read with `trolley` and the update with a 200; returns every request made.
function stubTrolley(t, trolley) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
    return Response.json(url.endsWith("/apis/ui/Trolley") ? trolley : { UpdatedItems: [] });
  });
  return requests;
}

const withQuantity = (stockcode, quantity) => ({
  ...trolleyFixture,
  AvailableItems: trolleyFixture.AvailableItems.map((item) => ({ ...item, Stockcode: stockcode, Quantity: quantity })),
});

for (const { name, trolley, add, sent } of [
  { name: "adds to a quantity already in the trolley", trolley: withQuantity(50923, 3), add: 1, sent: 4 },
  { name: "sets the requested quantity for a product not in the trolley", trolley: withQuantity(1, 3), add: 2, sent: 2 },
]) {
  test(`add_to_cart ${name}`, async (t) => {
    const requests = stubTrolley(t, trolley);

    const { isError } = await call("woolworths_add_to_cart", { stockcode: 50923, quantity: add });

    assert.equal(isError, false);
    assert.deepEqual(
      requests.map(({ url, method }) => `${method} ${new URL(url).pathname}`),
      ["GET /apis/ui/Trolley", "POST /api/v3/ui/trolley/update"]
    );
    assert.equal(requests[1].body.items[0].stockcode, 50923);
    assert.equal(requests[1].body.items[0].quantity, sent);
  });
}

test("add_to_cart fails with no update sent if its session is replaced after the trolley read", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push(`${init.method} ${new URL(url).pathname}`);
    if (!url.endsWith("/apis/ui/Trolley")) {
      return Response.json({ UpdatedItems: [] });
    }
    // The browser is closed and reopened while the trolley read is in flight.
    assert.equal((await call("woolworths_close_browser")).isError, false);
    assert.equal((await call("woolworths_open_browser", { headless: true })).isError, false);
    return Response.json(withQuantity(50923, 3));
  });

  const { isError, payload } = await call("woolworths_add_to_cart", { stockcode: 50923, quantity: 1 });

  assert.equal(isError, true);
  assert.match(payload.error, /closed or reopened/);
  assert.deepEqual(requests, ["GET /apis/ui/Trolley"]);
  assert.deepEqual(browsers[1].page.calls.filter((c) => c === "evaluate"), []);
});

test("add_to_cart never writes when the trolley read has no items array", async (t) => {
  const { AvailableItems: _, ...noItems } = trolleyFixture;
  const requests = stubTrolley(t, noItems);

  const { isError, payload } = await call("woolworths_add_to_cart", { stockcode: 50923, quantity: 1 });

  assert.equal(isError, true);
  assert.match(payload.error, /AvailableItems/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");
});
