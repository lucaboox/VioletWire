import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../shared/chat";
import { shouldAlertMention, viewerNameFor, type ViewerNames } from "./mention-alert";

const names: ViewerNames = { twitch: "lucaboox", kick: "luca_kick" };

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "1",
    channel: "xqc",
    login: "someone",
    displayName: "someone",
    color: "#fff",
    text: "",
    badges: [],
    sentAt: 0,
    twitchEmotes: [],
    ...overrides,
  };
}

describe("viewerNameFor", () => {
  it("uses the Twitch name in a Twitch chat and the Kick name in a Kick chat", () => {
    expect(viewerNameFor("xqc", names)).toBe("lucaboox");
    expect(viewerNameFor("kick:xqc", names)).toBe("luca_kick");
  });

  it("has no name to look for with no channel", () => {
    expect(viewerNameFor(null, names)).toBe("");
  });
});

describe("shouldAlertMention", () => {
  it("alerts for a mention in the chat that is open", () => {
    expect(shouldAlertMention(message({ text: "hi @lucaboox" }), names, ["xqc"])).toBe(true);
  });

  it("matches the Kick name in a Kick chat", () => {
    const kick = message({ channel: "xqc", text: "hey @luca_kick" });
    expect(shouldAlertMention(kick, names, ["kick:xqc"])).toBe(true);
  });

  it("does not match the Twitch name in a Kick chat", () => {
    const kick = message({ channel: "xqc", text: "hey @lucaboox" });
    expect(shouldAlertMention(kick, names, ["kick:xqc"])).toBe(false);
  });

  it("stays quiet for a chat that is not open", () => {
    // What a closed Kick stream's chat used to keep delivering.
    expect(shouldAlertMention(message({ channel: "left", text: "@lucaboox" }), names, ["xqc"])).toBe(
      false,
    );
  });

  it("alerts for any open multistream chat, not just the one on screen", () => {
    const fromBackground = message({ channel: "buddha", text: "@lucaboox look" });
    expect(shouldAlertMention(fromBackground, names, ["xqc", "buddha", "kick:someone"])).toBe(true);
  });

  it("stays quiet for history replayed on connect", () => {
    expect(
      shouldAlertMention(message({ text: "@lucaboox", historical: true }), names, ["xqc"]),
    ).toBe(false);
  });

  it("stays quiet for a deleted message", () => {
    expect(shouldAlertMention(message({ text: "@lucaboox", deleted: true }), names, ["xqc"])).toBe(
      false,
    );
  });

  it("stays quiet when signed out of that service", () => {
    const signedOut = { twitch: "", kick: "" };
    expect(shouldAlertMention(message({ text: "@lucaboox" }), signedOut, ["xqc"])).toBe(false);
  });
});
