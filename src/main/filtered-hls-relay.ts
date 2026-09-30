import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";

import type { Platform } from "../shared/platform";
import {
  firstMp4ChunkTime,
  looksLikeFragmentedMp4,
  mp4StartsIndependent,
  planMp4Parts,
  readMp4Tracks,
  type Mp4Track,
} from "./fmp4-parts";
import type { HlsMediaTransport } from "./hls-media-transport";
import { firstTsVideoTime, looksLikeTransportStream, planTsParts } from "./ts-parts";

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
  /** Twitch's media sequence number for it, when the playlist states one. */
  upstreamSequence?: number;
}

interface RelaySegment {
  sequence: number;
  duration: number;
  lines: string[];
  sourceKey: string;
  uri: string;
  prefetch: boolean;
  /** The parts it was published as while Twitch was writing it, if it was. */
  parts?: PublishedPart[];
}

/** A piece of a fragment, published before the fragment is finished. */
interface PublishedPart {
  uri: string;
  duration: number;
  /** Whether its video opens on a key frame, so playback can start at it. */
  independent: boolean;
}

/**
 * A fragment Twitch is still writing, streamed into memory and published a
 * part at a time. Each part is a complete piece the player appends on its
 * own — the difference from handing it the growing response to read as it
 * arrives, which shatters a fragmented MP4 buffer into disconnected islands.
 */
