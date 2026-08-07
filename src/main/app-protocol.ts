import type { Session } from "electron";
import { stat } from "node:fs/promises";
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
    codeCache: true,
  },
};

const textHeaders = {
  "Content-Type": "text/plain; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

function textResponse(
  body: string,
  status: number,
  extraHeaders?: HeadersInit,
): Response {
  return new Response(body, {
    status,
    headers: { ...textHeaders, ...extraHeaders },
  });
}

export function resolveAppAssetPath(
  rendererDirectory: string,
  encodedPathname: string,
): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(encodedPathname);
  } catch {
    return null;
  }

  const root = path.resolve(rendererDirectory);
  const relativePath =
    pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`))
    return null;
  return filePath;
}

/**
 * Registered against the session the interface actually runs in. A scheme
 * handled on the default session does not exist inside a partition, and the
 * window would have nothing to load.
 */
export function registerAppProtocol(
  target: Session,
  rendererDirectory: string,
  readKickBadge: (name: string) => Promise<Uint8Array | null>,
  readEmoteImage: (
    url: string,
  ) => Promise<{ bytes: Uint8Array; contentType: string } | null>,
): void {
  target.protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse("Method not allowed", 405, { Allow: "GET, HEAD" });
    }

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return textResponse("Bad request", 400);
    }
    // Only the one scheme and authority serve anything. Reject credentials and
    // ports as well so lookalike app URLs cannot become another trusted origin.
    if (
      url.protocol !== `${APP_SCHEME}:` ||
      url.host !== "app" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return textResponse("Not found", 404);
    }

    let requested: string;
    try {
      requested = decodeURIComponent(url.pathname);
    } catch {
      return textResponse("Bad request", 400);
    }
    // Emote artwork is kept in the app's own store rather than left to
    // Chromium's cache, where the video the player fetches would evict it. The
    // address wanted is carried as a parameter and checked against a list of
    // hosts before anything is fetched.
    if (requested === "/emote") {
      const source = url.searchParams.get("src");
      const image = source ? await readEmoteImage(source) : null;
      if (!image) return textResponse("Not found", 404);
      return new Response(
        request.method === "HEAD" ? null : new Uint8Array(image.bytes),
        {
          headers: {
            // Long-lived on purpose: an emote image is addressed by its id and
            // size, so it never changes meaning. Chromium keeping its own copy
            // saves reaching the store at all, and losing that copy costs only
            // a local read.
            "Cache-Control": "private, max-age=2592000, immutable",
            "Content-Length": String(image.bytes.byteLength),
            "Content-Type": image.contentType,
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    }

    // Kick badge artwork is kept in the app's own data rather than fetched
    // from its publisher every time, so it is served from there.
    const badge = /^\/kick-badges\/([a-z0-9_]+)\.svg$/i.exec(requested);
    if (badge) {
      const bytes = await readKickBadge(badge[1]);
      if (!bytes) return textResponse("Not found", 404);
      return new Response(
        request.method === "HEAD" ? null : new Uint8Array(bytes),
        {
          headers: {
            "Cache-Control": "private, max-age=604800",
            "Content-Length": String(bytes.byteLength),
            "Content-Type": "image/svg+xml",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    }

    const filePath = resolveAppAssetPath(rendererDirectory, url.pathname);
    if (!filePath) return textResponse("Not found", 404);

    try {
      const file = await stat(filePath);
      if (!file.isFile()) return textResponse("Not found", 404);
      const fileResponse = await target.fetch(
        pathToFileURL(filePath).toString(),
        {
          method: request.method,
          bypassCustomProtocolHandlers: true,
        },
      );
      if (!fileResponse.ok) return textResponse("Not found", 404);

      const headers = new Headers(fileResponse.headers);
      headers.set(
        "Cache-Control",
        requested.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      );
      headers.set("Content-Length", String(file.size));
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(
        request.method === "HEAD" ? null : fileResponse.body,
        {
          status: fileResponse.status,
          statusText: fileResponse.statusText,
          headers,
        },
      );
    } catch {
      return textResponse("Not found", 404);
    }
  });
}
