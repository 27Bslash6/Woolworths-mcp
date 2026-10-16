import { CircuitBreaker } from "@cachekit-io/cachekit";
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

const REPLACED = "The browser was closed or reopened while this call ran.";

function assertCurrent(started: Session): void {
  if (session !== started) {
    throw new Error(REPLACED);
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

// A field value a tool may return: a string, number, boolean or null. Anything else Woolworths puts in
// a kept field, such as an object, is dropped rather than passed through with whatever it holds.
const leaf = z.union([z.string(), z.number(), z.boolean(), z.null()]).optional().catch(undefined);

// A part of a response that is optional: one that is missing or malformed is dropped, not an error.
const part = <S extends z.ZodType>(schema: S) => schema.optional().catch(undefined);

// Drops the keys a dropped field left as undefined, so a fresh result and one read back from the cache
// (which stores undefined as null) are the same.
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

// An object of exactly the named fields, each a leaf unless `nested` gives its schema. Zod drops every
// other key, so what a tool returns, and the cache keeps, is named here at every depth.
function pick<const F extends string, N extends z.ZodRawShape = {}>(fields: readonly F[], nested?: N) {
  const leaves = Object.fromEntries(fields.map((field) => [field, leaf])) as Record<F, typeof leaf>;
  return z.object({ ...leaves, ...(nested as N) }).transform(defined);
}

// The search fields a caller needs to choose a product; Stockcode feeds the detail and cart tools.
const productTile = pick([
  "Stockcode", "DisplayName", "Brand", "PackageSize", "Price", "WasPrice", "IsOnSpecial", "CupString", "Unit",
  "IsAvailable",
]);

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

// A 5xx counts too, in classify.
function countsAsBlocked(status: number): boolean {
  return status === 403 || status === 429;
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
    throw new Error(OFF_ORIGIN);
  }
  return started;
}

const OFF_ORIGIN = `The browser tab is not on ${WOOLWORTHS_ORIGIN}, so nothing was sent. Use woolworths_navigate to return to it.`;
// The in-tab check, for a tab that moved while the call waited at the gate.
const LEFT_ORIGIN = `The browser tab left ${WOOLWORTHS_ORIGIN} while this call waited, so nothing was sent. Use woolworths_navigate to return to it.`;

// A request that reached Woolworths, or may have, with no usable answer back: a timeout, a network
// failure, a 5xx, or a 2xx that is not the expected JSON. A trolley write that fails this way may
// still have been applied.
class InFlightError extends Error {}

interface RequestOptions<T> {
  // Sent as JSON in a POST; a GET without one.
  body?: unknown;
  // Checks a 200's JSON and returns the result. It runs inside the breaker, so a bad shape counts.
  parse?: (data: unknown) => T;
  // A trolley write: when it fails in flight it may still have been applied.
  isUpdate?: boolean;
}

// Reads the answer to a request that was sent. Runs inside the breaker: a throw counts against it, and
// a returned error (a status that says nothing about blocking, such as 400 or 404) does not.
function classify<T>(result: TabResult, parse: (data: unknown) => T): { data: T } | { error: string } {
  if ("failure" in result) {
    throw new InFlightError(
      result.failure === "timeout" ? `Woolworths did not respond in time (${limits.timeoutMs / 1000} s)` : result.message
    );
  }
  if (!result.ok) {
    const error = `API request failed: ${describeResponse(result)}`;
    if (result.status >= 500) {
      throw new InFlightError(error);
    }
    if (countsAsBlocked(result.status)) {
      throw new Error(error);
    }
    return { error };
  }
  let data: unknown;
  try {
    data = JSON.parse(result.text ?? "");
  } catch {
    // The parser's message quotes the body, so it is dropped.
    throw new InFlightError(`API response was not JSON: ${describeResponse(result)}`);
  }
  try {
    return { data: parse(data) };
  } catch (error) {
    throw new InFlightError(errorMessage(error));
  }
}

// Sends one API request from the tab of session `started`, paced by the gate and guarded by the
// breaker. Only an answer from Woolworths enters the breaker: a browser fault (no answer came back,
// though the request may have gone out) or an off-origin tab (nothing was sent) never does, so it can
// neither count as a failure nor close a half-open breaker. Fails, rather than return a result, if
// the session is replaced.
async function makeWoolworthsRequest<T>(
  started: Session,
  url: string,
  { body, parse = (data) => data as T, isUpdate = false }: RequestOptions<T> = {}
): Promise<T> {
  // A replaced session outranks the call's own error. A write that may have been sent says so.
  const fail = (message: string, inFlight: boolean): Error => {
    const reason = session === started ? message : REPLACED;
    return new Error(
      isUpdate && inFlight ? `The update may have been applied (${reason}); check woolworths_get_cart before retrying.` : reason
    );
  };

  refuseWhileRateLimited();
  return throughGate(async () => {
    assertCurrent(started);
    refuseWhileRateLimited();
    probing = breaker.state === "half-open";
    lastStart = Date.now();
    try {
      let result: Awaited<ReturnType<typeof fetchInTab>>;
      try {
        result = await started.page.evaluate(fetchInTab, {
          origin: WOOLWORTHS_ORIGIN,
          url,
          body: body === undefined ? undefined : JSON.stringify(body),
          timeoutMs: limits.timeoutMs,
        });
      } catch (fault) {
        // The browser failed, not Woolworths. The request may have gone out first.
        throw fail(errorMessage(fault), true);
      }
      if (!result) {
        throw fail(LEFT_ORIGIN, false);
      }

      const sent = result;
      let outcome: { data: T } | { error: string };
      try {
        outcome = await breaker.execute(async () => classify(sent, parse));
      } catch (error) {
        if (breaker.state === "open") {
          openedAt = Date.now();
        }
        throw fail(errorMessage(error), error instanceof InFlightError);
      }
      if ("error" in outcome) {
        throw fail(outcome.error, false);
      }
      if (session !== started) {
        throw fail(REPLACED, true);
      }
      return outcome.data;
    } finally {
      probing = false;
    }
  });
}

function unexpected(what: string): Error {
  return new Error(`Unexpected Woolworths response: ${what}`);
}

// Parses a 200's JSON against the shape a tool reads. Zod drops every key a schema does not name, so a
// response schema is also the allowlist of what a tool returns and the cache keeps.
function parseShape<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const parsed = schema.safeParse(data);
  if (parsed.success) {
    return parsed.data;
  }
  const [issue] = parsed.error.issues;
  // ["Bundles", 0, "Products"] reads "Bundles[].Products".
  const path = issue.path.map((key, i) => (typeof key === "number" ? "[]" : `${i ? "." : ""}${String(key)}`)).join("");
  if (!path) {
    throw unexpected("not a JSON object");
  }
  throw unexpected(issue.code === "invalid_type" ? `no ${path} ${issue.expected}` : `bad ${path}`);
}

