import type {
  ChatConnectionState,
  ChatMessage,
  TwitchChatEmoteRange,
} from "../shared/chat";

type MessageListener = (message: ChatMessage) => void;
type StateListener = (state: ChatConnectionState) => void;

// A TCP connection can stop delivering data without ever firing "close"
// (Wi-Fi power saving while gaming, NAT timeouts, congestion drops). Twitch's
// IRC server pings roughly every five minutes, so a healthy connection is
// never silent longer than that: probe after four minutes of silence and
// declare the connection dead after five and a half.
const WATCHDOG_INTERVAL = 30_000;
const KEEPALIVE_AFTER_SILENCE = 4 * 60_000;
const DEAD_AFTER_SILENCE = 330_000;

export class TwitchChatService {
  private socket: WebSocket | null = null;
  private channel: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private manuallyClosed = false;
  private buffer = "";
  private readonly recentMessageIds = new Set<string>();
  private readonly recentMessageOrder: string[] = [];
  private historyLimit = 20;
  private lastActivityAt = 0;
  private keepalivePingSentAt = 0;
  private watchdogTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly onMessage: MessageListener,
    private readonly onState: StateListener,
  ) {}

  connect(channel: string): void {
    this.disconnect();
    this.channel = channel.toLowerCase();
    this.manuallyClosed = false;
    this.recentMessageIds.clear();
    this.recentMessageOrder.length = 0;
    this.open("connecting");
    void this.loadRecentMessages(this.channel);
  }

  disconnect(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopWatchdog();
    this.socket?.close();
    this.socket = null;
    this.channel = null;
    this.buffer = "";
    this.reconnectAttempt = 0;
    this.onState("disconnected");
  }

  setHistoryLimit(limit: number): void {
    this.historyLimit = limit;
  }

  private open(state: ChatConnectionState): void {
    const channel = this.channel;
    if (!channel) return;
    this.onState(state);
    const socket = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket || !this.channel) return;
      this.reconnectAttempt = 0;
      this.lastActivityAt = Date.now();
      this.keepalivePingSentAt = 0;
      this.startWatchdog();
      const nickname = `justinfan${Math.floor(10_000 + Math.random() * 89_999)}`;
      socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
      socket.send("PASS SCHMOOPIIE\r\n");
      socket.send(`NICK ${nickname}\r\n`);
      socket.send(`JOIN #${this.channel}\r\n`);
      this.onState("connected");
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      this.lastActivityAt = Date.now();
      this.handleData(String(event.data));
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.stopWatchdog();
      this.socket = null;
      if (!this.manuallyClosed && this.channel) this.scheduleReconnect();
    });
    socket.addEventListener("error", () => socket.close());
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    const timer = setInterval(() => this.checkConnectionLiveness(), WATCHDOG_INTERVAL);
    timer.unref?.();
    this.watchdogTimer = timer;
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private checkConnectionLiveness(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const silence = Date.now() - this.lastActivityAt;
    if (silence >= DEAD_AFTER_SILENCE) {
      // Silently dead: "close" may never fire on its own, so force the
      // reconnect path instead of waiting for the OS to notice.
      this.stopWatchdog();
      this.socket = null;
      try {
        socket.close();
      } catch {
        // The socket is already unusable; reconnecting is what matters.
      }
      if (!this.manuallyClosed && this.channel) this.scheduleReconnect();
      return;
    }
    // One probe per silent stretch: a healthy server answers with PONG,
    // which counts as activity and rearms the probe.
    if (silence >= KEEPALIVE_AFTER_SILENCE && this.keepalivePingSentAt <= this.lastActivityAt) {
      this.keepalivePingSentAt = Date.now();
      try {
        socket.send("PING :violetwire-keepalive\r\n");
      } catch {
        // Send failures are covered by the dead-connection cutoff above.
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt++);
    this.onState("reconnecting");
    this.reconnectTimer = setTimeout(() => this.open("reconnecting"), delay);
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\r\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("PING ")) {
        this.socket?.send(line.replace(/^PING/, "PONG") + "\r\n");
        continue;
      }
      const message = this.parseMessageLine(line);
      if (message) this.emitMessage(message);
    }
  }

  private async loadRecentMessages(channel: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(
        `https://recent-messages.robotty.de/api/v2/recent-messages/${encodeURIComponent(channel)}?limit=${this.historyLimit}`,
        { signal: controller.signal },
      );
      if (!response.ok) return;
      const payload: unknown = await response.json();
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("messages" in payload) ||
        !Array.isArray(payload.messages)
      ) {
        return;
      }
      if (this.channel !== channel) return;
      const messages = payload.messages
        .filter((line): line is string => typeof line === "string" && line.length <= 8_192)
        .map((line) => this.parseMessageLine(line))
        .filter((message): message is ChatMessage => Boolean(message))
        .sort((left, right) => left.sentAt - right.sentAt)
        .slice(-this.historyLimit);
      for (const message of messages) {
        if (this.channel !== channel) return;
        this.emitMessage({ ...message, historical: true });
      }
    } catch {
      // Recent history is a best-effort third-party enhancement. Live Twitch
      // IRC remains connected even when the history service is unavailable.
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseMessageLine(line: string): ChatMessage | null {
    const clearChatMatch =
      /^(?:@([^ ]+) )?:[^ ]+ CLEARCHAT #([^ ]+)(?: :?([\s\S]+))?$/.exec(line);
    if (clearChatMatch?.[3]) {
      const tags = this.parseTags(clearChatMatch[1] ?? "");
      const durationSeconds = Number(tags["ban-duration"]);
      const login = clearChatMatch[3].trim().toLowerCase();
      return {
        id: `moderation-${login}-${tags["tmi-sent-ts"] || Date.now()}`,
        channel: clearChatMatch[2],
        login,
        displayName: login,
        color: "#a1a1aa",
        text: "",
        badges: [],
        sentAt: Number(tags["tmi-sent-ts"]) || Date.now(),
        twitchEmotes: [],
        deleted: true,
        moderation: Number.isFinite(durationSeconds) && durationSeconds > 0
          ? { type: "timeout", durationSeconds }
          : { type: "ban" },
      };
    }
    const deletionMatch =
      /^(?:@([^ ]+) )?:[^ ]+ CLEARMSG #([^ ]+)(?: :?[\s\S]*)?$/.exec(line);
    if (deletionMatch) {
      const tags = this.parseTags(deletionMatch[1] ?? "");
      const targetMessageId = tags["target-msg-id"];
      if (!targetMessageId) return null;
      return {
        id: targetMessageId,
        channel: deletionMatch[2],
        login: tags.login ?? "",
        displayName: tags.login ?? "",
        color: "#a1a1aa",
        text: "",
        badges: [],
        sentAt: Number(tags["tmi-sent-ts"]) || Date.now(),
        twitchEmotes: [],
        deleted: true,
        moderation: { type: "message-deleted" },
      };
    }
    const userNoticeMatch =
      /^(?:@([^ ]+) )?:tmi\.twitch\.tv USERNOTICE #([^ ]+)(?: :?([\s\S]*))?$/.exec(
        line,
      );
    if (userNoticeMatch) {
      const tags = this.parseTags(userNoticeMatch[1] ?? "");
      const noticeType = this.parseNoticeType(tags["msg-id"]);
      const login = tags.login ?? "";
      return {
        id: tags.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        channel: userNoticeMatch[2],
        login,
        displayName: tags["display-name"] || login || "Twitch",
        color: /^#[0-9a-f]{6}$/i.test(tags.color ?? "") ? tags.color : "#a1a1aa",
        text: userNoticeMatch[3] ?? "",
        badges: (tags.badges ?? "").split(",").filter(Boolean),
        sentAt: Number(tags["tmi-sent-ts"]) || Date.now(),
        twitchEmotes: this.parseEmotes(tags.emotes ?? ""),
        notice: {
          type: noticeType,
          systemMessage:
            tags["system-msg"] ||
            this.fallbackNoticeMessage(noticeType, tags["display-name"] || login),
          cumulativeMonths: this.optionalPositiveNumber(
            tags["msg-param-cumulative-months"],
          ),
          streakMonths: this.optionalPositiveNumber(tags["msg-param-streak-months"]),
          recipientDisplayName:
            tags["msg-param-recipient-display-name"] ||
            tags["msg-param-recipient-user-name"] ||
            undefined,
          giftCount: this.optionalPositiveNumber(tags["msg-param-mass-gift-count"]),
          tier: this.formatSubscriptionTier(tags["msg-param-sub-plan"]),
        },
      };
    }
    const match = /^(?:@([^ ]+) )?:([^! ]+)!.* PRIVMSG #([^ ]+) :?([\s\S]*)$/.exec(line);
    if (!match) return null;
    const tags = this.parseTags(match[1] ?? "");
    const login = match[2];
    return {
      id: tags.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      channel: match[3],
      login,
      displayName: tags["display-name"] || login,
      color: /^#[0-9a-f]{6}$/i.test(tags.color ?? "") ? tags.color : "#a1a1aa",
      text: match[4],
      badges: (tags.badges ?? "").split(",").filter(Boolean),
      sentAt: Number(tags["tmi-sent-ts"]) || Date.now(),
      twitchEmotes: this.parseEmotes(tags.emotes ?? ""),
      reply: tags["reply-parent-msg-id"]
        ? {
            parentMessageId: tags["reply-parent-msg-id"],
            parentUserLogin: tags["reply-parent-user-login"] ?? "",
            parentDisplayName:
              tags["reply-parent-display-name"] ?? tags["reply-parent-user-login"] ?? "",
            parentMessageBody: tags["reply-parent-msg-body"] ?? "",
            threadMessageId: tags["reply-thread-parent-msg-id"] || undefined,
            threadUserLogin: tags["reply-thread-parent-user-login"] || undefined,
          }
        : undefined,
    };
  }

  private parseNoticeType(rawType: string | undefined): NonNullable<ChatMessage["notice"]>["type"] {
    switch (rawType) {
      case "sub":
      case "resub":
      case "subgift":
      case "submysterygift":
      case "giftpaidupgrade":
      case "anongiftpaidupgrade":
      case "raid":
      case "bitsbadgetier":
        return rawType;
      default:
        return "other";
    }
  }

  private optionalPositiveNumber(rawValue: string | undefined): number | undefined {
    if (!rawValue) return undefined;
    const value = Number(rawValue);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }

  private formatSubscriptionTier(rawTier: string | undefined): string | undefined {
    if (!rawTier) return undefined;
    if (rawTier === "Prime") return "Prime";
    if (rawTier === "1000") return "Tier 1";
    if (rawTier === "2000") return "Tier 2";
    if (rawTier === "3000") return "Tier 3";
    return undefined;
  }

  private fallbackNoticeMessage(
    type: NonNullable<ChatMessage["notice"]>["type"],
    displayName: string,
  ): string {
    const name = displayName || "Someone";
    if (type === "sub") return `${name} subscribed!`;
    if (type === "resub") return `${name} resubscribed!`;
    if (type === "subgift") return `${name} gifted a subscription!`;
    if (type === "submysterygift") return `${name} gifted subscriptions to the community!`;
    if (type === "raid") return `${name} is raiding!`;
    return "Twitch chat event";
  }

  private emitMessage(message: ChatMessage): void {
    if (message.deleted) {
      this.onMessage(message);
      return;
    }
    if (this.recentMessageIds.has(message.id)) return;
    this.recentMessageIds.add(message.id);
    this.recentMessageOrder.push(message.id);
    if (this.recentMessageOrder.length > 1_000) {
      const oldest = this.recentMessageOrder.shift();
      if (oldest) this.recentMessageIds.delete(oldest);
    }
    this.onMessage(message);
  }

  private parseTags(rawTags: string): Record<string, string> {
    const tags: Record<string, string> = {};
    for (const pair of rawTags.split(";")) {
      const separator = pair.indexOf("=");
      if (separator < 0) continue;
      tags[pair.slice(0, separator)] = pair
        .slice(separator + 1)
        .replaceAll("\\s", " ")
        .replaceAll("\\:", ";")
        .replaceAll("\\r", "\r")
        .replaceAll("\\n", "\n")
        .replaceAll("\\\\", "\\");
    }
    return tags;
  }

  private parseEmotes(raw: string): TwitchChatEmoteRange[] {
    if (!raw) return [];
    const ranges: TwitchChatEmoteRange[] = [];
    for (const group of raw.split("/")) {
      const [id, positions] = group.split(":");
      if (!id || !positions) continue;
      for (const position of positions.split(",")) {
        const [start, end] = position.split("-").map(Number);
        if (Number.isInteger(start) && Number.isInteger(end)) ranges.push({ id, start, end });
      }
    }
    return ranges;
  }
}
