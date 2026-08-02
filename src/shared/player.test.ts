import { describe, expect, it } from "vitest";
import {
  channelActionSchema,
  chatPresentationSchema,
  channelNameSchema,
  isHighResolutionQuality,
  nativeQualitySchema,
  nativePlayerCommandSchema,
  parseStreamlinkQualityOutput,
  presentNativePlaybackError,
  playerModeSchema,
} from "./player";

describe("channelNameSchema", () => {
  it("normalizes valid channel names", () => {
    expect(channelNameSchema.parse(" TwitchDev ")).toBe("twitchdev");
  });

  it.each([
    "https://www.twitch.tv/TwitchDev",
    "https://twitch.tv/twitchdev/",
    "twitch.tv/twitchdev",
    "m.twitch.tv/twitchdev?desktop-redirect=true",
  ])("accepts Twitch channel URL %s", (value) => {
    expect(channelNameSchema.parse(value)).toBe("twitchdev");
  });

  it.each(["", "https://example.com/twitchdev", "https://twitch.tv/directory/game/test", "name with spaces", "../escape", "x".repeat(26)])(
    "rejects unsafe channel input %s",
    (value) => expect(() => channelNameSchema.parse(value)).toThrow(),
  );
});

describe("channelActionSchema", () => {
  it.each(["channel", "clip"])("accepts allowlisted action %s", (action) => {
    expect(channelActionSchema.parse(action)).toBe(action);
  });

  it("rejects arbitrary external actions", () => {
    expect(() => channelActionSchema.parse("https://example.com")).toThrow();
  });

  it("rejects subscribe, which now has its own window", () => {
    expect(() => channelActionSchema.parse("subscribe")).toThrow();
  });
});

describe("playerModeSchema", () => {
  it.each(["official", "native"])("accepts supported player mode %s", (mode) => {
    expect(playerModeSchema.parse(mode)).toBe(mode);
  });

  it("rejects unknown player engines", () => {
    expect(() => playerModeSchema.parse("browser-hack")).toThrow();
  });
});

describe("nativePlayerCommandSchema", () => {
  it("accepts bounded volume and toggle commands", () => {
    expect(nativePlayerCommandSchema.parse({ command: "set-volume", value: 45 })).toEqual({
      command: "set-volume",
      value: 45,
    });
    expect(nativePlayerCommandSchema.parse({ command: "toggle-pause" })).toEqual({
      command: "toggle-pause",
    });
    expect(nativePlayerCommandSchema.parse({ command: "go-live" })).toEqual({
      command: "go-live",
    });
    expect(
      nativePlayerCommandSchema.parse({ command: "set-compressor", enabled: true }),
    ).toEqual({
      command: "set-compressor",
      enabled: true,
    });
  });

  it.each([-1, 101, Number.NaN])("rejects unsafe volume value %s", (value) => {
    expect(() => nativePlayerCommandSchema.parse({ command: "set-volume", value })).toThrow();
  });
});

describe("native playback presentation schemas", () => {
  it.each(["side", "overlay"])("accepts chat presentation %s", (presentation) => {
    expect(chatPresentationSchema.parse(presentation)).toBe(presentation);
  });

  it.each(["best", "source", "audio_only", "1080p60", "720p"])(
    "accepts safe quality selector %s",
    (quality) => expect(nativeQualitySchema.parse(quality)).toBe(quality),
  );

  it.each(["1080p;calc.exe", "../best", "", "4k"])(
    "rejects unsafe or unsupported quality selector %s",
    (quality) => expect(() => nativeQualitySchema.parse(quality)).toThrow(),
  );
});

describe("parseStreamlinkQualityOutput", () => {
  it("returns real qualities in useful display order", () => {
    expect(
      parseStreamlinkQualityOutput(
        "Available streams: audio_only, 160p30 (worst), 360p30, 480p30, 720p60, 1080p60 (best)",
      ),
    ).toEqual([
      { value: "best", label: "Auto (1080p)" },
      { value: "1080p60", label: "1080p · 60 FPS" },
      { value: "720p60", label: "720p · 60 FPS" },
      { value: "480p30", label: "480p · 30 FPS" },
      { value: "360p30", label: "360p · 30 FPS" },
      { value: "160p30", label: "160p · 30 FPS" },
      { value: "audio_only", label: "Audio only" },
    ]);
  });

  it("falls back to automatic quality when discovery output is unavailable", () => {
    expect(parseStreamlinkQualityOutput("No playable streams found")).toEqual([
      { value: "best", label: "Auto" },
    ]);
  });
});

describe("isHighResolutionQuality", () => {
  const available = [
    { value: "best" as const, label: "Auto (1440p)" },
    { value: "1440p60" as const, label: "1440p · 60 FPS" },
    { value: "1080p60" as const, label: "1080p · 60 FPS" },
  ];

  it("recognizes an explicitly selected quality above 1080p", () => {
    expect(isHighResolutionQuality("1440p60", [])).toBe(true);
  });

  it("recognizes when automatic or source playback resolves above 1080p", () => {
    expect(isHighResolutionQuality("best", available)).toBe(true);
    expect(isHighResolutionQuality("source", available)).toBe(true);
    expect(
      isHighResolutionQuality("best", [
        { value: "best", label: "Auto (1440p)" },
      ]),
    ).toBe(true);
  });

  it("keeps 1080p and lower qualities eligible for ultra-low latency", () => {
    expect(isHighResolutionQuality("1080p60", available)).toBe(false);
    expect(
      isHighResolutionQuality("best", [
        { value: "best", label: "Auto (1080p)" },
        { value: "1080p60", label: "1080p · 60 FPS" },
      ]),
    ).toBe(false);
  });
});

describe("presentNativePlaybackError", () => {
  it("turns Streamlink's offline failure into a clear message", () => {
    expect(
      presentNativePlaybackError(
        "error: No playable streams found on this URL: https://www.twitch.tv/summit1g",
      ),
    ).toBe("Stream is offline.");
  });

  it("preserves unrelated native-player errors", () => {
    expect(presentNativePlaybackError("decoder could not start")).toBe("decoder could not start");
  });
});
