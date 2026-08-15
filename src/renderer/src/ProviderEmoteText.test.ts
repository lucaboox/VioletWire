import { describe, expect, it } from "vitest";
import type { ProviderEmote } from "../../shared/emotes";
import { plainTextSegments } from "./ProviderEmoteText";

function emote(name: string, zeroWidth = false): ProviderEmote {
  return {
    id: name,
    name,
    provider: "7tv",
    animated: false,
    zeroWidth,
    variants: [],
  };
}

describe("plainTextSegments", () => {
  it("keeps a zero-width emote adjacent to its base without text spacing", () => {
    const segments = plainTextSegments(
      "Cat MoonOverlay",
      new Map([
        ["Cat", emote("Cat")],
        ["MoonOverlay", emote("MoonOverlay", true)],
      ]),
    );

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ kind: "emote", zeroWidth: false });
    expect(segments[1]).toMatchObject({ kind: "emote", zeroWidth: true });
  });

  it("marks a leading overlay so it can stack over a Twitch emote from the caller", () => {
    const segments = plainTextSegments(
      " MoonOverlay",
      new Map([["MoonOverlay", emote("MoonOverlay", true)]]),
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ kind: "emote", zeroWidth: true });
  });
});
