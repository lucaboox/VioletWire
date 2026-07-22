import { describe, expect, it } from "vitest";
import {
  channelKey,
  channelKeySchema,
  channelUrl,
  isValidChannelName,
  parseChannelKey,
  streamlinkPlatformArguments,
} from "./platform";

describe("channel keys", () => {
  it("leaves Twitch channels bare so stored values keep resolving", () => {
    expect(channelKey("twitch", "xqc")).toBe("xqc");
    expect(parseChannelKey("xqc")).toEqual({ platform: "twitch", login: "xqc" });
  });

  it("prefixes other services", () => {
    expect(channelKey("kick", "xqc")).toBe("kick:xqc");
    expect(parseChannelKey("kick:xqc")).toEqual({ platform: "kick", login: "xqc" });
  });

  it("round-trips a Kick slug containing a hyphen", () => {
    const key = channelKey("kick", "some-streamer");
    expect(parseChannelKey(key)).toEqual({ platform: "kick", login: "some-streamer" });
  });

  it("treats an unknown prefix as a Twitch login rather than guessing", () => {
    expect(parseChannelKey("youtube:someone")).toEqual({
      platform: "twitch",
      login: "youtube:someone",
    });
  });
});

describe("channel name validation", () => {
  it("rejects hyphens on Twitch but allows them on Kick", () => {
    expect(isValidChannelName("twitch", "some-streamer")).toBe(false);
    expect(isValidChannelName("kick", "some-streamer")).toBe(true);
  });

  it("rejects empty names on both services", () => {
    expect(isValidChannelName("twitch", "")).toBe(false);
    expect(isValidChannelName("kick", "")).toBe(false);
  });

  it("accepts Kick slugs longer than Twitch's limit", () => {
    const slug = "a".repeat(30);
    expect(isValidChannelName("kick", slug)).toBe(true);
    expect(isValidChannelName("twitch", slug)).toBe(false);
  });
});

describe("channelKeySchema", () => {
  it("accepts both services and normalizes case", () => {
    expect(channelKeySchema.parse("XQC")).toBe("xqc");
    expect(channelKeySchema.parse("KICK:Some-Streamer")).toBe("kick:some-streamer");
  });

  it("rejects a hyphenated Twitch login", () => {
    expect(channelKeySchema.safeParse("some-streamer").success).toBe(false);
  });

  it("rejects characters neither service allows", () => {
    expect(channelKeySchema.safeParse("kick:bad slug").success).toBe(false);
    expect(channelKeySchema.safeParse("kick:bad/slug").success).toBe(false);
  });
});

describe("streamlink arguments", () => {
  it("sends Twitch its codec list", () => {
    expect(streamlinkPlatformArguments("twitch")).toContain("--twitch-supported-codecs");
  });

  it("disables the browser challenge solver on Kick", () => {
    const args = streamlinkPlatformArguments("kick");
    expect(args).toContain("--kick-low-latency");
    expect(args).toContain("--webbrowser=no");
    expect(args).not.toContain("--twitch-low-latency");
  });

  it("points each service at its own site", () => {
    expect(channelUrl("twitch", "xqc")).toBe("https://www.twitch.tv/xqc");
    expect(channelUrl("kick", "xqc")).toBe("https://kick.com/xqc");
  });
});
