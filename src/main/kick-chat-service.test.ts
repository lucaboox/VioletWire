import { describe, expect, it } from "vitest";
import { parseKickEmotes } from "./kick-chat-service";

describe("parseKickEmotes", () => {
  it("leaves a message without emotes untouched", () => {
    const result = parseKickEmotes("hello there");
    expect(result.text).toBe("hello there");
    expect(result.emotes).toEqual([]);
  });

  it("replaces the markup with the emote name and reports its span", () => {
    const result = parseKickEmotes("[emote:37226:KEKW]");
    expect(result.text).toBe("KEKW");
    expect(result.emotes).toHaveLength(1);
    expect(result.emotes[0]).toMatchObject({
      id: "37226",
      start: 0,
      end: 3,
      provider: "kick",
    });
    expect(result.emotes[0].imageUrl).toBe("https://files.kick.com/emotes/37226/fullsize");
  });

  it("locates emotes that follow surrounding text", () => {
    const result = parseKickEmotes("lol [emote:37226:KEKW] yes");
    expect(result.text).toBe("lol KEKW yes");
    expect(result.emotes[0].start).toBe(4);
    expect(result.emotes[0].end).toBe(7);
    expect(result.text.slice(result.emotes[0].start, result.emotes[0].end + 1)).toBe("KEKW");
  });

  it("handles several emotes in one message", () => {
    const result = parseKickEmotes(
      "[emote:5620568:derekkingFKCUH] and [emote:37226:KEKW]",
    );
    expect(result.text).toBe("derekkingFKCUH and KEKW");
    expect(result.emotes.map((emote) => emote.id)).toEqual(["5620568", "37226"]);
    for (const emote of result.emotes) {
      const slice = [...result.text].slice(emote.start, emote.end + 1).join("");
      expect(slice).toMatch(/^(derekkingFKCUH|KEKW)$/);
    }
  });

  it("counts positions in code points so earlier emoji do not shift them", () => {
    const result = parseKickEmotes("👋 [emote:37226:KEKW]");
    const characters = [...result.text];
    const slice = characters.slice(result.emotes[0].start, result.emotes[0].end + 1).join("");
    expect(slice).toBe("KEKW");
  });

  it("ignores malformed markup rather than dropping the text", () => {
    const result = parseKickEmotes("[emote:abc:KEKW] [emote:12] plain");
    expect(result.text).toBe("[emote:abc:KEKW] [emote:12] plain");
    expect(result.emotes).toEqual([]);
  });

  it("is not affected by the previous call's regex position", () => {
    parseKickEmotes("[emote:1:A] [emote:2:B]");
    const result = parseKickEmotes("[emote:3:C]");
    expect(result.emotes).toHaveLength(1);
    expect(result.emotes[0].id).toBe("3");
  });
});
