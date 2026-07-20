import type { ChatConnectionState, ChatMessage } from "../shared/chat";
import { TwitchChatService } from "./twitch-chat-service";

// Retained per channel so a tab switch shows recent history immediately.
const BUFFER_LIMIT = 200;

/**
 * Keeps a live Twitch IRC connection for every multistream tile at once, each
 * with its own recent-message buffer. The renderer shows one channel's chat at
 * a time, but because they are all connected and buffered, switching tabs is
 * instant and no messages are missed while a tab is in the background.
 */
export class MultiChatService {
  private readonly services = new Map<string, TwitchChatService>();
  private readonly buffers = new Map<string, ChatMessage[]>();
  private historyLimit = 20;

  constructor(
    private readonly onMessage: (channel: string, message: ChatMessage) => void,
    private readonly onState: (channel: string, state: ChatConnectionState) => void,
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
      const service = new TwitchChatService(
        (message) => {
          buffer.push(message);
          if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT);
          this.onMessage(channel, message);
        },
        (state) => this.onState(channel, state),
      );
      service.setHistoryLimit(this.historyLimit);
      service.connect(channel);
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
