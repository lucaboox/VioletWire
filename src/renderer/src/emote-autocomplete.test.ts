import { describe, expect, it } from "vitest";
import { completeEmoteWord, matchEmoteNames } from "./emote-autocomplete";

const names = ["KEKW", "kekwait", "PogKEKW", "LULW", "omE", "ome0", "Kappa"];

describe("matchEmoteNames", () => {
  it("keeps only names starting with the word in prefix mode", () => {
    expect(matchEmoteNames(names, "kek", "prefix")).toEqual(["KEKW", "kekwait"]);
  });

  it("ignores case when matching", () => {
    expect(matchEmoteNames(names, "KEK", "prefix")).toEqual(["KEKW", "kekwait"]);
  });

  it("finds a word inside the name in substring mode", () => {
    expect(matchEmoteNames(names, "ek", "substring")).toEqual([
      "KEKW",
      "kekwait",
      "PogKEKW",
    ]);
  });

  it("does not reach into the middle of a name in prefix mode", () => {
    expect(matchEmoteNames(names, "ek", "prefix")).toEqual([]);
  });

  it("ranks an exact name, then the ones it starts, above the rest", () => {
    expect(matchEmoteNames(names, "kekw", "substring")).toEqual([
      "KEKW",
      "kekwait",
      "PogKEKW",
    ]);
  });

  it("orders equally ranked names alphabetically", () => {
    expect(matchEmoteNames(names, "ome", "prefix")).toEqual(["omE", "ome0"]);
  });

  it("returns everything for an empty word", () => {
    expect(matchEmoteNames(names, "", "prefix")).toHaveLength(names.length);
  });
});

describe("completeEmoteWord", () => {
  it("replaces the half-typed word with the emote's name", () => {
    expect(completeEmoteWord("hello KEK", { start: 6, end: 9 }, "KEKW")).toEqual({
      value: "hello KEKW",
      caret: 10,
      redraw: false,
    });
  });

  it("completes a word in the middle of a message", () => {
    expect(
      completeEmoteWord("KEK and more", { start: 0, end: 3 }, "KEKW"),
    ).toEqual({ value: "KEKW and more", caret: 4, redraw: false });
  });

  it("asks for a redraw when the name was already typed in full", () => {
    // Nothing about the message changes, so nothing downstream would redraw the
    // box and the word would stay as letters instead of becoming the emote.
    expect(completeEmoteWord("KEKW", { start: 0, end: 4 }, "KEKW")).toEqual({
      value: "KEKW",
      caret: 4,
      redraw: true,
    });
  });

  it("still changes the message when only the capitals differ", () => {
    expect(completeEmoteWord("kekw", { start: 0, end: 4 }, "KEKW")).toEqual({
      value: "KEKW",
      caret: 4,
      redraw: false,
    });
  });

  it("keeps what follows the word", () => {
    expect(
      completeEmoteWord("say KEK now", { start: 4, end: 7 }, "KEKWait"),
    ).toEqual({ value: "say KEKWait now", caret: 11, redraw: false });
  });
});
