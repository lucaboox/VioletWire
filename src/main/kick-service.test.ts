import { beforeEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({
  clearStorageData: vi.fn<() => Promise<void>>(),
  clearCache: vi.fn<() => Promise<void>>(),
  flushStorageData: vi.fn<() => Promise<void>>(),
  fromPartition: vi.fn(),
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
    electronState.fromPartition.mockReset().mockReturnValue({
      clearStorageData: electronState.clearStorageData,
      clearCache: electronState.clearCache,
      flushStorageData: electronState.flushStorageData,
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
});
