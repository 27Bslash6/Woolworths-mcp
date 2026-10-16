# Testing Guide for Woolworths MCP Server

## Manual Testing Checklist

### Prerequisites
- [ ] Node.js 22 or 24 installed
- [ ] pnpm 11 installed
- [ ] Project built (`pnpm run build`)
- [ ] Claude Desktop configured with server

## Test Suite

### 1. Installation Tests

#### Test 1.1: Dependencies Install
```bash
pnpm install --frozen-lockfile
pnpm exec puppeteer browsers install chrome
```
**Expected**: All dependencies install without errors

#### Test 1.2: TypeScript Compilation
```bash
pnpm run build
```
**Expected**: 
- No TypeScript errors
- `dist/` directory created
- `dist/index.js` exists

### 2. Browser Automation Tests

#### Test 2.1: Open Browser (Non-Headless)
**Command to Claude**: "Open the Woolworths browser"

**Expected**:
- Chrome window opens
- Navigates to woolworths.com.au
- Page loads completely
- Response includes:
  ```json
  {
    "success": true,
    "message": "Browser opened...",
    "url": "https://www.woolworths.com.au"
  }
  ```

#### Test 2.2: Navigate to Specific URL
**Command to Claude**: "Navigate to https://www.woolworths.com.au/shop/browse/fruit-veg"

**Expected**:
- Browser navigates to fruit & veg category
- Response includes current URL and page title

#### Test 2.3: List Cookies (Optional)
**Command to Claude**: "List the Woolworths cookies"

**Expected**:
- Response shows cookie count (typically 10-20 cookies)
- Each cookie shows only `name`, `domain`, `path`, `secure` and `httpOnly`; no values
- Response format:
  ```json
  {
    "success": true,
    "message": "The current session holds X cookies. API tools use them directly from the browser.",
    "cookies": [...]
  }
  ```
- No API tool needs this step to have run

#### Test 2.4: Close Browser
**Command to Claude**: "Close the browser"

**Expected**:
- Browser window closes
- Response confirms closure and says API tools need an open browser

#### Test 2.5: Prevent Double Browser Open
**Steps**:
1. Open browser
2. Try to open again without closing

**Expected**: Error message about browser already open

### 3. Product Search Tests

#### Test 3.1: Basic Search
**Command to Claude**: "Search for milk"

**Expected**:
- Returns list of milk products
- Total results count > 0
- Products have only: Stockcode, DisplayName, Brand, PackageSize, Price, WasPrice, IsOnSpecial, CupString, Unit, IsAvailable
- Response includes pagination info

#### Test 3.2: Search with Pagination
**Command to Claude**: "Search for bread, page 2, 24 results per page"

**Expected**:
- Returns page 2 of results
- Page size is 24
- Pagination info shows correct page number

#### Test 3.3: Search with Sorting (Price Low to High)
**Command to Claude**: "Search for coffee sorted by price ascending"

**Expected**:
- Products sorted from cheapest to most expensive
- First product cheaper than last product

#### Test 3.4: Search with Sorting (Price High to Low)
**Command to Claude**: "Search for wine sorted by price descending"

**Expected**:
- Products sorted from most expensive to cheapest
- First product more expensive than last product

#### Test 3.5: Search for Specials Only
**Command to Claude**: "Search for specials on fruit"

**Expected**:
- Returns only products with IsOnSpecial = true
- Shows discount information

#### Test 3.6: Search with No Results
**Command to Claude**: "Search for xyzabc123notarealproduct"

**Expected**:
- Returns 0 results
- No error, just empty products array

### 4. Product Detail Tests

#### Test 4.1: Get Product Details
**Steps**:
1. Search for a product
2. Note the Stockcode (e.g., 123456)
3. **Command**: "Get details for stockcode 123456"

**Expected**:
- Detailed product information
- More fields than search results
- Includes description, nutritional info, etc.

#### Test 4.2: Invalid Stockcode
**Command to Claude**: "Get details for stockcode 999999999"

**Expected**: Error response (404 or product not found)

### 5. Specials Tests

#### Test 5.1: Get Half-Price Specials
**Command to Claude**: "What's half price this week?"

