import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import puppeteer, { Browser, Cookie, Page } from "puppeteer";
import { z } from "zod";
import { assertWoolworthsUrl } from "./navigation.js";

// Cookie storage
let sessionCookies: Cookie[] = [];
let browser: Browser | null = null;
let currentPage: Page | null = null;

// Argument schemas. McpServer validates every call against these before a handler runs.
const stockcode = z.number().int().positive().describe("The product stockcode/ID");
const quantity = z.number().int().min(0);
// 36 is the page size the site's own search uses (woolworths-api-docs.md).
const pageSize = z.number().int().min(1).max(36);
const sortType = z.enum(["TraderRelevance", "PriceAsc", "PriceDesc", "Name"]);
type SortType = z.infer<typeof sortType>;

type ApiProduct = Record<string, unknown>;

// The search fields a caller needs to choose a product; Stockcode feeds the detail and cart tools.
const SEARCH_PRODUCT_FIELDS = [
  "Stockcode",
  "DisplayName",
  "Brand",
  "PackageSize",
  "Price",
  "WasPrice",
  "IsOnSpecial",
  "CupString",
  "Unit",
  "IsAvailable",
] as const;

export function slimProduct(product: ApiProduct): ApiProduct {
  return Object.fromEntries(SEARCH_PRODUCT_FIELDS.map((field) => [field, product[field]]));
}

export function setSessionCookies(cookies: Cookie[]): void {
  sessionCookies = cookies;
}

export async function closeBrowser(): Promise<void> {
  if (!browser) {
    return;
  }
  await browser.close();
  browser = null;
  currentPage = null;
}

// Helper function to get cookie header string
function getCookieHeader(): string {
  return sessionCookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

// GETs `url`, or POSTs `body` as JSON when one is given, with the captured session cookies.
async function makeWoolworthsRequest<T>(url: string, body?: unknown): Promise<T> {
  if (sessionCookies.length === 0) {
    throw new Error(
      "No session cookies available. Please use woolworths_get_cookies first."
    );
  }

  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: "https://www.woolworths.com.au",
    Referer: "https://www.woolworths.com.au/",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    Priority: "u=1, i",
    Cookie: getCookieHeader(),
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `API request failed: ${response.status} ${response.statusText}. ${errorText}`
    );
  }

  return (await response.json()) as T;
}

// Tool handlers. A failure throws; toolResult turns it into an isError result.
async function handleOpenBrowser({ headless }: { headless: boolean }) {
  if (browser) {
    throw new Error("Browser is already open. Close it first with woolworths_close_browser.");
  }

  // The sandbox is always on: strip Puppeteer's own opt-out (PUPPETEER_DANGEROUS_NO_SANDBOX adds
  // --no-sandbox to its defaults), then refuse any launch that still disabled it.
  const sandboxFlags = ["--no-sandbox", "--disable-setuid-sandbox"];
  const launched = await puppeteer.launch({
    browser: "chrome", // PUPPETEER_BROWSER / defaultBrowser could switch to Firefox, which these checks cannot see.
    headless,
    args: [
      "--disable-blink-features=AutomationControlled",
    ],
    ignoreDefaultArgs: sandboxFlags,
    defaultViewport: { width: 1280, height: 800 },
  });
  const spawnArgs = launched.process()?.spawnargs ?? [];
  if (spawnArgs.some((arg) => sandboxFlags.includes(arg))) {
    await launched.close();
    throw new Error("Refusing to run Chromium with its sandbox disabled");
  }
  browser = launched;

  currentPage = await browser.newPage();

  // Set user agent to appear more like a real browser
  await currentPage.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  // Navigate to Woolworths homepage
  await currentPage.goto("https://www.woolworths.com.au", {
    waitUntil: "networkidle2",
  });

  return {
    success: true,
    message:
      "Browser opened and navigated to Woolworths homepage. You can now log in manually if needed, then use woolworths_get_cookies to capture the session.",
    url: currentPage.url(),
  };
}

async function handleNavigate({ url }: { url: string }) {
  if (!browser || !currentPage) {
    throw new Error("Browser is not open. Use woolworths_open_browser first.");
  }

  // `url` comes from the model, which may be steered by page text it has read.
  const target = assertWoolworthsUrl(url);

  // Navigate the validated href, so Node and Chromium never parse different input.
  let navigationError: unknown;
  try {
    await currentPage.goto(target.href, { waitUntil: "networkidle2" });
  } catch (error) {
    navigationError = error;
  }

  // Redirects are followed, so the tab can still land off-domain; blank it rather than leave it there.
  const finalUrl = currentPage.url();
  try {
    assertWoolworthsUrl(finalUrl);
  } catch (blocked) {
    const cause = navigationError instanceof Error ? `; ${navigationError.message}` : "";
    const blanking = await currentPage.goto("about:blank").then(
      () => "",
      (error) => `; blanking failed: ${error instanceof Error ? error.message : error}`
    );
    throw new Error(`${(blocked as Error).message} (final URL ${finalUrl}${cause}${blanking})`);
  }
  if (navigationError) {
    throw navigationError;
  }

  return {
    success: true,
    url: finalUrl,
    title: await currentPage.title(),
  };
}

