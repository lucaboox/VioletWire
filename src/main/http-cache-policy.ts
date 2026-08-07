import type { Session } from "electron";

import { HTTP_CACHE_LIMIT_BYTES } from "../shared/http-cache";

/**
 * How long the interface's session is asked to hold emote images, and how big
 * its cache may get.
 *
 * 7TV serves emote images with `max-age=10` alongside `immutable` — a
 * contradiction, and taken at its word it means an emote is thrown out ten
 * seconds after it arrives. An emote image is addressed by the emote's id and
 * the size wanted, and a changed emote is a new id, so a month is safe.
 * BetterTTV asks for a hundred and eighty days and FrankerFaceZ for one; they
 * get this right and are left alone.
 *
 * Note what this mechanism cannot do: it cannot stop something being cached.
 * Rewriting a response header here happens after Chromium has decided what to
 * store — measured by setting `no-store` on video segments and finding them in
 * the cache anyway. Keeping video out is done by fetching it from a session
 * with no cache at all, in hls-media-protocol.
 */

const EMOTE_HOSTS = new Set(["cdn.7tv.app"]);
const KEEP_EMOTES_FOR_SECONDS = 30 * 24 * 60 * 60;

export type CacheDecision = "keep-long" | "leave-alone";

/**
 * The rule for one response. Separated from the plumbing so the decision can be
 * read and tested on its own.
 */
export function cacheDecisionFor(rawUrl: string): CacheDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "leave-alone";
  }
  return EMOTE_HOSTS.has(url.hostname) ? "keep-long" : "leave-alone";
}

/** Rewrites the caching headers a response arrived with, per the rules above. */
export function rewriteCacheHeaders(
  headers: Record<string, string | string[]> | undefined,
): Record<string, string | string[]> {
  const rewritten: Record<string, string | string[]> = {};
  // Header names arrive in whatever case the server used, so the existing ones
  // are dropped by matching case-insensitively rather than by guessing.
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower === "cache-control" || lower === "expires" || lower === "pragma") {
      continue;
    }
    rewritten[name] = value;
  }
  rewritten["cache-control"] = [
    `public, max-age=${KEEP_EMOTES_FOR_SECONDS}, immutable`,
  ];
  return rewritten;
}

export function applyHttpCachePolicy(target: Session): void {
  // Narrowed to the one host it concerns, so nothing else pays for a callback.
  target.webRequest.onHeadersReceived(
    { urls: ["https://cdn.7tv.app/*"] },
    (details, callback) => {
      if (cacheDecisionFor(details.url) === "leave-alone") {
        callback({});
        return;
      }
      callback({ responseHeaders: rewriteCacheHeaders(details.responseHeaders) });
    },
  );
}

/**
 * Keeps the cache from growing without end.
 *
 * Chromium's own `--disk-cache-size` was measured having no effect on a session
 * made from a partition: with it set to 25 MB the cache passed 240 MB and was
 * still climbing. So the ceiling is kept here instead. Electron offers no way
 * to drop just the oldest entries, so reaching the limit empties the cache and
 * it fills again from use — acceptable because everything in it is artwork that
 * refetches in milliseconds, and because with video no longer stored it should
 * take a very long time to get there at all.
 */
export function enforceHttpCacheLimit(
  target: Session,
  intervalMs = 15 * 60_000,
): () => void {
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      if ((await target.getCacheSize()) > HTTP_CACHE_LIMIT_BYTES) {
        await target.clearCache();
      }
    } catch {
      // Measuring the cache is best effort; a failure here must not take the
      // app down, and the next check will try again.
    } finally {
      checking = false;
    }
  };
  void check();
  const timer = setInterval(() => void check(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
