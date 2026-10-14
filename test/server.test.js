// Offline tests: fetch is stubbed and no browser is launched. Run `pnpm test` (builds dist/ first).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, setSessionCookies } from "../dist/server.js";

const readJson = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
const toolNames = readJson("./tool-names.json");
// One recorded search for "milk", cut to 8 results, with ad ids and tracking tokens removed.
const searchFixture = readJson("./fixtures/search-milk.json");
// One recorded anonymous trolley holding stockcode 50923 at quantity 1; it carries no session identifiers.
const trolleyFixture = readJson("./fixtures/trolley.json");

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
  const fields = ["Stockcode", "DisplayName", "Brand", "PackageSize", "Price", "WasPrice", "IsOnSpecial", "CupString", "Unit", "IsAvailable"];
  for (const product of payload.products) {
    assert.deepEqual(Object.keys(product), fields);
  }
  const rawSize = JSON.stringify(searchFixture.Products).length;
  const slimSize = JSON.stringify(payload.products).length;
  t.diagnostic(`raw Products ${(rawSize / 1024).toFixed(1)} KB, slim products ${(slimSize / 1024).toFixed(1)} KB`);
  assert.ok(slimSize < rawSize);
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

test("add_to_cart never writes when the trolley read has no items array", async (t) => {
  const { AvailableItems: _, ...noItems } = trolleyFixture;
  const requests = stubTrolley(t, noItems);

  const { isError, payload } = await call("woolworths_add_to_cart", { stockcode: 50923, quantity: 1 });

  assert.equal(isError, true);
  assert.match(payload.error, /AvailableItems/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");
});
