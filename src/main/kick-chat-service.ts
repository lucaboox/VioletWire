import type {
  ChatBadgeAsset,
  ChatConnectionState,
  ChatMessage,
  ChatRestrictions,
  TwitchChatEmoteRange,
} from "../shared/chat";
import { KICK_GLYPH_BADGE_TYPES, NO_CHAT_RESTRICTIONS } from "../shared/chat";
import type { KickService } from "./kick-service";
import type { KickChatReplyTarget } from "./kick-service";

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
const MAX_REPLY_TARGETS = 500;

// Kick sends emotes inline as [emote:id:name] rather than as ranges alongside
// the text. Both parts are in the markup, so nothing else has to be fetched to
// render one.
const EMOTE_MARKUP = /\[emote:(\d+):([^\]]+)\]/g;
const EMOTE_IMAGE = (id: string) => `https://files.kick.com/emotes/${id}/fullsize`;

/**
 * Replaces the markup with the emote's name and reports where each landed, so
 * the renderer can swap those spans for images exactly as it does for Twitch.
 * Positions are measured in code points, matching how Twitch indexes its own
 * ranges, so emoji earlier in a message do not shift them.
 */
export function parseKickEmotes(raw: string): {
  text: string;
  emotes: TwitchChatEmoteRange[];
} {
  EMOTE_MARKUP.lastIndex = 0;
  const emotes: TwitchChatEmoteRange[] = [];
  let text = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = EMOTE_MARKUP.exec(raw)) !== null) {
    text += raw.slice(cursor, match.index);
    const start = [...text].length;
    const name = match[2];
    text += name;
    emotes.push({
      id: match[1],
      start,
      end: start + [...name].length - 1,
      imageUrl: EMOTE_IMAGE(match[1]),
      provider: "kick",
    });
    cursor = match.index + match[0].length;
  }
  text += raw.slice(cursor);
  return { text, emotes };
}

interface KickChatIdentity {
  color?: string;
  badges?: { type?: string; text?: string; count?: number }[];
  badges_v2?: { name?: string; image_url?: string }[];
}

interface KickChatSender {
  id?: number;
  username?: string;
  slug?: string;
  identity?: KickChatIdentity;
}