**Expected**:
- `woolworths_get_specials` called with `halfPrice: true`
- Products with IsOnSpecial = true and WasPrice about twice Price

#### Test 5.2: Get Specials by Category
**Command to Claude**: "Show me specials in poultry, meat and seafood"

**Expected**:
- Categories fetched first, then `woolworths_get_specials` called with that category's NodeId
- Products from that category only

### 6. Category Tests

#### Test 6.1: Get All Categories
**Command to Claude**: "Show me all product categories"

**Expected**:
- Top-level categories, each with its subcategories
- Categories have: NodeId, Description, UrlFriendlyName
- Common categories present:
  - Fruit & Veg
  - Poultry, Meat & Seafood
  - Dairy, Eggs & Fridge
  - Bakery
  - etc.

### 7. Shopping Cart Tests

**⚠️ Important**: Keep the browser open for every cart test. Log in to test your account's trolley; without logging in, the cart is an anonymous trolley

#### Test 7.1: Add Item to Cart
**Steps**:
1. Log in to Woolworths in the browser
2. Search for a product and note its stockcode
3. **Command**: "Add stockcode 123456 to my cart, quantity 2"

**Expected**:
- Success response
- trolleyItemCount increases
- trolleyTotal shows updated price
- Item details returned

#### Test 7.2: View Cart
**Command to Claude**: "Show me my cart"

**Expected**:
- List of items in cart
- Quantities
- Line totals
- Subtotal
- Total savings
- Item count

#### Test 7.3: Update Cart Quantity
**Command to Claude**: "Update cart stockcode 123456 to quantity 5"

**Expected**:
- Quantity updated
- New totals calculated

#### Test 7.4: Remove from Cart
**Command to Claude**: "Remove stockcode 123456 from cart"

**Expected**:
- Item removed
- Cart totals updated
- Success confirmation

#### Test 7.5: Cart Operations Without Login
**Steps**:
1. Don't log in (skip login step)
2. Add an item to cart
3. View cart

**Expected**: The item is in the anonymous trolley: the browser keeps the cookies the first response sets, so the trolley persists between calls

### 8. Error Handling Tests

#### Test 8.1: API Call Without a Browser
**Steps**:
1. Close the browser (or restart the server)
2. Try to search without opening browser first

**Expected**: Error: "Browser is not open. Use woolworths_open_browser first." Nothing is sent

#### Test 8.2: Expired Session
**Steps**:
1. Open browser
2. Wait 2+ hours
3. Try to search

**Expected**: HTTP 401/403 error indicating expired session, reported as status, status text, content type and size in bytes, with no response body

#### Test 8.3: Invalid Tool Name
**Command**: Use MCP client to call non-existent tool

**Expected**: Error: "Unknown tool: [toolname]"

#### Test 8.4: Missing Required Parameters
**Command**: Call tool without required parameter

**Expected**: Parameter validation error

#### Test 8.5: API Call From Another Origin
**Steps**:
1. Open browser
2. Navigate to a woolworths.com.au subdomain (any page not on `https://www.woolworths.com.au`)
3. Try to search

**Expected**: Error saying the tab is not on https://www.woolworths.com.au and nothing was sent. Navigating back to a www.woolworths.com.au page fixes it

### 9. Session Management Tests

#### Test 9.1: Session Persistence Across API Calls
**Steps**:
1. Open browser and keep it open
2. Search for product A
3. Search for product B
4. Get specials
5. Get categories

**Expected**: All calls succeed from the same browser tab

#### Test 9.2: Multiple Browser Sessions
**Steps**:
1. Open browser
2. Close it
3. Open browser again

**Expected**: New browser instance created successfully

### 10. Integration Tests

#### Test 10.1: Full Shopping Workflow
**Complete workflow**:
1. Open browser → ✅
2. Log in manually → ✅
3. Search for "coffee" → ✅
4. Get details of first result → ✅
5. Add to cart → ✅
6. View cart → ✅
7. Update quantity → ✅
8. Remove item → ✅
9. Close browser → ✅

**Expected**: All steps complete without errors

