import { CircuitBreaker, CircuitBreakerOpenError } from "@cachekit-io/cachekit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import puppeteer, { Browser, Page } from "puppeteer";
import { z } from "zod";
import { catalogueWeek, getCache, resetCache } from "./cache.js";
import { assertWoolworthsUrl } from "./navigation.js";

// One browser and its tab. Calls capture the session they start on and check it is still current
// after each await, so a close or reopen mid-call can never hand them a newer session's page.
interface Session {
  browser: Browser;
  page: Page;
  // The store this session's cookies select, looked up on its first keyed call (see storeIdFor).
  storeId?: Promise<number>;
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
const pageNumber = z.number().int().min(1);
// 36 is the page size the site's own search uses (woolworths-api-docs.md).
const pageSize = z.number().int().min(1).max(36);
const sortType = z.enum(["TraderRelevance", "PriceAsc", "PriceDesc", "Name"]);
type SortType = z.infer<typeof sortType>;

type ApiProduct = Record<string, unknown>;
type ApiCategory = {
  NodeId: string;
  Description: string;
  UrlFriendlyName: string;
  IsSpecial: boolean;
  Children?: ApiCategory[];
};

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
  // null, not undefined, for an absent field: a value read back from the cache has null there.
  return Object.fromEntries(SEARCH_PRODUCT_FIELDS.map((field) => [field, product[field] ?? null]));
}

// A 200 without the array a slimming handler reads is a changed or blocked response, not an empty result.
function requireArray<T>(value: T[] | undefined, field: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`Unexpected Woolworths response: no ${field} array`);
  }
  return value;
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

// Every API call is sent from this origin only, so the request carries the tab's own cookies.
const WOOLWORTHS_ORIGIN = "https://www.woolworths.com.au";

// Request pacing and the in-tab timeout, in one place so tests can shorten them. Bot protection
// tarpits a burst (about 150 searches in a few minutes did it), so requests go out one at a time.
export const limits = { intervalMs: 1_000, jitterMs: 500, timeoutMs: 15_000 };

// Runs inside the tab (page.evaluate serialises it, so it may use only its argument). The origin test
// and the fetch share one synchronous step: script cannot move the tab between them, and an off-origin
// document sends nothing (null). `location` is unforgeable, so another origin's script cannot fake the
// test. No `mode` is set: Chrome sends it as Sec-Fetch-Mode, and the site's own requests use the default.
// The browser supplies the user agent, cookies and fetch metadata, and keeps any Set-Cookie it gets.
// A failed response's body never leaves the tab: only its size does. A fetch that throws comes back as
// its kind, read from the abort signal rather than the browser's error text.
async function fetchInTab(request: { origin: string; url: string; body?: string; timeoutMs: number }) {
  if (location.origin !== request.origin) {
    return null;
  }
  const signal = AbortSignal.timeout(request.timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: request.body === undefined ? "GET" : "POST",
      headers: request.body === undefined ? {} : { "Content-Type": "application/json" },
      body: request.body,
      signal,
    });
    const bytes = await response.arrayBuffer();
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type") ?? "",
      size: bytes.byteLength,
      text: response.ok ? new TextDecoder().decode(bytes) : undefined,
    };
  } catch (error) {
    return {
      failure: signal.aborted ? ("timeout" as const) : ("network" as const),
      message: (error instanceof Error ? error.message : String(error)).slice(0, 200),
    };
  }
}

type TabResult = NonNullable<Awaited<ReturnType<typeof fetchInTab>>>;
type TabResponse = Exclude<TabResult, { failure: unknown }>;

