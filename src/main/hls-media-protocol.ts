import type { Session } from "electron";

import type { Platform } from "../shared/platform";
import type {
  HlsMediaResource,
  HlsMediaResourceResolver,
  HlsMediaTransport,
} from "./hls-media-transport";

export const HLS_MEDIA_SCHEME = "violetwire-media";

const SESSION_TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const RESOURCE_ID_PATTERN = /^[a-f0-9]{32}$/;

function playbackHeaders(
  platform: Platform,
  request: Request,
): Record<string, string> {
  const headers: Record<string, string> =
    platform === "kick"
      ? { Origin: "https://kick.com", Referer: "https://kick.com/" }
      : {
          Origin: "https://player.twitch.tv",
          Referer: "https://player.twitch.tv/",
        };
  const range = request.headers.get("range");
  if (range) headers.Range = range;
  return headers;
}

function safeUpstreamUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges",
    // This is the header that was filling the disk. Each segment handed to the
    // player was marked cacheable, so Chromium kept a copy in the interface's
    // own cache — around two gigabytes an hour of video that is watched once
    // and never asked for again, crowding out the emote and avatar images that
    // share that cache. The player holds its own buffer; nothing needs a
    // segment a second time.
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  for (const name of [
    "accept-ranges",
    "content-length",
    "content-range",
    "content-type",
    "etag",
    "last-modified",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has("content-type")) headers.set("content-type", "video/mp4");
  return headers;
}

export class HlsMediaProtocol implements HlsMediaTransport {
  readonly name = "chromium-protocol" as const;
  private readonly sessions = new Map<string, HlsMediaResourceResolver>();
  private browserSession: Session | null = null;
  /**
   * Where the upstream video is fetched from, which is deliberately not the
   * session the interface runs in. Chromium stored every segment there — two
   * gigabytes an hour of video nobody will ever ask for again — and pushed the
   * emote and avatar images out to make room. Neither asking for `no-store` on
   * the fetch nor rewriting the response headers stops it: the first is ignored
   * by Electron, and the second happens after Chromium has already decided what
   * to store. A session with its cache switched off does stop it.
   */
  private upstreamSession: Session | null = null;
  private initialized = false;

  get ready(): boolean {
    return this.initialized && this.browserSession !== null;
  }

  async initialize(
    browserSession: Session,
    upstreamSession: Session = browserSession,
  ): Promise<void> {
    if (this.initialized) return;
    this.browserSession = browserSession;
    this.upstreamSession = upstreamSession;
    try {
      await browserSession.protocol.handle(HLS_MEDIA_SCHEME, (request) =>
        this.handleRequest(request),
      );
      this.initialized = true;
    } catch (error) {
      this.browserSession = null;
      throw error;
    }
  }

  registerSession(
    sessionToken: string,
    resolveResource: HlsMediaResourceResolver,
  ): () => void {
    if (!this.ready || !SESSION_TOKEN_PATTERN.test(sessionToken)) {
      throw new Error("The Chromium HLS media transport is unavailable.");
    }
    this.sessions.set(sessionToken, resolveResource);
    return () => {
      if (this.sessions.get(sessionToken) === resolveResource) {
        this.sessions.delete(sessionToken);
      }
    };
  }

  resourceUrl(sessionToken: string, resourceId: string): string {
    if (
      !SESSION_TOKEN_PATTERN.test(sessionToken) ||
      !RESOURCE_ID_PATTERN.test(resourceId)
    ) {
      throw new Error("Invalid HLS media resource identifier.");
    }
    return `${HLS_MEDIA_SCHEME}://hls/${sessionToken}/${resourceId}`;
  }

  async close(): Promise<void> {
    this.sessions.clear();
    const browserSession = this.browserSession;
    this.browserSession = null;
    this.upstreamSession = null;
    this.initialized = false;
    if (browserSession) {
      try {
        browserSession.protocol.unhandle(HLS_MEDIA_SCHEME);
      } catch {
        // The session can already be torn down during Electron shutdown.
      }
    }
  }

  private resolveRequest(request: Request): HlsMediaResource | null {
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return null;
    }
    if (url.protocol !== `${HLS_MEDIA_SCHEME}:` || url.hostname !== "hls") {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      parts.length !== 2 ||
      !SESSION_TOKEN_PATTERN.test(parts[0]) ||
      !RESOURCE_ID_PATTERN.test(parts[1])
    ) {
      return null;
    }
    const resource = this.sessions.get(parts[0])?.(parts[1]) ?? null;
    return resource && safeUpstreamUrl(resource.url) ? resource : null;
  }

  private async fetchUpstream(
    resource: HlsMediaResource,
    request: Request,
  ): Promise<Response> {
    const headers = playbackHeaders(resource.platform, request);
    const fetchSession = this.upstreamSession ?? this.browserSession;
    if (!fetchSession)
      throw new Error("Chromium HLS transport is unavailable.");

    try {
      const chromiumResponse = await fetchSession.fetch(resource.url, {
        method: request.method,
        headers,
        bypassCustomProtocolHandlers: true,
        signal: request.signal,
      });
      if (chromiumResponse.ok || chromiumResponse.status === 206) {
        return chromiumResponse;
      }
      await chromiumResponse.body?.cancel().catch(() => undefined);
    } catch {
      // Fall through to Node's standards-based fetch. This is intentionally a
      // compatibility path: it still returns a streaming Response through the
      // custom protocol and never restores the old manual localhost copy loop.
    }

    return fetch(resource.url, {
      method: request.method,
      headers,
      signal: request.signal,
    });
  }

  private async handleRequest(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Headers": "Range",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
    const resource = this.resolveRequest(request);
    if (!resource) {
      return new Response("Media resource not found.", {
        status:
          request.method === "GET" || request.method === "HEAD" ? 404 : 405,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    try {
      const upstream = await this.fetchUpstream(resource, request);
      if (!upstream.ok && upstream.status !== 206) {
        return new Response("Media resource unavailable.", {
          status: upstream.status || 502,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "text/plain; charset=utf-8",
          },
        });
      }
      return new Response(request.method === "HEAD" ? null : upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders(upstream),
      });
    } catch {
      return new Response("Unable to fetch media resource.", {
        status: 502,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }
  }
}

export const hlsMediaProtocol = new HlsMediaProtocol();
