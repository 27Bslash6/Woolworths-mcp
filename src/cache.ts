import { createCache, type Cache } from "@cachekit-io/cachekit";
import { file } from "@cachekit-io/cachekit/backends/file";
import { homedir } from "node:os";
import { join } from "node:path";

// Overrides where read-only API results are cached on disk.
export const CACHE_DIR_ENV = "WOOLWORTHS_MCP_CACHE_DIR";

export function cacheDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env[CACHE_DIR_ENV];
  if (override) {
    return override;
  }
  const base =
    platform === "win32"
      ? env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
      : env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "woolworths-mcp");
}

// Created on first use, so starting the server touches no disk. Metrics stay off: the production
// preset would otherwise log an error on every start without prom-client installed.
let cache: Cache | null = null;

export function getCache(): Cache {
  cache ??= createCache.production({
    backend: file({ cacheDir: cacheDir() }),
    l1: { swrEnabled: false },
    metrics: false,
  });
  return cache;
}

export async function resetCache(): Promise<void> {
  const closing = cache;
  cache = null;
  await closing?.close();
}

const sydneyDate = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Sydney",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

// Prices and specials change with the weekly catalogue, which starts on Wednesday. Returns the ISO
// date of the latest Wednesday 00:00 in Sydney at `now`; it is part of every price-bearing cache key.
export function catalogueWeek(now = new Date()): string {
  const part = (type: string) => Number(sydneyDate.formatToParts(now).find((p) => p.type === type)?.value);
  const day = new Date(Date.UTC(part("year"), part("month") - 1, part("day")));
  // getUTCDay: Sunday 0 … Wednesday 3, so (weekday + 4) % 7 is the days since Wednesday.
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 4) % 7));
  return day.toISOString().slice(0, 10);
}