// Status, status text, media type and size: enough to tell a block page from an outage, with no body.
function describeResponse({ status, statusText, contentType, size }: TabResponse): string {
  const mediaType = contentType.split(";")[0].trim().slice(0, 60) || "no content type";
  // HTTP/2 responses carry no status text.
  const line = statusText ? `${status} ${statusText.slice(0, 60)}` : String(status);
  return `${line} (${mediaType}, ${size} bytes)`.replace(/[<>]/g, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Stops calls while Woolworths is refusing them. Counted failures are the ones that say the site is
// blocking or down: 403, 429, 5xx, no answer, and a 200 that is not the expected JSON. One probe is let
// through after the timeout, and one success closes it (successThreshold must not exceed
// halfOpenMaxCalls, or the probe's slot is never freed and the breaker stays half-open).
const BREAKER_TIMEOUT_MS = 300_000;
const breaker = new CircuitBreaker({
  failureThreshold: 3,
  rollingWindow: 60_000,
  timeout: BREAKER_TIMEOUT_MS,
  halfOpenMaxCalls: 1,
  successThreshold: 1,
});
// The breaker keeps when it opened private, so the server records it for the retry hint.
let openedAt = 0;
// A half-open probe is in flight; the breaker's own slot count is private too.
let probing = false;

function refuseWhileRateLimited(): void {
  const state = breaker.state;
  if (state === "open" || (state === "half-open" && probing)) {
    const minutes = Math.ceil((openedAt + BREAKER_TIMEOUT_MS - Date.now()) / 60_000);
    throw new Error(`Woolworths is rate-limiting; retry in ${Math.min(5, Math.max(1, minutes))} min`);
  }
}

function countsAsBlocked(status: number): boolean {
  return status === 403 || status === 429 || status >= 500;
}

// One request at a time: each starts after the previous one settled, and at least the interval plus
// jitter after it started.
let gate: Promise<unknown> = Promise.resolve();
let lastStart = -Infinity;

function throughGate<T>(turn: () => Promise<T>): Promise<T> {
  const run = gate.then(async () => {
    const due = lastStart + limits.intervalMs + Math.random() * limits.jitterMs;
    for (let wait = due - Date.now(); wait > 0; wait = due - Date.now()) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    return turn();
  });
  gate = run.catch(() => undefined);
  return run;
}

// Clears the gate, breaker, store id memo and cache instance. For tests.
export async function resetState(): Promise<void> {
  gate = Promise.resolve();
  lastStart = -Infinity;
  breaker.reset();
  openedAt = 0;
  probing = false;
  if (session) {
    session.storeId = undefined;
  }
  await resetCache();
}

// The session every API call starts with. The tab's origin is checked here, before any cache read, so
// a closed browser or an off-origin tab is an error even when a cached result exists.
function apiSession(): Session {
  const started = currentSession();
  let origin = "";
  try {
    origin = new URL(started.page.url()).origin;
  } catch {
    // An unparseable URL is off-origin.
  }
  if (origin !== WOOLWORTHS_ORIGIN) {
    throw new Error(
      `The browser tab is not on ${WOOLWORTHS_ORIGIN}, so nothing was sent. Use woolworths_navigate to return to it.`
    );
  }
  return started;
}

// A request that may have reached Woolworths with no answer back: a timeout or a network failure.
class InFlightError extends Error {}

interface RequestOptions<T> {
  // Sent as JSON in a POST; a GET without one.
  body?: unknown;
  // Checks a 200's JSON and returns the result. It runs inside the breaker, so a bad shape counts.
  parse?: (data: unknown) => T;
  // A trolley write: when it fails in flight it may still have been applied.
  isUpdate?: boolean;
}

// An outcome that does not count against the breaker, turned into an error once the call leaves it.
interface Uncounted {
  error: string;
  // The request may have reached Woolworths without its result reaching us.
  inFlight: boolean;
}

// Sends one API request from the tab of session `started`, paced by the gate and guarded by the
// breaker. Fails, rather than return a result, if that session is replaced.
async function makeWoolworthsRequest<T>(
  started: Session,
  url: string,
  { body, parse = (data) => data as T, isUpdate = false }: RequestOptions<T> = {}
): Promise<T> {
  refuseWhileRateLimited();
  return throughGate(async () => {
    assertCurrent(started);
    refuseWhileRateLimited();
    probing = breaker.state === "half-open";
    lastStart = Date.now();
    let outcome: { data: T } | Uncounted;
    try {
      outcome = await breaker.execute(async (): Promise<{ data: T } | Uncounted> => {
        let result: Awaited<ReturnType<typeof fetchInTab>>;
        try {
          result = await started.page.evaluate(fetchInTab, {
            origin: WOOLWORTHS_ORIGIN,
            url,
            body: body === undefined ? undefined : JSON.stringify(body),
            timeoutMs: limits.timeoutMs,
          });
        } catch (fault) {
          // The browser failed, not Woolworths.
          return { error: errorMessage(fault), inFlight: true };
        }
        if (!result) {
          return {
            error: `The browser tab is not on ${WOOLWORTHS_ORIGIN}, so nothing was sent. Use woolworths_navigate to return to it.`,
            inFlight: false,
          };
        }
        if ("failure" in result) {
          throw new InFlightError(
            result.failure === "timeout"
              ? `Woolworths did not respond in time (${limits.timeoutMs / 1000} s)`
              : result.message
          );
        }
        if (!result.ok) {
          const error = `API request failed: ${describeResponse(result)}`;
          if (countsAsBlocked(result.status)) {
            throw new Error(error);
          }
          return { error, inFlight: false };
        }
        let data: unknown;
        try {
          data = JSON.parse(result.text ?? "");
        } catch {
          // The parser's message quotes the body, so it is dropped.
          throw new Error(`API response was not JSON: ${describeResponse(result)}`);
        }
        return { data: parse(data) };
      });
    } catch (error) {
      if (error instanceof CircuitBreakerOpenError) {
        refuseWhileRateLimited();
      }
      if (breaker.state === "open") {
        openedAt = Date.now();
      }
      outcome = { error: errorMessage(error), inFlight: error instanceof InFlightError };
    } finally {
      probing = false;
    }

    try {
      assertCurrent(started);
    } catch (error) {
      outcome = { error: errorMessage(error), inFlight: true };
    }
    if ("data" in outcome) {
      return outcome.data;
    }
    if (isUpdate && outcome.inFlight) {
      // The POST may have reached Woolworths before this failed; a blind retry could apply it twice.
      throw new Error(`The update may have been applied (${outcome.error}); check woolworths_get_cart before retrying.`);
    }
    throw new Error(outcome.error);
  });
}

function unexpected(what: string): Error {
  return new Error(`Unexpected Woolworths response: ${what}`);
}

function asObject(data: unknown): Record<string, unknown> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw unexpected("not a JSON object");
  }
  return data as Record<string, unknown>;
}

