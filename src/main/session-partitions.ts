/**
 * The interface's own session. The `persist:` prefix is what gives it a cache
 * on disk — without it Electron hands back an in-memory session, so every emote
 * image, avatar, and thumbnail was fetched again from scratch each launch, and
 * thrown away whenever Chromium wanted the memory back. Emote images asked to
 * be kept for a month by `emote-cache-policy`; there was nowhere to keep them.
 */
export const APP_UI_PARTITION = "persist:violetwire-app-ui";
export const TWITCH_WEBSITE_PARTITION = "persist:glint-twitch-playback";
