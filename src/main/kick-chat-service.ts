import type { ChatConnectionState, ChatMessage } from "../shared/chat";
import type { KickService } from "./kick-service";

type MessageListener = (message: ChatMessage) => void;
type StateListener = (state: ChatConnectionState) => void;

/**
 * Kick's official chat API only sends; it cannot read. Its event system is
 * webhook-based, which a desktop app has nowhere to receive. What the site
 * itself uses is Pusher, and that accepts anonymous subscribers, so reading a
 * public channel's chat needs no account and no key of our own.
 */
const PUSHER_APP_KEY = "32cbd69e4b950bf97679";
const PUSHER_CLUSTER = "us2";
const PUSHER_URL =
  `wss://ws-${PUSHER_CLUSTER}.pusher.com/app/${PUSHER_APP_KEY}` +
  "?protocol=7&client=violetwire&version=1.0";

// Pusher sends its own pings; treat a long silence as a dead connection the way
// the Twitch service does, rather than trusting close events to always arrive.
const WATCHDOG_INTERVAL = 30_000;
const DEAD_AFTER_SILENCE = 180_000;
const MAX_RECONNECT_DELAY = 30_000;

interface KickChatIdentity {
  color?: string;
  badges?: { type?: string; text?: string }[];
}

interface KickChatSender {
  id?: number;
  username?: string;
  slug?: string;
  identity?: KickChatIdentity;
}

interface KickChatMessagePayload {
  id?: string;
  content?: string;
  created_at?: string;
  sender?: KickChatSender;
}

export class KickChatService {
  private socket: WebSocket | null = null;
  private channel: string | null = null;
  private chatroomId: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private manuallyClosed = false;
  private lastActivityAt = 0;
  private watchdogTimer: NodeJS.Timeout | null = null;
  // Guards against a slow chatroom lookup completing after the user has already
  // moved to another channel.
  private connectGeneration = 0;

  constructor(
    private readonly getKickService: () => KickService,
    private readonly onMessage: MessageListener,
    private readonly onState: StateListener,
  ) {}

  /** `slug` is the bare Kick channel name, without the platform prefix. */
  async connect(slug: string): Promise<void> {
    this.disconnect();
    this.channel = slug.toLowerCase();
    this.manuallyClosed = false;
    const generation = ++this.connectGeneration;
    this.onState("connecting");

    // The chat socket is keyed by chatroom id, which only the channel endpoint
    // knows, so the lookup has to happen before subscribing.
    const channel = await this.getKickService().getChannel(this.channel);
    if (generation !== this.connectGeneration || this.manuallyClosed) return;

    if (!channel?.chatroomId) {
      this.onState("disconnected");
      return;
    }
    this.chatroomId = channel.chatroomId;
    this.openSocket();
  }

  disconnect(): void {
    this.manuallyClosed = true;
    this.connectGeneration += 1;
    this.clearTimers();
    this.reconnectAttempt = 0;
    this.chatroomId = null;
    this.channel = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.onopen = null;
      try {
        socket.close();
      } catch {
        // Already closing.
      }
    }
    this.onState("disconnected");
  }

  private openSocket(): void {
    const socket = new WebSocket(PUSHER_URL);
    this.socket = socket;
    this.lastActivityAt = Date.now();

    socket.onopen = () => {
      if (this.socket !== socket || this.chatroomId === null) return;
      this.lastActivityAt = Date.now();
      // v2 carries the identity fields (colour and badges) that v1 omits.
      this.send(socket, {
        event: "pusher:subscribe",
        data: { auth: "", channel: `chatrooms.${this.chatroomId}.v2` },
      });
      this.reconnectAttempt = 0;
      this.onState("connected");
      this.startWatchdog();
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.lastActivityAt = Date.now();
      this.handleFrame(typeof event.data === "string" ? event.data : "");
    };

    socket.onerror = () => {
      if (this.socket === socket) this.scheduleReconnect();
    };

    socket.onclose = () => {
      if (this.socket === socket) this.scheduleReconnect();
    };
  }

  private handleFrame(raw: string): void {
    if (raw.length === 0) return;
    let frame: { event?: string; data?: unknown };
    try {
      frame = JSON.parse(raw) as { event?: string; data?: unknown };
    } catch {
      return;
    }

    if (frame.event !== "App\\Events\\ChatMessageEvent") return;
    // Pusher nests the payload as a JSON string inside the frame.
    const payload = this.parseNestedData(frame.data);
    if (payload === null) return;

    const message = this.toChatMessage(payload);
    if (message !== null) this.onMessage(message);
  }

  private parseNestedData(data: unknown): KickChatMessagePayload | null {
    if (typeof data === "object" && data !== null) return data as KickChatMessagePayload;
    if (typeof data !== "string") return null;
    try {
      return JSON.parse(data) as KickChatMessagePayload;
    } catch {
      return null;
    }
  }

  private toChatMessage(payload: KickChatMessagePayload): ChatMessage | null {
    const channel = this.channel;
    const text = payload.content;
    if (channel === null || typeof text !== "string") return null;

    const sender = payload.sender ?? {};
    const login = sender.slug ?? sender.username ?? "";
    if (login.length === 0) return null;

    const sentAt = payload.created_at ? Date.parse(payload.created_at) : Number.NaN;
    return {
      id: payload.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      channel,
      login,
      displayName: sender.username ?? login,
      color: sender.identity?.color ?? "",
      text,
      // Kick's badges are its own set with no Twitch equivalent, and the
      // renderer resolves badge art from Twitch's assets, so they are dropped
      // rather than rendered as broken images.
      badges: [],
      sentAt: Number.isFinite(sentAt) ? sentAt : Date.now(),
      // Kick emotes use [emote:id:name] markup in the text rather than the
      // ranges Twitch sends; they render as their names until parsed.
      twitchEmotes: [],
    };
  }

  private send(socket: WebSocket, payload: unknown): void {
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      this.scheduleReconnect();
    }
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      if (Date.now() - this.lastActivityAt < DEAD_AFTER_SILENCE) return;
      // Silent far longer than Pusher's own ping interval: the socket is up as
      // far as the OS is concerned but is delivering nothing.
      this.scheduleReconnect();
    }, WATCHDOG_INTERVAL);
    this.watchdogTimer.unref();
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer === null) return;
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private clearTimers(): void {
    this.stopWatchdog();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed || this.reconnectTimer !== null) return;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.onopen = null;
      try {
        socket.close();
      } catch {
        // Already closing.
      }
    }
    this.stopWatchdog();
    this.onState("reconnecting");

    const delay = Math.min(MAX_RECONNECT_DELAY, 1_000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manuallyClosed || this.chatroomId === null) return;
      this.openSocket();
    }, delay);
    this.reconnectTimer.unref();
  }
}
