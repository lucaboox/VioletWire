/**
 * The interface's own session. The `persist:` prefix is what gives it a cache
 * on disk — without it Electron hands back an in-memory session, so every emote
 * image, avatar, and thumbnail was fetched again from scratch each launch, and
 * thrown away whenever Chromium wanted the memory back. Emote images asked to
 * be kept for a month by `http-cache-policy`; there was nowhere to keep them.
 */
export const APP_UI_PARTITION = "persist:violetwire-app-ui";
/**
 * Where video is fetched from. Kept apart from the interface's session, and
 * created with its cache switched off, because a live segment is watched once
 * and storing it only evicts the images the interface needs. Not persisted
 * either: there is nothing here worth keeping between launches beyond the
 * playback cookie, which is written again at startup.
 */
export const MEDIA_UPSTREAM_PARTITION = "violetwire-media-upstream";
export const TWITCH_WEBSITE_PARTITION = "persist:glint-twitch-playback";
