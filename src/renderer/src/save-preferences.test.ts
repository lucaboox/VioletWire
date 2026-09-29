import { beforeEach, describe, expect, it, vi } from "vitest";

const update = vi.fn();
vi.stubGlobal("window", { desktop: { preferences: { update } } });

const { onPreferenceSaveFailed, savePreferences } = await import("./save-preferences");

describe("savePreferences", () => {
  beforeEach(() => {
    update.mockReset();
  });

  it("resolves to what was saved and tells nobody when the write works", async () => {
    const saved = { oledMode: true };
    update.mockResolvedValue(saved);
    const listener = vi.fn();
    const stop = onPreferenceSaveFailed(listener);

    await expect(savePreferences({ oledMode: true })).resolves.toBe(saved);
    expect(listener).not.toHaveBeenCalled();
    stop();
  });

  it("reports a write that fails instead of dropping it", async () => {
    update.mockRejectedValue(new Error("disk full"));
    const listener = vi.fn();
    const stop = onPreferenceSaveFailed(listener);

    await expect(savePreferences({ chatShowGifs: false })).resolves.toBeNull();
    expect(listener).toHaveBeenCalledWith({ chatShowGifs: false });
    stop();
  });

  it("stops telling a listener once it has unsubscribed", async () => {
    update.mockRejectedValue(new Error("locked"));
    const listener = vi.fn();
    onPreferenceSaveFailed(listener)();

    await savePreferences({ oledMode: false });
    expect(listener).not.toHaveBeenCalled();
  });
});