const BOOTSTRAP_URL = `${WOOLWORTHS_ORIGIN}/api/ui/v2/bootstrap`;

// The bootstrap response also carries the trolley, so only the store id is kept, in memory.
function readStoreId(data: unknown): number {
  const delivery = asObject(data).GetDeliveryInfoRequest;
  const storeId = typeof delivery === "object" && delivery !== null ? (delivery as Record<string, unknown>).FulfilmentStoreId : undefined;
  if (typeof storeId !== "number" || !Number.isInteger(storeId) || storeId <= 0) {
    throw unexpected("no FulfilmentStoreId");
  }
  return storeId;
}

// Prices and availability are per store, so the store is part of every product cache key. It is read
// once per browser session; concurrent calls share the lookup, and a failed one is dropped.
function storeIdFor(started: Session): Promise<number> {
  if (!started.storeId) {
    const lookup = makeWoolworthsRequest(started, BOOTSTRAP_URL, { parse: readStoreId });
    started.storeId = lookup;
    lookup.catch(() => {
      if (started.storeId === lookup) {
        started.storeId = undefined;
      }
    });
  }
  return started.storeId;
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
    // No user agent override: the browser's own must match its TLS handshake and client hints.
    const page = await launched.newPage();
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
      "Browser opened and navigated to Woolworths homepage. Log in manually if needed. Keep the browser open: every API tool sends its request from this tab.",
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
    throw new Error(`Cookie listing refused (${(blocked as Error).message})`);
  }

  const cookies = await page.cookies();
  // A session closed or reopened meanwhile must not report a newer session's cookies as this one's.
  assertCurrent(started);

  return {
    success: true,
    message: `The current session holds ${cookies.length} cookies. API tools use them directly from the browser.`,
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
    message: "Browser closed. API tools need an open browser: use woolworths_open_browser to start a new session.",
  };
}

// Read results are cached on disk under these namespaces. Each cached function takes only plain data:
// its argument is the whole cache key, and it closes over the session it sends from. Prices and
// availability depend on the store and the weekly catalogue, so both are in every product key.
// Bump a namespace's version when the shape of its cached result changes.

