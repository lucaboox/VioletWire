import { z } from "zod";
import { chatHistoryLimitSchema } from "./chat";
import { nativePlaybackBackendSchema, playerModeSchema } from "./player";

export const mentionSoundIdSchema = z.enum(["ping", "chime", "pop", "knock"]);
export type MentionSoundId = z.infer<typeof mentionSoundIdSchema>;

export const appPreferencesSchema = z.object({
  preferredPlayerMode: playerModeSchema,
  nativePlaybackBackend: nativePlaybackBackendSchema,
  chatTimestamps: z.boolean(),
  chatHistoryLimit: chatHistoryLimitSchema,
  chatFontSize: z.number().int().min(14).max(25),
  chatEmoteSize: z.number().int().min(18).max(48),
  chatDeletedMessageStyle: z.enum(["placeholder", "dimmed"]),
  chatOnLeft: z.boolean(),
  // Last native player volume (0–100), restored when a stream opens so it
  // doesn't reset to 100% each time.
  playerVolume: z.number().int().min(0).max(100),
  // How long the native player controls stay visible before auto-hiding, in
  // milliseconds (1s–10s).
  controlsHideDelay: z.number().int().min(1000).max(10000),
  sidebarCollapsed: z.boolean(),
  chatSidebarWidth: z.number().int().min(300).max(620),
  chatOverlayOpacity: z.number().int().min(25).max(100),
  // Overlay chat geometry, relative to the video area. `placed` stays false
  // until the user first drags or resizes it, before which the CSS default
  // (top-right) applies; the stored values are clamped to the container on use.
  chatOverlayPlaced: z.boolean(),
  chatOverlayLeft: z.number().int().min(0).max(10000),
  chatOverlayTop: z.number().int().min(0).max(10000),
  chatOverlayWidth: z.number().int().min(280).max(560),
  chatOverlayHeight: z.number().int().min(200).max(1000),
  mentionSoundEnabled: z.boolean(),
  mentionSoundVolume: z.number().int().min(0).max(200),
  mentionSoundId: mentionSoundIdSchema,
  genericLinkPreviewsEnabled: z.boolean(),
  genericLinkPreviewActivation: z.enum(["hover", "ctrl", "alt"]),
  oledMode: z.boolean(),
  audioCompression: z.boolean(),
  // Show the live frame rate in the corner of the Native player.
  showFpsOverlay: z.boolean(),
  // Last restored main-window placement. Null coordinates let Windows choose a
  // safe initial display before the user has moved the window.
  windowX: z.number().int().min(-100_000).max(100_000).nullable(),
  windowY: z.number().int().min(-100_000).max(100_000).nullable(),
  windowWidth: z.number().int().min(960).max(10_000),
  windowHeight: z.number().int().min(640).max(10_000),
  windowMaximized: z.boolean(),
  // These live here rather than in localStorage: the packaged renderer is
  // served from a random localhost port, so its browser storage is a fresh
  // origin on every launch and cannot remember anything across runs.
  lastSeenChangelogVersion: z.string().max(64),
  emoteFavorites: z.array(z.string().max(200)).max(1_000),
  // Followed-channel logins pinned to a Favorites group above the live list.
  favoriteChannels: z.array(z.string().max(40)).max(500),
  // Which services the followed list covers.
  platformFilter: z.enum(["twitch", "kick", "both"]),
  // Which services search covers, kept separate from the followed list so the
  // two can be scoped independently.
  searchPlatformFilter: z.enum(["twitch", "kick", "both"]),
  // Which service the browse directory shows. One at a time — the two services'
  // category directories do not combine meaningfully.
  browsePlatform: z.enum(["twitch", "kick"]),
  emotePickerWidth: z.number().int().min(330).max(600),
  emotePickerHeight: z.number().int().min(360).max(700),
  emoteSearchAllProviders: z.boolean(),
});

export const appPreferencesPatchSchema = appPreferencesSchema.partial().strict();
// Saved files can contain keys from an older VioletWire version. Strip those
// keys during startup so removing a preference does not discard every other
// setting the user has saved. IPC updates continue to use the strict schema.
export const storedAppPreferencesPatchSchema = appPreferencesSchema.partial();

export type AppPreferences = z.infer<typeof appPreferencesSchema>;
export type AppPreferencesPatch = z.infer<typeof appPreferencesPatchSchema>;

export const defaultAppPreferences: AppPreferences = {
  preferredPlayerMode: "native",
  nativePlaybackBackend: "hls",
  chatTimestamps: true,
  chatHistoryLimit: 20,
  chatFontSize: 14,
  chatEmoteSize: 27,
  chatDeletedMessageStyle: "placeholder",
  chatOnLeft: false,
  playerVolume: 100,
  controlsHideDelay: 5000,
  sidebarCollapsed: false,
  chatSidebarWidth: 384,
  chatOverlayOpacity: 88,
  chatOverlayPlaced: false,
  chatOverlayLeft: 0,
  chatOverlayTop: 16,
  chatOverlayWidth: 370,
  chatOverlayHeight: 440,
  mentionSoundEnabled: false,
  mentionSoundVolume: 100,
  mentionSoundId: "ping",
  genericLinkPreviewsEnabled: false,
  genericLinkPreviewActivation: "ctrl",
  oledMode: false,
  audioCompression: false,
  showFpsOverlay: false,
  windowX: null,
  windowY: null,
  windowWidth: 1440,
  windowHeight: 900,
  windowMaximized: false,
  lastSeenChangelogVersion: "",
  emoteFavorites: [],
  favoriteChannels: [],
  platformFilter: "twitch",
  searchPlatformFilter: "both",
  browsePlatform: "twitch",
  emotePickerWidth: 390,
  emotePickerHeight: 500,
  emoteSearchAllProviders: false,
};

export interface PreferencesApi {
  getOrMigrate(legacyPreferences?: AppPreferencesPatch): Promise<AppPreferences>;
  update(patch: AppPreferencesPatch): Promise<AppPreferences>;
  onChanged(listener: (preferences: AppPreferences) => void): () => void;
}
