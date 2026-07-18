import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./chat";
import { getChatMentionCandidates, tokenizeChatLinks } from "./chat-content";

function message(login: string, displayName = login): ChatMessage {
  return {
    id: crypto.randomUUID(),
    channel: "channel",
    login,
    displayName,
    color: "#ffffff",
    text: "",
    badges: [],
    sentAt: Date.now(),
    twitchEmotes: [],
  };
}

describe("tokenizeChatLinks", () => {
  it("recognizes secure web links without swallowing sentence punctuation", () => {
    expect(tokenizeChatLinks("See https://example.com/path, okay?")).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", text: "https://example.com/path", url: "https://example.com/path" },
      { kind: "text", text: ", okay?" },
    ]);
  });

  it("normalizes www links to HTTPS", () => {
    expect(tokenizeChatLinks("www.example.com")).toEqual([
      { kind: "link", text: "www.example.com", url: "https://www.example.com" },
    ]);
  });

  it("recognizes bare domains with arbitrary valid-looking top-level domains", () => {
    expect(tokenizeChatLinks("Visit starforge.com or example.win today")).toEqual([
      { kind: "text", text: "Visit " },
      { kind: "link", text: "starforge.com", url: "https://starforge.com" },
      { kind: "text", text: " or " },
      { kind: "link", text: "example.win", url: "https://example.win" },
      { kind: "text", text: " today" },
    ]);
  });

  it("does not turn the domain portion of an email address into a link", () => {
    expect(tokenizeChatLinks("mail me at person@example.org")).toEqual([
      { kind: "text", text: "mail me at person@example.org" },
    ]);
  });
});

describe("getChatMentionCandidates", () => {
  it("returns matching recent users once, newest first", () => {
    const messages = [
      message("lucaboox", "Lucaboox"),
      message("other"),
      message("lucasaurus", "Lucasaurus"),
      message("lucaboox", "Lucaboox"),
    ];

    expect(getChatMentionCandidates(messages, "luca").map(({ login }) => login)).toEqual([
      "lucaboox",
      "lucasaurus",
    ]);
  });
});
