# Woolworths MCP Server - Project Summary

## Overview

This is a fully functional Model Context Protocol (MCP) server that enables AI assistants to interact with Woolworths Australia's online shopping platform. The server uses browser automation to capture session cookies and then makes authenticated API calls to Woolworths' backend services.

## Key Features

### 🌐 Browser Automation
- Uses Puppeteer to launch and control a Chrome browser
- Navigates to Woolworths website
- Captures session cookies for API authentication
- Inspired by chrome-devtools-mcp architecture

### 🔐 Session Management
- Stores session cookies in memory
- Maintains authentication across multiple API calls
- Handles cookie expiration gracefully

### 🛒 Shopping Features
- **Product Search**: Search the entire Woolworths catalog
- **Product Details**: Get comprehensive information about specific items
- **Specials Browser**: View current deals and promotions
- **Category Explorer**: Navigate through product categories

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    MCP Client (Claude)                  │
└────────────────┬────────────────────────────────────────┘
                 │ stdio
                 │
┌────────────────▼────────────────────────────────────────┐
│              Woolworths MCP Server                      │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Browser Automation Layer (Puppeteer)            │  │
│  │  - Open browser                                  │  │
│  │  - Navigate to Woolworths                        │  │
│  │  - Capture cookies                               │  │
│  └──────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Cookie Management                               │  │
│  │  - Store session cookies                         │  │
│  │  - Attach to API requests                        │  │
│  └──────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────┐  │
│  │  API Tools                                       │  │
│  │  - Search products                               │  │
│  │  - Get product details                           │  │
│  │  - Browse specials                               │  │
│  │  - Get categories                                │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────┬────────────────────────────────────────┘
                 │ HTTPS
                 │
┌────────────────▼────────────────────────────────────────┐
│         Woolworths API (woolworths.com.au)              │
└─────────────────────────────────────────────────────────┘
```

## File Structure

```
Woolworths/
├── src/
│   └── index.ts              # Main server implementation
├── dist/                     # Compiled JavaScript (generated)
├── package.json              # Dependencies and scripts
├── tsconfig.json             # TypeScript configuration
├── README.md                 # User documentation
├── SETUP.md                  # Detailed setup guide
├── PROJECT_SUMMARY.md        # This file
├── install.bat               # Windows installation script
├── install.sh                # Unix installation script
├── .gitignore                # Git ignore rules
├── .npmrc                    # NPM configuration
└── claude_desktop_config.example.json  # Example config
```

## Tools Provided

| Tool | Purpose | Authentication |
|------|---------|----------------|
| `woolworths_open_browser` | Launch browser and navigate to Woolworths | None |
| `woolworths_navigate` | Navigate to specific URL | None |
| `woolworths_get_cookies` | Capture session cookies | None |
| `woolworths_close_browser` | Close browser window | None |
| `woolworths_search_products` | Search for products | Requires cookies |
| `woolworths_get_product_details` | Get detailed product info | Requires cookies |
| `woolworths_get_specials` | Browse current specials | Requires cookies |
| `woolworths_get_categories` | List product categories | Requires cookies |

## Technology Stack

- **Runtime**: Node.js 18+
- **Language**: TypeScript 5.5
- **MCP SDK**: @modelcontextprotocol/sdk ^1.0.4
- **Browser Automation**: Puppeteer ^23.0.0
- **HTTP Client**: node-fetch ^3.3.2

## API Endpoints Used

The server interacts with these Woolworths internal APIs:

1. **Search API**
   - Endpoint: `/apis/ui/Search/products`
   - Purpose: Product search functionality

2. **Product Detail API**
   - Endpoint: `/apis/ui/product/detail/{stockcode}`
   - Purpose: Get comprehensive product information

3. **Browse/Category API**
   - Endpoint: `/apis/ui/browse/category`
   - Purpose: Browse products by category and specials

4. **Categories API**
   - Endpoint: `/apis/ui/browse/categories`
   - Purpose: List all available categories

## Workflow

### Initial Setup
1. User runs `./install.sh` (macOS/Linux) or `install.bat` (Windows), which installs dependencies, downloads Chrome and builds the project
2. User configures MCP client (e.g., Claude Desktop)
3. User restarts MCP client

### Runtime Flow
1. **Browser Phase**:
   - User requests to open browser
   - Server launches Puppeteer browser
   - Browser navigates to Woolworths
   - User can manually log in if needed
   - Server captures all cookies
   - Browser closes (cookies persist in memory)

2. **API Phase**:
   - User requests product search/details/specials
   - Server attaches cookies to requests
   - Server calls Woolworths API
   - Server returns structured data to user

## Security Considerations

✅ **What's Secure:**
- Cookies stored only in memory (not persisted to disk)
- HTTPS for all external communications
- stdio transport (no network exposure)
- No hardcoded credentials

⚠️ **Limitations:**
- Cookies lost on server restart
- No encryption of in-memory data
- Relies on user's own Woolworths account

## Installation Methods

### Method 1: Automated (Windows)
```bash
install.bat
```

### Method 2: Automated (Unix/Mac)
```bash
chmod +x install.sh
./install.sh
```

### Method 3: Manual
```bash
pnpm install --frozen-lockfile
pnpm exec puppeteer browsers install chrome
pnpm run build
# Then configure Claude Desktop manually
```

## Configuration Example

For Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "woolworths": {
      "command": "node",
      "args": ["C:\\Users\\eglass\\Projects\\Woolworths\\dist\\index.js"]
    }
  }
}
```

## Common Use Cases

### 1. Price Comparison
Search for the same product to compare prices and sizes.

### 2. Shopping List
Build a shopping list by searching multiple products.

### 3. Deal Hunting
Browse current specials to find the best deals.

### 4. Product Research
Get detailed information about products including nutritional info, ingredients, etc.

### 5. Meal Planning
Search for ingredients and check availability.

## Error Handling

The server handles these error scenarios:

- **Browser not open**: Returns helpful error message
- **No cookies**: Prompts user to capture cookies first
- **API failures**: Returns error details with HTTP status
- **Network issues**: Gracefully handles timeouts and connection errors
- **Invalid stockcodes**: Returns appropriate error from API

## Future Enhancement Ideas

- [ ] Cookie persistence to file system (encrypted)
- [ ] Shopping cart management
- [ ] Order history retrieval
- [ ] Price tracking and alerts
- [ ] Recipe suggestions based on available products
- [ ] Nutritional analysis tools
- [ ] Multiple store location support
- [ ] Substitution suggestions

## Troubleshooting Quick Reference

| Issue | Solution |
|-------|----------|
| "Browser is not open" | Run `woolworths_open_browser` |
| "No session cookies" | Capture cookies with `woolworths_get_cookies` |
| "API request failed: 403" | Cookies expired - recapture them |
| Puppeteer won't install | Use Node 22 or 24, delete the puppeteer cache folder (`~/.cache/puppeteer/chrome`, or `%USERPROFILE%\.cache\puppeteer\chrome` on Windows) and re-run the install script |
| Server won't start | Check Node version (needs 18+) |

## Credits

Inspired by:
- [chrome-devtools-mcp](https://github.com/benjaminr/chrome-devtools-mcp) for browser automation approach
- Model Context Protocol specification by Anthropic
- Woolworths Australia online shopping platform

## License

MIT

## Support

For issues, questions, or contributions, refer to:
- `README.md` for user documentation
- `SETUP.md` for installation help
- `src/index.ts` for implementation details

---

**Created**: October 30, 2025
**Last Updated**: October 30, 2025
**Status**: ✅ Fully Functional

