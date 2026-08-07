import type { Session } from "electron";

/**
 * Keeps emote images in Chromium's cache for longer than their host asks.
 *
 * 7TV serves every emote image with `max-age=10`, alongside `immutable` — a
 * contradiction, and almost certainly not what was meant. Taken at its word it
 * means an emote is thrown out of the cache ten seconds after it arrives, so a
 * busy chat downloads the same handful of images over and over: the emotes
 * visibly reload, and 7TV carries traffic nobody wanted to send it. The other
 * services get this right — BetterTTV asks for a hundred and eighty days,
 * FrankerFaceZ for one — and are left alone.
 *
 * An emote image is addressed by the emote's id and the size wanted, and a
 * changed emote is a new id, so holding one for a month is safe. Chat settings
 * can empty the cache if an image ever does need fetching again.
 */

const OVERRIDDEN_HOSTS = new Set(["cdn.7tv.app"]);
const KEEP_FOR_SECONDS = 30 * 24 * 60 * 60;

export function applyEmoteCachePolicy(target: Session): void {
  target.webRequest.onHeadersReceived(
    { urls: ["https://cdn.7tv.app/*"] },
    (details, callback) => {
      let host: string;
      try {
        host = new URL(details.url).hostname;
      } catch {
        callback({});
        return;
      }
      if (!OVERRIDDEN_HOSTS.has(host)) {
        callback({});
        return;
      }
      // Header names arrive in whatever case the server used, so the existing
      // one is removed by matching case-insensitively rather than by guessing.
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
        if (name.toLowerCase() === "cache-control") continue;
        if (name.toLowerCase() === "expires") continue;
        headers[name] = value;
      }
      headers["cache-control"] = [`public, max-age=${KEEP_FOR_SECONDS}, immutable`];
      callback({ responseHeaders: headers });
    },
  );
}