interface KickChatMessagePayload {
  id?: string | number;
  content?: string;
  created_at?: string;
  type?: string;
  metadata?: unknown;
  thread_parent_id?: string;
  replied_to?: unknown;
  replies_to?: unknown;
  sender?: KickChatSender;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Kick's website Pusher feed uses `metadata.original_*`, while its public
 * event API calls the same object `replies_to`. Accept both so a server-side
 * payload rollout does not silently remove reply context from chat.
 */
export function parseKickReply(payload: unknown): ChatMessage["reply"] | undefined {
  const message = record(payload);
  if (message === null) return undefined;
  const metadata = record(message.metadata);
  const originalMessage = record(metadata?.original_message);
  const originalSender = record(metadata?.original_sender);
  const publicReply = record(message.replied_to) ?? record(message.replies_to);
  const publicMessage = record(publicReply?.message);
  const publicSender = record(publicReply?.sender);

  const parentMessageId =
    textValue(originalMessage?.id) ??
    textValue(publicReply?.message_id) ??
    textValue(publicReply?.id) ??
    textValue(publicMessage?.id);
  const parentMessageBody =
    textValue(originalMessage?.content) ??
    textValue(publicReply?.content) ??
    textValue(publicReply?.message) ??
    textValue(publicMessage?.content);
  const parentUserLogin =
    textValue(originalSender?.slug) ??
    textValue(originalSender?.username) ??
    textValue(publicSender?.channel_slug) ??
    textValue(publicSender?.slug) ??
    textValue(publicSender?.username);

  if (!parentMessageId || parentMessageBody === undefined || !parentUserLogin) {
    return undefined;
  }
  const currentSender = record(message.sender);
  const threadMessageId = textValue(message.thread_parent_id);
  return {
    parentMessageId,
    parentUserLogin,
    parentDisplayName:
      textValue(originalSender?.username) ??
      textValue(publicSender?.username) ??
      parentUserLogin,
    parentMessageBody: parseKickEmotes(parentMessageBody).text,
    threadMessageId,
    threadUserLogin:
      threadMessageId === undefined
        ? undefined
        : textValue(currentSender?.slug) ?? textValue(currentSender?.username),
  };
}

/**
 * Converts Kick's live moderation events to the same tombstone messages used
 * by Twitch. `applyChatMessage` then keeps the original text in memory and
 * lets the user reveal it, rather than replacing it with an empty event row.
 */
export function parseKickModerationEvent(
  eventName: string,
  payload: unknown,
  channel: string,
  now = Date.now(),
): ChatMessage | null {
  const data = record(payload);
  if (data === null) return null;

  if (
    eventName === "MessageDeletedEvent" ||
    eventName === "ChatMessageDeletedEvent" ||
    eventName.endsWith("\\MessageDeletedEvent") ||
    eventName.endsWith("\\ChatMessageDeletedEvent")
  ) {
    const nestedMessage =
      record(data.message) ??
      (typeof data.message === "string"
        ? (() => {
            try {
              return record(JSON.parse(data.message));
            } catch {
              return null;
            }
          })()
        : null);
    const messageId =
      textValue(data.message_id) ??
      textValue(data.deleted_message_id) ??
      textValue(nestedMessage?.message_id) ??
      textValue(nestedMessage?.id) ??
      (typeof data.message === "string" && !data.message.trim().startsWith("{")
        ? textValue(data.message)
        : undefined);
    if (!messageId) return null;
    return {
      id: messageId,
      channel,
      login: "",
      displayName: "",
      color: "",
      text: "",
      badges: [],
      sentAt: now,
      twitchEmotes: [],
      deleted: true,
      moderation: { type: "message-deleted" },
    };
  }

  if (
    eventName !== "UserBannedEvent" &&
    !eventName.endsWith("\\UserBannedEvent")
  ) {
    return null;
  }
  const user = record(data.user);
  const login =
    textValue(user?.slug) ??
    textValue(user?.username) ??
    textValue(data.banned_username) ??
    textValue(data.username);
  if (!login) return null;

  const permanent = data.permanent === true || data.expires_at === null;
  const durationMinutes = numberValue(data.duration);
  const expiresAt =
    typeof data.expires_at === "string" ? Date.parse(data.expires_at) : Number.NaN;
  const durationSeconds =
    durationMinutes !== undefined
      ? Math.max(1, Math.round(durationMinutes * 60))
      : Number.isFinite(expiresAt)
        ? Math.max(1, Math.round((expiresAt - now) / 1000))
        : undefined;
  const isTimeout = !permanent && durationSeconds !== undefined;

  return {
    id: `kick-moderation-${textValue(data.id) ?? `${login}-${now}`}`,
    channel,
    login: login.toLowerCase(),
    displayName: textValue(user?.username) ?? login,
    color: "",
    text: "",
    badges: [],
    sentAt: now,
    twitchEmotes: [],
    deleted: true,
    moderation: isTimeout
      ? { type: "timeout", durationSeconds }
      : { type: "ban" },
  };
}

// Kick renders these as built-in icons with no image in the chat payload. The
// ones VioletWire has artwork for are drawn as that glyph; the rest fall back
// to a small coloured chip below.
const KICK_GLYPH_BADGES = new Set<string>(KICK_GLYPH_BADGE_TYPES);

// Kick's own badges arrive as a type with no artwork attached, so every new one
// used to mean drawing another glyph by hand. KickTalk publishes Kick's badge
// art under its type name, which means a badge type VioletWire has never seen
// still renders correctly. The hand-drawn glyphs stay as the fallback, so a
// badge whose art is missing — or the whole host being unreachable — still
// looks the way it did before.
const KICK_BADGE_ART_HOST = "https://cdn.kicktalk.app/Badges";
// The few whose art is filed under a different name than Kick's badge type.
const KICK_BADGE_ART_NAMES: Record<string, string> = {
  sub_gifter: "subgifter1",
};

function kickBadgeArtUrl(type: string): string {
  // The type comes from Kick's API, so only a plain name is allowed to reach
  // the URL; anything else would be able to point this somewhere else entirely.
  if (!/^[a-z0-9_]+$/i.test(type)) return "";
  return `${KICK_BADGE_ART_HOST}/${KICK_BADGE_ART_NAMES[type] ?? type}.svg`;
}

const KICK_TEXT_BADGE_COLORS: Record<string, string> = {
  broadcaster: "#fa5838",
  moderator: "#00c9a7",
  verified: "#1475e1",
  vip: "#e0559c",
  og: "#d17ee6",
  founder: "#e0a944",
  staff: "#8a5cf6",
  subscriber: "#5a9bff",
  sub_gifter: "#5a9bff",
};

export function kickBadges(
  identity: KickChatIdentity | undefined,
  subscriberBadges: { months: number; imageUrl: string }[],
): ChatBadgeAsset[] {
  if (!identity) return [];
  const assets: ChatBadgeAsset[] = [];
  // Image badges (level, and any others Kick gives a URL) render as images.
  for (const badge of identity.badges_v2 ?? []) {
    if (!badge.image_url) continue;
    assets.push({
      key: `kick-img-${badge.name ?? assets.length}`,
      title: badge.name ?? "Badge",
      imageUrl: badge.image_url,
    });
  }
  for (const badge of identity.badges ?? []) {
    const type = badge.type ?? "";
    if (type.length === 0) continue;
    const label = badge.text ?? type;
    // Subscriber badges are real, channel-specific images tiered by months, so
    // match the sub's month count to the best tier rather than a text chip.
    if (type === "subscriber") {
      const months = badge.count ?? 0;
      const tier = subscriberBadges.find((entry) => months >= entry.months);
      if (tier) {
        assets.push({
          key: "kick-subscriber",
          title: `Subscriber (${months} month${months === 1 ? "" : "s"})`,
          imageUrl: tier.imageUrl,
        });
        continue;
      }
    }
    if (KICK_GLYPH_BADGES.has(type)) {
      assets.push({
        key: `kick-${type}`,
        title: label,
        imageUrl: kickBadgeArtUrl(type),
        glyph: type,
      });
      continue;
    }
    // A badge with no glyph of its own still gets Kick's artwork; only one
    // Kick has never published falls all the way through to a coloured chip.
    assets.push({
      key: `kick-${type}`,
      title: label,
      imageUrl: kickBadgeArtUrl(type),
      label: label
        .split(/\s+/)
        .map((word) => word[0] ?? "")
        .join("")
        .slice(0, 3)
        .toUpperCase(),
      color: KICK_TEXT_BADGE_COLORS[type] ?? "#7a7a85",
    });
  }
  return assets;
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
  private historyLimit = 20;
  private subscriberBadges: { months: number; imageUrl: string }[] = [];
  private readonly replyTargets = new Map<string, KickChatReplyTarget>();

  constructor(
    private readonly getKickService: () => KickService,
    private readonly onMessage: MessageListener,
    private readonly onState: StateListener,
    private readonly onRestrictions: (restrictions: ChatRestrictions) => void,
  ) {}

  /** `slug` is the bare Kick channel name, without the platform prefix. */
  async connect(slug: string): Promise<void> {
    this.disconnect();
    this.channel = slug.toLowerCase();
    this.manuallyClosed = false;
    const generation = ++this.connectGeneration;
    this.onRestrictions(NO_CHAT_RESTRICTIONS);
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
    this.subscriberBadges = channel.subscriberBadges ?? [];
    if (channel.restrictions) this.onRestrictions(channel.restrictions);
    this.openSocket();
    // Load recent chat once the socket is opening, so history and live messages
    // both flow to the same buffer. The channel id, not the chatroom id, keys
    // the message route.
    void this.loadHistory(channel.id, generation);
  }

  setHistoryLimit(limit: number): void {
    this.historyLimit = limit;
  }

  private async loadHistory(channelId: string, generation: number): Promise<void> {
    if (this.historyLimit <= 0) return;
    const messages = await this.getKickService().getChatHistory(channelId);
    if (generation !== this.connectGeneration || this.manuallyClosed) return;

    const mapped = messages
      .map((entry) =>
        this.toChatMessage({
          id: entry.id ?? undefined,
          content: entry.content ?? undefined,
          created_at: entry.created_at ?? undefined,
          type: entry.type ?? undefined,
          metadata: entry.metadata,
          thread_parent_id: entry.thread_parent_id ?? undefined,
          replied_to: entry.replied_to,
          replies_to: entry.replies_to,
          sender: entry.sender
            ? {
                id: entry.sender.id ?? undefined,
                slug: entry.sender.slug ?? undefined,
                username: entry.sender.username ?? undefined,
                identity: entry.sender.identity
                  ? {
                      color: entry.sender.identity.color ?? undefined,
                      badges: (entry.sender.identity.badges ?? []).map((badge) => ({
                        type: badge.type ?? undefined,
                        text: badge.text ?? undefined,
                        count: badge.count ?? undefined,
                      })),
                      badges_v2: (entry.sender.identity.badges_v2 ?? []).map((badge) => ({
                        name: badge.name ?? undefined,
                        image_url: badge.image_url ?? undefined,
                      })),
                    }
                  : undefined,
              }
            : undefined,
        }),
      )
      .filter((message): message is ChatMessage => message !== null)
      // Kick returns newest first; the buffer wants chronological order.
      .sort((left, right) => left.sentAt - right.sentAt)
      .slice(-this.historyLimit);
    for (const message of mapped) {
      if (generation !== this.connectGeneration) return;
      this.onMessage({ ...message, historical: true });
    }
  }

  /** The room the live connection is subscribed to, if any. */
  getChatroomId(): string | null {
    return this.chatroomId;
  }

  getReplyTarget(messageId: string): KickChatReplyTarget | undefined {
    return this.replyTargets.get(messageId);
  }

  disconnect(): void {
    this.manuallyClosed = true;
    this.connectGeneration += 1;
    this.clearTimers();
    this.reconnectAttempt = 0;
    this.chatroomId = null;
    this.channel = null;
    this.replyTargets.clear();
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

    // Pusher nests the payload as a JSON string inside the frame.
    const payload = this.parseNestedData(frame.data);
    if (payload === null) return;

    if (frame.event === "App\\Events\\ChatMessageEvent") {
      const message = this.toChatMessage(payload);
      if (message !== null) this.onMessage(message);
      return;
    }

    if (this.channel === null || !frame.event) return;
    const moderation = parseKickModerationEvent(frame.event, payload, this.channel);
    if (moderation !== null) this.onMessage(moderation);
  }

  private parseNestedData(data: unknown): UnknownRecord | null {
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      return data as UnknownRecord;
    }
    if (typeof data !== "string") return null;
    try {
      return record(JSON.parse(data));
    } catch {
      return null;
    }
  }

