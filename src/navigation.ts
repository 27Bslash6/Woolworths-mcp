// Returns `raw` parsed if it is an https URL on woolworths.com.au or a subdomain; throws otherwise.
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
  // Parsed hostname, not the raw string; empty labels (".woolworths.com.au") must fail the suffix test.
  const host = target.hostname.replace(/\.$/, "");
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