#### Test 10.2: Browse and Compare Workflow
**Workflow**:
1. Get categories → ✅
2. Search in category (e.g., dairy) → ✅
3. Get specials in that category → ✅
4. Compare prices → ✅

**Expected**: Can explore catalog systematically

## Performance Tests

### Test P.1: Response Time
**Measure**:
- Browser open: Should complete in < 5 seconds
- Cookie listing: Should complete in < 1 second
- Product search: Should complete in < 3 seconds
- Product details: Should complete in < 2 seconds

### Test P.2: Large Result Sets
**Command**: "Search for bread with 100 results per page"

**Expected**: Should handle large page sizes (Woolworths may cap at 36)

### Test P.3: Concurrent Requests
**Steps**: Make multiple API calls in quick succession

**Expected**: All complete successfully. They reach Woolworths one at a time, about a second apart, so a burst of N calls takes about N seconds

## Security Tests

### Test S.1: Cookie Inspection
**Check**: Cookie values not logged to console or files, or returned by any tool

**Expected**: Cookies stay in the browser. `woolworths_get_cookies` lists names and attributes only, and a failed API response is reported without its body

### Test S.2: HTTPS Verification
**Check**: All API calls use HTTPS

**Expected**: No HTTP requests (all HTTPS)

### Test S.3: User Data Directory
**Check**: Browser user data isolation

**Expected**: Separate profile, no cross-contamination

## Compatibility Tests

### Test C.1: Windows
**Platform**: Windows 10/11
**Expected**: All features work

### Test C.2: macOS
**Platform**: macOS 12+
**Expected**: All features work

### Test C.3: Linux
**Platform**: Ubuntu/Debian
**Expected**: All features work

## Regression Tests

After any code changes, run this minimal regression suite:

1. ✅ Open browser
2. ✅ Search products
3. ✅ Get product details
4. ✅ Get specials
5. ✅ Get categories
6. ✅ Close browser

## Known Issues & Limitations

| Issue | Impact | Workaround |
|-------|--------|------------|
| Session expires after ~1 hour | API calls fail with 401/403 | Close and re-open the browser, and log in again if needed |
| API tools need the browser open | Closing it stops every API call | Keep the browser open while using API tools |
| Account trolley needs login | Anonymous trolley otherwise | Log in in the browser window |
| API rate limiting | Three refusals within a minute pause requests for 5 minutes | Wait the minutes the error gives; requests are already paced to about one a second |
| Woolworths API changes | Server may break | Update endpoints as needed |

## Test Results Template

```
Date: ___________
Tester: ___________
Platform: ___________ (Windows/macOS/Linux)
Node Version: ___________

Browser Automation: [Pass/Fail]
Product Search: [Pass/Fail]
Product Details: [Pass/Fail]
Specials: [Pass/Fail]
Categories: [Pass/Fail]
Shopping Cart: [Pass/Fail]
Error Handling: [Pass/Fail]

Notes:
_______________________________________
_______________________________________
_______________________________________
```

## Automated Testing

The offline tests build the server, then run the tests in `test/` with node:test:

```bash
pnpm test
```

They stub `puppeteer.launch` with fake browsers (`test/fake-browser.js`). The fake tab runs the server's real in-page request function in Node with `globalThis.fetch` stubbed, so no network or browser is needed.

## Debugging Tips

### Enable Verbose Logging
Modify `src/server.ts` to add console.error statements

### Inspect Network Traffic
Use Chrome DevTools Network tab while browser is open

### Check Cookie Contents
Use the Chrome DevTools Application tab while the browser is open

### MCP Client Logs
Check Claude Desktop logs for MCP communication issues

---

**Testing Checklist Summary**

- [ ] Installation (2 tests)
- [ ] Browser Automation (5 tests)
- [ ] Product Search (6 tests)
- [ ] Product Details (2 tests)
- [ ] Specials (2 tests)
- [ ] Categories (1 test)
- [ ] Shopping Cart (5 tests)
- [ ] Error Handling (5 tests)
- [ ] Session Management (2 tests)
- [ ] Integration (2 tests)
- [ ] Performance (3 tests)
- [ ] Security (3 tests)
- [ ] Compatibility (3 tests)

**Total Test Cases**: 40+

Happy Testing! 🧪

