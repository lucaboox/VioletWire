import { z } from "zod";
import { chatHistoryLimitSchema } from "./chat";
import { playerModeSchema } from "./player";

export const appPreferencesSchema = z.object({
  preferredPlayerMode: playerModeSchema,
  chatTimestamps: z.boolean(),
  chatHistoryLimit: chatHistoryLimitSchema,
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
  chatTimestamps: true,
  chatHistoryLimit: 20,
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
