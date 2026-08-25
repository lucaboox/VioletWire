import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../shared/chat";
import { withoutRedundantReplyMention } from "./chat-display";

const message: ChatMessage = {
  id: "message",
  channel: "channel",
  login: "sender",
  displayName: "Sender",
  color: "#ffffff",
  text: "@Target hello",
  badges: [],
  sentAt: 1,
  twitchEmotes: [],
  reply: {
    parentMessageId: "parent",
    parentUserLogin: "target",
    parentDisplayName: "Target",
    parentMessageBody: "Earlier",
  },
};

describe("withoutRedundantReplyMention", () => {
  it("hides Twitch's redundant leading reply mention", () => {
    expect(withoutRedundantReplyMention(message).text).toBe("hello");
  });

  it("preserves mentions that are part of the actual reply", () => {
    expect(withoutRedundantReplyMention({ ...message, text: "hello @Target" }).text).toBe("hello @Target");
  });

  it("shifts emote and GIF positions by the same count Twitch used", () => {
    // Twitch counts characters, not the pairs JavaScript stores them as, so an
    // emoji in the message must not move the positions by an extra place.
    const withEmoji = withoutRedundantReplyMention({
      ...message,
      // "@Target " is 8 characters; the emoji is one, the emote follows it.
      text: "@Target 😀 Kappa",
      twitchEmotes: [{ id: "25", start: 10, end: 14 }],
    });

    expect(withEmoji.text).toBe("😀 Kappa");
    expect(withEmoji.twitchEmotes).toEqual([{ id: "25", start: 2, end: 6 }]);
    expect([...withEmoji.text].slice(2, 7).join("")).toBe("Kappa");
  });
});
