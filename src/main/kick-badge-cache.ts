import { app } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { APP_ORIGIN } from "./app-protocol";

/**
 * Keeps a copy of Kick's badge artwork on disk.
 *
 * The artwork is published by someone else, and a chat full of badges asking
 * for it on every launch is a steady cost to a host that never agreed to carry
 * it. Each badge is fetched once, kept, and served from here afterwards, which
 * also means badges keep working when that host does not.
 */

const REMOTE_HOST = "https://cdn.kicktalk.app/Badges";
// The few whose art is filed under a different name than Kick's badge type.
const REMOTE_NAMES: Record<string, string> = { sub_gifter: "subgifter1" };
// Long enough that a badge is fetched about once a week, short enough that new
// artwork for an existing badge still arrives.
const RECHECK_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BADGE_BYTES = 512 * 1024;

const inFlight = new Set<string>();
const checkedAt = new Map<string, number>();

function directory(): string {
  return path.join(app.getPath("userData"), "kick-badges");
}

/** Only a plain name reaches the filesystem or the address it is fetched from. */
function safeType(type: string): string | null {
  return /^[a-z0-9_]+$/i.test(type) ? type : null;
}

export function kickBadgeRemoteUrl(type: string): string {
  const name = safeType(type);
  if (!name) return "";
  return `${REMOTE_HOST}/${REMOTE_NAMES[name] ?? name}.svg`;
}

export function kickBadgeCachedUrl(type: string): string {
  const name = safeType(type);
  if (!name) return "";
  return `${APP_ORIGIN}/kick-badges/${name}.svg`;
}

/** The stored copy, or null when this badge has not been kept yet. */
export async function readCachedKickBadge(name: string): Promise<Buffer | null> {
  if (!safeType(name)) return null;
  try {
    return await readFile(path.join(directory(), `${name}.svg`));
  } catch {
    return null;
  }
}

/**
 * Fetches a badge's artwork if it is not already kept, or if the copy is old
 * enough to be worth asking about again. Failures are silent: the badge falls
 * back to its published address, and then to the glyph drawn into the app.
 */
export function keepKickBadge(type: string): void {
  const name = safeType(type);
  if (!name || inFlight.has(name)) return;
  const lastChecked = checkedAt.get(name) ?? 0;
  if (Date.now() - lastChecked < RECHECK_AFTER_MS) return;

  inFlight.add(name);
  void (async () => {
    try {
      const existing = await readCachedKickBadge(name);
      if (existing) {
        checkedAt.set(name, Date.now());
        return;
      }
      const response = await fetch(kickBadgeRemoteUrl(name));
      if (!response.ok) return;
      const type = response.headers.get("content-type") ?? "";
      if (!type.includes("svg")) return;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_BADGE_BYTES) return;
      await mkdir(directory(), { recursive: true });
      // Written aside and moved into place, so a badge is never read half-saved.
      const destination = path.join(directory(), `${name}.svg`);
      const pending = `${destination}.part`;
      await writeFile(pending, bytes);
      await rename(pending, destination);
      checkedAt.set(name, Date.now());
    } catch {
      // Kept for the next attempt rather than retried in a loop.
    } finally {
      inFlight.delete(name);
    }
  })();
}
