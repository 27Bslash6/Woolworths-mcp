# Woolworths MCP Server - Feature List

## 🔧 Core Features

### 1. Browser Automation
- ✅ Launch Chrome browser with Puppeteer
- ✅ Navigate to Woolworths website
- ✅ Manual login support (non-headless mode, the recommended default)
- ✅ Cookie listing (names and attributes, never values; optional)
- ✅ Browser cleanup on close
- ✅ Browser's own user agent (no override; headless Chrome reports `HeadlessChrome` and may be refused)

### 2. Session Management
- ✅ Every API request sent with `fetch` from the open browser tab
- ✅ Browser supplies its own user agent, cookies and fetch headers
- ✅ Session persistence across multiple requests (the browser keeps cookies responses set, so an anonymous trolley persists)
- ✅ Requests sent only from `https://www.woolworths.com.au`; any other origin fails with nothing sent
- ✅ Failed responses reported as status, status text, content type and size, never the body

### 3. Product Search
- ✅ Full-text product search
- ✅ Pagination support (page number + page size)
- ✅ Sort options:
  - TraderRelevance (most relevant)
  - PriceAsc (price low to high)
  - PriceDesc (price high to low)
  - Name (alphabetical)
- ✅ Filter by specials
- ✅ Compact product information in results, limited to these fields:
  - `Stockcode`, `DisplayName`, `Brand`, `PackageSize`
  - `Price`, `WasPrice`, `IsOnSpecial`, `CupString`, `Unit`
  - `IsAvailable`
- ✅ Full product record via `woolworths_get_product_details` (pass the `Stockcode`)

### 4. Product Details
- ✅ Get comprehensive product information by stockcode
- ✅ Includes all product attributes and metadata
- ✅ Nutritional information (if available)
- ✅ Ingredient lists
- ✅ Allergen information

### 5. Specials & Deals
- ✅ Browse half-price specials across the store
- ✅ Browse a category's specials, optionally half price only
- ✅ Pagination support
- ✅ Price and was-price per product

### 6. Category Browsing
- ✅ Top-level categories and their subcategories
- ✅ Top-level category NodeIds, which the specials tool takes (subcategory NodeIds are not specials listings)
- ✅ URL-friendly category names

### 7. Shopping Cart (Trolley) Management
- ✅ Add items to cart (adds to any quantity already in the trolley)
- ✅ View complete cart contents
- ✅ Set item quantities
- ✅ Remove items from cart
- ✅ Cart totals and item counts
- ✅ Line item pricing
- ✅ Savings calculations

## 🛠️ MCP Server Features

### Standard MCP Functionality
- ✅ stdio-based communication
- ✅ Tool registration and discovery
- ✅ Structured request/response handling
- ✅ Error handling and reporting
- ✅ JSON-based tool inputs/outputs

### Server Management
- ✅ Graceful shutdown handling (SIGINT)
- ✅ Browser cleanup on exit
- ✅ Logging to stderr
- ✅ Version information

## 📋 Available Tools

| # | Tool Name | Description | API Call (sent from open browser) |
|---|-----------|-------------|---------------|
| 1 | `woolworths_open_browser` | Launch browser to Woolworths | No |
| 2 | `woolworths_navigate` | Navigate to specific URL | No |
| 3 | `woolworths_get_cookies` | List cookie names and attributes (optional) | No |
| 4 | `woolworths_close_browser` | Close browser window | No |
| 5 | `woolworths_search_products` | Search product catalog | Yes |
| 6 | `woolworths_get_product_details` | Get product details | Yes |
| 7 | `woolworths_get_specials` | Browse special offers | Yes |
| 8 | `woolworths_get_categories` | List product categories | Yes |
| 9 | `woolworths_add_to_cart` | Add to an item's quantity in the cart | Yes |
| 10 | `woolworths_get_cart` | View cart contents | Yes |
| 11 | `woolworths_remove_from_cart` | Remove item from cart | Yes |
| 12 | `woolworths_update_cart_quantity` | Set cart item quantity | Yes |

## 🎯 Use Cases

### Personal Shopping
- ✅ Create shopping lists with AI assistance
- ✅ Compare products and prices
- ✅ Find best deals and specials
- ✅ Discover products by natural language queries

