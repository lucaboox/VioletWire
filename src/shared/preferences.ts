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
  chatOnLeft: z.boolean(),
  chatOverlayOpacity: z.number().int().min(25).max(100),
  mentionSoundEnabled: z.boolean(),
  oledMode: z.boolean(),
  audioCompression: z.boolean(),
});

export const appPreferencesPatchSchema = appPreferencesSchema.partial().strict();

export type AppPreferences = z.infer<typeof appPreferencesSchema>;
export type AppPreferencesPatch = z.infer<typeof appPreferencesPatchSchema>;

export const defaultAppPreferences: AppPreferences = {
  preferredPlayerMode: "official",
  experimentalTexturePlayer: false,
  chatTimestamps: true,
  chatHistoryLimit: 20,
  chatFontSize: 14,
  chatEmoteSize: 27,
  chatOnLeft: false,
  chatOverlayOpacity: 88,
  mentionSoundEnabled: false,
  oledMode: false,
  audioCompression: false,
};

export interface PreferencesApi {
  getOrMigrate(legacyPreferences?: AppPreferencesPatch): Promise<AppPreferences>;
  update(patch: AppPreferencesPatch): Promise<AppPreferences>;
  onChanged(listener: (preferences: AppPreferences) => void): () => void;
}