// One entry per normalised term, so "Milk " and "milk" share it; the normalised term is what is sent.
function normaliseSearchTerm(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, " ");
}

interface SearchKey {
  storeId: number;
  catalogueWeek: string;
  searchTerm: string;
  pageNumber: number;
  pageSize: number;
  sortType: SortType;
  isSpecial: boolean;
}

// Each search result is a group whose Products array holds the product itself.
type SearchResponse = {
  SearchResultsCount?: number;
  Products: { Products: ApiProduct[] }[];
  Pagination?: unknown;
};

// A search with no hits has no Products list and a count of 0; anything else without the groups is a
// changed or blocked response, not an empty result.
function readSearch(data: unknown): SearchResponse {
  const body = asObject(data);
  if (body.Products == null && body.SearchResultsCount === 0) {
    return { ...body, SearchResultsCount: 0, Products: [] };
  }
  const groups = body.Products;
  const valid =
    Array.isArray(groups) &&
    groups.every((group: unknown) => Array.isArray((group as { Products?: unknown } | null)?.Products));
  if (!valid) {
    throw unexpected("no Products array in every search result");
  }
  return body as SearchResponse;
}

async function searchUpstream(
  started: Session,
  { searchTerm, pageNumber, pageSize, sortType, isSpecial }: SearchKey
) {
  const data = await makeWoolworthsRequest(started, `${WOOLWORTHS_ORIGIN}/apis/ui/Search/products`, {
    body: {
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
    },
    parse: readSearch,
  });

  return {
    success: true,
    searchTerm,
    totalResults: data.SearchResultsCount || 0,
    products: data.Products.flatMap((group) => group.Products.map(slimProduct)),
    pagination: data.Pagination || {
      TotalRecords: data.SearchResultsCount || 0,
      PageNumber: pageNumber,
      PageSize: pageSize,
    },
  };
}

async function handleSearchProducts(args: Omit<SearchKey, "storeId" | "catalogueWeek">) {
  const started = apiSession();
  const key: SearchKey = {
    storeId: await storeIdFor(started),
    catalogueWeek: catalogueWeek(),
    searchTerm: normaliseSearchTerm(args.searchTerm),
    pageNumber: args.pageNumber,
    pageSize: args.pageSize,
    sortType: args.sortType,
    isSpecial: args.isSpecial,
  };
  return getCache().wrap((k: SearchKey) => searchUpstream(started, k), { namespace: "ww:search:v1", ttl: 1800 })(key);
}

interface ProductKey {
  storeId: number;
  catalogueWeek: string;
  stockcode: number;
}

// The detail response carries this session's trolley state, purchase history and tracking data, none
// of which may be cached.
const DROPPED_DETAIL_FIELDS = ["DiagnosticsData", "RichRelevancePlacements"];
const DROPPED_PRODUCT_FIELDS = [
  "IsInTrolley",
  "QuantityInTrolley",
  "IsPersonalisedByPurchaseHistory",
  "HasBeenBoughtBefore",
  "Diagnostics",
];

function omit(object: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).filter(([field]) => !fields.includes(field)));
}

// Product is null when no product has the stockcode; a 200 without the key is not a product response.
function readProductDetail(data: unknown): Record<string, unknown> & { Product: Record<string, unknown> | null } {
  const body = omit(asObject(data), DROPPED_DETAIL_FIELDS);
  if (!("Product" in body)) {
    throw unexpected("no Product");
  }
  return { ...body, Product: body.Product === null ? null : omit(asObject(body.Product), DROPPED_PRODUCT_FIELDS) };
}

async function productUpstream(started: Session, { stockcode }: ProductKey) {
  const url = `${WOOLWORTHS_ORIGIN}/apis/ui/product/detail/${encodeURIComponent(stockcode)}`;
  const data = await makeWoolworthsRequest(started, url, { parse: readProductDetail });
  if (data.Product === null) {
    throw new Error(`No product has stockcode ${stockcode}.`);
  }
  return {
    success: true,
    product: data,
  };
}

async function handleGetProductDetails({ stockcode }: { stockcode: number }) {
  const started = apiSession();
  const key: ProductKey = { storeId: await storeIdFor(started), catalogueWeek: catalogueWeek(), stockcode };
  return getCache().wrap((k: ProductKey) => productUpstream(started, k), { namespace: "ww:product:v1", ttl: 21600 })(key);
}

