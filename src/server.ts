import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import puppeteer, { Browser, Cookie, Page } from "puppeteer";
import { z } from "zod";
import { assertWoolworthsUrl } from "./navigation.js";

// Cookie storage
let sessionCookies: Cookie[] = [];

// One browser and its tab. Calls capture the session they start on and check it is still current
// after each await, so a close or reopen mid-call can never hand them a newer session's page.
interface Session {
  browser: Browser;
  page: Page;
}
let session: Session | null = null;

// Launch and close run one at a time, chained here, so concurrent calls cannot orphan a browser.
let lifecycle: Promise<unknown> = Promise.resolve();

function serialise<T>(step: () => Promise<T>): Promise<T> {
  const run = lifecycle.then(step, step);
  lifecycle = run.catch(() => undefined);
  return run;
}

// A browser whose close failed while its process kept running. No browser launches until it is
// gone, so a failed close can never leave two live Chromes; every open or close retries it.
let unclosed: Browser | null = null;

function isRunning(browser: Browser): boolean {
  const proc = browser.process();
  return !proc || (proc.exitCode === null && proc.signalCode === null);
}

// Runs inside serialise. Puppeteer's close falls back to killing Chrome, so it rarely fails live.
async function shutDown(closing: Browser): Promise<void> {
  try {
    await closing.close();
    unclosed = null;
  } catch (error) {
    unclosed = isRunning(closing) ? closing : null;
    throw error;
  }
}

function currentSession(): Session {
  if (!session) {
    throw new Error("Browser is not open. Use woolworths_open_browser first.");
  }
  return session;
}

function assertCurrent(started: Session): void {
  if (session !== started) {
    throw new Error("The browser was closed or reopened while this call ran.");
  }
}

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

// Resolves false when no browser was open. Forgets the session before closing it, so a failed
// close cannot leave the server stuck on it; a browser that stays running is kept in `unclosed`.
export function closeBrowser(): Promise<boolean> {
  return serialise(async () => {
    const closing = session?.browser ?? unclosed;
    if (!closing) {
      return false;
    }
    session = null;
    await shutDown(closing);
    return true;
  });
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

// Runs inside serialise: a browser that launched but cannot become the session is closed again.
async function launchSession(headless: boolean): Promise<Session> {
  if (session) {
    throw new Error("Browser is already open. Close it first with woolworths_close_browser.");
  }
  if (unclosed) {
    await shutDown(unclosed).catch((error: unknown) => {
      throw new Error(
        `The previous browser could not be closed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
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
  try {
    const spawnArgs = launched.process()?.spawnargs ?? [];
    if (spawnArgs.some((arg) => sandboxFlags.includes(arg))) {
      throw new Error("Refusing to run Chromium with its sandbox disabled");
    }
    const page = await launched.newPage();
    // Set user agent to appear more like a real browser
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    const opened = { browser: launched, page };
    session = opened;
    // The user can close a headed window directly; forget that browser so it can be opened again.
    launched.once("disconnected", () => {
      if (session === opened) {
        session = null;
      }
    });
    return opened;
  } catch (error) {
    // Report the launch failure; a Chrome that will not close stays tracked in `unclosed`.
    await shutDown(launched).catch(() => undefined);
    throw error;
  }
}

async function handleOpenBrowser({ headless }: { headless: boolean }) {
  // The homepage load runs outside the lifecycle chain, so a close never waits on a slow page.
  const opened = await serialise(() => launchSession(headless));

  // Navigate to Woolworths homepage
  await opened.page.goto("https://www.woolworths.com.au", {
    waitUntil: "networkidle2",
  });
  assertCurrent(opened);

  return {
    success: true,
    message:
      "Browser opened and navigated to Woolworths homepage. You can now log in manually if needed, then use woolworths_get_cookies to capture the session.",
    url: opened.page.url(),
  };
}

async function handleNavigate({ url }: { url: string }) {
  const started = currentSession();
  const { page } = started;

  // `url` comes from the model, which may be steered by page text it has read.
  const target = assertWoolworthsUrl(url);

  // Navigate the validated href, so Node and Chromium never parse different input.
  let navigationError: unknown;
  try {
    await page.goto(target.href, { waitUntil: "networkidle2" });
  } catch (error) {
    navigationError = error;
  }
  assertCurrent(started);

  // Redirects are followed, so the tab can still land off-domain; blank it rather than leave it there.
  const finalUrl = page.url();
  try {
    assertWoolworthsUrl(finalUrl);
  } catch (blocked) {
    const cause = navigationError instanceof Error ? `; ${navigationError.message}` : "";
    const blanking = await page.goto("about:blank").then(
      () => "",
      (error) => `; blanking failed: ${error instanceof Error ? error.message : error}`
    );
    throw new Error(`${(blocked as Error).message} (final URL ${finalUrl}${cause}${blanking})`);
  }
  if (navigationError) {
    throw navigationError;
  }

  const title = await page.title();
  assertCurrent(started);
  return {
    success: true,
    url: finalUrl,
    title,
  };
}

async function handleGetCookies() {
  const started = currentSession();
  const { page } = started;

  // The tab can drift off-domain after woolworths_navigate returns (a slow redirect, in-page script).
  try {
    assertWoolworthsUrl(page.url());
  } catch (blocked) {
    throw new Error(`Cookie capture refused (${(blocked as Error).message})`);
  }

  const cookies = await page.cookies();
  // A session closed or reopened meanwhile must not replace the cookies of the one now in use.
  assertCurrent(started);
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
  if (!(await closeBrowser())) {
    throw new Error("Browser is not open.");
  }

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
      description:
        "Put a product in the shopping cart/trolley. This sets its quantity: it replaces a quantity already in the trolley rather than adding to it.",
      inputSchema: {
        stockcode,
        quantity: quantity.min(1).default(1).describe("Quantity to put in the trolley"),
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
