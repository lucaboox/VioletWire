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
});
