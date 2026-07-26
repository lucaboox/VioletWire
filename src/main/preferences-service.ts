import { app } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  appPreferencesPatchSchema,
  appPreferencesSchema,
  defaultAppPreferences,
  storedAppPreferencesPatchSchema,
  type AppPreferences,
} from "../shared/preferences";

export class PreferencesService {
  private readonly filePath: string;
  private preferences: AppPreferences = { ...defaultAppPreferences };
  private hasPersistedPreferences = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath = path.join(app.getPath("userData"), "preferences.json")) {
    this.filePath = filePath;
  }

  async initialize(): Promise<void> {
    try {
      const stored = JSON.parse(await fs.readFile(this.filePath, "utf8")) as unknown;
      const parsed = storedAppPreferencesPatchSchema.safeParse(stored);
      if (!parsed.success) return;
      this.preferences = appPreferencesSchema.parse({
        ...defaultAppPreferences,
        ...parsed.data,
      });
      this.hasPersistedPreferences = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }

  async getOrMigrate(legacyPreferences?: unknown): Promise<AppPreferences> {
    if (!this.hasPersistedPreferences && legacyPreferences !== undefined) {
      const parsed = storedAppPreferencesPatchSchema.safeParse(legacyPreferences);
      if (parsed.success) {
        this.preferences = appPreferencesSchema.parse({
          ...this.preferences,
          ...parsed.data,
        });
        this.hasPersistedPreferences = true;
        await this.enqueueWrite();
      }
    }
    return this.get();
  }

  async update(patch: unknown): Promise<AppPreferences> {
    const parsed = appPreferencesPatchSchema.parse(patch);
    const nextPreferences = appPreferencesSchema.parse({
      ...this.preferences,
      ...parsed,
    });
    if (
      this.hasPersistedPreferences &&
      Object.entries(parsed).every(
        ([key, value]) => this.preferences[key as keyof AppPreferences] === value,
      )
    ) {
      return this.get();
    }
    this.preferences = nextPreferences;
    this.hasPersistedPreferences = true;
    await this.enqueueWrite();
    return this.get();
  }

  get(): AppPreferences {
    return { ...this.preferences };
  }

  private enqueueWrite(): Promise<void> {
    const snapshot = this.get();
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => this.writeAtomically(snapshot));
    return this.writeQueue;
  }

  private async writeAtomically(preferences: AppPreferences): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(preferences, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.rename(temporaryPath, this.filePath);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
