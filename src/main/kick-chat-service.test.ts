import { afterEach, describe, expect, it, vi } from "vitest";
import type { KickService } from "./kick-service";
import {
  kickBadges,
  KickChatService,
  parseKickEmotes,
  parseKickModerationEvent,
  parseKickReply,
} from "./kick-chat-service";

class FakeKickSocket {
  static instances: FakeKickSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor(readonly url: string) {
    FakeKickSocket.instances.push(this);
  }

  frame(event: string, data: unknown = {}, channel?: string): void {
    this.onmessage?.({ data: JSON.stringify({ event, data: JSON.stringify(data), channel }) });
  }
}

describe("KickChatService connection", () => {
  let service: KickChatService;

  afterEach(() => {
    service.disconnect();
    FakeKickSocket.instances = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function setup() {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeKickSocket);
    const api = {
      getChannel: vi.fn().mockResolvedValue({ id: "42", chatroomId: "99" }),
      getChatConnection: vi.fn().mockResolvedValue({ appKey: "currentKey", cluster: "us2" }),
      getChatHistory: vi.fn().mockResolvedValue([]),
    };
    const onMessage = vi.fn();
    const onState = vi.fn();
    service = new KickChatService(() => api as unknown as KickService, onMessage, onState, vi.fn());
    await service.connect("example");
    await Promise.resolve();
    return { api, onMessage, onState, socket: FakeKickSocket.instances[0] };
  }

  it("uses the channel's current app and waits for subscription confirmation", async () => {
    const { api, socket, onState, onMessage } = await setup();
    expect(api.getChatConnection).toHaveBeenCalledWith("42");
    expect(socket.url).toContain("ws-us2.pusher.com/app/currentKey?");
    socket.onopen?.();
    expect(socket.send).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalledWith("connected");
    socket.frame("pusher:connection_established", { socket_id: "1.2" });
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({
      event: "pusher:subscribe", data: { auth: "", channel: "chatrooms.99.v2" },
    });
    socket.frame("pusher_internal:subscription_succeeded", {}, "chatrooms.99.v2");
    expect(onState).toHaveBeenLastCalledWith("connected");
    socket.frame("App\\Events\\ChatMessageEvent", {
      id: "live-message", content: "hello", sender: { username: "Viewer" },
    }, "chatrooms.99.v2");
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "live-message", text: "hello" }));
  });

  it("answers application heartbeats even when they have no data", async () => {
    const { socket } = await setup();
    socket.onmessage?.({ data: JSON.stringify({ event: "pusher:ping" }) });
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ event: "pusher:pong", data: {} }));
  });

  it("refreshes the descriptor after rejection and backs off until subscribed", async () => {
    const { socket, api, onState } = await setup();
    socket.frame("pusher:error", { code: 4001 });
    expect(socket.close).toHaveBeenCalled();
    expect(onState).toHaveBeenLastCalledWith("reconnecting");
    api.getChatConnection.mockResolvedValue({ appKey: "replacement", cluster: "eu" });
    await vi.advanceTimersByTimeAsync(1_000);
    const next = FakeKickSocket.instances[1];
    expect(next.url).toContain("ws-eu.pusher.com/app/replacement?");
    next.onopen?.();
    next.frame("pusher:error", { code: 4001 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeKickSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeKickSocket.instances).toHaveLength(3);
  });

  it("does not open a stale connection after disconnecting during lookup", async () => {
    const { api } = await setup();
    let resolve!: (value: { appKey: string; cluster: string }) => void;
    api.getChatConnection.mockReturnValue(new Promise((done) => { resolve = done; }));
    await service.connect("other");
    service.disconnect();
    resolve({ appKey: "stale", cluster: "us2" });
    await Promise.resolve();
    expect(FakeKickSocket.instances).toHaveLength(1);
  });
});

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

  it("normalizes nested serialized and numeric deletion message ids", () => {
    expect(
      parseKickModerationEvent(
        "MessageDeletedEvent",
        { message: JSON.stringify({ id: 12345 }) },
        "xqc",
      ),
    ).toMatchObject({
      id: "12345",
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

describe("kickBadges", () => {
  const badges = (types: { type: string; text?: string; count?: number }[]) =>
    kickBadges({ badges: types }, []);

  it("gives a badge Kick's own artwork and keeps the drawn glyph behind it", () => {
    const [badge] = badges([{ type: "moderator", text: "Moderator" }]);

    expect(badge.imageUrl).toBe("https://cdn.kicktalk.app/Badges/moderator.svg");
    // The glyph stays so the badge still renders if the artwork cannot load.
    expect(badge.glyph).toBe("moderator");
    expect(badge.title).toBe("Moderator");
  });

  it("finds artwork for a badge type it has never seen", () => {
    // The point of deriving the address from the type: a badge Kick adds later
    // needs no change here.
    const [badge] = badges([{ type: "brandnewbadge", text: "Brand New" }]);

    expect(badge.imageUrl).toBe("https://cdn.kicktalk.app/Badges/brandnewbadge.svg");
    // And it still falls back to a chip if that artwork does not exist.
    expect(badge.label).toBe("BN");
  });

  it("follows the name artwork is filed under when it differs", () => {
    const [badge] = badges([{ type: "sub_gifter", text: "Sub Gifter" }]);

    expect(badge.imageUrl).toBe("https://cdn.kicktalk.app/Badges/subgifter1.svg");
  });

  it("refuses a badge type that could point the address elsewhere", () => {
    const [badge] = badges([{ type: "../../evil", text: "Evil" }]);

    expect(badge.imageUrl).toBe("");
  });

  it("still prefers the channel's own subscriber artwork", () => {
    const assets = kickBadges({ badges: [{ type: "subscriber", text: "Subscriber", count: 7 }] }, [
      { months: 6, imageUrl: "https://files.kick.com/channel_subscriber_badges/9/original" },
      { months: 1, imageUrl: "https://files.kick.com/channel_subscriber_badges/8/original" },
    ]);

    expect(assets[0].imageUrl).toBe(
      "https://files.kick.com/channel_subscriber_badges/9/original",
    );
  });
});
