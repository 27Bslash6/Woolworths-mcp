# Cart API Update

## Summary
Updated the Woolworths MCP server to use the correct Woolworths cart API endpoint and request format.

## Changes Made

### 1. Updated Endpoint
- **Old**: `/apis/ui/Trolley/AddItem`, `/apis/ui/Trolley/RemoveItem`, `/apis/ui/Trolley/UpdateItem`
- **New**: `/api/v3/ui/trolley/update` (unified endpoint for all cart operations)

### 2. Updated Request Body Format
The new API uses a standardized request body format:

```json
{
  "items": [
    {
      "stockcode": 184653,
      "quantity": 1,
      "source": "ProductDetail",
      "diagnostics": "0",
      "searchTerm": null,
      "evaluateRewardPoints": false,
      "offerId": null,
      "profileId": null,
      "priceLevel": null
    }
  ]
}
```

### 3. Headers
Requests are sent with `fetch` from the open browser tab, so the browser supplies the user agent, cookies and `sec-fetch-*` headers. The server sets only `Content-Type: application/json` on a POST body.

### 4. Functions Updated
- `handleUpdateTrolley()` - Sets a product's trolley quantity with the new endpoint and request format; update calls it directly, and remove sends `quantity: 0`
- `handleAddToTrolley()` - The endpoint sets a quantity and does not add to it, so add reads `GET /apis/ui/Trolley` first and sets the current quantity plus the requested one. A failed read writes nothing
- `makeWoolworthsRequest()` - Sends each request from the open browser tab

## Testing
After restarting Cursor/Claude Desktop, the cart functionality should work correctly. You can test by:
1. Opening the browser with `woolworths_open_browser` (keep it open)
2. Adding items to cart with `woolworths_add_to_cart`

## Next Steps
To apply these changes:
1. Restart Cursor or Claude Desktop to reload the MCP server
2. Test the cart functionality with the roast dinner ingredients

