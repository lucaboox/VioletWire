import { describe, expect, it } from "vitest";
import type { ProviderEmote } from "../../shared/emotes";
import { getEmoteEffectClasses, isPrefixEmoteModifier } from "./emote-effects";

function modifier(
  name: string,
  provider: ProviderEmote["provider"],
  modifierFlags?: number,
): ProviderEmote {
  return {
    id: name,
    name,
    provider,
    animated: false,
    modifier: true,
    modifierFlags,
    variants: [],
  };
}

describe("emote effects", () => {
  it("maps BetterTTV modifier codes to visual effects", () => {
    expect(getEmoteEffectClasses([modifier("w!", "bttv")])).toContain(
      "emote-effect-wide",
    );
    expect(isPrefixEmoteModifier(modifier("h!", "bttv"))).toBe(true);
  });

  it("maps FrankerFaceZ modifier flags and treats them as suffixes", () => {
    expect(getEmoteEffectClasses([modifier("ffzHyper", "ffz", 12_289)])).toEqual(
      expect.arrayContaining(["emote-effect-hyper", "emote-effect-shake"]),
    );
    expect(isPrefixEmoteModifier(modifier("ffzHyper", "ffz", 12_289))).toBe(false);
  });
});
