/**
 * Points an emote image at the app's own store instead of straight at the
 * service that publishes it.
 *
 * Fetched directly, an emote lands in Chromium's cache, where it competes with
 * the video the player is pulling — measured at around two gigabytes an hour,
 * enough to push every emote back out within minutes and leave chat fetching
 * the same handful over and over. Asked for through the app's own address, it
 * is fetched once, kept in a store with its own size limit, and read from disk
 * afterwards.
 *
 * The addresses are unchanged while developing, where the interface is served
 * over http by Vite and the app scheme is not registered.
 */

const APP_ORIGIN = "violetwire://app";

function storeAvailable(): boolean {
  try {
    return window.location.protocol === "violetwire:";
  } catch {
    return false;
  }
}

export function emoteImageUrl(remoteUrl: string): string {
  if (!remoteUrl.startsWith("https://")) return remoteUrl;
  if (!storeAvailable()) return remoteUrl;
  return `${APP_ORIGIN}/emote?src=${encodeURIComponent(remoteUrl)}`;
}