// Specials listings are category ids from the category tree: `<NodeId>_SPECIALS` is a top-level
// category's specials, HALF_PRICE is Half Price across the store, and `HALF_PRICE.<NodeId>` is Half
// Price within a category. The site has no store-wide listing of every special: the Specials root
// (`specialsgroup`) is refused.
const HALF_PRICE = "specialsgroup.3676";

interface SpecialsKey {
  storeId: number;
  catalogueWeek: string;
  category: string | null;
  halfPrice: boolean;
  pageNumber: number;
  pageSize: number;
}

function readSpecials(data: unknown) {
  const body = asObject(data) as { TotalRecordCount?: number; Bundles?: { Products?: ApiProduct[] }[] };
  return {
    totalResults: body.TotalRecordCount || 0,
    products: requireArray(body.Bundles, "Bundles").flatMap((bundle) =>
      requireArray(bundle?.Products, "Bundles[].Products").map(slimProduct)
    ),
  };
}

async function specialsUpstream(started: Session, { category, halfPrice, pageNumber, pageSize }: SpecialsKey) {
  let categoryId = HALF_PRICE;
  if (category) {
    categoryId = halfPrice ? `${HALF_PRICE}.${category}` : `${category}_SPECIALS`;
  }

  // The body the site's own specials browse sends; categoryId selects the listing.
  const { totalResults, products } = await makeWoolworthsRequest(started, `${WOOLWORTHS_ORIGIN}/apis/ui/browse/category`, {
    body: {
      categoryId,
      pageNumber,
      pageSize,
      sortType: "TraderRelevance",
      url: "/shop/browse/specials",
      location: "/shop/browse/specials",
      formatObject: JSON.stringify({ name: "Specials" }),
      isSpecial: false,
      isBundle: false,
      isMobile: false,
      filters: [],
      isHideUnavailableProducts: true,
      isRegisteredRewardCardPromotion: false,
      isHideEverydayMarketProducts: true,
      categoryVersion: "v2",
    },
    parse: readSpecials,
  });
  return {
    success: true,
    totalResults,
    pageNumber,
    pageSize,
    products,
  };
}

async function handleGetSpecials({
  category,
  halfPrice,
  pageNumber,
  pageSize,
}: {
  category?: string;
  halfPrice: boolean;
  pageNumber: number;
  pageSize: number;
}) {
  if (!category && !halfPrice) {
    throw new Error(
      "Woolworths has no store-wide listing of all specials. Pass a category NodeId from woolworths_get_categories, or halfPrice: true."
    );
  }
  const started = apiSession();
  const key: SpecialsKey = {
    storeId: await storeIdFor(started),
    catalogueWeek: catalogueWeek(),
    category: category ?? null,
    halfPrice,
    pageNumber,
    pageSize,
  };
  return getCache().wrap((k: SpecialsKey) => specialsUpstream(started, k), { namespace: "ww:specials:v1", ttl: 86400 })(key);
}

// The full tree is about 2,700 nodes (1.7 MB as a tool result). Keep two levels of NodeId, name and
// slug, and drop the specials listings, which woolworths_get_specials builds from a top-level NodeId.
function slimCategory({ NodeId, Description, UrlFriendlyName }: ApiCategory) {
  return { NodeId, Description, UrlFriendlyName };
}

function slimCategories(categories: ApiCategory[]) {
  const plain = (list: ApiCategory[] = []) => list.filter((category) => !category.IsSpecial);
  return plain(categories).map((category) => ({
    ...slimCategory(category),
    Children: plain(category.Children).map(slimCategory),
  }));
}

function readCategories(data: unknown) {
  return slimCategories(requireArray(asObject(data).Categories as ApiCategory[] | undefined, "Categories"));
}

async function categoriesUpstream(started: Session) {
  const url = `${WOOLWORTHS_ORIGIN}/apis/ui/PiesCategoriesWithSpecials`;
  return {
    success: true,
    categories: await makeWoolworthsRequest(started, url, { parse: readCategories }),
  };
}

