// Offline tests: fetch is stubbed and no browser is launched. Run `pnpm test` (builds dist/ first).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, setSessionCookies } from "../dist/server.js";

const readJson = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
const toolNames = readJson("./tool-names.json");
// Recorded live responses, cut to a few results, with ad ids and tracking tokens removed.
const searchFixture = readJson("./fixtures/search-milk.json");
// Half-price specials in Pantry (categoryId specialsgroup.3676.1_39FD49C).
const specialsFixture = readJson("./fixtures/specials-half-price-pantry.json");
const detailFixture = readJson("./fixtures/product-detail-223104.json");
// The Specials group and two top-level categories of the category tree.
const categoriesFixture = readJson("./fixtures/categories.json");
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

beforeEach(() => setSessionCookies([{ name: "session", value: "test" }]));

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

test("a non-2xx response is an isError result with the status and body", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response("upstream down", { status: 503, statusText: "Service Unavailable" })
  );

  const { isError, payload } = await call("woolworths_get_cart");

  assert.equal(isError, true);
  assert.equal(payload.success, false);
  assert.match(payload.error, /503 Service Unavailable\. upstream down/);
});

test("a thrown non-Error value still fills the error field", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw "socket hang up";
  });

  const { isError, payload } = await call("woolworths_get_product_details", { stockcode: 1 });

  assert.equal(isError, true);
  assert.deepEqual(payload, { success: false, error: "socket hang up" });
});

test("closing a browser that is not open is an isError result", async () => {
  const { isError, payload } = await call("woolworths_close_browser");

  assert.equal(isError, true);
  assert.deepEqual(payload, { success: false, error: "Browser is not open." });
});