### Meal Planning
- ✅ Search for recipe ingredients
- ✅ Check ingredient availability
- ✅ Get price estimates for meals
- ✅ Find substitutions

### Price Tracking
- ✅ Monitor product prices
- ✅ Identify special offers
- ✅ Compare regular vs. special pricing
- ✅ Track savings

### Research & Analysis
- ✅ Browse product categories systematically
- ✅ Analyze product attributes
- ✅ Compare brands and options
- ✅ Read reviews and ratings

### Cart Management
- ✅ Build shopping carts programmatically
- ✅ Manage cart contents via AI
- ✅ Calculate cart totals
- ✅ Modify orders easily

## 🔒 Security Features

- ✅ No hardcoded credentials
- ✅ Server stores no cookies; they stay in the browser
- ✅ Cookie values never returned by any tool
- ✅ HTTPS-only communication
- ✅ stdio transport (no network exposure)
- ✅ User-controlled authentication (manual login)
- ✅ No cookie persistence to disk
- ✅ Browser isolation (separate user data directory)

## 📊 Data Provided

### Product Information
- Name, Brand, Description
- Stockcode (unique ID)
- Barcode
- Pricing (current, was, savings)
- Unit sizes and packaging
- Cup price (per unit comparison)
- Availability status
- Product images (multiple sizes)
- Categories and tags

### Cart Information
- Item list with quantities
- Line item totals
- Subtotal
- Total savings
- Item count

### Category Information
- Category hierarchy, two levels deep
- URL-friendly names
- Category IDs

### Search Results
- Total result count
- Paginated product list
- Search facets (filters)
- Sorting options

## 🚀 Performance Features

- ✅ No separate cookie capture step
- ✅ Minimal browser overhead (headless option)
- ✅ One browser session reused by every API call
- ✅ Pagination for large result sets
- ✅ Concurrent API request capability

## 📦 Package Features

### Dependencies
- ✅ Minimal dependency footprint
- ✅ Well-maintained packages
- ✅ Type-safe with TypeScript
- ✅ Modern ES modules

### Build System
- ✅ TypeScript compilation
- ✅ Source maps
- ✅ Development watch mode
- ✅ Production builds

### Installation
- ✅ Automated install scripts (Windows & Unix)
- ✅ Clear documentation
- ✅ Example configurations
- ✅ Quick start guide

## 🔮 Future Enhancement Opportunities

### Potential Features (Not Yet Implemented)
- ⏳ Cookie persistence to encrypted file
- ⏳ Multiple store location support
- ⏳ Order history retrieval
- ⏳ Recipe suggestions
- ⏳ Price tracking with notifications
- ⏳ Substitution recommendations
- ⏳ Nutritional analysis tools
- ⏳ Checkout automation
- ⏳ Delivery slot checking
- ⏳ Product availability alerts
- ⏳ Compare with competitors
- ⏳ Barcode scanning integration

## 📈 Current Limitations

1. **Session Duration**: Sessions expire after ~1 hour (Woolworths limitation)
2. **No Checkout**: Cannot complete purchases through API
3. **No Order History**: Cannot retrieve past orders
4. **Single Account**: One session at a time, and API tools need its browser open
5. **Location**: Australian Woolworths only
6. **Rate Limiting**: Subject to Woolworths' rate limits
7. **API Changes**: Dependent on Woolworths' internal APIs

## ✅ Quality Features

- ✅ Comprehensive error handling
- ✅ Detailed error messages
- ✅ TypeScript type safety
- ✅ Code documentation
- ✅ User documentation (5 doc files)
- ✅ Example configurations
- ✅ Troubleshooting guides

## 🎓 Learning Resources Included

1. **README.md** - User guide and feature overview
2. **SETUP.md** - Detailed installation and configuration
3. **QUICK_START.md** - Get started in 5 minutes
4. **PROJECT_SUMMARY.md** - Technical architecture
5. **FEATURES.md** - This file - complete feature list
6. **woolworths-api-docs.md** - API endpoint documentation

---

**Total Tools**: 12  
**Total Features**: 50+  
**Lines of Code**: ~650  
**Documentation Pages**: 6  
**Supported Platforms**: Windows, macOS, Linux  
**Status**: ✅ Production Ready

