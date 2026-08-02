import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";

import type { Platform } from "../shared/platform";
import type { HlsMediaTransport } from "./hls-media-transport";

interface AdRange {
  start: number;
  end: number;
}

interface ParsedSegment {
  uri: string;
  duration: number;
  title: string;
  date?: number;
  discontinuity: boolean;
  tags: string[];
  ad: boolean;
  prefetch: boolean;
}

interface RelaySegment {
  sequence: number;
  duration: number;
  lines: string[];
  sourceUri: string;
  uri: string;
  prefetch: boolean;
}

interface ResourceEntry {
  url: string;
  lastUsedAt: number;
}

interface ParsedPlaylist {
  version: number;
  targetDuration: number;
  segments: ParsedSegment[];
}

// The renderer polls this localhost playlist at the media cadence. A short
// cache still coalesces simultaneous requests without keeping a newly arrived
// Twitch segment hidden for most of another second.
const PLAYLIST_CACHE_MS = 300;
const RESOURCE_TTL_MS = 2 * 60_000;
const MAX_RELAY_SEGMENTS = 18;

export function isDirectTwitchMediaUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return false;
    return ["ttvnw.net", "twitchcdn.net"].some(
      (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}
function getPlaybackHeaders(platform: Platform): Record<string, string> {
  if (platform === "kick") {
    return {
      Origin: "https://kick.com",
      Referer: "https://kick.com/",
    };
  }

  return {
    Origin: "https://player.twitch.tv",
    Referer: "https://player.twitch.tv/",
  };
}

function parseAttributeList(value: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let start = 0;
  let quoted = false;
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index];
    if (character === '"') quoted = !quoted;
    if (index < value.length && (character !== "," || quoted)) continue;
    const part = value.slice(start, index);
    const separator = part.indexOf("=");
    if (separator > 0) {
      const key = part.slice(0, separator).trim().toUpperCase();
      const raw = part.slice(separator + 1).trim();
      attributes.set(
        key,
        raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw,
      );
    }
    start = index + 1;
  }
  return attributes;
}

function parseDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : undefined;
}

function parseAdRanges(lines: string[]): AdRange[] {
  const ranges: AdRange[] = [];
  for (const line of lines) {
    if (!line.startsWith("#EXT-X-DATERANGE:")) continue;
    const attributes = parseAttributeList(line.slice("#EXT-X-DATERANGE:".length));
    const id = attributes.get("ID") ?? "";
    const className = attributes.get("CLASS") ?? "";
    if (className !== "twitch-stitched-ad" && !id.startsWith("stitched-ad-")) continue;
    const start = parseDate(attributes.get("START-DATE"));
    if (start === undefined) continue;
    const explicitEnd = parseDate(attributes.get("END-DATE"));
    const duration = Number.parseFloat(
      attributes.get("DURATION") ?? attributes.get("PLANNED-DURATION") ?? "",
    );
    const end =
      explicitEnd ??
      (Number.isFinite(duration) && duration > 0 ? start + duration * 1_000 : start);
    ranges.push({ start, end });
  }
  return ranges;
}

