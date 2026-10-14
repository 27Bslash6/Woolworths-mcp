# 🛒 Woolworths API Documentation

> Reverse-engineered documentation for the woolworths.com.au product search and cart APIs.

## 📋 Table of Contents

- [Base URL](#base-url)
- [Authentication](#authentication)
- [Product Search API](#1-product-search-api)
- [Search Suggestions API](#2-search-suggestions-api)
- [Shopping Cart API](#3-shopping-cart-trolley-api)
- [Categories API](#4-product-categories-api)
- [Specials Browse API](#5-specials-browse-api)
- [Product Detail API](#6-product-detail-api)
- [Bootstrap/Settings](#7-bootstrapsettings-apis)
- [Example Usage](#example-usage)
- [Rate Limiting](#rate-limiting)
- [Error Codes](#error-codes)

---

## 🌐 Base URL

```
https://www.woolworths.com.au
```

## 🔐 Authentication

⚠️ **The API requires session-based authentication via cookies**

### Required Cookies

| Cookie | Purpose | Lifetime |
|--------|---------|----------|
| `w-rctx` | JWT token for request context | 1 hour |
| `wow-auth-token` | Main authentication token (JWT) | 1 hour |
| `prodwow-auth-token` | Production authentication token (JWT) | 1 hour |
| `bm_sv`, `_abck`, `ak_bmsc` | Bot management/security cookies | Short-lived |
| `INGRESSCOOKIE` | Load balancer cookie | Session |

### How to Obtain Cookies

1. Visit https://www.woolworths.com.au in your browser
2. Open Developer Tools (F12) → Network tab
3. Copy the Cookie header from any request
4. Use these cookies in your API requests

> 💡 **Note:** JWT tokens authenticate you as a "Shopper" user type and expire after 1 hour.

### 📤 Required Headers

```http
accept: application/json, text/plain, */*
content-type: application/json
origin: https://www.woolworths.com.au
user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
Cookie: [your cookies here]
```

---

## 🔍 1. Product Search API

### Search Count Endpoint

Gets the count of products matching a search term.

#### Endpoint

```http
GET /apis/ui/v2/Search/count
```

**Query Parameters:**
- `searchTerm` (string, required) - The product search term
- `groupEdmVariants` (boolean) - Group product variants (default: false)
- `excludeSearchTypes` (string) - Comma-separated search types to exclude (e.g., "specials")

**Example Request:**
```
GET /apis/ui/v2/Search/count?searchTerm=milk&groupEdmVariants=false&excludeSearchTypes=specials
```

**Response:**
```json
{
  "count": 363,
  "searchTerm": "milk"
}
```

---

### Product Search Endpoint

Retrieves detailed product information based on search criteria.

#### Endpoint

```http
POST /apis/ui/Search/products
```

**Request Body:**
```json
{
  "searchTerm": "milk",
  "pageNumber": 1,
  "pageSize": 36,
  "sortType": "TraderRelevance",
  "location": "/shop/search/products?searchTerm=milk",
  "formatObject": "{\"name\":\"milk\"}",
  "isSpecial": false,
  "isBundle": false,
  "isMobile": false,
  "filters": [],
  "groupEdmVariants": false
}
```

**Parameters:**
- `searchTerm` (string) - Product search query
- `pageNumber` (integer) - Page number for pagination (starts at 1)
- `pageSize` (integer) - Number of results per page (typically 36)
- `sortType` (string) - Sort order options:
  - `TraderRelevance` - Most relevant
  - `PriceAsc` - Price low to high
  - `PriceDesc` - Price high to low
  - `Name` - Alphabetical
- `filters` (array) - Category/brand filters
- `isSpecial` (boolean) - Filter for special offers
- `location` (string) - Current page URL

**Response Structure:**
```json
{
  "SearchResultsCount": 363,
  "Products": [
    {
      "Stockcode": 123456,
      "Barcode": "9300605123456",
      "Name": "Product Name",
      "DisplayName": "Brand Product Name Size",
      "Description": "Product description text",
      "Brand": "Brand Name",
      "IsAvailable": true,
      "Price": 4.50,
      "WasPrice": 5.00,
      "IsOnSpecial": true,
      "PromotionDescription": "SAVE $0.50",
      "Unit": "Each",
      "PackageSize": "1L",
      "MinimumQuantity": 1,
      "MaximumQuantity": 36,
      "HasBeenBoughtBefore": false,
      "IsInTrolley": false,
      "UrlFriendlyName": "product-name-1l",
      "ImageUris": {
        "small": "https://cdn0.woolworths.media/content/wowproductimages/small/123456.jpg",
        "medium": "https://cdn0.woolworths.media/content/wowproductimages/medium/123456.jpg",
        "large": "https://cdn0.woolworths.media/content/wowproductimages/large/123456.jpg"
      },
      "RatingCount": 42,
      "RatingAverage": 4.5,
      "Categories": ["Dairy", "Milk"],
      "CupPrice": "$4.50 per litre",
      "CupMeasure": "1L"
    }
  ],
  "Pagination": {
    "TotalRecords": 363,
    "PageNumber": 1,
    "PageSize": 36,
    "TotalPages": 11
  },
  "Facets": [
    {
      "Name": "Category",
      "Items": [
        {
          "Term": "Fresh Milk",
          "Count": 120,
          "IsSelected": false
        }
      ]
    }
  ]
}
```

---

## 💡 2. Search Suggestions API

#### Endpoint

```http
GET /apis/ui/search-suggestions/suggestionsb2c
```

**Query Parameters:**
- `searchTerm` (string) - Partial search term for autocomplete

**Example Request:**
```
GET /apis/ui/search-suggestions/suggestionsb2c?searchTerm=mil
```

**Response:**
```json
{
  "suggestions": [
    "milk",
    "milk powder",
    "milk chocolate",
    "almond milk",
    "oat milk"
  ],
  "products": [
    {
      "stockcode": 123456,
      "name": "Full Cream Milk 3L",
      "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/small/123456.jpg"
    }
  ]
}
```

---

## 🛒 3. Shopping Cart (Trolley) API

### Add, Update or Remove an Item

One endpoint sets the trolley quantity of a product. A quantity of 0 removes it.

#### Endpoint

```http
POST /api/v3/ui/trolley/update
```

**Request Body:**
```json
{
  "items": [
    {
      "stockcode": 123456,
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

See [CART_API_UPDATE.md](CART_API_UPDATE.md) for the headers the endpoint expects.

---

### Get Cart Contents

#### Endpoint

```http
GET /apis/ui/Trolley
```

**Response:**
```json
{
  "items": [
    {
      "stockcode": 123456,
      "name": "Product Name",
      "quantity": 2,
      "price": 4.50,
      "lineTotal": 9.00,
      "imageUrl": "https://cdn0.woolworths.media/content/wowproductimages/small/123456.jpg"
    }
  ],
  "subtotal": 45.50,
  "totalSavings": 5.00,
  "itemCount": 10
}
```

---

## 📂 4. Product Categories API

Returns the whole category tree, specials listings included: about 2,700 nodes and 870 KB.

#### Endpoint

```http
GET /apis/ui/PiesCategoriesWithSpecials
```

**Response** (abridged; every node also carries `NodeLevel`, `ParentNodeId`, `DisplayOrder`, `ProductCount` and other flags):
```json
{
  "Categories": [
    {
      "NodeId": "specialsgroup",
      "Description": "Specials",
      "UrlFriendlyName": "specials",
      "IsSpecial": true,
      "Children": [
        { "NodeId": "specialsgroup.3676", "Description": "Half Price", "IsSpecial": true, "Children": ["..."] }
      ]
    },
    {
      "NodeId": "1-E5BEE36E",
      "Description": "Fruit & Veg",
      "UrlFriendlyName": "fruit-veg",
      "IsSpecial": false,
      "Children": [
        { "NodeId": "1-E5BEE36E_SPECIALS", "Description": "Fruit & Veg Specials & Offers", "IsSpecial": true, "Children": [] },
        { "NodeId": "1-5931EE89", "Description": "Fruit", "IsSpecial": false, "Children": ["..."] }
      ]
    }
  ]
}
```

The `Specials` group's children are the specials listings: `specialsgroup.3676` is Half Price, and `specialsgroup.3676.<NodeId>` is Half Price within a top-level category. Each top-level category also has a `<NodeId>_SPECIALS` child, its Specials & Offers listing. Pass any of these as `categoryId` to the Specials Browse API.

---

## 🏷️ 5. Specials Browse API

Returns a page of one specials listing. This is the request the site's own specials pages send.

#### Endpoint

```http
POST /apis/ui/browse/category
```

**Request Body:**
```json
{
  "categoryId": "specialsgroup.3676",
  "pageNumber": 1,
  "pageSize": 36,
  "sortType": "TraderRelevance",
  "url": "/shop/browse/specials",
  "location": "/shop/browse/specials",
  "formatObject": "{\"name\":\"Specials\"}",
  "isSpecial": false,
  "isBundle": false,
  "isMobile": false,
  "filters": [],
  "isHideUnavailableProducts": true,
  "isRegisteredRewardCardPromotion": false,
  "isHideEverydayMarketProducts": true,
  "categoryVersion": "v2"
}
```

`categoryId` selects the listing (see the Categories API). The Specials root, `specialsgroup`, is refused with a 403: there is no single listing of every special.

**Response** (abridged):
```json
{
  "TotalRecordCount": 1733,
  "Bundles": [
    {
      "Name": "Lindt Lindor Assorted Chocolate Rose Gold Cornet",
      "DisplayName": "Lindt Lindor Assorted Chocolate Rose Gold Cornet 331g",
      "Products": [
        { "Stockcode": 6035173, "Price": 18, "WasPrice": 36, "IsOnSpecial": true, "IsHalfPrice": true }
      ]
    }
  ],
  "Aggregations": [],
  "Success": true
}
```

Each `Products` entry has the same fields as a search result. A page of 36 is about 500 KB.

---

## 🔎 6. Product Detail API

Returns the full record for one product.

#### Endpoint

```http
GET /apis/ui/product/detail/{stockcode}
```

**Response** (top-level keys): `Product`, `Nutrition`, `VideoUrl`, `PrimaryCategory`, `AdditionalAttributes`, `TgaAttributes`, `DetailsImagePaths`, `NutritionalInformation`, `RichRelevancePlacements`, `Variants`, `VariantOptionGroups`, `IsTobacco`, `CountryOfOriginLabel`, `DiagnosticsData`. `Product` has the same fields as a search result. About 26 KB.

---

## ⚙️ 7. Bootstrap/Settings APIs

### Bootstrap

Returns initial configuration and user session data.

```http
GET /api/ui/v2/bootstrap
```

### Settings

Returns application settings and feature flags.

```http
GET /apis/ui/settings
```

---

## ⚡ Rate Limiting

- ✅ No explicit rate limits documented
- ⚠️ Standard browser-like request patterns recommended
- ❌ Avoid aggressive scraping

## 📝 Important Notes

| Note | Details |
|------|----------|
| 💰 **Currency** | All prices are in AUD |
| 📍 **Location** | Product availability varies by delivery address |
| 🖼️ **Images** | Served from CDN: `cdn0.woolworths.media` |
| 🛒 **Terminology** | "Trolley" is used instead of "cart" |
| 🔢 **Product IDs** | Stock codes are the primary identifiers |
| 🔒 **Cart Access** | Requires authenticated session |

## 🚨 Error Codes

| Code | Status | Description |
|------|--------|-------------|
| `200` | ✅ Success | Request completed successfully |
| `400` | ❌ Bad Request | Invalid parameters |
| `401` | 🔒 Unauthorized | Login/cookies required |
| `404` | ❓ Not Found | Resource not found |
| `500` | ⚠️ Server Error | Internal server error |

## 💻 Example Usage

### 🐟 cURL Example - Search for Salmon

```bash
curl --location 'https://www.woolworths.com.au/apis/ui/Search/products' \
--header 'accept: application/json, text/plain, */*' \
--header 'content-type: application/json' \
--header 'origin: https://www.woolworths.com.au' \
--header 'Cookie: [YOUR_COOKIES_HERE]' \
--data '{
  "Filters": [],
  "IsSpecial": false,
  "Location": "/shop/search/products?searchTerm=salmon",
  "PageNumber": 1,
  "PageSize": 24,
  "SearchTerm": "salmon",
  "SortType": "TraderRelevance",
  "GroupEdmVariants": false,
  "ExcludeSearchTypes": ["UntraceableVendors"]
}'
```

> ⚠️ **Important:** You must first visit https://www.woolworths.com.au in your browser to obtain valid cookies, then copy them into the Cookie header.

### 🟦 TypeScript/JavaScript Example

```typescript
// Search for products
async function searchProducts(searchTerm: string, page: number = 1) {
  const response = await fetch('https://www.woolworths.com.au/apis/ui/Search/products', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    credentials: 'include', // Important: sends cookies
    body: JSON.stringify({
      Filters: [],
      IsSpecial: false,
      Location: `/shop/search/products?searchTerm=${searchTerm}`,
      PageNumber: page,
      PageSize: 24,
      SearchTerm: searchTerm,
      SortType: 'TraderRelevance',
      GroupEdmVariants: false,
      ExcludeSearchTypes: ['UntraceableVendors']
    })
  });
  
  return await response.json();
}

// Set the trolley quantity of a product (0 removes it)
async function setTrolleyQuantity(stockcode: number, quantity: number = 1) {
  const response = await fetch('https://www.woolworths.com.au/api/v3/ui/trolley/update', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': '*/*'
    },
    credentials: 'include', // Important for session cookies
    body: JSON.stringify({
      items: [
        {
          stockcode,
          quantity,
          source: 'ProductDetail',
          diagnostics: '0',
          searchTerm: null,
          evaluateRewardPoints: false,
          offerId: null,
          profileId: null,
          priceLevel: null
        }
      ]
    })
  });
  
  return await response.json();
}
```

---

## ⚖️ Disclaimer

> ⚠️ **Educational Use Only**
>
> This documentation was created through reverse engineering of the public Woolworths website for educational purposes.
> 
> - ✅ Use of this API should comply with Woolworths' Terms of Service and robots.txt
> - ⚠️ For production use, contact Woolworths for official API access
> - 🔒 Respect rate limits and don't abuse the service

---

**📅 Last Updated:** October 29, 2025  
**🔧 Version:** 1.0  
**👤 Created by:** Reverse Engineering
