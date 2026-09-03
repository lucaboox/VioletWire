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
      true,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ kind: "emote", zeroWidth: true });
  });

  it("draws an overlay sent on its own like any other emote", () => {
    // With nothing to its left, an overlay would be painted over the sender's
    // name and hang off the side of the message.
    const segments = plainTextSegments(
      "FirstTimeClanka",
      new Map([["FirstTimeClanka", emote("FirstTimeClanka", true)]]),
    );

    expect(segments).toEqual([
      expect.objectContaining({ kind: "emote", zeroWidth: false }),
    ]);
  });

  it("draws an overlay that opens a message like any other emote", () => {
    const segments = plainTextSegments(
      "FirstTimeClanka hello",
      new Map([["FirstTimeClanka", emote("FirstTimeClanka", true)]]),
    );

    expect(segments[0]).toMatchObject({ kind: "emote", zeroWidth: false });
    expect(segments[1]).toMatchObject({ kind: "text", text: " hello" });
  });

  it("stacks an overlay that follows one drawn in its place", () => {
    // The first stands in for the base; the second stacks on it.
    const segments = plainTextSegments(
      "FirstTimeClanka MoonOverlay",
      new Map([
        ["FirstTimeClanka", emote("FirstTimeClanka", true)],
        ["MoonOverlay", emote("MoonOverlay", true)],
      ]),
    );

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ kind: "emote", zeroWidth: false });
    expect(segments[1]).toMatchObject({ kind: "emote", zeroWidth: true });
  });

  it("stacks an overlay that follows ordinary words", () => {
    const segments = plainTextSegments(
      "Cat is here MoonOverlay",
      new Map([
        ["Cat", emote("Cat")],
        ["MoonOverlay", emote("MoonOverlay", true)],
      ]),
    );

    expect(segments.at(-1)).toMatchObject({ kind: "emote", zeroWidth: true });
  });
});
