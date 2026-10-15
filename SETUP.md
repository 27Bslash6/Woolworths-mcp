# Setup Guide for Woolworths MCP Server

## Quick Start

Follow these steps to get the Woolworths MCP server up and running:

### 1. Install Dependencies

Run `./install.sh` (macOS/Linux) or `install.bat` (Windows). It runs these steps, which you can also run by hand (install pnpm with `corepack enable pnpm` on Node 22 or 24):

```bash
pnpm install --frozen-lockfile
pnpm exec puppeteer browsers install chrome
pnpm run build
```

This will install:
- `@modelcontextprotocol/sdk` - MCP SDK for building the server
- `puppeteer` - Browser automation: every API request is sent from the open browser tab
- TypeScript and type definitions

### 2. Build the Project

The install script already does this. To rebuild by hand:

```bash
pnpm run build
```

This compiles the TypeScript code in `src/` to JavaScript in `dist/`.

### 3. Configure Claude Desktop (or your MCP client)

#### For Claude Desktop:

1. Locate your Claude Desktop config file:
   - **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Linux**: `~/.config/Claude/claude_desktop_config.json`

2. Edit the file and add the Woolworths server configuration:

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

**Important**: Update the path in `args` to match your actual installation directory!

3. Restart Claude Desktop

### 4. Verify Installation

After restarting Claude Desktop, you should see the Woolworths tools available. Try asking:

> "What Woolworths tools do you have available?"

You should see 12 tools listed:
- woolworths_open_browser
- woolworths_navigate
- woolworths_get_cookies
- woolworths_close_browser
- woolworths_search_products
- woolworths_get_product_details
- woolworths_get_specials
- woolworths_get_categories
- woolworths_add_to_cart
- woolworths_get_cart
- woolworths_remove_from_cart
- woolworths_update_cart_quantity

## First Time Usage

### Opening a Session

The first thing you need to do is open the browser. Every API tool sends its request from that browser tab, so keep it open while you use them:

1. **Open the browser**:
   ```
   "Open the Woolworths browser"
   ```
   
   A Chrome browser window will open and navigate to woolworths.com.au

2. **Log in (if needed)**:
   - If you want your account's trolley, log in manually in the browser window
   - If you just want to browse products, you can skip this step. Without logging in, the cart is an anonymous trolley that the browser keeps between calls

3. **Use the API tools**:
   With the browser still open, search products, view specials, etc.:
   ```
   "Search for milk"
   "What's half price this week?"
   "Show me the fruit and veg category"
   ```

4. **Close browser** when you are done:
   ```
   "Close the browser"
   ```
   
   API tools return an error until you open the browser again

## Example Conversations

### Shopping List Search

```
User: Open the Woolworths browser
Assistant: [Opens browser]

User: Search for bread
Assistant: [Returns list of bread products with prices]

User: Search for milk
Assistant: [Returns list of milk products]

User: What's half price this week?
Assistant: [Returns half-price specials]

User: Close the browser
Assistant: [Closes browser]
```

### Product Research

```
User: Open Woolworths browser
Assistant: [Opens browser]

User: Search for organic bananas
Assistant: [Returns organic banana products]

User: Get details for stockcode 123456
Assistant: [Returns detailed product information]

User: Close it
Assistant: [Closes browser]
```

## Troubleshooting

### "Browser is not open" Error

**Problem**: You called a tool that needs the browser, such as a search, but the browser isn't open. Nothing was sent.

**Solution**: Run `woolworths_open_browser` first, and keep it open while you use the API tools.

### "The browser tab is not on https://www.woolworths.com.au" Error

**Problem**: The tab is on another origin (another site, a woolworths.com.au subdomain, or http). API calls run only from `https://www.woolworths.com.au`, so nothing was sent.

**Solution**: Use `woolworths_navigate` to return to a www.woolworths.com.au page, then try again.

### "API request failed: 403" Error

**Problem**: The session has expired, or the site refused the request. The error gives the status, status text, content type and size of the response, never its body.

**Solution**: Close the browser and open it again (headed), and log in again if needed.

### Puppeteer Install Issues

**Problem**: Puppeteer fails to install or can't find Chrome.

**Solution**: Use Node 22 or 24, delete the puppeteer cache folder (`~/.cache/puppeteer/chrome`, or `%USERPROFILE%\.cache\puppeteer\chrome` on Windows) and re-run the install script.

Or set a custom Chrome path:
```bash
export PUPPETEER_EXECUTABLE_PATH=/path/to/chrome
```

### Server Won't Start

**Problem**: Error when running `pnpm start`.

**Solution**:
1. Make sure you've built the project: `pnpm run build`
2. Check that `dist/index.js` exists
3. Check Node.js version (requires 22 or 24): `node --version`

## Development Tips

### Watch Mode

For development, use watch mode to auto-recompile on changes:

```bash
pnpm run dev
```

Keep this running in one terminal, and start the server in another terminal.

### Testing Changes

After making changes:

1. Stop the MCP server (restart Claude Desktop)
2. Rebuild: `pnpm run build`
3. Start Claude Desktop again

### Debugging

The server logs errors to stderr. You can see these in:
- Claude Desktop: Check the developer console (if available)
- Terminal: Run the server directly with `node dist/index.js` and watch output

## Advanced Configuration

### Headless Mode

If you don't need to see the browser, you can use headless mode. Headed (the default) is recommended: in headless mode Chrome reports `HeadlessChrome` in its user agent, and the site may refuse it.

```json
{
  "headless": true
}
```

### Custom User Data Directory

To persist browser data between sessions, modify the Puppeteer launch options in `src/server.ts`:

```typescript
const launched = await puppeteer.launch({
  // ...the existing options...
  userDataDir: './browser-data',
});
```

## Security Notes

- **Cookies in the Browser**: The server keeps no cookies of its own. API requests use the browser's cookies, which are lost when the browser closes or the server restarts
- **No Persistence**: This server doesn't save any data to disk (except for build artifacts)
- **HTTPS Only**: All communication with Woolworths uses HTTPS
- **Local Only**: The server only accepts connections via stdio (local only, no network exposure)

## Next Steps

Now that you have the server running, you can:

1. Browse the Woolworths catalog
2. Search for products
3. Check current specials
4. Get detailed product information
5. Explore categories

Enjoy shopping with AI assistance! 🛒