const BOOTSTRAP_URL = `${WOOLWORTHS_ORIGIN}/api/ui/v2/bootstrap`;

// The bootstrap response also carries the trolley, so only the store id is kept, in memory.
const bootstrapResponse = z.object({
  GetDeliveryInfoRequest: z.object({ FulfilmentStoreId: z.number().int().positive() }),
});

function readStoreId(data: unknown): number {
  return parseShape(bootstrapResponse, data).GetDeliveryInfoRequest.FulfilmentStoreId;
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
        `The previous browser could not be closed: ${errorMessage(error)}`
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
      (error) => `; blanking failed: ${errorMessage(error)}`
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
const searchResponse = z.object({
  SearchResultsCount: z.number().optional(),
  Products: z.array(z.object({ Products: z.array(productTile) })),
  Pagination: z.unknown().optional(),
});

// A search with no hits has no Products list and a count of 0; anything else without the groups is a
// changed or blocked response, not an empty result.
function readSearch(data: unknown): z.output<typeof searchResponse> {
  const zeroHits = z.object({ SearchResultsCount: z.literal(0), Products: z.null().optional() }).safeParse(data);
  return zeroHits.success ? { SearchResultsCount: 0, Products: [] } : parseShape(searchResponse, data);
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
    products: data.Products.flatMap((group) => group.Products),
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

// The detail response also carries this session's trolley state, purchase history and tracking data,
// on the product and on every product record nested in it. Only the fields named here are kept, down
// to the leaves, so none of that, and nothing Woolworths adds later, can reach the result or the cache.
// Nested product records are cut to search tiles.
const productDetail = pick(
  [
    "Stockcode", "Barcode", "Name", "DisplayName", "Brand", "Description", "FullDescription", "RichDescription",
    "Variety", "PackageSize", "Unit", "UnitWeightInGrams", "MinimumQuantity", "SupplyLimit", "ProductLimit",
    "Price", "WasPrice", "SavingsAmount", "CupPrice", "CupMeasure", "CupString", "PricePerKGLabel",
    "MinWeightPrice", "MaxWeightPrice", "InstorePrice", "InstoreWasPrice", "InstoreCupString", "IsOnSpecial",
    "IsHalfPrice", "IsEdrSpecial", "InstoreIsOnSpecial", "IsNew", "IsAvailable", "IsInStock", "IsPurchasable",
    "IsRanged", "InstoreIsAvailable", "IsForDelivery", "IsForCollection", "IsForExpress", "IsOnlineOnly",
    "NextAvailabilityDate", "AgeRestricted", "ProductRestrictionMessage", "ProductWarningMessage",
    "IsMarketProduct", "Vendor", "IsBundle", "HasVariants", "VariantTitle", "UrlFriendlyName",
    "SmallImageFile", "MediumImageFile", "LargeImageFile",
  ],
  {
    Rating: part(pick([
      "Average", "ReviewCount", "RatingCount", "RatingSum", "OneStarCount", "TwoStarCount", "ThreeStarCount",
      "FourStarCount", "FiveStarCount",
    ])),
    ChildProducts: z.array(productTile).nullish(),
  }
);

// The product attributes a shopper asks about. The rest are the retailer's internal codes and costs.
const PRODUCT_ATTRIBUTES = [
  "description", "brand", "manufacturer", "ingredients", "allergencontains", "allergenmaybepresent",
  "allergystatement", "containsgluten", "containsnuts", "contains", "lifestyleanddietarystatement",
  "lifestyleclaim", "wool_dietaryclaim", "vegetarian", "claims", "healthstarrating", "nutritionalinformation",
  "servingsize-total-nip", "servingsperpack-total-nip", "storageinstructions", "usageinstructions",
  "importantinformation", "suitablefor", "countryoforigin", "freezable", "microwaveable", "ovencook",
  "recyclableinformation", "wool_productpackaging",
];

// Product is null when no product has the stockcode; a 200 without the key is not a product response.
const productDetailResponse = pick(["VideoUrl"], {
  Product: productDetail.nullable(),
  PrimaryCategory: part(pick(["Department", "Aisle"])),
  AdditionalAttributes: part(pick(PRODUCT_ATTRIBUTES)),
  TgaAttributes: part(pick(["Directions", "ProductWarnings", "SuitableFor", "StorageInstructions"])),
  NutritionalInformation: part(
    z.array(
      pick(["Name", "ServingSize", "ServingsPerPack"], {
        Values: part(pick(["Quantity Per Serving", "Quantity Per 100g / 100mL"])),
      })
    )
  ),
  CountryOfOriginLabel: part(pick(["CountryOfOrigin", "IngredientPercentage", "AltText", "Disclaimer"])),
  DetailsImagePaths: part(z.array(z.string())),
  Variants: z.array(productTile).nullish(),
});

async function productUpstream(started: Session, { stockcode }: ProductKey) {
  const url = `${WOOLWORTHS_ORIGIN}/apis/ui/product/detail/${encodeURIComponent(stockcode)}`;
  const data = await makeWoolworthsRequest(started, url, { parse: (body) => parseShape(productDetailResponse, body) });
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

const specialsResponse = z.object({
  TotalRecordCount: z.number().optional(),
  Bundles: z.array(z.object({ Products: z.array(productTile) })),
});

function readSpecials(data: unknown) {
  const { TotalRecordCount, Bundles } = parseShape(specialsResponse, data);
  return {
    totalResults: TotalRecordCount || 0,
    products: Bundles.flatMap((bundle) => bundle.Products),
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
const categoryFields = { NodeId: z.string(), IsSpecial: z.boolean().default(false) };
const category = pick(["Description", "UrlFriendlyName"], categoryFields);
const categoriesResponse = z.object({
  Categories: z.array(
    pick(["Description", "UrlFriendlyName"], { ...categoryFields, Children: z.array(category).default([]) })
  ),
});

function readCategories(data: unknown) {
  const plain = <C extends { IsSpecial: boolean }>(list: C[]) => list.filter((node) => !node.IsSpecial);
  const slim = ({ NodeId, Description, UrlFriendlyName }: z.output<typeof category>) =>
    defined({ NodeId, Description, UrlFriendlyName });
  return plain(parseShape(categoriesResponse, data).Categories).map((node) => ({
    ...slim(node),
    Children: plain(node.Children).map(slim),
  }));
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
const trolleyItems = z.object({
  AvailableItems: z.array(z.object({ Stockcode: z.unknown().optional(), Quantity: z.unknown().optional() })),
});

function readTrolleyItems(data: unknown) {
  const parsed = trolleyItems.safeParse(data);
  if (!parsed.success) {
    throw new Error("Trolley read returned no AvailableItems array; nothing was added.");
  }
  return parsed.data.AvailableItems;
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
    const message = errorMessage(error);
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
