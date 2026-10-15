# Woolworths MCP Server

A Model Context Protocol (MCP) server for interacting with Woolworths Australia's online shopping platform. This server provides tools for browsing products, searching items, viewing specials, and more.

<a href="https://glama.ai/mcp/servers/@elijah-g/Woolworths-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@elijah-g/Woolworths-mcp/badge" alt="Woolworths Server MCP server" />
</a>

## Features

- **Browser Automation**: Uses Puppeteer to open a browser and navigate to Woolworths, where you can log in manually
- **Session Management**: Sends every API request from the open browser tab, with the browser's own cookies and headers
- **Product Search**: Search for products across the Woolworths catalog with filtering and sorting
- **Product Details**: Get detailed information about specific products
- **Specials & Deals**: Browse current specials and promotional offers
- **Category Browsing**: Explore product categories
- **Shopping Cart**: Add items to cart, view cart contents, update quantities, and remove items

## Installation

Run the install script: `./install.sh` (macOS/Linux) or `install.bat` (Windows).

It installs the pinned dependencies from `pnpm-lock.yaml` without running package install scripts, downloads Chrome for Puppeteer, and builds the TypeScript code. To run the same steps by hand (install pnpm with `corepack enable pnpm` on Node 22 or 24):

```bash
pnpm install --frozen-lockfile
pnpm exec puppeteer browsers install chrome
pnpm run build
```

## Usage

### Running the Server

The MCP server runs on stdio and is designed to be used with MCP-compatible clients (like Claude Desktop, Cline, or other AI assistants).

```bash
pnpm start
```

### Configuration for Claude Desktop

Add this to your Claude Desktop configuration file:

**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "woolworths": {
      "command": "node",
      "args": ["/path/to/Woolworths-mcp/dist/index.js"]
    }
  }
}
```

Make sure to update the path to match your installation directory. On Windows, write it with escaped backslashes, for example `"C:\\path\\to\\Woolworths-mcp\\dist\\index.js"`.

## Available Tools

Every tool returns JSON text. When a call fails, the result has `isError: true` and the payload `{ "success": false, "error": "<reason>" }`.

The API tools (5 to 12) send their requests from the browser tab that `woolworths_open_browser` opens, so they need it open. With the browser closed, each returns an error telling you to open it, and sends nothing.

### 1. woolworths_open_browser

Opens a browser and navigates to the Woolworths website. This is the first step: every API tool sends its request from this browser tab, so keep it open while you use them.

**Parameters:**
- `headless` (boolean, optional): Whether to run in headless mode (default: false). Headed is recommended: in headless mode Chrome reports `HeadlessChrome` in its user agent, and the site may refuse it.

**Example:**
```json
{
  "headless": false
}
```

### 2. woolworths_navigate

Navigate to a specific URL on the Woolworths website. Only `https:` URLs whose host is `woolworths.com.au` or one of its subdomains are accepted; anything else is refused with an error naming the reason. If a redirect lands the page off woolworths.com.au, the tab is cleared to `about:blank` and the tool returns an error naming the final URL.

The API tools only run while the tab is on `https://www.woolworths.com.au`. After visiting a subdomain, navigate back to a www.woolworths.com.au page before using them.

**Parameters:**
- `url` (string, required): The https URL on woolworths.com.au to navigate to

### 3. woolworths_get_cookies

Lists the names and attributes (`domain`, `path`, `secure`, `httpOnly`) of the current browser session's cookies, never their values. It is optional and informational: no API tool needs it to have run. It refuses if the tab is no longer on an https woolworths.com.au page.

**Parameters:** None

### 4. woolworths_close_browser

Closes the browser instance. API tools fail until you open the browser again with `woolworths_open_browser`.

**Parameters:** None

### 5. woolworths_search_products

Search for products on Woolworths.

**Parameters:**
- `searchTerm` (string, required, non-empty): The product search term. It is trimmed, lower-cased and its inner spaces collapsed before it is sent, so `Milk ` and `milk` are the same search
- `pageNumber` (integer, optional, 1 or more): Page number (default: 1)
- `pageSize` (integer, optional, 1 to 36): Number of results to return (default: 36)
- `sortType` (string, optional): Sort order, one of `TraderRelevance`, `PriceAsc`, `PriceDesc` or `Name` (default: `TraderRelevance`)
- `isSpecial` (boolean, optional): Return only products on special (default: false)

