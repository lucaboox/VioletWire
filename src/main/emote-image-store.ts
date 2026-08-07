import { app } from "electron";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import type { EmoteStoreUsage } from "../shared/chat";
import { EMOTE_STORE_LIMIT_BYTES } from "../shared/http-cache";

/**
 * Keeps emote artwork in the app's own store rather than in Chromium's cache.
 *
 * Sharing that cache never worked. Video is fetched straight from the CDN by
 * the player and Chromium stores it — around two gigabytes an hour, measured —
 * so emote images were pushed out almost as fast as they arrived and every
 * message had to fetch them again over the network. Nothing available from
 * Electron stops that: `session.fetch` ignores its `cache` option, rewriting
 * response headers happens after Chromium has decided what to store, and
 * `--disk-cache-size` has no effect on a session made from a partition (set to
 * 25 MB, the cache was measured passing 240 MB and still climbing).
 *
 * So emotes are kept here instead: one file per image, in a directory of their
 * own, with a size limit this code enforces and eviction by least-recent use.
 * Video churn cannot reach it. If Chromium does drop its copy of an emote, the
 * refetch is a local file read rather than a round trip to another continent,
 * which is the difference between an emote that flickers and one that vanishes
 * for seconds at a time.
 */

/** Only these serve emote artwork, and only over https. */
const ALLOWED_HOSTS = new Set([
  "cdn.7tv.app",
  "cdn.betterttv.net",
  "cdn.frankerfacez.com",
  "static-cdn.jtvnw.net",
  "files.kick.com",
]);

const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
/** Evict down to this much of the limit, so pruning is not run constantly. */
const PRUNE_TO = 0.9;

interface StoredEntry {
  bytes: number;
  usedAt: number;
}

const entries = new Map<string, StoredEntry>();
const inFlight = new Map<string, Promise<Buffer | null>>();
let heldBytes = 0;
let scanned: Promise<void> | null = null;

function directory(): string {
  return path.join(app.getPath("userData"), "emote-images");
}

/** The upstream address, if it is one we are willing to fetch and keep. */
export function allowedEmoteUrl(rawUrl: string): URL | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return ALLOWED_HOSTS.has(url.hostname) ? url : null;
}

/**
 * A file name for an address. Hashed rather than derived from the URL so no
 * part of a remote address can reach into the filesystem, and so every name is
 * a fixed, harmless length.
 */
export function storeKeyFor(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

/**
 * What kind of image this is, read from the bytes themselves. Sniffed rather
 * than stored alongside because the services disagree about extensions —
 * FrankerFaceZ and Twitch put none in the address at all — and the bytes are
 * the only account that cannot drift.
 */
export function imageContentType(bytes: Buffer): string | null {
  const ascii = (start: number, end: number) =>
    bytes.subarray(start, end).toString("ascii");
  if (bytes.length < 12) return null;
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (ascii(0, 3) === "GIF") return "image/gif";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  // AVIF and other ISO base media files name their brand in the ftyp box.
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand.startsWith("avif") || brand.startsWith("avis")) return "image/avif";
  }
  return null;
}

/** Reads what is already on disk once, so the size held is known from the start. */
async function scanStore(): Promise<void> {
  if (scanned) return scanned;
  scanned = (async () => {
    try {
      const names = await readdir(directory());
      for (const name of names) {
        if (name.endsWith(".part")) {
          await rm(path.join(directory(), name), { force: true }).catch(() => undefined);
          continue;
        }
        try {
          const info = await stat(path.join(directory(), name));
          if (!info.isFile()) continue;
          entries.set(name, { bytes: info.size, usedAt: info.mtimeMs });
          heldBytes += info.size;
        } catch {
          // A file that vanished between listing and reading is simply skipped.
        }
      }
    } catch {
      // No directory yet: the first emote kept will create it.
    }
  })();
  return scanned;
}

/**
 * Drops the least recently used images until the store is comfortably under its
 * limit. Reaching the limit costs a refetch of the oldest artwork, nothing more.
 */
async function pruneStore(): Promise<void> {
  if (heldBytes <= EMOTE_STORE_LIMIT_BYTES) return;
  const target = EMOTE_STORE_LIMIT_BYTES * PRUNE_TO;
  const oldestFirst = [...entries.entries()].sort(
    ([, left], [, right]) => left.usedAt - right.usedAt,
  );
  for (const [key, entry] of oldestFirst) {
    if (heldBytes <= target) break;
    try {
      await rm(path.join(directory(), key), { force: true });
      entries.delete(key);
      heldBytes -= entry.bytes;
    } catch {
      // Leave it counted; the next prune will try again.
    }
  }
}

async function fetchAndStore(url: URL): Promise<Buffer | null> {
  const response = await fetch(url, {
    headers: { Accept: "image/webp,image/avif,image/png,image/gif,*/*" },
  });
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_ENTRY_BYTES) return null;
  // Kept only if the bytes really are an image, so a redirect to an error page
  // can never be stored and served back as artwork.
  if (!imageContentType(bytes)) return null;

  const key = storeKeyFor(url.toString());
  const destination = path.join(directory(), key);
  try {
    await mkdir(directory(), { recursive: true });
    // Written aside and moved into place, so an image is never read half-saved.
    const pending = `${destination}.part`;
    await writeFile(pending, bytes);
    await rename(pending, destination);
    const previous = entries.get(key);
    if (previous) heldBytes -= previous.bytes;
    entries.set(key, { bytes: bytes.length, usedAt: Date.now() });
    heldBytes += bytes.length;
    await pruneStore();
  } catch {
    // Serving the image matters more than keeping it; the next request retries.
  }
  return bytes;
}

/**
 * The image for an upstream address: from the store when it is there, fetched
 * and kept when it is not. Requests for the same image share one fetch.
 */
export async function readEmoteImage(
  rawUrl: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const url = allowedEmoteUrl(rawUrl);
  if (!url) return null;
  await scanStore();

  const key = storeKeyFor(url.toString());
  const held = entries.get(key);
  if (held) {
    try {
      const bytes = await readFile(path.join(directory(), key));
      const contentType = imageContentType(bytes);
      if (contentType) {
        const now = new Date();
        held.usedAt = now.getTime();
        // Recorded on the file as well, so least-recent use survives a restart.
        void utimes(path.join(directory(), key), now, now).catch(() => undefined);
        return { bytes, contentType };
      }
      // Unreadable or not an image after all: drop it and fetch again.
      entries.delete(key);
      heldBytes -= held.bytes;
      await rm(path.join(directory(), key), { force: true }).catch(() => undefined);
    } catch {
      entries.delete(key);
      heldBytes -= held.bytes;
    }
  }

  const existing = inFlight.get(key);
  const fetching = existing ?? fetchAndStore(url);
  if (!existing) inFlight.set(key, fetching);
  try {
    const bytes = await fetching;
    if (!bytes) return null;
    const contentType = imageContentType(bytes);
    return contentType ? { bytes, contentType } : null;
  } catch {
    return null;
  } finally {
    if (!existing) inFlight.delete(key);
  }
}

/** What is held, for the figure shown in chat settings. */
export async function emoteStoreUsage(): Promise<EmoteStoreUsage> {
  await scanStore();
  return { bytes: heldBytes, emotes: entries.size };
}

/** Empties the store, so every emote is fetched afresh. */
export async function clearEmoteStore(): Promise<void> {
  await scanStore();
  await rm(directory(), { recursive: true, force: true }).catch(() => undefined);
  entries.clear();
  heldBytes = 0;
}
