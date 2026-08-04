import { net } from "electron";
import type { Session } from "electron";
import { readCachedKickBadge } from "./kick-badge-cache";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Serves the built interface from an address of the app's own.
 *
 * It used to come from a local web server listening on a port the system
 * picked, which meant the interface had a different origin every launch —
 * anything the page stored against that origin was thrown away each time — and
 * that address is what Chromium shows in windows it labels, such as picture in
 * picture. A scheme of our own is fixed, so storage survives and the label
 * reads as the app.
 */

export const APP_SCHEME = "violetwire";
export const APP_ORIGIN = `${APP_SCHEME}://app`;

/** Must be registered before the app is ready, alongside the media scheme. */
export const appProtocolPrivileges = {
  scheme: APP_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
  },
};

/**
 * Registered against the session the interface actually runs in. A scheme
 * handled on the default session does not exist inside a partition, and the
 * window would have nothing to load.
 */
export function registerAppProtocol(
  target: Session,
  rendererDirectory: string,
): void {
  target.protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    // Only the one host serves anything, and a single page backs every route.
    if (url.hostname !== "app") return new Response("Not found", { status: 404 });
    const requested = decodeURIComponent(url.pathname);
    // Kick badge artwork is kept in the app's own data rather than fetched
    // from its publisher every time, so it is served from there.
    const badge = /^\/kick-badges\/([a-z0-9_]+)\.svg$/i.exec(requested);
    if (badge) {
      const bytes = await readCachedKickBadge(badge[1]);
      if (!bytes) return new Response("Not found", { status: 404 });
      return new Response(new Uint8Array(bytes), {
        headers: { "Content-Type": "image/svg+xml" },
      });
    }
    const relative = requested === "/" ? "/index.html" : requested;
    const target = path.join(rendererDirectory, relative);
    // Keep a path built from the address inside the directory being served.
    const root = path.resolve(rendererDirectory);
    if (path.resolve(target) !== root && !path.resolve(target).startsWith(root + path.sep)) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });
}
