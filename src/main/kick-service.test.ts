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

import { getKickLoginUrl, KickService } from "./kick-service";

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

  it("sends social sign-in back through the main Kick site", () => {
    expect(getKickLoginUrl()).toBe(
      "https://id.kick.com/login?redirect=https%3A%2F%2Fkick.com%2F",
    );
  });

  it("does not report a read-only identity as a usable signed-in account", async () => {
    const service = new KickService();

    await expect(service.getUser()).resolves.toBeNull();

    expect(electronState.fetch).not.toHaveBeenCalled();
  });

  it("reports a server-rejected stored session as expired", async () => {
    electronState.cookiesGet.mockImplementation(async () => [{ value: "test" }]);
    electronState.fetch.mockResolvedValue(new Response(null, { status: 401 }));
    const service = new KickService();

    await expect(service.getAuthState()).resolves.toEqual({
      status: "signed-out",
      account: null,
      reason: "expired",
    });
  });

  it("accepts an authenticated account without an obsolete XSRF prerequisite", async () => {
    electronState.cookiesGet.mockImplementation(
      async (filter: { name?: string }) =>
        filter.name === "session_token" ? [{ value: "test" }] : [],
    );
    electronState.fetch.mockResolvedValue(
      new Response(JSON.stringify({ id: 42, username: "viewer" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const service = new KickService();

    await expect(service.getAuthState()).resolves.toEqual({
      status: "signed-in",
      account: { id: "42", username: "viewer", profileImageUrl: "" },
    });
    expect(electronState.fetch).toHaveBeenCalled();
  });

  it("reports a missing account bearer as signed out without waiting on Kick", async () => {
    const service = new KickService();

    await expect(service.getAuthState()).resolves.toEqual({
      status: "signed-out",
      account: null,
    });
    expect(electronState.fetch).not.toHaveBeenCalled();
  });

  it("does not call a temporary Kick outage an expired session", async () => {
    electronState.cookiesGet.mockImplementation(async () => [{ value: "test" }]);
    electronState.fetch.mockRejectedValue(new Error("offline"));
    const service = new KickService();

    await expect(service.getAuthState()).resolves.toEqual({
      status: "unavailable",
      account: null,
    });
  });

  it("rejects a chat send immediately when write credentials are absent", async () => {
    const service = new KickService();

    await expect(service.sendMessage("42", "hello")).rejects.toThrow(
      "Not signed in to Kick.",
    );

    expect(electronState.fetch).not.toHaveBeenCalled();
  });

  it("sends with the current bearer-and-cookie request shape", async () => {
    electronState.cookiesGet.mockImplementation(
      async (filter: { name?: string }) => {
        if (filter.name === "session_token") return [{ value: "bearer" }];
        return [];
      },
    );
    electronState.fetch.mockImplementation(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/api/v2/messages/send/")) {
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const service = new KickService();

    await expect(service.sendMessage("123", "hello")).resolves.toBeUndefined();

    expect(electronState.fetch).toHaveBeenCalledWith(
      "https://kick.com/api/v2/messages/send/123",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({
          Authorization: "Bearer bearer",
          "x-app-platform": "web",
        }),
      }),
    );
  });
});
