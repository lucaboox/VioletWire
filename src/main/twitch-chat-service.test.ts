import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../shared/chat";
import { TwitchChatService } from "./twitch-chat-service";

interface TwitchChatServiceInternals {
  parseMessageLine(line: string): ChatMessage | null;
  emitMessage(message: ChatMessage): void;
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeWebSocket.instances = [];
});

describe("TwitchChatService action messages", () => {
  it("unwraps CTCP ACTION and marks the message as an action", () => {
    const service = new TwitchChatService(vi.fn(), vi.fn(), vi.fn());
    const internals = service as unknown as TwitchChatServiceInternals;
    const message = internals.parseMessageLine(
      "@color=#8A2BE2;display-name=NightBot;id=51d6bd60-6c94-4f43-b78f-1c125fb51694;tmi-sent-ts=1720000000000 :nightbot!nightbot@nightbot.tmi.twitch.tv PRIVMSG #channel :\u0001ACTION Song request opened!\u0001",
    );

    expect(message).toMatchObject({
      text: "Song request opened!",
      action: true,
      color: "#8A2BE2",
    });
  });

  it("leaves ordinary messages unmarked", () => {
    const service = new TwitchChatService(vi.fn(), vi.fn(), vi.fn());
    const internals = service as unknown as TwitchChatServiceInternals;
    const message = internals.parseMessageLine(
      "@color=#8A2BE2;display-name=Someone;id=61d6bd60-6c94-4f43-b78f-1c125fb51694 :someone!someone@someone.tmi.twitch.tv PRIVMSG #channel :hello",
    );

    expect(message?.action).toBeUndefined();
    expect(message?.text).toBe("hello");
  });

  it("keeps Twitch's first-message marker for a new chatter", () => {
    const service = new TwitchChatService(vi.fn(), vi.fn(), vi.fn());
    const internals = service as unknown as TwitchChatServiceInternals;
    const first = internals.parseMessageLine(
      "@color=#9147FF;display-name=NewViewer;first-msg=1;id=71d6bd60-6c94-4f43-b78f-1c125fb51694 :newviewer!newviewer@newviewer.tmi.twitch.tv PRIVMSG #channel :hello chat",
    );
    const later = internals.parseMessageLine(
      "@color=#9147FF;display-name=Regular;first-msg=0;id=81d6bd60-6c94-4f43-b78f-1c125fb51694 :regular!regular@regular.tmi.twitch.tv PRIVMSG #channel :hello again",
    );

    expect(first?.firstMessage).toBe(true);
    expect(later?.firstMessage).toBeUndefined();
  });
});

describe("TwitchChatService connection watchdog", () => {
  function createConnectedService() {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onState = vi.fn();
    const service = new TwitchChatService(vi.fn(), onState, vi.fn());
    // loadRecentMessages runs fire-and-forget; a resolved dummy keeps it inert.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    service.connect("somechannel");
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.emit("open");
    return { service, socket, onState };
  }

  it("probes a silent connection with a client PING exactly once per stretch", async () => {
    const { socket } = createConnectedService();

    await vi.advanceTimersByTimeAsync(4 * 60_000 + 30_000);
    const keepalives = socket.sent.filter((line) => line.startsWith("PING"));
    expect(keepalives).toHaveLength(1);

    // Still silent, but before the dead cutoff: no additional probe.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.sent.filter((line) => line.startsWith("PING"))).toHaveLength(1);
  });

  it("rearms the probe after server activity", async () => {
    const { socket } = createConnectedService();

    await vi.advanceTimersByTimeAsync(4 * 60_000 + 30_000);
    expect(socket.sent.filter((line) => line.startsWith("PING"))).toHaveLength(1);

    socket.emit("message", { data: ":tmi.twitch.tv PONG tmi.twitch.tv :violetwire-keepalive\r\n" });
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 30_000);
    expect(socket.sent.filter((line) => line.startsWith("PING"))).toHaveLength(2);
  });

  it("reconnects when a connection stays silent past the dead cutoff", async () => {
    const { socket, onState } = createConnectedService();
    expect(FakeWebSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(330_000 + 30_000);

    expect(socket.closed).toBe(true);
    expect(onState).toHaveBeenCalledWith("reconnecting");
    // The reconnect timer (1s after first attempt) creates a fresh socket.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
  });

  it("never declares an active connection dead", async () => {
    const { socket } = createConnectedService();

    for (let minute = 0; minute < 12; minute += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      socket.emit("message", { data: "PING :tmi.twitch.tv\r\n" });
    }

    expect(socket.closed).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe("TwitchChatService recent history", () => {
  it("refreshes once after joining and deduplicates messages indexed late", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const line =
      "@color=#9147FF;display-name=Viewer;id=history-message;tmi-sent-ts=1720000000000 :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #channel :hello";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [] }), { status: 200 }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ messages: [line] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const onMessage = vi.fn();
    const service = new TwitchChatService(onMessage, vi.fn(), vi.fn());

    service.connect("channel");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("https://logs.zonian.dev/rm/channel");
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "history-message", historical: true }),
    );

    service.disconnect();
  });

  it("falls back to Robotty when Zonian is unavailable", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const line =
      "@color=#9147FF;display-name=Viewer;id=fallback-message;tmi-sent-ts=1720000000000 :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #channel :hello";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(
        new Response(JSON.stringify({ messages: [line] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const onMessage = vi.fn();
    const service = new TwitchChatService(onMessage, vi.fn(), vi.fn());

    service.connect("channel");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain(
      "https://recent-messages.robotty.de/api/v2/recent-messages/channel",
    );
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "fallback-message", historical: true }),
    );

    service.disconnect();
  });
});

