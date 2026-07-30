import { describe, expect, it } from "vitest";
import {
  parseKickEmotes,
  parseKickModerationEvent,
  parseKickReply,
} from "./kick-chat-service";

describe("parseKickEmotes", () => {
  it("leaves a message without emotes untouched", () => {
    const result = parseKickEmotes("hello there");
    expect(result.text).toBe("hello there");
    expect(result.emotes).toEqual([]);
  });

  it("replaces the markup with the emote name and reports its span", () => {
    const result = parseKickEmotes("[emote:37226:KEKW]");
    expect(result.text).toBe("KEKW");
    expect(result.emotes).toHaveLength(1);
    expect(result.emotes[0]).toMatchObject({
      id: "37226",
      start: 0,
      end: 3,
      provider: "kick",
    });
    expect(result.emotes[0].imageUrl).toBe("https://files.kick.com/emotes/37226/fullsize");
  });

  it("locates emotes that follow surrounding text", () => {
    const result = parseKickEmotes("lol [emote:37226:KEKW] yes");
    expect(result.text).toBe("lol KEKW yes");
    expect(result.emotes[0].start).toBe(4);
    expect(result.emotes[0].end).toBe(7);
    expect(result.text.slice(result.emotes[0].start, result.emotes[0].end + 1)).toBe("KEKW");
  });

  it("handles several emotes in one message", () => {
    const result = parseKickEmotes(
      "[emote:5620568:derekkingFKCUH] and [emote:37226:KEKW]",
    );
    expect(result.text).toBe("derekkingFKCUH and KEKW");
    expect(result.emotes.map((emote) => emote.id)).toEqual(["5620568", "37226"]);
    for (const emote of result.emotes) {
      const slice = [...result.text].slice(emote.start, emote.end + 1).join("");
      expect(slice).toMatch(/^(derekkingFKCUH|KEKW)$/);
    }
  });

  it("counts positions in code points so earlier emoji do not shift them", () => {
    const result = parseKickEmotes("👋 [emote:37226:KEKW]");
    const characters = [...result.text];
    const slice = characters.slice(result.emotes[0].start, result.emotes[0].end + 1).join("");
    expect(slice).toBe("KEKW");
  });

  it("ignores malformed markup rather than dropping the text", () => {
    const result = parseKickEmotes("[emote:abc:KEKW] [emote:12] plain");
    expect(result.text).toBe("[emote:abc:KEKW] [emote:12] plain");
    expect(result.emotes).toEqual([]);
  });

  it("is not affected by the previous call's regex position", () => {
    parseKickEmotes("[emote:1:A] [emote:2:B]");
    const result = parseKickEmotes("[emote:3:C]");
    expect(result.emotes).toHaveLength(1);
    expect(result.emotes[0].id).toBe("3");
  });
});

describe("parseKickReply", () => {
  it("reads the reply metadata emitted by Kick's website chat", () => {
    expect(
      parseKickReply({
        id: "reply-id",
        sender: { id: 9, username: "Replier", slug: "replier" },
        thread_parent_id: "thread-root",
        metadata: {
          original_message: {
            id: "parent-id",
            content: "hello [emote:37226:KEKW]",
          },
          original_sender: { id: 4, username: "OriginalUser" },
        },
      }),
    ).toEqual({
      parentMessageId: "parent-id",
      parentUserLogin: "OriginalUser",
      parentDisplayName: "OriginalUser",
      parentMessageBody: "hello KEKW",
      threadMessageId: "thread-root",
      threadUserLogin: "replier",
    });
  });

  it("also accepts the public event API's replies_to shape", () => {
    expect(
      parseKickReply({
        replies_to: {
          message_id: "parent-id",
          content: "original text",
          sender: {
            username: "Display Name",
            channel_slug: "display_name",
          },
        },
      }),
    ).toEqual({
      parentMessageId: "parent-id",
      parentUserLogin: "display_name",
      parentDisplayName: "Display Name",
      parentMessageBody: "original text",
      threadMessageId: undefined,
      threadUserLogin: undefined,
    });
  });

  it("ignores incomplete reply metadata", () => {
    expect(parseKickReply({ metadata: { original_message: { id: "parent-id" } } })).toBe(
      undefined,
    );
  });
});

describe("parseKickModerationEvent", () => {
  it("converts current message deletion events into a revealable tombstone", () => {
    expect(
      parseKickModerationEvent(
        "App\\Events\\MessageDeletedEvent",
        { id: "event-id", message: { id: "deleted-message-id" } },
        "xqc",
        123,
      ),
    ).toMatchObject({
      id: "deleted-message-id",
      channel: "xqc",
      deleted: true,
      moderation: { type: "message-deleted" },
      sentAt: 123,
    });
  });

  it("accepts Kick's older message_id deletion payload", () => {
    expect(
      parseKickModerationEvent(
        "App\\Events\\ChatMessageDeletedEvent",
        { message_id: "deleted-message-id", chatroom_id: 42 },
        "xqc",
      ),
    ).toMatchObject({
      id: "deleted-message-id",
      deleted: true,
      moderation: { type: "message-deleted" },
    });
  });

  it("converts temporary bans from minutes to seconds", () => {
    expect(
      parseKickModerationEvent(
        "App\\Events\\UserBannedEvent",
        {
          id: "ban-event",
          user: { username: "SomeUser", slug: "someuser" },
          permanent: false,
          duration: 10,
          expires_at: "2026-07-30T12:10:00Z",
        },
        "xqc",
        Date.parse("2026-07-30T12:00:00Z"),
      ),
    ).toMatchObject({
      login: "someuser",
      displayName: "SomeUser",
      deleted: true,
      moderation: { type: "timeout", durationSeconds: 600 },
    });
  });

  it("converts permanent bans without inventing a duration", () => {
    expect(
      parseKickModerationEvent(
        "App\\Events\\UserBannedEvent",
        {
          user: { username: "SomeUser" },
          permanent: true,
          duration: 10,
        },
        "xqc",
      ),
    ).toMatchObject({
      login: "someuser",
      deleted: true,
      moderation: { type: "ban" },
    });
  });
});
