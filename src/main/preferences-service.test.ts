import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultAppPreferences } from "../shared/preferences";
import { PreferencesService } from "./preferences-service";

const testDirectory = path.join(tmpdir(), "violetwire-preferences-service-tests");
const preferencesPath = path.join(testDirectory, "preferences.json");

beforeEach(async () => {
  await fs.rm(testDirectory, { recursive: true, force: true });
});

describe("PreferencesService", () => {
  it("uses defaults before any preferences have been saved", async () => {
    const service = new PreferencesService(preferencesPath);

    await service.initialize();

    expect(await service.getOrMigrate()).toEqual(defaultAppPreferences);
  });

  it("migrates the renderer's existing local preferences once", async () => {
    const service = new PreferencesService(preferencesPath);
    await service.initialize();

    const migrated = await service.getOrMigrate({
      preferredPlayerMode: "native",
      experimentalTexturePlayer: true,
      chatTimestamps: false,
      chatHistoryLimit: 70,
      chatFontSize: 18,
      chatEmoteSize: 32,
      chatOnLeft: true,
      chatOverlayOpacity: 65,
    });
    const ignoredSecondMigration = await service.getOrMigrate({
      preferredPlayerMode: "official",
    });

    expect(migrated).toMatchObject({
      preferredPlayerMode: "native",
      experimentalTexturePlayer: true,
      chatTimestamps: false,
      chatHistoryLimit: 70,
      chatFontSize: 18,
      chatEmoteSize: 32,
      chatOnLeft: true,
      chatOverlayOpacity: 65,
    });
    expect(ignoredSecondMigration.preferredPlayerMode).toBe("native");
  });

  it("persists updated preferences across service instances", async () => {
    const first = new PreferencesService(preferencesPath);
    await first.initialize();
    await first.update({
      preferredPlayerMode: "native",
      experimentalTexturePlayer: true,
      chatTimestamps: false,
      chatHistoryLimit: 100,
      chatFontSize: 21,
      chatEmoteSize: 40,
      chatDeletedMessageStyle: "dimmed",
      chatOnLeft: true,
      chatOverlayOpacity: 42,
      mentionSoundEnabled: true,
      mentionSoundVolume: 85,
      oledMode: true,
      audioCompression: true,
      lastSeenChangelogVersion: "0.3.0-alpha.1",
    });

    const second = new PreferencesService(preferencesPath);
    await second.initialize();

    expect(await second.getOrMigrate()).toEqual({
      preferredPlayerMode: "native",
      experimentalTexturePlayer: true,
      chatTimestamps: false,
      chatHistoryLimit: 100,
      chatFontSize: 21,
      chatEmoteSize: 40,
      chatDeletedMessageStyle: "dimmed",
      chatOnLeft: true,
      playerVolume: 100,
      controlsHideDelay: 5000,
      sidebarCollapsed: false,
      chatSidebarWidth: 384,
      chatOverlayOpacity: 42,
      chatOverlayPlaced: false,
      chatOverlayLeft: 0,
      chatOverlayTop: 16,
      chatOverlayWidth: 370,
      chatOverlayHeight: 440,
      mentionSoundEnabled: true,
      mentionSoundVolume: 85,
      mentionSoundId: "ping",
      oledMode: true,
      audioCompression: true,
      lastSeenChangelogVersion: "0.3.0-alpha.1",
      emoteFavorites: [],
      favoriteChannels: [],
      platformFilter: "twitch",
      searchPlatformFilter: "both",
      emotePickerWidth: 390,
      emotePickerHeight: 500,
      emoteSearchAllProviders: false,
    });
  });

  it("serializes rapid updates so the newest value wins", async () => {
    const service = new PreferencesService(preferencesPath);
    await service.initialize();

    await Promise.all([
      service.update({ chatOverlayOpacity: 40 }),
      service.update({ chatOverlayOpacity: 55 }),
      service.update({ chatOverlayOpacity: 75 }),
    ]);

    const stored = JSON.parse(await fs.readFile(preferencesPath, "utf8")) as {
      chatOverlayOpacity: number;
    };
    expect(stored.chatOverlayOpacity).toBe(75);
  });

  it("rejects invalid preference updates without changing the saved file", async () => {
    const service = new PreferencesService(preferencesPath);
    await service.initialize();
    await service.update({ chatHistoryLimit: 40 });

    await expect(service.update({ chatHistoryLimit: 999 })).rejects.toThrow();

    const reloaded = new PreferencesService(preferencesPath);
    await reloaded.initialize();
    expect((await reloaded.getOrMigrate()).chatHistoryLimit).toBe(40);
  });
});