export function parseTwitchMediaPlaylist(
  text: string,
  playlistUrl: string,
  includePrefetch = true,
): ParsedPlaylist {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const adRanges = parseAdRanges(lines);
  const versionLine = lines.find((line) => line.startsWith("#EXT-X-VERSION:"));
  const targetLine = lines.find((line) => line.startsWith("#EXT-X-TARGETDURATION:"));
  const version = Math.max(3, Number.parseInt(versionLine?.split(":")[1] ?? "6", 10) || 6);
  const targetDuration = Math.max(
    1,
    Number.parseFloat(targetLine?.split(":")[1] ?? "6") || 6,
  );
  const segments: ParsedSegment[] = [];
  let segmentTags: string[] = [];
  let duration: number | undefined;
  let title = "";
  let date: number | undefined;
  let discontinuity = false;
  let currentMapTag: string | undefined;
  let currentKeyTag: string | undefined;

  const appendPrefetchSegment = (rawUri: string): void => {
    if (segments.length === 0) return;
    const completedSegments = segments.filter((segment) => !segment.prefetch);
    const durationSource = completedSegments.length > 0 ? completedSegments : segments;
    const inferredDuration =
      durationSource.reduce((total, segment) => total + segment.duration, 0) /
      durationSource.length;
    if (!Number.isFinite(inferredDuration) || inferredDuration <= 0) return;
    const previous = segments.at(-1)!;
    const inferredDate =
      previous.date === undefined
        ? undefined
        : previous.date + previous.duration * 1_000;
    const ad =
      discontinuity ||
      (inferredDate !== undefined &&
        adRanges.some(
          (range) => inferredDate >= range.start && inferredDate < range.end,
        ));
    const prefetchTags = [
      ...(currentKeyTag ? [currentKeyTag] : []),
      ...(currentMapTag ? [currentMapTag] : []),
      ...(inferredDate === undefined
        ? []
        : [`#EXT-X-PROGRAM-DATE-TIME:${new Date(inferredDate).toISOString()}`]),
      `#EXTINF:${inferredDuration.toFixed(3)},live`,
    ];
    segments.push({
      uri: new URL(rawUri, playlistUrl).toString(),
      duration: inferredDuration,
      title: "live",
      date: inferredDate,
      discontinuity,
      tags: prefetchTags,
      ad,
      prefetch: true,
    });
  };

  for (const line of lines) {
    if (line === "#EXT-X-DISCONTINUITY") {
      discontinuity = true;
      continue;
    }
    if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      date = parseDate(line.slice("#EXT-X-PROGRAM-DATE-TIME:".length));
      segmentTags.push(line);
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      const value = line.slice("#EXTINF:".length);
      const comma = value.indexOf(",");
      duration = Number.parseFloat(comma >= 0 ? value.slice(0, comma) : value);
      title = comma >= 0 ? value.slice(comma + 1) : "";
      segmentTags.push(line);
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      currentMapTag = line;
      continue;
    }
    if (line.startsWith("#EXT-X-KEY:")) {
      currentKeyTag = line;
      continue;
    }
    if (line.startsWith("#EXT-X-BYTERANGE:") || line === "#EXT-X-GAP") {
      segmentTags.push(line);
      continue;
    }
    if (line.startsWith("#EXT-X-TWITCH-PREFETCH:")) {
      if (includePrefetch) {
        appendPrefetchSegment(line.slice("#EXT-X-TWITCH-PREFETCH:".length));
      }
      continue;
    }
    if (line.startsWith("#")) continue;
    if (duration === undefined || !Number.isFinite(duration)) continue;

    const absoluteUri = new URL(line, playlistUrl).toString();
    const ad =
      title.includes("Amazon") ||
      (date !== undefined &&
        adRanges.some((range) => date! >= range.start && date! < range.end));
    segments.push({
      uri: absoluteUri,
      duration,
      title,
      date,
      discontinuity,
      tags: [
        ...(currentKeyTag ? [currentKeyTag] : []),
        ...(currentMapTag ? [currentMapTag] : []),
        ...segmentTags,
      ],
      ad,
      prefetch: false,
    });
    segmentTags = [];
    duration = undefined;
    title = "";
    date = undefined;
    discontinuity = false;
  }

  return { version, targetDuration, segments };
}

function rewriteTagUri(
  line: string,
  playlistUrl: string,
  registerResource: (url: string) => string,
): string {
  return line.replace(/URI="([^"]+)"/, (_match, uri: string) => {
    const absolute = new URL(uri, playlistUrl).toString();
    return `URI="${registerResource(absolute)}"`;
  });
}

function writeText(
  response: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(body);
}

export class FilteredHlsRelay {
  private server: Server | null = null;
  private port = 0;
  private readonly sessionToken = randomUUID().replaceAll("-", "");
  private readonly resources = new Map<string, ResourceEntry>();
  private readonly resourceIds = new Map<string, string>();
  private readonly segmentSequences = new Map<string, number>();
  private readonly relaySegments: RelaySegment[] = [];
  private nextSequence = 0;
  private sourceUrl: string | null = null;
  private playlistCache: { expiresAt: number; body: string } | null = null;
  private playlistRequest: Promise<string> | null = null;
  private pendingDiscontinuity = false;
  private closed = false;
  private readonly abortControllers = new Set<AbortController>();
  private unregisterMediaSession: (() => void) | null = null;
  private useMediaTransport = false;
  private useDirectMedia = false;

