# Quick Start Guide

## Installation (30 seconds)

```bash
# Windows
install.bat

# macOS/Linux
chmod +x install.sh && ./install.sh
```

## Configuration (1 minute)

1. Open Claude Desktop config:
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

2. Add this configuration:

```json
{
  "mcpServers": {
    "woolworths": {
      "command": "node",
      "args": ["YOUR_PATH_HERE\\dist\\index.js"]
    }
  }
}
```

3. Replace `YOUR_PATH_HERE` with your actual project path

4. Restart Claude Desktop

## First Use (2 minutes)

### Step 1: Open the Browser

Say to Claude:

> "Open the Woolworths browser"

A Chrome window will open showing woolworths.com.au

### Step 2: Log In (Optional)

If you want your account's trolley:
- Log in manually in the browser window
- Otherwise, skip this step: browsing and an anonymous trolley work without logging in

### Step 3: Start Shopping! 🛒

Keep the browser open: every request is sent from its tab. Now you can:

> "Search for milk"

> "What's half price this week?"

> "Show me the fruit and vegetables category"

> "Add product 123456 to my cart"

> "Show me my cart"

### Step 4: Close Browser

When you are done, say to Claude:

> "Close the browser"

Shopping commands stop working until you open the browser again.

## Common Commands

| What you want | Say to Claude |
|---------------|---------------|
| Search products | "Search for [product name]" |
| View specials | "What's half price this week?" |
| Product details | "Get details for stockcode [number]" |
| Categories | "Show me the product categories" |
| Add to cart | "Add stockcode [number] to my cart" |
| View cart | "Show me my cart" |
| Remove from cart | "Remove stockcode [number] from cart" |

## Tips

- 💡 Keep the browser open while you shop: closing it stops every shopping command
- 🔄 If you get a 403 error, your session expired or the site refused the request - close and reopen the browser. Three refusals within a minute pause all requests for 5 minutes (`Woolworths is rate-limiting; retry in N min`)
- 🛍️ Log in if you want your account's trolley; otherwise the cart is an anonymous trolley kept by the browser
- 📦 Note the stockcode from search results to add items to cart

## Full Documentation

- `README.md` - Complete feature documentation
- `SETUP.md` - Detailed installation guide
- `PROJECT_SUMMARY.md` - Technical overview
- `woolworths-api-docs.md` - API reference

## Troubleshooting

**"Browser is not open"** → Run `woolworths_open_browser` first

**"The browser tab is not on https://www.woolworths.com.au"** → Navigate back to a www.woolworths.com.au page with `woolworths_navigate`

**"API request failed: 403"** → Session expired or refused: close and reopen the browser (headed), and log in again if needed. After three refusals within a minute the server stops sending for 5 minutes

**"Woolworths is rate-limiting; retry in N min"** → The site refused three requests within a minute, so nothing is sent until the minutes given have passed. Cached results are still served

**Server won't start** → Check you've run `pnpm run build`

## Support

For issues, check `SETUP.md` for detailed troubleshooting steps.

---

**That's it! You're ready to shop with AI! 🎉**