**Returns:** `totalResults`, `pagination` and `products`. Each product carries only these fields from the Woolworths response: `Stockcode`, `DisplayName`, `Brand`, `PackageSize`, `Price`, `WasPrice`, `IsOnSpecial`, `CupString`, `Unit` and `IsAvailable`. Pass `Stockcode` to the product detail and cart tools; `woolworths_get_product_details` returns everything else.

**Example:**
```json
{
  "searchTerm": "milk",
  "pageSize": 20
}
```

### 6. woolworths_get_product_details

Get detailed information about a specific product by its stockcode.

**Parameters:**
- `stockcode` (positive integer, required): The product stockcode/ID

**Returns:** `product`, the Woolworths product record (`Product`, `NutritionalInformation`, `AdditionalAttributes` and the rest), about 30 KB. Fields that describe your session rather than the product are dropped: `Product.IsInTrolley`, `Product.QuantityInTrolley`, `Product.IsPersonalisedByPurchaseHistory`, `Product.HasBeenBoughtBefore`, `Product.Diagnostics`, `DiagnosticsData` and `RichRelevancePlacements`. A stockcode with no product is an error.

### 7. woolworths_get_specials

Get a page of current specials, the listing the site's own specials pages show. Pass a `category`, `halfPrice: true`, or both: the site has no store-wide listing of every special.

**Parameters:**
- `category` (string, optional): NodeId of a top-level category from `woolworths_get_categories`, e.g. `1-E5BEE36E` (Fruit & Veg) or `1_39FD49C` (Pantry). Returns that category's Specials & Offers listing, which can include multibuy offers not marked `IsOnSpecial`. A subcategory NodeId is not a specials listing; use its top-level parent.
- `halfPrice` (boolean, optional): Only half-price specials (default: false). Without a `category`, returns half-price specials across the store.
- `pageNumber` (integer, optional, 1 or more): Page number (default: 1)
- `pageSize` (integer, optional, 1 to 36): Number of results to return (default: 36)

**Returns:** `totalResults`, `pageNumber`, `pageSize` and `products`, with the same fields per product as `woolworths_search_products`.

**Example:**
```json
{
  "category": "1_39FD49C",
  "halfPrice": true
}
```

### 8. woolworths_get_categories

Get the product categories: each top-level category with its subcategories, as `NodeId`, `Description` and `UrlFriendlyName`. The specials listings in the site's tree are left out; pass a top-level `NodeId` to `woolworths_get_specials` instead.

**Parameters:** None

### 9. woolworths_add_to_cart

Add a product to the shopping cart/trolley. The quantity is added to any quantity already in the trolley: the tool reads the trolley, then sets the current quantity plus the requested one. If the trolley read fails, nothing is written. To set an exact quantity, use `woolworths_update_cart_quantity`.

**Parameters:**
- `stockcode` (positive integer, required): The product stockcode/ID
- `quantity` (integer, optional, 1 or more): Quantity to add (default: 1)

**Example:**
```json
{
  "stockcode": 123456,
  "quantity": 2
}
```

### 10. woolworths_get_cart

Get the current contents of the shopping cart/trolley.

**Parameters:** None

### 11. woolworths_remove_from_cart

Remove a product from the shopping cart/trolley.

**Parameters:**
- `stockcode` (positive integer, required): The product stockcode/ID to remove

### 12. woolworths_update_cart_quantity

Set the quantity of a product in the shopping cart/trolley. It replaces any quantity already there; 0 removes the product.

**Parameters:**
- `stockcode` (positive integer, required): The product stockcode/ID
- `quantity` (integer, required, 0 or more): New quantity

## Typical Workflow

1. **Open Browser**: Use `woolworths_open_browser` to launch a browser window
2. **Log In** (if needed): The browser will open in non-headless mode by default, allowing you to manually log in to your Woolworths account if you want your account's trolley. Log in, and pick your store, before the first API tool call: the store is read once per browser session (see [Cache](#cache)). If you log in or change store later, close and reopen the browser
3. **Use API Tools**: Use any of the API tools (search, get product details, cart, etc.). Keep the browser open: each request is sent from its tab
4. **Close Browser**: Use `woolworths_close_browser` when you are done. API tools fail until the browser is reopened

