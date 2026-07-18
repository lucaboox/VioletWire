import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./chat";
import { applyChatMessage, CHAT_MESSAGE_LIMIT } from "./chat-messages";

function makeMessage(id: string, sentAt: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    channel: "testchannel",
    login: "viewer",
    displayName: "Viewer",
    color: "#ff0000",
    text: `message ${id}`,
    badges: [],
    sentAt,
    twitchEmotes: [],
    ...overrides,
  };
}

describe("applyChatMessage", () => {
  it("appends messages that arrive in timestamp order", () => {
    const first = makeMessage("a", 1_000);
    const second = makeMessage("b", 2_000);
    const third = makeMessage("c", 2_000);

    let messages = applyChatMessage([], first);
    messages = applyChatMessage(messages, second);
    messages = applyChatMessage(messages, third);

    expect(messages.map((message) => message.id)).toEqual(["a", "b", "c"]);
    // Untouched entries keep their identity so memoized rows do not re-render.
    expect(messages[0]).toBe(first);
    expect(messages[1]).toBe(second);
  });

  it("inserts out-of-order history before newer live messages", () => {
    const live = [makeMessage("live-1", 5_000), makeMessage("live-2", 6_000)];
    const history = makeMessage("history-1", 1_500, { historical: true });

    const messages = applyChatMessage(live, history);

    expect(messages.map((message) => message.id)).toEqual(["history-1", "live-1", "live-2"]);
  });

  it("keeps arrival order for equal out-of-order timestamps", () => {
    const base = [makeMessage("a", 1_000), makeMessage("b", 3_000)];
    const firstEqual = applyChatMessage(base, makeMessage("c", 1_000));
    const secondEqual = applyChatMessage(firstEqual, makeMessage("d", 1_000));

    expect(secondEqual.map((message) => message.id)).toEqual(["a", "c", "d", "b"]);
  });

  it("rejects duplicate message ids without changing the list", () => {
    const original = applyChatMessage([], makeMessage("a", 1_000));
    const next = applyChatMessage(original, makeMessage("a", 9_000));

    expect(next).toBe(original);
    expect(next).toHaveLength(1);
    expect(next[0].sentAt).toBe(1_000);
  });

  it("marks an existing message deleted and ignores unmatched deletions", () => {
    const original = [makeMessage("a", 1_000), makeMessage("b", 2_000)];
    const next = applyChatMessage(original, makeMessage("a", 1_000, { deleted: true }));

    expect(next[0].deleted).toBe(true);
    expect(next[0].text).toBe("message a");
    expect(next[1]).toBe(original[1]);

    const unmatched = applyChatMessage(next, makeMessage("missing", 3_000, { deleted: true }));
    expect(unmatched).toBe(next);
  });

  it("marks every visible message from a timed-out user with the moderation details", () => {
    const original = [
      makeMessage("a", 1_000, { login: "target" }),
      makeMessage("b", 2_000, { login: "someone-else" }),
      makeMessage("c", 3_000, { login: "TARGET" }),
    ];
    const next = applyChatMessage(
      original,
      makeMessage("moderation-target", 4_000, {
        login: "target",
        deleted: true,
        moderation: { type: "timeout", durationSeconds: 600 },
      }),
    );

    expect(next[0]).toMatchObject({
      deleted: true,
      moderation: { type: "timeout", durationSeconds: 600 },
    });
    expect(next[1]).toBe(original[1]);
    expect(next[2].deleted).toBe(true);
  });

  it("retains only the newest 500 messages", () => {
    let messages: ChatMessage[] = [];
    for (let index = 0; index < CHAT_MESSAGE_LIMIT + 25; index += 1) {
      messages = applyChatMessage(messages, makeMessage(`m-${index}`, index));
    }

    expect(messages).toHaveLength(CHAT_MESSAGE_LIMIT);
    expect(messages[0].id).toBe("m-25");
    expect(messages.at(-1)?.id).toBe(`m-${CHAT_MESSAGE_LIMIT + 24}`);
  });

  it("enforces the limit for out-of-order insertions as well", () => {
    let messages: ChatMessage[] = [];
    for (let index = 0; index < CHAT_MESSAGE_LIMIT; index += 1) {
      messages = applyChatMessage(messages, makeMessage(`m-${index}`, 1_000 + index));
    }

    const inserted = applyChatMessage(messages, makeMessage("old", 500, { historical: true }));

    // The oldest entry is the freshly inserted one, so the cap drops it again.
    expect(inserted).toHaveLength(CHAT_MESSAGE_LIMIT);
    expect(inserted.some((message) => message.id === "old")).toBe(false);
  });
});