async function handleGetCookies() {
  if (!browser || !currentPage) {
    throw new Error("Browser is not open. Use woolworths_open_browser first.");
  }

  // The tab can drift off-domain after woolworths_navigate returns (a slow redirect, in-page script).
  try {
    assertWoolworthsUrl(currentPage.url());
  } catch (blocked) {
    throw new Error(`Cookie capture refused (${(blocked as Error).message})`);
  }

  const cookies = await currentPage.cookies();
  setSessionCookies(cookies);

  return {
    success: true,
    message: `Captured ${cookies.length} cookies from the current session.`,
    cookies: cookies.map((c) => ({
      name: c.name,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
    })),
  };
}

async function handleCloseBrowser() {
  if (!browser) {
    throw new Error("Browser is not open.");
  }

  await closeBrowser();

  return {
    success: true,
    message: "Browser closed. Session cookies have been preserved.",
  };
}

async function handleSearchProducts({
  searchTerm,
  pageNumber,
  pageSize,
  sortType,
  isSpecial,
}: {
  searchTerm: string;
  pageNumber: number;
  pageSize: number;
  sortType: SortType;
  isSpecial: boolean;
}) {
  // Woolworths search API endpoint (POST method)
  const url = `https://www.woolworths.com.au/apis/ui/Search/products`;

  const requestBody = {
    searchTerm,
    pageNumber,
    pageSize,
    sortType,
    location: `/shop/search/products?searchTerm=${encodeURIComponent(searchTerm)}`,
    formatObject: JSON.stringify({ name: searchTerm }),
    isSpecial,
    isBundle: false,
    isMobile: false,
    filters: [],
    groupEdmVariants: false,
  };

  // Each search result is a group whose Products array holds the product itself.
  const data = await makeWoolworthsRequest<{
    SearchResultsCount?: number;
    Products?: { Products: ApiProduct[] }[];
    Pagination?: unknown;
  }>(url, requestBody);

  return {
    success: true,
    searchTerm,
    totalResults: data.SearchResultsCount || 0,
    products: (data.Products || []).flatMap((group) => group.Products.map(slimProduct)),
    pagination: data.Pagination || {
      TotalRecords: data.SearchResultsCount || 0,
      PageNumber: pageNumber,
      PageSize: pageSize,
    },
  };
}

async function handleGetProductDetails({ stockcode }: { stockcode: number }) {
  const url = `https://www.woolworths.com.au/apis/ui/product/detail/${encodeURIComponent(stockcode)}`;

  const data = await makeWoolworthsRequest<unknown>(url);
  return {
    success: true,
    product: data,
  };
}

async function handleGetSpecials({
  category,
  pageSize,
}: {
  category?: string;
  pageSize: number;
}) {
  let url = `https://www.woolworths.com.au/apis/ui/browse/category`;

  if (category) {
    url += `?category=${encodeURIComponent(category)}&filter=Specials&pageSize=${pageSize}`;
  } else {
    url += `?category=specials&pageSize=${pageSize}`;
  }

  const data = await makeWoolworthsRequest<{
    TotalRecordCount?: number;
    Products?: unknown[];
    Bundles?: unknown[];
  }>(url);
  return {
    success: true,
    category: category || "all",
    totalResults: data.TotalRecordCount || 0,
    products: data.Products || data.Bundles || [],
  };
}

async function handleGetCategories() {
  const url = `https://www.woolworths.com.au/apis/ui/PiesCategoriesWithSpecials`;

  const data = await makeWoolworthsRequest<unknown>(url);
  return {
    success: true,
    categories: data,
  };
}

// Sets the trolley quantity of one product; quantity 0 removes it.
async function handleUpdateTrolley({
  stockcode,
  quantity,
}: {
  stockcode: number;
  quantity: number;
}) {
  const url = `https://www.woolworths.com.au/api/v3/ui/trolley/update`;

  const data = await makeWoolworthsRequest<unknown>(url, {
    items: [
      {
        stockcode,
        quantity,
        source: "ProductDetail",
        diagnostics: "0",
        searchTerm: null,
        evaluateRewardPoints: false,
        offerId: null,
        profileId: null,
        priceLevel: null,
      },
    ],
  });
  return {
    success: true,
    cart: data,
  };
}

