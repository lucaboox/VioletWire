import { afterEach, describe, expect, it, vi } from "vitest";
import type { TwitchPickerEmote } from "../../shared/chat";
import type { EmoteProvider, ProviderEmote } from "../../shared/emotes";
import {
  forgetWarmedEmoteImages,
  planEmoteWarmUrls,
  warmEmoteImages,
} from "./emote-preload";

interface EmoteOptions {
  animated?: boolean;
  bytes?: number;
}

function emote(
  name: string,
  urls: Array<[number, string]>,
  { animated = false, bytes }: EmoteOptions = {},
): ProviderEmote {
  return {
    id: name,
    name,
    provider: "7tv",
    animated,
    variants: urls.map(([scale, url]) => ({
      url,
      width: 32 * scale,
      height: 32 * scale,
      format: "webp",
      scale,
      ...(bytes === undefined ? {} : { bytes }),
    })),
  };
}

function providerEmotes(
  entries: Array<[EmoteProvider, ProviderEmote[]]>,
): Map<EmoteProvider, Map<string, ProviderEmote>> {
  return new Map(
    entries.map(([provider, emotes]) => [
      provider,
      new Map(emotes.map((item) => [item.name, item])),
    ]),
  );
}

function platformEmote(
  name: string,
  scope: "global" | "channel",
): TwitchPickerEmote {
  return {
    id: name,
    name,
    imageUrl: `https://twitch/${name}`,
    scope,
    subscriptionOnly: false,
  };
}

