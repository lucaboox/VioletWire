import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./chat";
import {
  filterChatMentionCandidates,
  getChatMentionCandidates,
  getLinkImagePreviewUrl,
  RecentChatterIndex,
  RECENT_CHATTER_LIMIT,
  tokenizeChatLinks,
  tokenizeChatMentions,
} from "./chat-content";

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

  it("keeps the current streamer first even when they have not chatted", () => {
    const messages = [message("viewer"), message("recent_chatter")];

    expect(
      getChatMentionCandidates(messages, "", 8, {
        color: "#9147ff",
        displayName: "The Streamer",
        login: "the_streamer",
      }).map(({ login }) => login),
    ).toEqual(["the_streamer", "recent_chatter", "viewer"]);
  });

  it("does not duplicate a preferred streamer who has chatted", () => {
    const messages = [message("the_streamer", "The Streamer"), message("viewer")];

    expect(
      getChatMentionCandidates(messages, "", 8, {
        color: "#9147ff",
        displayName: "The Streamer",
        login: "the_streamer",
      }).map(({ login }) => login),
    ).toEqual(["the_streamer", "viewer"]);
  });
});

describe("RecentChatterIndex", () => {
  it("keeps recently observed users independently of message history", () => {
    const index = new RecentChatterIndex();
    index.add({ color: "#111111", displayName: "First", login: "first" });
    index.add({ color: "#222222", displayName: "Second", login: "second" });
    index.add({ color: "#333333", displayName: "First Updated", login: "FIRST" });

    expect(index.allNewestFirst()).toEqual([
      { color: "#333333", displayName: "First Updated", login: "first" },
      { color: "#222222", displayName: "Second", login: "second" },
    ]);
  });

  it("evicts the least recently observed user at the channel limit", () => {
    const index = new RecentChatterIndex();
    for (let position = 0; position <= RECENT_CHATTER_LIMIT; position += 1) {
      index.add({
        color: "",
        displayName: `User ${position}`,
        login: `user_${position}`,
      });
    }

    const users = index.allNewestFirst();
    expect(users).toHaveLength(RECENT_CHATTER_LIMIT);
    expect(users.at(-1)?.login).toBe("user_1");
    expect(users.some(({ login }) => login === "user_0")).toBe(false);
  });

  it("filters a recent-chatter index while pinning the broadcaster", () => {
    expect(
      filterChatMentionCandidates(
        [
          { color: "", displayName: "Viewer Two", login: "viewer_two" },
          { color: "", displayName: "Viewer One", login: "viewer_one" },
        ],
        "view",
        8,
        { color: "#9147ff", displayName: "Viewer Stream", login: "viewer_stream" },
      ).map(({ login }) => login),
    ).toEqual(["viewer_stream", "viewer_two", "viewer_one"]);
  });
});

describe("tokenizeChatMentions", () => {
  it("separates Twitch-style mentions from surrounding chat text", () => {
    expect(tokenizeChatMentions("hello @Streamer, and @viewer_2!")).toEqual([
      { kind: "text", text: "hello " },
      { kind: "mention", text: "@Streamer" },
      { kind: "text", text: ", and " },
      { kind: "mention", text: "@viewer_2" },
      { kind: "text", text: "!" },
    ]);
  });

  it("does not treat email addresses as chat mentions", () => {
    expect(tokenizeChatMentions("person@example.org")).toEqual([
      { kind: "text", text: "person@example.org" },
    ]);
  });
});

describe("getLinkImagePreviewUrl", () => {
  it("passes through direct https image links", () => {
    expect(getLinkImagePreviewUrl("https://example.com/photo.png")).toBe(
      "https://example.com/photo.png",
    );
    expect(getLinkImagePreviewUrl("https://cdn.example.com/a/b/c.JPeG?x=1")).toBe(
      "https://cdn.example.com/a/b/c.JPeG?x=1",
    );
  });

  it("maps imgur and gyazo pages to their direct image forms", () => {
    expect(getLinkImagePreviewUrl("https://imgur.com/aB3dE9")).toBe(
      "https://i.imgur.com/aB3dE9.jpg",
    );
    expect(getLinkImagePreviewUrl("https://imgur.com/aB3dE9.png?share=1")).toBe(
      "https://i.imgur.com/aB3dE9.png",
    );
    expect(getLinkImagePreviewUrl("https://m.imgur.com/aB3dE9/")).toBe(
      "https://i.imgur.com/aB3dE9.jpg",
    );
    expect(
      getLinkImagePreviewUrl("https://gyazo.com/0123456789abcdef0123456789abcdef"),
    ).toBe("https://i.gyazo.com/0123456789abcdef0123456789abcdef.jpg");
  });

  it("rejects non-image, non-https, and album links", () => {
    expect(getLinkImagePreviewUrl("http://example.com/photo.png")).toBeNull();
    expect(getLinkImagePreviewUrl("https://example.com/page")).toBeNull();
    expect(getLinkImagePreviewUrl("https://imgur.com/a/aB3dE9")).toBeNull();
    expect(getLinkImagePreviewUrl("https://imgur.com/gallery/xyz")).toBeNull();
    expect(getLinkImagePreviewUrl("https://gyazo.com/short")).toBeNull();
    expect(getLinkImagePreviewUrl("not a url")).toBeNull();
  });
});
