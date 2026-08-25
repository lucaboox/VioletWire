import { beforeEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({
  clearStorageData: vi.fn<() => Promise<void>>(),
  clearCache: vi.fn<() => Promise<void>>(),
  flushStorageData: vi.fn<() => Promise<void>>(),
  fromPartition: vi.fn(),
  cookiesGet: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: class {},
  session: {
    fromPartition: electronState.fromPartition,
  },
}));

import { KickService } from "./kick-service";

describe("KickService authentication", () => {
  beforeEach(() => {
    electronState.clearStorageData.mockReset().mockResolvedValue(undefined);
    electronState.clearCache.mockReset().mockResolvedValue(undefined);
    electronState.flushStorageData.mockReset().mockResolvedValue(undefined);
    electronState.cookiesGet.mockReset().mockResolvedValue([]);
    electronState.fetch.mockReset();
    electronState.fromPartition.mockReset().mockReturnValue({
      clearStorageData: electronState.clearStorageData,
      clearCache: electronState.clearCache,
      flushStorageData: electronState.flushStorageData,
      cookies: { get: electronState.cookiesGet },
      fetch: electronState.fetch,
    });
  });

  it("clears and flushes the entire Kick-only partition on sign out", async () => {
    const service = new KickService();

    await service.signOut();

    expect(electronState.fromPartition).toHaveBeenCalledWith("persist:violetwire-kick");
    expect(electronState.clearStorageData).toHaveBeenCalledOnce();
    expect(electronState.clearStorageData).toHaveBeenCalledWith();
    expect(electronState.clearCache).toHaveBeenCalledOnce();
    expect(electronState.flushStorageData).toHaveBeenCalledOnce();
  });

  it("does not report a read-only identity as a usable signed-in account", async () => {
    const service = new KickService();

    await expect(service.getUser()).resolves.toBeNull();

    expect(electronState.fetch).not.toHaveBeenCalled();
  });

  it("rejects a chat send immediately when write credentials are absent", async () => {
    const service = new KickService();

    await expect(service.sendMessage("42", "hello")).rejects.toThrow(
      "Not signed in to Kick.",
    );

    expect(electronState.fetch).not.toHaveBeenCalled();
  });
});