## Example Usage Scenario

```
1. User: "Open the Woolworths browser"
   → Calls: woolworths_open_browser
   
2. User manually logs in on the opened browser (if needed)

3. User: "Search for bananas"
   → Calls: woolworths_search_products with searchTerm="bananas"
   
4. User: "What's half price this week?"
   → Calls: woolworths_get_specials with halfPrice=true

5. User: "Add product 123456 to my cart"
   → Calls: woolworths_add_to_cart with stockcode=123456

6. User: "Show me my cart"
   → Calls: woolworths_get_cart

7. User: "Close the browser"
   → Calls: woolworths_close_browser
```

## Technical Details

### Browser Automation

The server uses Puppeteer to:
- Launch a Chromium browser instance
- Navigate to Woolworths website
- Send each API request with `fetch` from inside the open tab

### API Integration

Each API tool sends its request from the open browser tab, so the browser supplies its own user agent, cookies and fetch headers. The server sets no user agent of its own. Requests go to Woolworths' internal APIs:
- Search API: `/apis/ui/Search/products` (POST)
- Product Detail API: `/apis/ui/product/detail/{stockcode}` (GET)
- Specials Browse API: `/apis/ui/browse/category` (POST; `categoryId` selects the specials listing)
- Categories API: `/apis/ui/PiesCategoriesWithSpecials` (GET)
- Shopping Cart API: `/apis/ui/Trolley` (GET, cart contents) and `/api/v3/ui/trolley/update` (POST; sets a product's quantity, 0 removes it)

### Session Management

The session lives in the browser. The server keeps no cookies of its own: API requests use the tab's cookies, and the browser keeps any cookies a response sets, so an anonymous trolley persists between calls. Closing the browser, or restarting the server, ends the session; open the browser again (and log in again if needed) to start a new one.

API calls run only while the tab is on exactly `https://www.woolworths.com.au`. If it is on any other origin (another site, a subdomain, or http), the call fails with an error saying so and nothing is sent; use `woolworths_navigate` to return to a www.woolworths.com.au page. A failed response (not 2xx, or a 200 that is not JSON) is reported as its status, status text, content type and size in bytes, never its body. A 200 without the data a tool reads (a search with no product list, a product detail with no `Product`) is an error starting `Unexpected Woolworths response`, never an empty result.

### Pacing, timeout and rate limiting

Woolworths' bot protection blocks a client that sends requests in a burst, and then holds its requests open. So the server paces and bounds every API request, the cart's included:

- **Pacing:** requests go out one at a time, about one a second. Each starts after the previous one finished, and at least 1 second plus up to 0.5 seconds of random jitter after it started. Concurrent tool calls wait their turn.
- **Timeout:** a request with no answer in 15 seconds is cancelled and the tool returns `Woolworths did not respond in time`. For a cart change the error says the change may have been applied: check `woolworths_get_cart` before retrying.
- **Rate limiting:** three refusals within a minute (a 403, 429 or 5xx, a timeout, a network failure, or a 200 that is not the expected JSON) stop all requests for 5 minutes. Meanwhile every call that would send a request returns `Woolworths is rate-limiting; retry in N min` and sends nothing. Cached category results are still served; cached search, product and specials results are served only if this browser session read its store before the 5 minutes began (see [Cache](#cache)). After the 5 minutes one request is let through: if it succeeds, requests resume, and if it is refused, the wait starts again. A 404 or 400, such as an unknown stockcode, does not count.

The server never retries a request by itself: a retry would only add to the requests the bot protection counts.

### Cache

Search, product detail, specials and category results are cached on disk with [CacheKit](https://github.com/cachekit-io/cachekit-ts), so a repeated call, even after a restart, does not fetch the result again:

| Tool | Kept for | Keyed on |
|---|---|---|
| `woolworths_search_products` | 30 minutes | store, catalogue week, search term, page, page size, sort, specials only |
| `woolworths_get_product_details` | 6 hours | store, catalogue week, stockcode |
| `woolworths_get_specials` | 24 hours | store, catalogue week, category, half price, page, page size |
| `woolworths_get_categories` | 7 days | nothing (the same for every store) |

The store is the one your session's cookies select. The server reads it from Woolworths once per browser session, on the first search, product or specials call, and keeps only its number, in memory. The catalogue week starts on Wednesday at 00:00 Sydney time, when prices and specials change. A failed call caches nothing.

The trolley (`woolworths_get_cart` and every cart change), the store lookup's response and cookies are never cached.

The cache is in `$XDG_CACHE_HOME/woolworths-mcp` (or `~/.cache/woolworths-mcp`) on Linux and macOS, and in `%LOCALAPPDATA%\woolworths-mcp` on Windows. Set `WOOLWORTHS_MCP_CACHE_DIR` in the server's environment to use another directory. To clear the cache, stop the server and delete that directory.

## Development

### Watch Mode

For development with auto-recompilation:

```bash
pnpm run dev
```

### Building

```bash
pnpm run build
```

### Lint and tests

```bash
pnpm run lint   # Oxlint, type-aware
pnpm test       # builds, then runs the offline tests in test/ with node:test
```

The tests stub `puppeteer.launch` with fake browsers (`test/fake-browser.js`), and point the cache at a fresh temporary directory, never your own. The fake tab runs the server's real in-page request function in Node with `globalThis.fetch` stubbed, so the tests never reach the network or start a browser. `test/fixtures/` holds one recorded response per endpoint the read tools call (search, specials, product detail, categories), cut to a few results, with ad ids and tracking tokens removed.

## Requirements

- Node.js 22 or 24
- pnpm 11
- One of the five platforms CacheKit ships its native addon for, the only ones the server starts on: Linux x64 or arm64 (glibc), macOS x64 or arm64 (Intel or Apple silicon), or Windows x64
- Chromium/Chrome (automatically installed by Puppeteer)

## Notes

- The browser opens in non-headless mode by default to allow for manual login
- API tools need the browser open; the session's cookies live in the browser, not the server
- API endpoints are based on Woolworths' public web interface and may change
- Always respect Woolworths' Terms of Service when using this tool

## Troubleshooting

### Browser won't open
- Check that Puppeteer installed correctly
- Try running with headless: true if display issues occur (the site may refuse headless Chrome)

### `No usable sandbox!` on Linux
Chromium always runs with its sandbox enabled; Puppeteer's `PUPPETEER_DANGEROUS_NO_SANDBOX` is ignored, and a launch that ends up with the sandbox disabled is refused. Linux distributions that restrict unprivileged user namespaces (Ubuntu 23.10 and later, via AppArmor) only grant them to specific browser binaries by path, such as the installed Google Chrome at `/opt/google/chrome/chrome`. The Chrome for Testing build that Puppeteer downloads is not covered, so it aborts at launch with `FATAL ... No usable sandbox!`.

Install Google Chrome and point Puppeteer at it with `PUPPETEER_EXECUTABLE_PATH` in your MCP client config:

```json
{
  "mcpServers": {
    "woolworths": {
      "command": "node",
      "args": ["/path/to/Woolworths-mcp/dist/index.js"],
      "env": {
        "PUPPETEER_EXECUTABLE_PATH": "/opt/google/chrome/chrome"
      }
    }
  }
}
```

Puppeteer only guarantees compatibility with the Chrome version it bundles, so a much newer system Chrome may need a Puppeteer upgrade.

### API requests fail
- Ensure the browser is open (`woolworths_open_browser`); with it closed, every API tool returns an error and sends nothing
- If the error says the tab is not on https://www.woolworths.com.au, use `woolworths_navigate` to return to a www.woolworths.com.au page
- If the session has expired, close and reopen the browser, and log in again if needed
- `Woolworths is rate-limiting; retry in N min` means the site refused three requests within a minute. Wait the minutes it gives; reopening the browser does not shorten the wait, and a reopened browser serves no cached search, product or specials results until it ends
- `Woolworths did not respond in time` means a request got no answer in 15 seconds, often the start of a block. Slow down, and reopen the browser if it keeps happening
- Verify the API endpoints are still valid

### Connection issues
- Ensure you have a stable internet connection
- Check that Woolworths website is accessible from your location

## License

GPL-3.0. See [LICENSE](LICENSE).

## Disclaimer

This is an unofficial tool and is not affiliated with or endorsed by Woolworths Group Limited. Use at your own risk and ensure compliance with Woolworths' Terms of Service.