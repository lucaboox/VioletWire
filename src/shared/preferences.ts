import { z } from "zod";
import { chatHistoryLimitSchema } from "./chat";
import { playerModeSchema } from "./player";

export const appPreferencesSchema = z.object({
  preferredPlayerMode: playerModeSchema,
  experimentalTexturePlayer: z.boolean(),
  chatTimestamps: z.boolean(),
  chatHistoryLimit: chatHistoryLimitSchema,
  chatFontSize: z.number().int().min(14).max(25),
  chatEmoteSize: z.number().int().min(18).max(48),
  chatDeletedMessageStyle: z.enum(["placeholder", "dimmed"]),
  chatOnLeft: z.boolean(),
  chatOverlayOpacity: z.number().int().min(25).max(100),
  mentionSoundEnabled: z.boolean(),
  oledMode: z.boolean(),
  audioCompression: z.boolean(),
  // These live here rather than in localStorage: the packaged renderer is
  // served from a random localhost port, so its browser storage is a fresh
  // origin on every launch and cannot remember anything across runs.
  lastSeenChangelogVersion: z.string().max(64),
  emoteFavorites: z.array(z.string().max(200)).max(1_000),
  emotePickerWidth: z.number().int().min(330).max(600),
  emotePickerHeight: z.number().int().min(360).max(700),
});

export const appPreferencesPatchSchema = appPreferencesSchema.partial().strict();

export type AppPreferences = z.infer<typeof appPreferencesSchema>;
export type AppPreferencesPatch = z.infer<typeof appPreferencesPatchSchema>;

export const defaultAppPreferences: AppPreferences = {
  preferredPlayerMode: "native",
  experimentalTexturePlayer: true,
  chatTimestamps: true,
  chatHistoryLimit: 20,
  chatFontSize: 14,
  chatEmoteSize: 27,
  chatDeletedMessageStyle: "placeholder",
  chatOnLeft: false,
  chatOverlayOpacity: 88,
  mentionSoundEnabled: false,
  oledMode: false,
  audioCompression: false,
  lastSeenChangelogVersion: "",
  emoteFavorites: [],
  emotePickerWidth: 390,
  emotePickerHeight: 500,
};

export interface PreferencesApi {
  getOrMigrate(legacyPreferences?: AppPreferencesPatch): Promise<AppPreferences>;
  update(patch: AppPreferencesPatch): Promise<AppPreferences>;
  onChanged(listener: (preferences: AppPreferences) => void): () => void;
}