// The category tree is the same for every store and week.
async function handleGetCategories() {
  const started = apiSession();
  return getCache().wrap(() => categoriesUpstream(started), { namespace: "ww:categories:v1", ttl: 604800 })();
}

// The trolley is never cached: it changes with every write, and it is this session's own state.
const TROLLEY_URL = `${WOOLWORTHS_ORIGIN}/apis/ui/Trolley`;

// Sets the trolley quantity of one product; quantity 0 removes it.
async function handleUpdateTrolley(
  { stockcode, quantity }: { stockcode: number; quantity: number },
  started = apiSession()
) {
  const url = `${WOOLWORTHS_ORIGIN}/api/v3/ui/trolley/update`;

  const data = await makeWoolworthsRequest<unknown>(started, url, {
    body: {
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
    },
    isUpdate: true,
  });
  return {
    success: true,
    cart: data,
  };
}

// Only AvailableItems lines are counted: that is the trolley shape on record (test/fixtures/trolley.json).
function readTrolleyItems(data: unknown): ApiProduct[] {
  const items = asObject(data).AvailableItems;
  if (!Array.isArray(items)) {
    throw new Error("Trolley read returned no AvailableItems array; nothing was added.");
  }
  return items as ApiProduct[];
}

// trolley/update sets a line's quantity, so an add reads the trolley and sets current + requested.
// Both requests are bound to the session the call started on, so a browser reopened between them
// fails the call before the update, rather than carry this trolley's quantity into another trolley.
async function handleAddToTrolley({
  stockcode,
  quantity,
}: {
  stockcode: number;
  quantity: number;
}) {
  const started = apiSession();
  const items = await makeWoolworthsRequest(started, TROLLEY_URL, { parse: readTrolleyItems });
  const line = items.find((item) => item.Stockcode === stockcode);
  const current = line ? line.Quantity : 0;
  if (typeof current !== "number") {
    throw new Error(`Trolley line for ${stockcode} has no numeric Quantity; nothing was added.`);
  }
  return handleUpdateTrolley({ stockcode, quantity: current + quantity }, started);
}

async function handleGetCart() {
  const data = await makeWoolworthsRequest<unknown>(apiSession(), TROLLEY_URL);
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
        "Opens a browser and navigates to Woolworths website. This is the first step: every other tool sends its requests from this browser, so keep it open.",
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
        "Lists the names and attributes (not the values) of the current browser session's cookies. Optional: API tools use the browser's cookies directly.",
      annotations: { readOnlyHint: true },
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
        "Search for products on Woolworths. Requires an open browser (woolworths_open_browser).",
      inputSchema: {
        searchTerm: z.string().trim().min(1).describe("The product search term"),
        pageNumber: pageNumber.default(1).describe("Page number for pagination"),
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
      description:
        "Get a page of current specials from Woolworths. Pass a top-level category NodeId from woolworths_get_categories, halfPrice: true, or both. The site has no store-wide listing of every special, so a call needs at least one of them.",
      inputSchema: {
        category: z
          .string()
          .regex(/^[\w-]{1,32}$/)
          .optional()
          .describe("NodeId of a top-level category from woolworths_get_categories, e.g. '1-E5BEE36E' (Fruit & Veg)"),
        halfPrice: z
          .boolean()
          .default(false)
          .describe("Only half-price specials; without a category, half-price specials across the store"),
        pageNumber: pageNumber.default(1).describe("Page number for pagination"),
        pageSize: pageSize.default(36).describe("Number of results to return"),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => toolResult(() => handleGetSpecials(args))
  );

  server.registerTool(
    "woolworths_get_categories",
    {
      description:
        "Get the product categories: each top-level category's NodeId, name and URL slug, with its subcategories. woolworths_get_specials takes a top-level NodeId only, not a subcategory's.",
      annotations: { readOnlyHint: true },
    },
    () => toolResult(handleGetCategories)
  );

  server.registerTool(
    "woolworths_add_to_cart",
    {
      description:
        "Add a product to the shopping cart/trolley. The quantity is added to any quantity already in the trolley.",
      inputSchema: {
        stockcode,
        quantity: quantity.min(1).default(1).describe("Quantity to add"),
      },
      annotations: { destructiveHint: true },
    },
    (args) => toolResult(() => handleAddToTrolley(args))
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
