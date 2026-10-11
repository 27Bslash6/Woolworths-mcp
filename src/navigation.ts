// The browser tab holds a live authenticated Woolworths session, and every tool in this server is
// Woolworths-only, so there is no legitimate off-domain navigation to preserve. Kept out of
// index.ts so it can be exercised without starting the server.

// Parses `raw` and returns it only if it is an https URL on woolworths.com.au or a subdomain;
// otherwise throws an error naming the reason.
export function assertWoolworthsUrl(raw: string): URL {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new Error("Navigation blocked: url is not a valid absolute URL");
  }
  if (target.protocol !== "https:") {
    throw new Error(
      `Navigation blocked: only https is allowed (got "${target.protocol}")`
    );
  }
  // Compare against the parsed hostname, never the raw string: a substring test would accept
  // https://woolworths.com.au.evil.com/ and userinfo like https://woolworths.com.au@evil.com/.
  // A single trailing dot is the legal absolute-root form of the same host; an empty label
  // anywhere (".woolworths.com.au", "a..b") is not, and must not pass the suffix test.
  const host = target.hostname.replace(/\.$/, "").toLowerCase();
  const labelsValid = host.split(".").every((label) => label.length > 0);
  const allowed =
    labelsValid &&
    (host === "woolworths.com.au" || host.endsWith(".woolworths.com.au"));
  if (!allowed) {
    throw new Error(
      `Navigation blocked: "${host}" is not a woolworths.com.au host`
    );
  }
  return target;
}
