import { z } from "zod";
import type { FollowedChannel } from "../../shared/twitch";

const KEY = "violetwire.followed-cache";
const schema = z.object({
  accountId: z.string(),
  savedAt: z.number(),
  channels: z
    .array(
      z.object({
        id: z.string(),
        login: z.string(),
        displayName: z.string(),
        category: z.string(),
        profileImageUrl: z.string(),
        thumbnailUrl: z.string().optional(),
        title: z.string().optional(),
        language: z.string().optional(),
        tags: z.array(z.string()).optional(),
        isMature: z.boolean().optional(),
        viewerCount: z.number(),
        startedAt: z.string().optional(),
        isLive: z.boolean(),
      }),
    )
    .max(10_000),
});

export function readFollowedCache(
  storage: Storage,
  accountId: string,
): FollowedChannel[] {
  try {
    const cached = schema.parse(JSON.parse(storage.getItem(KEY) ?? "null"));
    if (
      cached.accountId !== accountId ||
      Date.now() - cached.savedAt > 7 * 86_400_000
    )
      return [];
    return cached.channels;
  } catch {
    return [];
  }
}

export function saveFollowedCache(
  storage: Storage,
  accountId: string,
  channels: FollowedChannel[],
): void {
  try {
    storage.setItem(
      KEY,
      JSON.stringify({ accountId, savedAt: Date.now(), channels }),
    );
  } catch {
    /* Storage may be unavailable or full; fresh network data still works. */
  }
}

export function clearFollowedCache(storage: Storage): void {
  try {
    storage.removeItem(KEY);
  } catch {
    /* Storage is optional. */
  }
}
