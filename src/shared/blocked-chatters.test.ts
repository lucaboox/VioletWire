import { describe, expect, it } from "vitest";
import {
  BLOCKED_CHATTER_LIMIT,
  isBlockableChatter,
  normalizeBlockedChatter,
  withBlockedChatter,
  withoutBlockedChatter,
} from "./blocked-chatters";

describe("normalizeBlockedChatter", () => {
  it("takes a name however it was typed", () => {
    expect(normalizeBlockedChatter("  @LucaBoox ")).toBe("lucaboox");
    expect(normalizeBlockedChatter("@@someone")).toBe("someone");
    expect(normalizeBlockedChatter("SOMEONE")).toBe("someone");
  });
});

describe("isBlockableChatter", () => {
  it("accepts what a login can be on either service", () => {
    for (const login of ["lucaboox", "user_123", "a", "kick-name"]) {
      expect(isBlockableChatter(login), login).toBe(true);
    }
  });

  it("refuses what cannot be one", () => {
    for (const value of ["", "   ", "@", "two words", "no.dots", "sla/sh", "x".repeat(41)]) {
      expect(isBlockableChatter(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("withBlockedChatter", () => {
  it("adds a name and keeps the list alphabetical", () => {
    expect(withBlockedChatter(["zed", "adam"], "Mallory")).toEqual([
      "adam",
      "mallory",
      "zed",
    ]);
  });

  it("ignores a name already on the list, whatever its capitals", () => {
    expect(withBlockedChatter(["mallory"], "@MALLORY")).toEqual(["mallory"]);
  });

  it("ignores a name that could not be a login", () => {
    expect(withBlockedChatter(["mallory"], "two words")).toEqual(["mallory"]);
    expect(withBlockedChatter([], "  ")).toEqual([]);
  });

  it("stops at the limit rather than growing without end", () => {
    const full = Array.from({ length: BLOCKED_CHATTER_LIMIT }, (_, index) => `user${index}`);
    expect(withBlockedChatter(full, "onemore")).toHaveLength(BLOCKED_CHATTER_LIMIT);
    expect(withBlockedChatter(full, "onemore")).not.toContain("onemore");
  });

  it("leaves the list it was given alone", () => {
    const list = ["adam"];
    withBlockedChatter(list, "mallory");
    expect(list).toEqual(["adam"]);
  });
});

describe("withoutBlockedChatter", () => {
  it("removes a name however it is typed", () => {
    expect(withoutBlockedChatter(["adam", "mallory"], "@Mallory")).toEqual(["adam"]);
  });

  it("leaves the list alone when the name is not on it", () => {
    expect(withoutBlockedChatter(["adam"], "mallory")).toEqual(["adam"]);
  });
});
