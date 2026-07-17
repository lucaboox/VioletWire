import type {
  ChatConnectionState,
  ChatMessage,
  TwitchChatEmoteRange,
} from "../shared/chat";

type MessageListener = (message: ChatMessage) => void;
type StateListener = (state: ChatConnectionState) => void;

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
      const nickname = `justinfan${Math.floor(10_000 + Math.random() * 89_999)}`;
      socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
      socket.send("PASS SCHMOOPIIE\r\n");
      socket.send(`NICK ${nickname}\r\n`);
      socket.send(`JOIN #${this.channel}\r\n`);
      this.onState("connected");
    });
    socket.addEventListener("message", (event) => {
      if (this.socket === socket) this.handleData(String(event.data));
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.manuallyClosed && this.channel) this.scheduleReconnect();
    });
    socket.addEventListener("error", () => socket.close());
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
    };
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