describe("TwitchChatService replies", () => {
  it("keeps Twitch reply and thread metadata from IRC tags", () => {
    const service = new TwitchChatService(vi.fn(), vi.fn(), vi.fn());
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
    const service = new TwitchChatService(vi.fn(), vi.fn(), vi.fn());
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
    const service = new TwitchChatService(vi.fn(), vi.fn(), vi.fn());
    const internals = service as unknown as TwitchChatServiceInternals;
    const message = internals.parseMessageLine(
      "@badge-info=subscriber/14;badges=subscriber/12;color=#00FF7F;display-name=VioletFan;emotes=;id=51d6bd60-6c94-4f43-b78f-1c125fb51694;login=violetfan;msg-id=resub;msg-param-cumulative-months=14;msg-param-streak-months=4;msg-param-sub-plan=1000;system-msg=VioletFan\\ssubscribed\\sat\\sTier\\s1.\\sThey've\\ssubscribed\\sfor\\s14\\smonths!;tmi-sent-ts=1720000000000 :tmi.twitch.tv USERNOTICE #channel :Love the stream!",
    );

    expect(message).toMatchObject({
      displayName: "VioletFan",
      text: "Love the stream!",
      badges: ["subscriber/12"],
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

  it("folds community-gift recipient notices into the matching summary", () => {
    const onMessage = vi.fn();
    const service = new TwitchChatService(onMessage, vi.fn(), vi.fn());
    const internals = service as unknown as TwitchChatServiceInternals;
    const summary = internals.parseMessageLine(
      "@badges=sub-gifter/10;color=#9147FF;display-name=CyanFlare;id=gift-summary;login=cyanflare;msg-id=submysterygift;msg-param-mass-gift-count=2;msg-param-sub-plan=1000;system-msg=CyanFlare\\sis\\sgifting\\s2\\sTier\\s1\\sSubs\\sto\\sthe\\scommunity!;tmi-sent-ts=1720000000000 :tmi.twitch.tv USERNOTICE #channel",
    );
    const firstRecipient = internals.parseMessageLine(
      "@badges=sub-gifter/10;color=#9147FF;display-name=CyanFlare;id=gift-one;login=cyanflare;msg-id=subgift;msg-param-recipient-display-name=FirstViewer;msg-param-sub-plan=1000;system-msg=CyanFlare\\sgifted\\sa\\sTier\\s1\\ssub\\sto\\sFirstViewer!;tmi-sent-ts=1720000000001 :tmi.twitch.tv USERNOTICE #channel",
    );
    const secondRecipient = internals.parseMessageLine(
      "@badges=sub-gifter/10;color=#9147FF;display-name=CyanFlare;id=gift-two;login=cyanflare;msg-id=subgift;msg-param-recipient-display-name=SecondViewer;msg-param-sub-plan=1000;system-msg=CyanFlare\\sgifted\\sa\\sTier\\s1\\ssub\\sto\\sSecondViewer!;tmi-sent-ts=1720000000002 :tmi.twitch.tv USERNOTICE #channel",
    );

    expect(summary).not.toBeNull();
    expect(firstRecipient).not.toBeNull();
    expect(secondRecipient).not.toBeNull();
    internals.emitMessage(summary!);
    internals.emitMessage(firstRecipient!);
    internals.emitMessage(secondRecipient!);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "gift-summary",
        notice: expect.objectContaining({ type: "submysterygift", giftCount: 2 }),
      }),
    );
  });

  it("keeps standalone gift notices visible", () => {
    const onMessage = vi.fn();
    const service = new TwitchChatService(onMessage, vi.fn(), vi.fn());
    const internals = service as unknown as TwitchChatServiceInternals;
    const gift = internals.parseMessageLine(
      "@badges=sub-gifter/1;color=#9147FF;display-name=CyanFlare;id=single-gift;login=cyanflare;msg-id=subgift;msg-param-recipient-display-name=Viewer;msg-param-sub-plan=1000;system-msg=CyanFlare\\sgifted\\sa\\sTier\\s1\\ssub\\sto\\sViewer!;tmi-sent-ts=1720000000000 :tmi.twitch.tv USERNOTICE #channel",
    );

    expect(gift).not.toBeNull();
    internals.emitMessage(gift!);

    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "single-gift" }));
  });
});
