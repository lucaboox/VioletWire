import { describe, expect, it } from "vitest";
import {
  clearFollowedCache,
  readFollowedCache,
  saveFollowedCache,
} from "./followed-cache";
describe("followed channel startup cache", () => {
  it("restores only the matching account and clears on sign out", () => {
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
      removeItem: (k: string) => values.delete(k),
    };
    const channels = [
      {
        id: "1",
        login: "one",
        displayName: "One",
        category: "Music",
        profileImageUrl: "",
        viewerCount: 4,
        isLive: true,
      },
    ];
    saveFollowedCache(storage, "account-a", channels);
    expect(readFollowedCache(storage, "account-a")).toEqual(channels);
    expect(readFollowedCache(storage, "account-b")).toEqual([]);
    clearFollowedCache(storage);
    expect(readFollowedCache(storage, "account-a")).toEqual([]);
  });
  it("ignores malformed, expired and inaccessible local storage", () => {
    for (const value of [
      "bad json",
      JSON.stringify({ accountId: "a", savedAt: 0, channels: [] }),
    ]) {
      expect(
        readFollowedCache({ getItem: () => value } as unknown as Storage, "a"),
      ).toEqual([]);
    }
    expect(
      readFollowedCache(
        {
          getItem: () => {
            throw new Error("unavailable");
          },
        } as unknown as Storage,
        "a",
      ),
    ).toEqual([]);
  });
});