describe("planEmoteWarmUrls", () => {
  it("warms the size chat draws first, then the picker's larger one", () => {
    const urls = planEmoteWarmUrls({
      providerEmotes: providerEmotes([
        [
          "7tv",
          [
            emote("KEKW", [
              [1, "one"],
              [2, "two"],
              [4, "four"],
            ]),
          ],
        ],
      ]),
      providerChannelNames: new Map(),
      platformEmotes: [],
    });
    expect(urls).toEqual(["one", "two"]);
  });

  it("does not warm the picker's larger size for an animated emote", () => {
    // These are the expensive ones. Chat gets what it draws; the picker's copy
    // waits until the grid is actually opened.
    const urls = planEmoteWarmUrls({
      providerEmotes: providerEmotes([
        [
          "7tv",
          [
            emote(
              "dance",
              [
                [1, "one"],
                [2, "two"],
              ],
              { animated: true, bytes: 9 * 1024 },
            ),
          ],
        ],
      ]),
      providerChannelNames: new Map(),
      platformEmotes: [],
    });
    expect(urls).toEqual(["one"]);
  });

  it("falls back to the largest variant when there is no 2x", () => {
    const urls = planEmoteWarmUrls({
      providerEmotes: providerEmotes([
        [
          "7tv",
          [
            emote("KEKW", [
              [1, "one"],
              [3, "three"],
            ]),
          ],
        ],
      ]),
      providerChannelNames: new Map(),
      platformEmotes: [],
    });
    expect(urls).toEqual(["one", "three"]);
  });

  it("skips emotes with no image at all", () => {
    const urls = planEmoteWarmUrls({
      providerEmotes: providerEmotes([["7tv", [emote("KEKW", [])]]]),
      providerChannelNames: new Map(),
      platformEmotes: [],
    });
    expect(urls).toEqual([]);
  });

  it("puts channel emotes ahead of global ones, across providers", () => {
    const urls = planEmoteWarmUrls({
      providerEmotes: providerEmotes([
        [
          "7tv",
          [emote("global7", [[2, "g7"]]), emote("channel7", [[2, "c7"]])],
        ],
        ["bttv", [emote("channelB", [[2, "cB"]])]],
      ]),
      providerChannelNames: new Map([
        ["7tv", new Set(["channel7"])],
        ["bttv", new Set(["channelB"])],
      ]),
      platformEmotes: [
        platformEmote("sub", "channel"),
        platformEmote("Kappa", "global"),
      ],
    });
    expect(urls).toEqual([
      "c7",
      "cB",
      "https://twitch/sub",
      "g7",
      "https://twitch/Kappa",
    ]);
  });

  it("leaves out an emote the service says is heavy", () => {
    const urls = planEmoteWarmUrls({
      providerEmotes: providerEmotes([
        [
          "7tv",
          [
            emote("still", [[2, "still-url"]], { bytes: 5 * 1024 }),
            emote("light", [[2, "light-url"]], {
              animated: true,
              bytes: 9 * 1024,
            }),
            emote("middling", [[2, "middling-url"]], {
              animated: true,
              bytes: 40 * 1024,
            }),
            emote("wide", [[2, "wide-url"]], {
              animated: true,
              bytes: 900 * 1024,
            }),
          ],
        ],
      ]),
      providerChannelNames: new Map(),
      platformEmotes: [],
    });
    expect(urls).toEqual(["still-url", "light-url"]);
  });

  it("assumes an animated emote is heavy when no size is published", () => {
    const urls = planEmoteWarmUrls({
      providerEmotes: providerEmotes([
        [
          "bttv",
          [
            emote("still", [[2, "still-url"]]),
            emote("moving", [[2, "moving-url"]], { animated: true }),
          ],
        ],
      ]),
      providerChannelNames: new Map(),
      platformEmotes: [],
    });
    expect(urls).toEqual(["still-url"]);
  });

  it("stops at the budget rather than at a count", () => {
    // 400 half-megabyte emotes: the budget allows 32 of them, where a count cap
    // would have pulled two hundred megabytes.
    const heavy = Array.from({ length: 400 }, (_, index) =>
      emote(`animated${index}`, [[2, `a${index}`]], {
        animated: true,
        bytes: 512 * 1024,
      }),
    );
    const urls = planEmoteWarmUrls({
      providerEmotes: providerEmotes([["7tv", heavy]]),
      providerChannelNames: new Map([
        ["7tv", new Set(heavy.map((item) => item.name))],
      ]),
      platformEmotes: [],
    });
    // Every one is over the per-emote ceiling, so none of them are warmed.
    expect(urls).toEqual([]);
  });

  it("warms a large channel's still emotes for a few megabytes", () => {
    // The measured shape of a large 7TV set: mostly animated by count, almost
    // entirely animated by weight.
    const stills = Array.from({ length: 301 }, (_, index) =>
      emote(`still${index}`, [[2, `s${index}`]], { bytes: 5 * 1024 }),
    );
    const animated = Array.from({ length: 667 }, (_, index) =>
      emote(`animated${index}`, [[2, `a${index}`]], {
        animated: true,
        bytes: 158 * 1024,
      }),
    );
    const all = [...stills, ...animated];
    const urls = planEmoteWarmUrls({
      providerEmotes: providerEmotes([["7tv", all]]),
      providerChannelNames: new Map([
        ["7tv", new Set(all.map((item) => item.name))],
      ]),
      platformEmotes: [],
    });
    expect(urls).toEqual(stills.map((_, index) => `s${index}`));
  });

  it("keeps the request count bounded for very small emotes", () => {
    const tiny = Array.from({ length: 1200 }, (_, index) =>
      emote(`tiny${index}`, [[2, `t${index}`]], { bytes: 512 }),
    );
    const urls = planEmoteWarmUrls({
      providerEmotes: providerEmotes([["7tv", tiny]]),
      providerChannelNames: new Map(),
      platformEmotes: [],
    });
    expect(urls).toHaveLength(400);
  });

  it("asks for each image once, however many emotes share it", () => {
    const urls = planEmoteWarmUrls({
      providerEmotes: providerEmotes([
        ["7tv", [emote("one", [[2, "same"]]), emote("two", [[2, "same"]])]],
      ]),
      providerChannelNames: new Map(),
      platformEmotes: [],
    });
    expect(urls).toEqual(["same"]);
  });
});

describe("warmEmoteImages", () => {
  afterEach(() => {
    forgetWarmedEmoteImages();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("cancels a previous channel's delayed queue when the next has no emotes", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const image = vi.fn();
    vi.stubGlobal("Image", image);

    warmEmoteImages({
      providerEmotes: providerEmotes([
        ["7tv", [emote("old", [[1, "old-url"]])]],
      ]),
      providerChannelNames: new Map(),
      platformEmotes: [],
    });
    warmEmoteImages({
      providerEmotes: new Map(),
      providerChannelNames: new Map(),
      platformEmotes: [],
    });
    vi.advanceTimersByTime(60_000);

    expect(image).not.toHaveBeenCalled();
  });
});
