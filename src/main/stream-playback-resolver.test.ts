import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  spawn: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("./native-runtime", () => ({
  getNativeRuntimeAvailability: () => ({
    available: true,
    streamlinkPath: "streamlink.exe",
  }),
}));
vi.mock("./streamlink-worker", () => ({
  StreamlinkWorker: class {
    resolve = mocks.resolve;
    start() {}
    destroy = mocks.destroy;
  },
}));
vi.mock("./streamlink-process", () => ({
  spawnStreamlink: mocks.spawn,
  redactSensitivePlaybackText: (s: string) => s,
}));
import { StreamPlaybackResolver } from "./stream-playback-resolver";
afterEach(() => vi.clearAllMocks());
describe("warm playback resolution", () => {
  it("shares the stream lookup with quality discovery and avoids the CLI", async () => {
    mocks.resolve.mockResolvedValue({
      best: "https://example.com/live",
      "720p": "https://example.com/720",
    });
    const resolver = new StreamPlaybackResolver(() => null);
    const [url, qualities] = await Promise.all([
      resolver.resolve("one", "best"),
      resolver.getQualities("one"),
    ]);
    expect(url).toBe("https://example.com/live");
    expect(qualities.map((q) => q.value)).toEqual(["best", "720p"]);
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
    resolver.destroy();
  });
  it("invalidates cached stream URLs when playback credentials change", async () => {
    let token: string | null = null;
    mocks.resolve.mockResolvedValue({ best: "https://example.com/live" });
    const resolver = new StreamPlaybackResolver(() => token);
    await resolver.resolve("one", "best");
    token = "test-token";
    await resolver.resolve("one", "best");
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    expect(mocks.resolve).toHaveBeenLastCalledWith("one", "test-token");
    resolver.destroy();
  });
  it("falls back to the secure CLI when the worker fails", async () => {
    mocks.resolve.mockRejectedValue(new Error("worker failed"));
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    mocks.spawn.mockReturnValue(child);
    const resolver = new StreamPlaybackResolver(() => "test-token");
    const pending = resolver.resolve("one", "best");
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    child.stdout.emit("data", "https://example.com/fallback\n");
    child.emit("close", 0);
    await expect(pending).resolves.toBe("https://example.com/fallback");
    expect(mocks.spawn.mock.calls[0][2]).toEqual({
      twitchToken: "test-token",
      httpCookie: null,
    });
    resolver.destroy();
  });
  it("does not start fallback work after cancellation or shutdown", async () => {
    let reject!: (error: Error) => void;
    mocks.resolve.mockReturnValue(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    const resolver = new StreamPlaybackResolver(() => null);
    const pending = expect(resolver.resolve("one", "best")).rejects.toThrow(
      "cancelled",
    );
    resolver.cancelActiveResolution();
    reject(new Error("worker failed"));
    await pending;
    expect(mocks.spawn).not.toHaveBeenCalled();
    resolver.destroy();
  });
});
