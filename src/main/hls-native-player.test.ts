import { describe, expect, it, vi } from "vitest";
import type { NativeHlsStateReport, NativePlayerState } from "../shared/player";
const mocks = vi.hoisted(() => ({ options: [] as { publishParts?: boolean }[], close: vi.fn() }));
vi.mock("./filtered-hls-relay", () => ({
  FilteredHlsRelay: class {
    mediaTransportName = "direct-cdn";
    constructor(_origin: unknown, _platform: unknown, options: { publishParts?: boolean }) { mocks.options.push(options); }
    async start() { return "http://127.0.0.1/playlist"; }
    close = mocks.close;
  },
}));
import { HlsNativePlayer } from "./hls-native-player";

describe("parts startup compatibility fallback", () => {
  it("replaces a failed parts session once and ignores late reports from it", async () => {
    mocks.options.length = 0;
    mocks.close.mockResolvedValue(undefined);
    const resolve = vi.fn().mockResolvedValue("https://example.com/stream");
    const states: NativePlayerState[] = [];
    const player = new HlsNativePlayer(() => null, () => null, resolve, () => 50, () => "ultra-low", (state) => states.push(state));
    await player.start("ufdtech", "best", { kind: "channel", detail: "ufdtech" });
    const original = player.getState().hlsSource!;
    const report: NativeHlsStateReport = {
      target: "main", sessionId: original.sessionId, status: "error", paused: false,
      muted: false, volume: 50, behindLive: false, requestWholeSegments: true,
    };
    player.report(report);
    player.report(report);
    await vi.waitFor(() => expect(player.getState().hlsSource?.sessionId).not.toBe(original.sessionId));
    await vi.waitFor(() => expect(player.getState().hlsSource).toBeDefined());
    expect(mocks.options.map((options) => options.publishParts)).toEqual([true, false]);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    player.report({ ...report, status: "playing", requestWholeSegments: false });
    expect(player.getState().status).toBe("starting");
    const replacement = player.getState().hlsSource!;
    player.report({ ...report, sessionId: replacement.sessionId, requestWholeSegments: false, status: "playing" });
    expect(player.getState().status).toBe("playing");
    expect(player.getStats()?.["Playback compatibility"]).toContain("Whole segments");
    await player.start("ufdtech", "720p");
    expect(mocks.options.at(-1)?.publishParts).toBe(false);
    await player.start("another", "best");
    expect(mocks.options.at(-1)?.publishParts).toBe(true);
    player.destroy();
  });
});
