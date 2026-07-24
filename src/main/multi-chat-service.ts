import type { ChatConnectionState, ChatMessage } from "../shared/chat";
import { parseChannelKey } from "../shared/platform";
import { TwitchChatService } from "./twitch-chat-service";
import { KickChatService } from "./kick-chat-service";
import type { KickService } from "./kick-service";

// Retained per channel so a tab switch shows recent history immediately.
const BUFFER_LIMIT = 200;

type TileChatService = TwitchChatService | KickChatService;

/**
 * Keeps a live chat connection for every multistream tile at once, each with
 * its own recent-message buffer. The renderer shows one channel's chat at a
 * time, but because they are all connected and buffered, switching tabs is
 * instant and no messages are missed while a tab is in the background. Each
 * tile uses the right service for its platform — Twitch IRC or Kick's socket.
 */
export class MultiChatService {
  private readonly services = new Map<string, TileChatService>();
  private readonly buffers = new Map<string, ChatMessage[]>();
  private historyLimit = 20;

  constructor(
    private readonly onMessage: (channel: string, message: ChatMessage) => void,
    private readonly onState: (channel: string, state: ChatConnectionState) => void,
    private readonly getKickService: () => KickService,
  ) {}

  setChannels(channels: string[]): void {
    const wanted = new Set(channels.map((channel) => channel.toLowerCase()));
    for (const [channel, service] of this.services) {
      if (!wanted.has(channel)) {
        service.disconnect();
        this.services.delete(channel);
        this.buffers.delete(channel);
      }
    }
    for (const channel of wanted) {
      if (this.services.has(channel)) continue;
      const buffer: ChatMessage[] = [];
      this.buffers.set(channel, buffer);
      // The map key stays the full channel key so the renderer's buffers line up
      // with each tile; the service connects to the bare login for its platform.
      const { platform, login } = parseChannelKey(channel);
      const onMessage = (message: ChatMessage) => {
        buffer.push(message);
        if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT);
        this.onMessage(channel, message);
      };
      const onState = (state: ChatConnectionState) => this.onState(channel, state);
      // Multistream tiles have no composer, so restrictions are not surfaced.
      const service: TileChatService =
        platform === "kick"
          ? new KickChatService(this.getKickService, onMessage, onState, () => undefined)
          : new TwitchChatService(onMessage, onState, () => undefined);
      service.setHistoryLimit(this.historyLimit);
      void service.connect(login);
      this.services.set(channel, service);
    }
  }

  setHistoryLimit(limit: number): void {
    this.historyLimit = limit;
    for (const service of this.services.values()) service.setHistoryLimit(limit);
  }

  stop(): void {
    for (const service of this.services.values()) service.disconnect();
    this.services.clear();
    this.buffers.clear();
  }
}