interface PartedFragment {
  sourceKey: string;
  /** The media sequence it has in the relay's playlist, now and once complete. */
  sequence: number;
  /** Twitch's media sequence number for it, which it keeps once complete. */
  upstreamSequence?: number;
  url: string;
  date?: number;
  /** How long Twitch's fragments run; what it will say once it lists this one. */
  duration: number;
  discontinuity: boolean;
  container: "ts" | "fmp4" | "unsupported" | null;
  /** Whether its first timestamp has been checked against the stream's timeline. */
  timelineChecked: boolean;
  buffer: Buffer;
  length: number;
  /** Bytes already published as parts. */
  cut: number;
  parts: PublishedPart[];
  /** Every byte is here and the fragment is in the playlist as a whole. */
  finished: boolean;
  /** The stream broke off; its parts stay, but it is never completed from here. */
  failed: boolean;
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
const MAX_SEEN_SEGMENTS = 512;

// Low-latency parts. Twitch writes a two-second fragment as nineteen chunks of
// about 0.107s, so a part closes once it covers this much: three chunks, 0.32s.
const PART_TARGET_SECONDS = 0.3;
// Only the fragment being written, the one about to start and a couple just
// finished still matter; older ones have been played.
const MAX_PARTED_FRAGMENTS = 4;
// Parts of the last few fragments stay addressable for a player that is still
// working through them. The playlist lists at most about thirty at once, seven
// for each of the recent fragments and the one being written; older ones are
// dropped first.
const MAX_PART_RESOURCES = 48;
// A fragment's response stays open until Twitch finishes writing it, and the
// next one is requested before Twitch has started it, so this covers waiting
// for it to begin as well as writing it.
const PARTED_FRAGMENT_TIMEOUT_MS = 15_000;
// With parts the player long-polls the relay, so Twitch's playlist is read on
// a clock of the relay's own. Parts themselves arrive as bytes do; this only
// finds the next fragments and hears about ads.
const UPSTREAM_POLL_MS = 1_000;
// Completed segments keep listing their parts this long, so a player midway
// through one is not left holding parts the playlist no longer mentions.
const RECENT_PARTED_SEGMENTS = 3;
// How far a complete fragment's date may sit from the one inferred while it
// was being written and still be recognised as the same fragment. Twitch's
// fragments are two seconds apart, so this cannot match a neighbour.
const PARTED_DATE_TOLERANCE_MS = 400;
// How far a fragment's first timestamp may sit from where the one before it
// says it should start and still be cut into parts. Twitch's own fragments
// continue each other to the frame; anything else (an advertisement Twitch
// has not marked yet, a restarted encoder) is left to arrive whole, where the
// usual advertisement and discontinuity handling sees it.
const TIMELINE_TOLERANCE_SECONDS = 0.5;

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
  // Twitch numbers every fragment, the ones it is still writing included, and
  // the number stays with a fragment from reload to reload.
  let upstreamSequence: number | undefined;
  const takeUpstreamSequence = (): number | undefined =>
    upstreamSequence === undefined ? undefined : upstreamSequence++;

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
      upstreamSequence: takeUpstreamSequence(),
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
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const sequence = Number.parseInt(line.slice("#EXT-X-MEDIA-SEQUENCE:".length), 10);
      if (Number.isSafeInteger(sequence) && sequence >= 0) upstreamSequence = sequence;
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
      upstreamSequence: takeUpstreamSequence(),
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

function getSegmentKey(segment: ParsedSegment): string {
  const byteRange = segment.tags.find((line) => line.startsWith("#EXT-X-BYTERANGE:"));
  if (segment.date !== undefined) {
    // Twitch's PROGRAM-DATE-TIME is stable across playlist reloads even when
    // both the CDN path and signed query are rotated for an existing segment.
    return `pdt:${segment.date}|${byteRange ?? ""}`;
  }
  const url = new URL(segment.uri);
  // Without a program date, retain the stable CDN path while ignoring renewed
  // query authorization for an existing segment.
  url.search = "";
  url.hash = "";
  return `${url.toString()}|${byteRange ?? ""}`;
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

/** A blocking-reload directive (_HLS_msn, _HLS_part) as a whole number, if valid. */
function parseDirective(value: string | null): number | undefined {
  if (value === null || !/^\d{1,9}$/.test(value)) return undefined;
  return Number(value);
}

/** Grows a streamed fragment's buffer, doubling capacity rather than copying per chunk. */
function appendFragmentBytes(fragment: PartedFragment, chunk: Uint8Array): void {
  const required = fragment.length + chunk.length;
  if (required > fragment.buffer.length) {
    const grown = Buffer.alloc(Math.max(required, 64 * 1024, fragment.buffer.length * 2));
    fragment.buffer.copy(grown, 0, 0, fragment.length);
    fragment.buffer = grown;
  }
  fragment.buffer.set(chunk, fragment.length);
  fragment.length = required;
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
  // Low-latency parts: the fragments being streamed, the bytes of each part,
  // and what a fragmented MP4 needs to be measured.
  private readonly partedFragments = new Map<string, PartedFragment>();
  private readonly partBytes = new Map<string, { bytes: Buffer; contentType: string }>();
  private mp4Tracks = new Map<number, Mp4Track>();
  private initSegmentUrl: string | null = null;
  private mp4TracksRequest: Promise<void> | null = null;
  private largestPartSeconds = PART_TARGET_SECONDS;
  private latestMapLine: string | null = null;
  private latestVersion = 6;
  private upstreamPoll: NodeJS.Timeout | null = null;
  // Where the newest streamed fragment began in media time, to check that the
  // next continues it.
  private timeline: { sequence: number; start: number; duration: number } | null = null;
  private refreshedOnce = false;
  // Players waiting on a blocking playlist request for a part not yet written.
  private readonly playlistWaiters = new Set<() => void>();

  constructor(
    private readonly getAllowedOrigin: () => string | null,
    private readonly platform: Platform = "twitch",
    private readonly options: {
      includePrefetch?: boolean;
      directMedia?: boolean;
      mediaTransport?: HlsMediaTransport;
      /**
       * Publish the fragment Twitch is still writing as LL-HLS parts, with
       * blocking playlist reload, so the player is seconds closer to live.
       */
      publishParts?: boolean;
    } = {},
  ) {}

  private get partsEnabled(): boolean {
    return this.options.publishParts === true;
  }

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
    if (this.partsEnabled && !this.upstreamPoll) {
      this.upstreamPoll = setInterval(() => {
        void this.getPlaylist().catch(() => undefined);
      }, UPSTREAM_POLL_MS);
      this.upstreamPoll.unref?.();
    }
    return `http://127.0.0.1:${this.port}/${this.sessionToken}/index.m3u8`;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.upstreamPoll) clearInterval(this.upstreamPoll);
    this.upstreamPoll = null;
    this.notifyPlaylistWaiters();
    this.partedFragments.clear();
    this.partBytes.clear();
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
    let query: URLSearchParams;
    try {
      const url = new URL(request.url ?? "/", `http://${host}`);
      pathname = url.pathname;
      query = url.searchParams;
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
        const body = this.partsEnabled
          ? await this.getPartedPlaylist(query)
          : await this.getPlaylist();
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

    const partMatch = new RegExp(`^/${this.sessionToken}/part/([a-f0-9]{32})$`).exec(pathname);
    const hintMatch = new RegExp(`^/${this.sessionToken}/hint/(\\d{1,9})/(\\d{1,3})$`).exec(
      pathname,
    );
    if (partMatch || hintMatch) {
      // A preload hint names a part before it exists; the request is held
      // until it does, as a blocking playlist request is.
      let id = partMatch?.[1];
      if (hintMatch && this.partsEnabled) {
        const msn = Number(hintMatch[1]);
        const index = Number(hintMatch[2]);
        await this.waitForMedia(msn, index);
        id = this.partedFragmentWithSequence(msn)?.parts[index]?.uri.slice("part/".length);
      }
      const part = id === undefined ? undefined : this.partBytes.get(id);
      if (!part) {
        writeText(response, 404, "Expired media part", corsHeaders);
        return;
      }
      response.writeHead(200, {
        ...corsHeaders,
        "Cache-Control": "private, max-age=30",
        "Content-Type": part.contentType,
        "Content-Length": String(part.bytes.length),
        "X-Content-Type-Options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : part.bytes);
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
        // Parts need to know about the fragment being written, but it is
        // streamed rather than listed as a segment.
        this.partsEnabled || (this.options.includePrefetch ?? true),
      );
      this.latestVersion = parsed.version;
      const prefetched: ParsedSegment[] = [];
      let filteredAd = false;
      for (const segment of parsed.segments) {
        const segmentKey = getSegmentKey(segment);
        if (segment.ad) {
          const existingSequence = this.segmentSequences.get(segmentKey);
          if (existingSequence !== undefined) {
            const existingIndex = this.relaySegments.findIndex(
              (candidate) => candidate.sourceKey === segmentKey,
            );
            if (existingIndex >= 0) this.relaySegments.splice(existingIndex, 1);
            this.segmentSequences.delete(segmentKey);
          }
          filteredAd = true;
          this.pendingDiscontinuity = true;
          continue;
        }
        if (this.partsEnabled && segment.prefetch) {
          prefetched.push(segment);
          continue;
        }
        let existingSequence = this.segmentSequences.get(segmentKey);
        if (existingSequence === undefined && this.partsEnabled && !segment.prefetch) {
          existingSequence = this.adoptPartedSequence(segment, segmentKey);
        }
        if (existingSequence !== undefined) {
          const existing = this.relaySegments.find(
            (candidate) => candidate.sequence === existingSequence,
          );
          if (!existing && this.partsEnabled) {
            // Its sequence was given out while it was being streamed as
            // parts. If that stream is still going, it joins the playlist
            // the moment it finishes; otherwise it joins now, whole.
            const parted = this.partedFragmentWithSequence(existingSequence);
            if (parted && !parted.finished && !parted.failed) continue;
            const lines = segment.tags.map((line) =>
              rewriteTagUri(line, sourceUrl, (url) => this.registerResource(url)),
            );
            if (segment.discontinuity || parted?.discontinuity) {
              lines.unshift("#EXT-X-DISCONTINUITY");
            }
            this.insertRelaySegment({
              sequence: existingSequence,
              duration: segment.duration,
              lines,
              sourceKey: segmentKey,
              uri: this.registerResource(segment.uri),
              prefetch: false,
            });
            continue;
          }
          // Keep the local media sequence and address stable: hls.js treats a
          // listed segment whose URI changes between reloads as a broken
          // playlist and fails the whole stream. Behind a relay address, the
          // newest signed CDN URL still replaces the old one.
          if (existing) this.retargetResource(existing.uri, segment.uri);
          // Twitch exposes an in-progress segment as PREFETCH before the same
          // URI appears as a completed EXTINF entry. Keep its local sequence
          // stable, then replace the inferred metadata with the authoritative
          // completed tags when they arrive.
          if (!segment.prefetch) {
            if (existing?.prefetch) {
              const completedLines = segment.tags.map((line) =>
                rewriteTagUri(line, sourceUrl, (url) => this.registerResource(url)),
              );
              // Whether it follows a discontinuity was settled when it was
              // first listed; changing it later is another mismatch to hls.js.
              if (existing.lines[0] === "#EXT-X-DISCONTINUITY") {
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
        this.segmentSequences.set(segmentKey, sequence);
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
          sourceKey: segmentKey,
          uri: this.registerResource(segment.uri),
          prefetch: segment.prefetch,
        });
      }
      if (this.partsEnabled) {
        const mapLine = this.relaySegments
          .at(-1)
          ?.lines.find((line) => line.startsWith("#EXT-X-MAP:"));
        if (mapLine) this.latestMapLine = mapLine;
        this.ensureMp4Tracks(parsed.segments, sourceUrl);
        // Around an ad break the timeline is being stitched, and a part cut
        // there could land on the wrong side of it. Whole fragments carry on.
        const adNearby =
          filteredAd ||
          this.pendingDiscontinuity ||
          parsed.segments.slice(-3).some((segment) => segment.ad);
        if (!adNearby) this.startPartedFragments(prefetched);
      }
      while (this.relaySegments.length > MAX_RELAY_SEGMENTS) {
        this.relaySegments.shift();
      }
      // Keep recently pruned identities around. Twitch's upstream playlist can
      // contain more entries than VioletWire's shorter relay window (notably
      // channels using one-second fragments). Forgetting a pruned entry makes
      // the next refresh append that old upstream segment as if it were new.
      while (this.segmentSequences.size > MAX_SEEN_SEGMENTS) {
        const oldestKey = this.segmentSequences.keys().next().value;
        if (!oldestKey) break;
        this.segmentSequences.delete(oldestKey);
      }
      this.pruneResources();
      this.refreshedOnce = true;
      this.notifyPlaylistWaiters();
      if (this.relaySegments.length === 0) {
        throw new Error("Waiting for Twitch content; an advertisement may be playing.");
      }
      const body = this.renderPlaylist();
      this.playlistCache = {
        expiresAt: Date.now() + PLAYLIST_CACHE_MS,
        body,
      };
      return body;
    } finally {
      this.abortControllers.delete(controller);
    }
  }

  private renderPlaylist(): string {
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
    if (!this.partsEnabled) {
      return [
        "#EXTM3U",
        `#EXT-X-VERSION:${this.latestVersion}`,
        `#EXT-X-TARGETDURATION:${relayTargetDuration}`,
        `#EXT-X-MEDIA-SEQUENCE:${firstSequence}`,
        "#EXT-X-INDEPENDENT-SEGMENTS",
        ...this.relaySegments.flatMap((segment) => [...segment.lines, segment.uri]),
        "",
      ].join("\n");
    }

    const partLine = (part: PublishedPart) =>
      `#EXT-X-PART:DURATION=${part.duration.toFixed(3)},URI="${part.uri}"${
        part.independent ? ",INDEPENDENT=YES" : ""
      }`;
    const recentFrom = this.relaySegments.length - RECENT_PARTED_SEGMENTS;
    const segmentLines = this.relaySegments.flatMap((segment, index) => {
      if (index < recentFrom || !segment.parts?.length) return [...segment.lines, segment.uri];
      // A segment's parts go after its other tags and before its EXTINF.
      const extinf = segment.lines.findIndex((line) => line.startsWith("#EXTINF:"));
      const head = extinf < 0 ? segment.lines : segment.lines.slice(0, extinf);
      const tail = extinf < 0 ? [] : segment.lines.slice(extinf);
      return [...head, ...segment.parts.map(partLine), ...tail, segment.uri];
    });
    const writing = this.inProgressFragment();
    const writingLines =
      writing && writing.parts.length > 0
        ? [
            ...(writing.discontinuity ? ["#EXT-X-DISCONTINUITY"] : []),
            ...(this.latestMapLine ? [this.latestMapLine] : []),
            ...(writing.date === undefined
              ? []
              : [`#EXT-X-PROGRAM-DATE-TIME:${new Date(writing.date).toISOString()}`]),
            ...writing.parts.map(partLine),
          ]
        : [];
    // The part that comes next. Besides being what LL-HLS asks a server to
    // name, something has to follow the last segment: hls.js, reading a
    // playlist that ends on a complete segment, takes that segment for the
    // one in progress and places the next two seconds too early.
    const lastSequence = this.relaySegments.at(-1)!.sequence;
    const hint =
      writing && writing.parts.length > 0
        ? { msn: writing.sequence, part: writing.parts.length }
        : { msn: lastSequence + 1, part: 0 };
    const partTarget = Math.max(this.largestPartSeconds, PART_TARGET_SECONDS);
    return [
      "#EXTM3U",
      "#EXT-X-VERSION:9",
      `#EXT-X-TARGETDURATION:${relayTargetDuration}`,
      // Three part targets is the least the specification lets a player sit
      // behind; VioletWire's player chooses its own cushion on top of that.
      `#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=${(partTarget * 3).toFixed(3)}`,
      `#EXT-X-PART-INF:PART-TARGET=${partTarget.toFixed(3)}`,
      `#EXT-X-MEDIA-SEQUENCE:${firstSequence}`,
      "#EXT-X-INDEPENDENT-SEGMENTS",
      ...segmentLines,
      ...writingLines,
      `#EXT-X-PRELOAD-HINT:TYPE=PART,URI="hint/${hint.msn}/${hint.part}"`,
      "",
    ].join("\n");
  }

  /**
   * The playlist in parts mode. A request carrying _HLS_msn (and _HLS_part)
   * asks for a playlist that contains that segment (or part); it is held here
   * until the relay has it, so the player learns of each part within
   * milliseconds of it being cut rather than on its next poll.
   */
  private async getPartedPlaylist(query: URLSearchParams): Promise<string> {
    if (this.closed || !this.sourceUrl) throw new Error("HLS session ended.");
    if (!this.refreshedOnce) await this.getPlaylist();
    const msn = parseDirective(query.get("_HLS_msn"));
    const part = parseDirective(query.get("_HLS_part"));
    if (msn !== undefined) await this.waitForMedia(msn, part);
    if (this.relaySegments.length === 0) {
      throw new Error("Waiting for Twitch content; an advertisement may be playing.");
    }
    return this.renderPlaylist();
  }

  private async waitForMedia(msn: number, part: number | undefined): Promise<void> {
    // The specification lets a blocked request wait three target durations.
    const targetDuration = Math.max(1, this.relaySegments.at(-1)?.duration ?? 2);
    const deadline = Date.now() + Math.min(10_000, targetDuration * 3 * 1_000);
    while (!this.closed && !this.mediaAvailable(msn, part)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.playlistWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, remaining);
        this.playlistWaiters.add(done);
      });
    }
  }

  private mediaAvailable(msn: number, part: number | undefined): boolean {
    const last = this.relaySegments.at(-1)?.sequence;
    if (last !== undefined && msn <= last) return true;
    const writing = this.inProgressFragment();
    if (!writing || writing.sequence !== msn) return false;
    return part !== undefined && writing.parts.length > part;
  }

  /** The fragment being written right after the playlist's last whole segment. */
  private inProgressFragment(): PartedFragment | null {
    const last = this.relaySegments.at(-1)?.sequence;
    if (last === undefined) return null;
    for (const fragment of this.partedFragments.values()) {
      if (fragment.sequence === last + 1 && !fragment.finished) return fragment;
    }
    return null;
  }

  /**
   * Gives a newly listed complete fragment the sequence it already had as
   * parts. Twitch names a fragmented MP4 fragment by a different URL while it
   * is being written than once it is listed complete; only its date carries
   * over, and the date of a fragment still being written is itself inferred
   * (from the average fragment length), so Twitch's own number for it comes
   * first; the date is for a playlist without one.
   */
  private adoptPartedSequence(segment: ParsedSegment, segmentKey: string): number | undefined {
    if (segment.upstreamSequence !== undefined) {
      for (const fragment of this.partedFragments.values()) {
        if (fragment.upstreamSequence !== segment.upstreamSequence) continue;
        this.segmentSequences.set(segmentKey, fragment.sequence);
        return fragment.sequence;
      }
      // With Twitch's numbers to go by, a date that happens to be close
      // belongs to some other fragment.
      return undefined;
    }
    if (segment.date === undefined) return undefined;
    for (const fragment of this.partedFragments.values()) {
      if (fragment.date === undefined) continue;
      if (Math.abs(fragment.date - segment.date) > PARTED_DATE_TOLERANCE_MS) continue;
      this.segmentSequences.set(segmentKey, fragment.sequence);
      return fragment.sequence;
    }
    return undefined;
  }

  private partedFragmentWithSequence(sequence: number): PartedFragment | undefined {
    for (const fragment of this.partedFragments.values()) {
      if (fragment.sequence === sequence) return fragment;
    }
    return undefined;
  }

  private notifyPlaylistWaiters(): void {
    for (const waiter of [...this.playlistWaiters]) waiter();
  }

  private insertRelaySegment(segment: RelaySegment): void {
    if (this.relaySegments.some((candidate) => candidate.sequence === segment.sequence)) return;
    const index = this.relaySegments.findIndex(
      (candidate) => candidate.sequence > segment.sequence,
    );
    if (index < 0) this.relaySegments.push(segment);
    else this.relaySegments.splice(index, 0, segment);
    while (this.relaySegments.length > MAX_RELAY_SEGMENTS) this.relaySegments.shift();
  }

  /**
   * Reads the tracks out of the stream's initialisation segment. A fragmented
   * MP4 states each chunk's decode time in its track's own units, so its
   * parts cannot be measured in seconds without them. Transport streams carry
   * their own timing and never need this.
   */
  private ensureMp4Tracks(segments: ParsedSegment[], playlistUrl: string): void {
    const tag = segments
      .flatMap((segment) => segment.tags)
      .reverse()
      .find((line) => line.startsWith("#EXT-X-MAP:"));
    const match = tag ? /URI="([^"]+)"/.exec(tag) : null;
    if (!match) return;
    let url: URL;
    try {
      url = new URL(match[1], playlistUrl);
    } catch {
      return;
    }
    const href = url.toString();
    if (href === this.initSegmentUrl) return;
    // The relay chooses to make this request, so it is kept to Twitch's media
    // CDN or wherever the playlist itself came from.
    if (!isDirectTwitchMediaUrl(href) && url.origin !== new URL(playlistUrl).origin) return;
    this.initSegmentUrl = href;
    const controller = new AbortController();
    this.abortControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), PARTED_FRAGMENT_TIMEOUT_MS);
    this.mp4TracksRequest = (async () => {
      try {
        const upstream = await fetch(href, {
          headers: getPlaybackHeaders(this.platform),
          signal: controller.signal,
        });
        if (!upstream.ok) return;
        const tracks = readMp4Tracks(new Uint8Array(await upstream.arrayBuffer()));
        if (tracks.size === 0 || this.closed) return;
        this.mp4Tracks = tracks;
        // Fragments that started streaming before the tracks were known can
        // be cut now instead of on their next bytes.
        for (const fragment of this.partedFragments.values()) {
          if (!fragment.finished && !fragment.failed) this.publishReadyParts(fragment);
        }
      } catch {
        // Without the tracks the stream plays as whole fragments.
      } finally {
        clearTimeout(timeout);
        this.abortControllers.delete(controller);
      }
    })();
  }

  /**
   * Starts streaming the fragments Twitch names as in progress: the one being
   * written, and the one after it. The second request is answered as soon as
   * Twitch begins writing it, so its parts start without waiting for the relay
   * to read the playlist again.
   */
  private startPartedFragments(prefetched: ParsedSegment[]): void {
    for (const segment of prefetched.slice(0, 2)) {
      // Its inferred date moves between reloads whenever fragment lengths
      // vary, so the number is what says it is the same fragment.
      const key =
        segment.upstreamSequence === undefined
          ? getSegmentKey(segment)
          : `msn:${segment.upstreamSequence}`;
      if (this.relaySegments.some((candidate) => candidate.sourceKey === key)) continue;
      const existing = this.partedFragments.get(key);
      // A request that failed before a single byte came is tried again.
      if (existing && !(existing.failed && existing.length === 0)) continue;
      // The same URL is only allowed where the relay would fetch media anyway.
      if (!isDirectTwitchMediaUrl(segment.uri)) {
        try {
          if (new URL(segment.uri).origin !== new URL(this.sourceUrl ?? "").origin) continue;
        } catch {
          continue;
        }
      }
      let sequence = this.segmentSequences.get(key);
      if (sequence === undefined) {
        sequence = this.nextSequence++;
        this.segmentSequences.set(key, sequence);
      }
      const discontinuity = segment.discontinuity || this.pendingDiscontinuity;
      this.pendingDiscontinuity = false;
      this.beginPartedFragment({
        sourceKey: key,
        sequence,
        upstreamSequence: segment.upstreamSequence,
        url: segment.uri,
        date: segment.date,
        duration: segment.duration,
        discontinuity,
        container: null,
        timelineChecked: false,
        buffer: Buffer.alloc(0),
        length: 0,
        cut: 0,
        parts: [],
        finished: false,
        failed: false,
      });
    }
  }

  private beginPartedFragment(fragment: PartedFragment): void {
    this.partedFragments.set(fragment.sourceKey, fragment);
    while (this.partedFragments.size > MAX_PARTED_FRAGMENTS) {
      const oldest = this.partedFragments.keys().next().value;
      if (oldest === undefined) break;
      this.partedFragments.delete(oldest);
    }
    const controller = new AbortController();
    this.abortControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), PARTED_FRAGMENT_TIMEOUT_MS);
    void (async () => {
      try {
        const upstream = await fetch(fragment.url, {
          headers: getPlaybackHeaders(this.platform),
          signal: controller.signal,
        });
        if (!upstream.ok || !upstream.body) {
          fragment.failed = true;
          return;
        }
        const reader = upstream.body.getReader();
        while (!this.closed) {
          const { done, value } = await reader.read();
          if (done) break;
          appendFragmentBytes(fragment, value);
          this.publishReadyParts(fragment);
        }
        // A fragment that arrived faster than the initialisation segment is
        // cut once that is read, rather than left whole.
        if (fragment.container === "fmp4" && this.mp4Tracks.size === 0) {
          await this.mp4TracksRequest;
          if (!this.closed) this.publishReadyParts(fragment);
        }
        if (!this.closed) this.finishFragment(fragment);
      } catch {
        // Whatever parts were published stay. The fragment still arrives as a
        // whole segment once Twitch lists it complete.
        fragment.failed = true;
      } finally {
        clearTimeout(timeout);
        this.abortControllers.delete(controller);
        this.notifyPlaylistWaiters();
      }
    })();
  }

  private publishReadyParts(fragment: PartedFragment): void {
    const view = fragment.buffer.subarray(0, fragment.length);
    // Decide the container once, from the opening bytes, and publish nothing
    // for anything else — the fragment still arrives whole when complete.
    if (fragment.container === null && view.length >= 188) {
      fragment.container = looksLikeTransportStream(view)
        ? "ts"
        : looksLikeFragmentedMp4(view)
          ? "fmp4"
          : "unsupported";
    }
    if (fragment.container === null || fragment.container === "unsupported") return;
    // A fragmented MP4 cannot be measured until its tracks are known.
    if (fragment.container === "fmp4" && this.mp4Tracks.size === 0) return;
    if (!fragment.timelineChecked) {
      const start =
        fragment.container === "ts"
          ? firstTsVideoTime(view)
          : firstMp4ChunkTime(view, this.mp4Tracks);
      if (start === null) return;
      fragment.timelineChecked = true;
      const continues = this.continuesTimeline(fragment.sequence, start);
      if (!this.timeline || fragment.sequence > this.timeline.sequence) {
        this.timeline = { sequence: fragment.sequence, start, duration: fragment.duration };
      }
      if (!continues) {
        fragment.container = "unsupported";
        return;
      }
    }
    const firstCut = fragment.cut === 0;
    const planned =
      fragment.container === "ts"
        ? planTsParts(view, fragment.cut, PART_TARGET_SECONDS).map((part, index) => ({
            ...part,
            // A transport stream fragment opens on its key frame.
            independent: firstCut && index === 0,
          }))
        : planMp4Parts(view, fragment.cut, PART_TARGET_SECONDS, this.mp4Tracks);
    if (planned.length === 0) return;
    for (const part of planned) {
      const bytes = Buffer.from(view.subarray(fragment.cut, part.end));
      this.largestPartSeconds = Math.max(this.largestPartSeconds, part.duration);
      fragment.parts.push({
        uri: this.registerPartBytes(bytes, fragment.container),
        duration: part.duration,
        independent: part.independent,
      });
      fragment.cut = part.end;
    }
    this.notifyPlaylistWaiters();
  }

  /** Whether a fragment starting at `start` carries on the stream's timeline. */
  private continuesTimeline(sequence: number, start: number): boolean {
    const previous = this.timeline;
    if (!previous || sequence <= previous.sequence) return previous === null;
    const expected = previous.start + (sequence - previous.sequence) * previous.duration;
    return Math.abs(start - expected) <= TIMELINE_TOLERANCE_SECONDS;
  }

  /**
   * Publishes the remainder as the closing part, then puts the fragment in the
   * playlist as an ordinary segment of its own bytes — it is complete, and
   * waiting for Twitch to list it would hold back the parts of the next.
   */
  private finishFragment(fragment: PartedFragment): void {
    if (fragment.finished) return;
    if (fragment.parts.length === 0 || fragment.container === null || fragment.container === "unsupported") {
      // Nothing was cut from it; leave it to arrive whole from Twitch's list.
      fragment.failed = true;
      return;
    }
    const view = fragment.buffer.subarray(0, fragment.length);
    if (fragment.length > fragment.cut) {
      const used = fragment.parts.reduce((total, part) => total + part.duration, 0);
      const independent =
        fragment.container === "fmp4"
          ? mp4StartsIndependent(view, fragment.cut, this.mp4Tracks)
          : false;
      fragment.parts.push({
        uri: this.registerPartBytes(Buffer.from(view.subarray(fragment.cut)), fragment.container),
        duration: Math.max(0.001, Number((fragment.duration - used).toFixed(3))),
        independent,
      });
      fragment.cut = fragment.length;
    }
    fragment.finished = true;
    const lines = [
      ...(fragment.discontinuity ? ["#EXT-X-DISCONTINUITY"] : []),
      ...(this.latestMapLine ? [this.latestMapLine] : []),
      ...(fragment.date === undefined
        ? []
        : [`#EXT-X-PROGRAM-DATE-TIME:${new Date(fragment.date).toISOString()}`]),
      `#EXTINF:${fragment.duration.toFixed(3)},live`,
    ];
    this.insertRelaySegment({
      sequence: fragment.sequence,
      duration: fragment.duration,
      lines,
      sourceKey: fragment.sourceKey,
      // The URL it was streamed from serves the whole fragment once it is
      // complete, and it stays this segment's address from now on — Twitch's
      // own listing names it differently, but a listed URI must not change.
      uri: this.registerResource(fragment.url),
      // Twitch's own tags replace these once it lists the fragment complete.
      prefetch: true,
      parts: fragment.parts,
    });
    this.notifyPlaylistWaiters();
  }

  private registerPartBytes(bytes: Buffer, container: "ts" | "fmp4"): string {
    const id = randomUUID().replaceAll("-", "");
    this.partBytes.set(id, {
      bytes,
      contentType: container === "ts" ? "video/mp2t" : "video/mp4",
    });
    while (this.partBytes.size > MAX_PART_RESOURCES) {
      const oldest = this.partBytes.keys().next().value;
      if (oldest === undefined) break;
      this.partBytes.delete(oldest);
    }
    // Relative, so it resolves against the local playlist whichever way the
    // rest of the media is being fetched.
    return `part/${id}`;
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

  /**
   * Points a listed segment's relay address at a newer upstream URL for the
   * same media. Direct CDN addresses are the URL itself and cannot follow a
   * change, so they keep the one they were listed with.
   */
  private retargetResource(location: string, url: string): void {
    if (this.useDirectMedia && isDirectTwitchMediaUrl(url)) return;
    for (const [id, entry] of this.resources) {
      if (this.resourceLocation(id) !== location) continue;
      if (entry.url !== url) {
        this.resourceIds.delete(entry.url);
        entry.url = url;
        this.resourceIds.set(url, id);
      }
      entry.lastUsedAt = Date.now();
      return;
    }
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
