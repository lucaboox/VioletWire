import { describe, expect, it } from "vitest";
import { matchEmoteNames } from "./emote-autocomplete";

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