  constructor(
    private readonly getAllowedOrigin: () => string | null,
    private readonly platform: Platform = "twitch",
    private readonly options: {
      includePrefetch?: boolean;
      directMedia?: boolean;
      mediaTransport?: HlsMediaTransport;
    } = {},
  ) {}

  get mediaTransportName():
    | "direct-cdn"
    | "chromium-protocol"
    | "localhost-relay" {
    if (this.useDirectMedia) return "direct-cdn";
    return this.useMediaTransport ? "chromium-protocol" : "localhost-relay";
  }

  async start(sourceUrl: string): Promise<string> {
    this.sourceUrl = sourceUrl;
    this.useDirectMedia =
      this.platform === "twitch" && this.options.directMedia === true;
    const transport = this.options.mediaTransport;
    if (!this.useDirectMedia && transport?.ready) {
      try {
        this.unregisterMediaSession = transport.registerSession(
          this.sessionToken,
          (resourceId) => {
            const entry = this.resources.get(resourceId);
            if (!entry || Date.now() - entry.lastUsedAt > RESOURCE_TTL_MS) return null;
            entry.lastUsedAt = Date.now();
            return { platform: this.platform, url: entry.url };
          },
        );
        this.useMediaTransport = true;
      } catch {
        // The existing localhost resource endpoint remains a tested fallback
        // if Electron cannot register or service the custom protocol.
        this.unregisterMediaSession = null;
        this.useMediaTransport = false;
      }
    }
    if (!this.server) await this.listen();
    return `http://127.0.0.1:${this.port}/${this.sessionToken}/index.m3u8`;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unregisterMediaSession?.();
    this.unregisterMediaSession = null;
    for (const controller of this.abortControllers) controller.abort();
    this.abortControllers.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async listen(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to start the filtered HLS relay.");
    }
    this.port = address.port;
  }

