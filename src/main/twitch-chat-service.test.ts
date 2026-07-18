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

  it("parses timeout duration and permanent bans from CLEARCHAT", () => {
    const service = new TwitchChatService(vi.fn(), vi.fn());
    const internals = service as unknown as TwitchChatServiceInternals;
    const timeout = internals.parseMessageLine(
      "@ban-duration=600;target-user-id=42;tmi-sent-ts=1720000000000 :tmi.twitch.tv CLEARCHAT #channel :TroubleMaker",
    );
    const ban = internals.parseMessageLine(
      "@target-user-id=42;tmi-sent-ts=1720000001000 :tmi.twitch.tv CLEARCHAT #channel :TroubleMaker",
    );

    expect(timeout).toMatchObject({
      login: "troublemaker",
      deleted: true,
      moderation: { type: "timeout", durationSeconds: 600 },
    });
    expect(ban).toMatchObject({
      login: "troublemaker",
      deleted: true,
      moderation: { type: "ban" },
    });
  });

  it("parses subscription USERNOTICE metadata and the subscriber message", () => {
    const service = new TwitchChatService(vi.fn(), vi.fn());
    const internals = service as unknown as TwitchChatServiceInternals;
    const message = internals.parseMessageLine(
      "@badge-info=subscriber/14;badges=subscriber/12;color=#00FF7F;display-name=VioletFan;emotes=;id=51d6bd60-6c94-4f43-b78f-1c125fb51694;login=violetfan;msg-id=resub;msg-param-cumulative-months=14;msg-param-streak-months=4;msg-param-sub-plan=1000;system-msg=VioletFan\\ssubscribed\\sat\\sTier\\s1.\\sThey've\\ssubscribed\\sfor\\s14\\smonths!;tmi-sent-ts=1720000000000 :tmi.twitch.tv USERNOTICE #channel :Love the stream!",
    );

    expect(message).toMatchObject({
      displayName: "VioletFan",
      text: "Love the stream!",
      notice: {
        type: "resub",
        cumulativeMonths: 14,
        streakMonths: 4,
        tier: "Tier 1",
        systemMessage:
          "VioletFan subscribed at Tier 1. They've subscribed for 14 months!",
      },
    });
  });
});
