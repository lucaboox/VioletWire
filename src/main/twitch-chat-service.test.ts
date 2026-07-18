import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../shared/chat";
import { TwitchChatService } from "./twitch-chat-service";

interface TwitchChatServiceInternals {
  parseMessageLine(line: string): ChatMessage | null;
}

describe("TwitchChatService replies", () => {
  it("keeps Twitch reply and thread metadata from IRC tags", () => {
    const service = new TwitchChatService(vi.fn(), vi.fn());
    const internals = service as unknown as TwitchChatServiceInternals;
    const message = internals.parseMessageLine(
      "@badges=;color=#9147FF;display-name=Responder;id=51d6bd60-6c94-4f43-b78f-1c125fb51694;reply-parent-display-name=Parent;reply-parent-msg-body=hello\\sworld;reply-parent-msg-id=719e45c4-5861-4c3f-932d-e34141177b0e;reply-parent-user-login=parent;reply-thread-parent-msg-id=719e45c4-5861-4c3f-932d-e34141177b0e;reply-thread-parent-user-login=parent;tmi-sent-ts=1720000000000 :responder!responder@responder.tmi.twitch.tv PRIVMSG #channel :A reply",
    );

    expect(message?.reply).toEqual({
      parentMessageId: "719e45c4-5861-4c3f-932d-e34141177b0e",
      parentUserLogin: "parent",
      parentDisplayName: "Parent",
      parentMessageBody: "hello world",
      threadMessageId: "719e45c4-5861-4c3f-932d-e34141177b0e",
      threadUserLogin: "parent",
    });
  });
});