  private toChatMessage(payload: KickChatMessagePayload | UnknownRecord): ChatMessage | null {
    const channel = this.channel;
    const typedPayload = payload as KickChatMessagePayload;
    const text = typedPayload.content;
    if (channel === null || typeof text !== "string") return null;

    const sender = typedPayload.sender ?? {};
    const login = sender.slug ?? sender.username ?? "";
    if (login.length === 0) return null;

    const { text: rendered, emotes } = parseKickEmotes(text);
    const sentAt = typedPayload.created_at
      ? Date.parse(typedPayload.created_at)
      : Number.NaN;
    const id =
      typedPayload.id === undefined
        ? `${Date.now()}-${Math.random().toString(36).slice(2)}`
        : String(typedPayload.id);
    if (typeof sender.id === "number" && sender.username) {
      this.replyTargets.set(id, {
        id,
        content: text,
        senderId: sender.id,
        senderUsername: sender.username,
        threadParentId: typedPayload.thread_parent_id,
      });
      if (this.replyTargets.size > MAX_REPLY_TARGETS) {
        const oldest = this.replyTargets.keys().next().value;
        if (oldest !== undefined) this.replyTargets.delete(oldest);
      }
    }
    return {
      id,
      channel,
      login,
      displayName: sender.username ?? login,
      color: sender.identity?.color ?? "",
      text: rendered,
      badges: [],
      badgeAssets: kickBadges(typedPayload.sender?.identity, this.subscriberBadges),
      sentAt: Number.isFinite(sentAt) ? sentAt : Date.now(),
      twitchEmotes: emotes,
      reply: parseKickReply(typedPayload),
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
