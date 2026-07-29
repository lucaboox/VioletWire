import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../shared/chat";
import { MultiChatService } from "./multi-chat-service";

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "sent-id",
    channel: "somechannel",
    login: "tester",
    displayName: "Tester",
    color: "#a1a1aa",
    text: "Hello",
    badges: [],
    sentAt: 1_000,
    twitchEmotes: [],
    ...overrides,
  };
}

interface MultiChatServiceInternals {
  buffers: Map<string, ChatMessage[]>;
}

describe("MultiChatService sent messages", () => {
  it("publishes a pending message into an active multistream channel", () => {
    const onMessage = vi.fn();
    const service = new MultiChatService(onMessage, vi.fn(), vi.fn() as never);
    const internals = service as unknown as MultiChatServiceInternals;
    internals.buffers.set("somechannel", []);

    const pending = message({ pending: true });
    service.publishSentMessage("SomeChannel", pending);

    expect(internals.buffers.get("somechannel")).toEqual([pending]);
    expect(onMessage).toHaveBeenCalledWith("somechannel", pending);
  });

  it("replaces the pending buffer entry with the confirmed chat copy", () => {
    const onMessage = vi.fn();
    const service = new MultiChatService(onMessage, vi.fn(), vi.fn() as never);
    const internals = service as unknown as MultiChatServiceInternals;
    const pending = message({ pending: true });
    internals.buffers.set("somechannel", [pending]);
    const confirmed = message({
      color: "#9147ff",
      badges: ["subscriber/12"],
      sentAt: 1_050,
    });

    (
      service as unknown as {
        recordMessage(channel: string, incoming: ChatMessage): void;
      }
    ).recordMessage("somechannel", confirmed);

    expect(internals.buffers.get("somechannel")).toEqual([confirmed]);
    expect(onMessage).toHaveBeenCalledWith("somechannel", confirmed);
  });
});