async function handleGetCart() {
  const url = `https://www.woolworths.com.au/apis/ui/Trolley`;

  const data = await makeWoolworthsRequest<unknown>(url);
  return {
    success: true,
    cart: data,
  };
}

// Serialises a handler's result; a thrown error becomes an isError result with a { success: false, error } payload.
async function toolResult(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await run(), null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ success: false, error: message }, null, 2),
        },
      ],
      isError: true,
    };
  }
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "woolworths-mcp-server",
    version: "1.0.0",
  });

  server.registerTool(
    "woolworths_open_browser",
    {
      description:
        "Opens a browser and navigates to Woolworths website. This is the first step to establish a session.",
      inputSchema: {
        headless: z
          .boolean()
          .default(false)
          .describe("Whether to run browser in headless mode (headed makes manual login easier)"),
      },
    },
    (args) => toolResult(() => handleOpenBrowser(args))
  );

  server.registerTool(
    "woolworths_navigate",
    {
      description:
        "Navigate to a specific URL on the Woolworths website. Only https URLs on woolworths.com.au or its subdomains are allowed.",
      inputSchema: {
        url: z.string().describe("The https URL on woolworths.com.au to navigate to"),
      },
    },
    (args) => toolResult(() => handleNavigate(args))
  );

  server.registerTool(
    "woolworths_get_cookies",
    {
      description:
        "Retrieves session cookies from the current browser session. Run this after logging in or establishing a session.",
      // Not read-only: the captured cookies replace the session every later call sends.
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    () => toolResult(handleGetCookies)
  );

  server.registerTool(
    "woolworths_close_browser",
    { description: "Closes the browser instance" },
    () => toolResult(handleCloseBrowser)
  );

  server.registerTool(
    "woolworths_search_products",
    {
      description:
        "Search for products on Woolworths. Requires session cookies to be obtained first.",
      inputSchema: {
        searchTerm: z.string().min(1).describe("The product search term"),
        pageNumber: z.number().int().min(1).default(1).describe("Page number for pagination"),
        pageSize: pageSize.default(36).describe("Number of results to return"),
        sortType: sortType.default("TraderRelevance").describe("Sort order"),
        isSpecial: z.boolean().default(false).describe("Filter for special offers only"),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => toolResult(() => handleSearchProducts(args))
  );

  server.registerTool(
    "woolworths_get_product_details",
    {
      description: "Get detailed information about a specific product by its stockcode",
      inputSchema: { stockcode },
      annotations: { readOnlyHint: true },
    },
    (args) => toolResult(() => handleGetProductDetails(args))
  );

  server.registerTool(
    "woolworths_get_specials",
    {
      description: "Get current specials and deals from Woolworths",
      inputSchema: {
        category: z
          .string()
          .optional()
          .describe("Optional category filter (e.g., 'fruit-veg', 'meat-seafood')"),
        pageSize: pageSize.default(20).describe("Number of results to return"),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => toolResult(() => handleGetSpecials(args))
  );

  server.registerTool(
    "woolworths_get_categories",
    {
      description: "Get the list of available product categories",
      annotations: { readOnlyHint: true },
    },
    () => toolResult(handleGetCategories)
  );

  server.registerTool(
    "woolworths_add_to_cart",
    {
      description: "Add a product to the shopping cart/trolley",
      inputSchema: {
        stockcode,
        quantity: quantity.default(1).describe("Quantity to add"),
      },
      annotations: { destructiveHint: true },
    },
    (args) => toolResult(() => handleUpdateTrolley(args))
  );

  server.registerTool(
    "woolworths_get_cart",
    {
      description: "Get the contents of the shopping cart/trolley",
      annotations: { readOnlyHint: true },
    },
    () => toolResult(handleGetCart)
  );

  server.registerTool(
    "woolworths_remove_from_cart",
    {
      description: "Remove a product from the shopping cart/trolley",
      inputSchema: { stockcode },
      annotations: { destructiveHint: true },
    },
    ({ stockcode }) => toolResult(() => handleUpdateTrolley({ stockcode, quantity: 0 }))
  );

  server.registerTool(
    "woolworths_update_cart_quantity",
    {
      description: "Update the quantity of a product in the shopping cart/trolley",
      inputSchema: {
        stockcode,
        quantity: quantity.describe("New quantity"),
      },
      annotations: { destructiveHint: true },
    },
    (args) => toolResult(() => handleUpdateTrolley(args))
  );

  return server;
}
