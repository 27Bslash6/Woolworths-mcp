# Woolworths MCP Server

A Model Context Protocol (MCP) server for interacting with Woolworths Australia's online shopping platform. This server provides tools for browsing products, searching items, viewing specials, and more.

<a href="https://glama.ai/mcp/servers/@elijah-g/Woolworths-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@elijah-g/Woolworths-mcp/badge" alt="Woolworths Server MCP server" />
</a>

## Features

- **Browser Automation**: Uses Puppeteer to open a browser, navigate to Woolworths, and capture session cookies
- **Session Management**: Maintains session cookies for authenticated API requests
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

### 1. woolworths_open_browser

Opens a browser and navigates to the Woolworths website. This is typically the first step to establish a session.

**Parameters:**
- `headless` (boolean, optional): Whether to run in headless mode (default: false)

**Example:**
```json
{
  "headless": false
}
```

### 2. woolworths_navigate

Navigate to a specific URL on the Woolworths website. Only `https:` URLs whose host is `woolworths.com.au` or one of its subdomains are accepted; anything else is refused with an error naming the reason. If a redirect lands the page off woolworths.com.au, the tab is cleared to `about:blank` and the tool returns an error naming the final URL.

**Parameters:**
- `url` (string, required): The https URL on woolworths.com.au to navigate to

### 3. woolworths_get_cookies

Retrieves and stores session cookies from the current browser session. Run this after logging in or when you have an active session. It refuses to capture if the tab is no longer on an https woolworths.com.au page.

**Parameters:** None

### 4. woolworths_close_browser

Closes the browser instance while preserving the captured session cookies.

**Parameters:** None

### 5. woolworths_search_products

Search for products on Woolworths.

**Parameters:**
- `searchTerm` (string, required, non-empty): The product search term
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

### 7. woolworths_get_specials

Get current specials and deals from Woolworths.

**Parameters:**
- `category` (string, optional): Category filter (e.g., 'fruit-veg', 'meat-seafood')
- `pageSize` (integer, optional, 1 to 36): Number of results to return (default: 20)

### 8. woolworths_get_categories

Get the list of available product categories.

**Parameters:** None

### 9. woolworths_add_to_cart

Put a product in the shopping cart/trolley. This sets its quantity: if the product is already in the trolley, its quantity is replaced, not added to.

**Parameters:**
- `stockcode` (positive integer, required): The product stockcode/ID
- `quantity` (integer, optional, 1 or more): Quantity to put in the trolley (default: 1)

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

Update the quantity of a product in the shopping cart/trolley.

**Parameters:**
- `stockcode` (positive integer, required): The product stockcode/ID
- `quantity` (integer, required, 0 or more): New quantity

## Typical Workflow

1. **Open Browser**: Use `woolworths_open_browser` to launch a browser window
2. **Log In** (if needed): The browser will open in non-headless mode by default, allowing you to manually log in to your Woolworths account if required
3. **Capture Cookies**: Use `woolworths_get_cookies` to capture session cookies
4. **Close Browser**: Use `woolworths_close_browser` to close the browser (cookies are preserved)
5. **Use API Tools**: Now you can use any of the API tools (search, get product details, etc.)

## Example Usage Scenario

```
1. User: "Open the Woolworths browser"
   → Calls: woolworths_open_browser
   
2. User manually logs in on the opened browser (if needed)

3. User: "Get the session cookies"
   → Calls: woolworths_get_cookies
   
4. User: "Close the browser"
   → Calls: woolworths_close_browser
   
5. User: "Search for bananas"
   → Calls: woolworths_search_products with searchTerm="bananas"
   
6. User: "What are the current specials?"
   → Calls: woolworths_get_specials

7. User: "Add product 123456 to my cart"
   → Calls: woolworths_add_to_cart with stockcode=123456

8. User: "Show me my cart"
   → Calls: woolworths_get_cart
```

## Technical Details

### Browser Automation

The server uses Puppeteer to:
- Launch a Chromium browser instance
- Navigate to Woolworths website
- Capture cookies from the browser session
- Maintain user agent and browser fingerprint

### API Integration

Once cookies are captured, the server makes authenticated requests to Woolworths' internal APIs:
- Search API: `/apis/ui/Search/products` (POST)
- Product Detail API: `/apis/ui/product/detail/{stockcode}`
- Browse/Category API: `/apis/ui/browse/category`
- Categories API: `/apis/ui/PiesCategoriesWithSpecials`
- Shopping Cart API: `/apis/ui/Trolley` (GET, cart contents) and `/api/v3/ui/trolley/update` (POST; add, update, and remove with quantity 0)

### Session Management

Session cookies are stored in memory for the duration of the server process. If the server restarts, you'll need to recapture cookies by opening the browser again.

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

The tests stub `fetch` and `puppeteer.launch`, so they never reach the network or start a browser. `test/fixtures/search-milk.json` is a recorded search response, cut to 8 results, with ad ids and tracking tokens removed.

## Requirements

- Node.js 22 or 24
- pnpm 11
- Chromium/Chrome (automatically installed by Puppeteer)

## Notes

- The browser opens in non-headless mode by default to allow for manual login
- Session cookies are stored in memory and persist until the server is restarted
- API endpoints are based on Woolworths' public web interface and may change
- Always respect Woolworths' Terms of Service when using this tool

## Troubleshooting

### Browser won't open
- Check that Puppeteer installed correctly
- Try running with headless: true if display issues occur

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
- Ensure you've captured cookies with `woolworths_get_cookies`
- Check that the session hasn't expired (you may need to re-open browser and capture new cookies)
- Verify the API endpoints are still valid

### Connection issues
- Ensure you have a stable internet connection
- Check that Woolworths website is accessible from your location

## License

GPL-3.0. See [LICENSE](LICENSE).

## Disclaimer

This is an unofficial tool and is not affiliated with or endorsed by Woolworths Group Limited. Use at your own risk and ensure compliance with Woolworths' Terms of Service.