  private async handleRequest(
    request: import("node:http").IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const host = request.headers.host ?? "";
    const allowedOrigin = this.getAllowedOrigin();
    const requestOrigin = request.headers.origin;
    if (
      !new RegExp(`^127\\.0\\.0\\.1:${this.port}$`).test(host) ||
      (requestOrigin && requestOrigin !== allowedOrigin)
    ) {
      writeText(response, 403, "Forbidden");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      writeText(response, 405, "Method not allowed", { Allow: "GET, HEAD" });
      return;
    }

    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", `http://${host}`).pathname;
    } catch {
      writeText(response, 400, "Bad request");
      return;
    }
    const prefix = `/${this.sessionToken}/`;
    if (!pathname.startsWith(prefix)) {
      writeText(response, 404, "Not found");
      return;
    }
    const corsHeaders: Record<string, string> = allowedOrigin
      ? { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" }
      : {};
    if (pathname === `${prefix}index.m3u8`) {
      try {
        const body = await this.getPlaylist();
        response.writeHead(200, {
          ...corsHeaders,
          "Cache-Control": "no-store",
          "Content-Type": "application/vnd.apple.mpegurl",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(request.method === "HEAD" ? undefined : body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Playlist unavailable";
        writeText(response, 503, message, {
          ...corsHeaders,
          "Retry-After": "1",
        });
      }
      return;
    }

    const resourceMatch = new RegExp(`^/${this.sessionToken}/resource/([a-f0-9]{32})$`).exec(
      pathname,
    );
    if (!resourceMatch) {
      writeText(response, 404, "Not found");
      return;
    }
    const entry = this.resources.get(resourceMatch[1]);
    if (!entry || Date.now() - entry.lastUsedAt > RESOURCE_TTL_MS) {
      writeText(response, 404, "Expired media resource", corsHeaders);
      return;
    }
    entry.lastUsedAt = Date.now();
    const controller = new AbortController();
    this.abortControllers.add(controller);
    try {
      const upstream = await fetch(entry.url, {
        headers: {
          ...getPlaybackHeaders(this.platform),
          ...(request.headers.range ? { Range: request.headers.range } : {}),
        },
        signal: controller.signal,
      });
      if (!upstream.ok || !upstream.body) {
        writeText(response, upstream.status || 502, "Media resource unavailable", corsHeaders);
        return;
      }
      const headers: Record<string, string> = {
        ...corsHeaders,
        "Cache-Control": "private, max-age=30",
        "Content-Type": upstream.headers.get("content-type") ?? "video/mp4",
        "X-Content-Type-Options": "nosniff",
      };
      const length = upstream.headers.get("content-length");
      if (length) headers["Content-Length"] = length;
      const contentRange = upstream.headers.get("content-range");
      if (contentRange) headers["Content-Range"] = contentRange;
      const acceptRanges = upstream.headers.get("accept-ranges");
      if (acceptRanges) headers["Accept-Ranges"] = acceptRanges;
      response.writeHead(upstream.status, headers);
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const abortOnDownstreamClose = () => {
        if (!response.writableEnded) controller.abort();
      };
      request.once("aborted", abortOnDownstreamClose);
      response.once("close", abortOnDownstreamClose);
      const reader = upstream.body.getReader();
      try {
        while (!this.closed && !response.destroyed) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!response.write(value)) {
            await new Promise<void>((resolve, reject) => {
              const cleanup = () => {
                response.off("drain", onDrain);
                response.off("close", onClose);
                response.off("error", onError);
              };
              const onDrain = () => {
                cleanup();
                resolve();
              };
              const onClose = () => {
                cleanup();
                reject(new Error("Media consumer disconnected."));
              };
              const onError = (error: Error) => {
                cleanup();
                reject(error);
              };
              response.once("drain", onDrain);
              response.once("close", onClose);
              response.once("error", onError);
            });
          }
        }
        if (!response.destroyed) response.end();
      } finally {
        request.off("aborted", abortOnDownstreamClose);
        response.off("close", abortOnDownstreamClose);
        controller.abort();
      }
    } catch (error) {
      if (!response.headersSent) {
        writeText(
          response,
          502,
          error instanceof Error && error.name !== "AbortError"
            ? "Unable to fetch media resource"
            : "Media request ended",
          corsHeaders,
        );
      } else {
        response.destroy();
      }
    } finally {
      this.abortControllers.delete(controller);
    }
  }

  private async getPlaylist(): Promise<string> {
    if (this.closed || !this.sourceUrl) throw new Error("HLS session ended.");
    if (this.playlistCache && this.playlistCache.expiresAt > Date.now()) {
      return this.playlistCache.body;
    }
    if (this.playlistRequest) return this.playlistRequest;
    this.playlistRequest = this.refreshPlaylist();
    try {
      return await this.playlistRequest;
    } finally {
      this.playlistRequest = null;
    }
  }

  private async refreshPlaylist(): Promise<string> {
    const sourceUrl = this.sourceUrl;
    if (!sourceUrl) throw new Error("HLS source is unavailable.");
    const controller = new AbortController();
    this.abortControllers.add(controller);
    try {
      const timeout = setTimeout(() => controller.abort(), 8_000);
      let upstream: Response;
      try {
        upstream = await fetch(sourceUrl, {
          headers: getPlaybackHeaders(this.platform),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!upstream.ok) throw new Error(`Upstream playlist returned ${upstream.status}.`);
      const parsed = parseTwitchMediaPlaylist(
        await upstream.text(),
        sourceUrl,
        this.options.includePrefetch ?? true,
      );
      let filteredAd = false;
      for (const segment of parsed.segments) {
        if (segment.ad) {
          const existingSequence = this.segmentSequences.get(segment.uri);
          if (existingSequence !== undefined) {
            const existingIndex = this.relaySegments.findIndex(
              (candidate) => candidate.sourceUri === segment.uri,
            );
            if (existingIndex >= 0) this.relaySegments.splice(existingIndex, 1);
            this.segmentSequences.delete(segment.uri);
          }
          filteredAd = true;
          this.pendingDiscontinuity = true;
          continue;
        }
        const existingSequence = this.segmentSequences.get(segment.uri);
        if (existingSequence !== undefined) {
          // Twitch exposes an in-progress segment as PREFETCH before the same
          // URI appears as a completed EXTINF entry. Keep its local sequence
          // stable, then replace the inferred metadata with the authoritative
          // completed tags when they arrive.
          if (!segment.prefetch) {
            const existing = this.relaySegments.find(
              (candidate) => candidate.sourceUri === segment.uri,
            );
            if (existing?.prefetch) {
              const completedLines = segment.tags.map((line) =>
                rewriteTagUri(line, sourceUrl, (url) => this.registerResource(url)),
              );
              if (
                segment.discontinuity ||
                existing.lines[0] === "#EXT-X-DISCONTINUITY"
              ) {
                completedLines.unshift("#EXT-X-DISCONTINUITY");
              }
              existing.duration = segment.duration;
              existing.lines = completedLines;
              existing.prefetch = false;
            }
          }
          continue;
        }
        const sequence = this.nextSequence++;
        this.segmentSequences.set(segment.uri, sequence);
        const discontinuity =
          segment.discontinuity || filteredAd || this.pendingDiscontinuity;
        filteredAd = false;
        this.pendingDiscontinuity = false;
        const lines = segment.tags.map((line) =>
          rewriteTagUri(line, sourceUrl, (url) => this.registerResource(url)),
        );
        if (discontinuity) lines.unshift("#EXT-X-DISCONTINUITY");
        this.relaySegments.push({
          sequence,
          duration: segment.duration,
          lines,
          sourceUri: segment.uri,
          uri: this.registerResource(segment.uri),
          prefetch: segment.prefetch,
        });
      }
      while (this.relaySegments.length > MAX_RELAY_SEGMENTS) {
        const removed = this.relaySegments.shift();
        if (removed) this.segmentSequences.delete(removed.sourceUri);
      }
      this.pruneResources();
      if (this.relaySegments.length === 0) {
        throw new Error("Waiting for Twitch content; an advertisement may be playing.");
      }

      const firstSequence = this.relaySegments[0].sequence;
      // Twitch's upstream TARGETDURATION also covers occasional long ad
      // fragments. Those fragments are removed above, so forwarding the old
      // value makes hls.js refresh too slowly. Advertise the longest fragment
      // that is actually present in the playlist we serve.
      const relayTargetDuration = Math.max(
        1,
        Math.ceil(
          this.relaySegments.reduce(
            (maximum, segment) => Math.max(maximum, segment.duration),
            0,
          ),
        ),
      );
      const body = [
        "#EXTM3U",
        `#EXT-X-VERSION:${parsed.version}`,
        `#EXT-X-TARGETDURATION:${relayTargetDuration}`,
        `#EXT-X-MEDIA-SEQUENCE:${firstSequence}`,
        "#EXT-X-INDEPENDENT-SEGMENTS",
        ...this.relaySegments.flatMap((segment) => [
          ...segment.lines,
          segment.uri,
        ]),
        "",
      ].join("\n");
      this.playlistCache = {
        expiresAt: Date.now() + PLAYLIST_CACHE_MS,
        body,
      };
      return body;
    } finally {
      this.abortControllers.delete(controller);
    }
  }

  private registerResource(url: string): string {
    // Twitch's media CDN already grants cross-origin access to browser media
    // requests. Keep the playlist filtering local, but let Chromium download
    // allowlisted media directly instead of copying every byte through Node.
    if (this.useDirectMedia && isDirectTwitchMediaUrl(url)) return url;
    const existingId = this.resourceIds.get(url);
    if (existingId) {
      const existing = this.resources.get(existingId);
      if (existing) existing.lastUsedAt = Date.now();
      return this.resourceLocation(existingId);
    }
    const id = randomUUID().replaceAll("-", "");
    this.resourceIds.set(url, id);
    this.resources.set(id, { url, lastUsedAt: Date.now() });
    return this.resourceLocation(id);
  }

  private resourceLocation(resourceId: string): string {
    return this.useMediaTransport
      ? this.options.mediaTransport!.resourceUrl(this.sessionToken, resourceId)
      : `resource/${resourceId}`;
  }

  private pruneResources(): void {
    const now = Date.now();
    for (const [id, entry] of this.resources) {
      if (now - entry.lastUsedAt <= RESOURCE_TTL_MS) continue;
      this.resources.delete(id);
      this.resourceIds.delete(entry.url);
    }
  }
}
