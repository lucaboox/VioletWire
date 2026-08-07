/**
 * The most emote artwork the app keeps in its own store. A channel's emotes at
 * the size chat draws them come to a few megabytes, so this is many channels'
 * worth; past it, the least recently used artwork is dropped and refetched if
 * it is ever needed again. Chat settings shows what is held against this figure
 * and can empty it early.
 */
export const EMOTE_STORE_LIMIT_BYTES = 512 * 1024 * 1024;

/**
 * The most Chromium's own cache may hold for the interface — thumbnails,
 * avatars, badges, and, unavoidably, the video the player fetches directly.
 * Chromium's `--disk-cache-size` was measured having no effect on a session
 * made from a partition, so this ceiling is enforced by the app: passing it
 * empties that cache, which costs nothing now that emote artwork is kept
 * separately and is not thrown away with it.
 */
export const HTTP_CACHE_LIMIT_BYTES = 1024 * 1024 * 1024;
