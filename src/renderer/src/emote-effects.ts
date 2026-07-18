import type { ProviderEmote } from "../../shared/emotes";

const namedEffects: Record<string, string> = {
  "w!": "emote-effect-wide",
  "h!": "emote-effect-flip-x",
  "v!": "emote-effect-flip-y",
  "z!": "emote-effect-zero-space",
  "c!": "emote-effect-cursed",
  "l!": "emote-effect-rotate-left",
  "r!": "emote-effect-rotate-right",
  "p!": "emote-effect-party",
  "s!": "emote-effect-shake",
  ffzW: "emote-effect-wide",
  ffzX: "emote-effect-flip-x",
  ffzY: "emote-effect-flip-y",
  ffzCursed: "emote-effect-cursed",
};

export function isPrefixEmoteModifier(emote: ProviderEmote): boolean {
  return emote.provider === "bttv" || emote.name.endsWith("!");
}

export function getEmoteEffectClasses(modifiers: ProviderEmote[]): string[] {
  const classes = new Set<string>();
  for (const modifier of modifiers) {
    const named = namedEffects[modifier.name];
    if (named) classes.add(named);

    const flags = modifier.modifierFlags ?? 0;
    if (flags & 2) classes.add("emote-effect-flip-x");
    if (flags & 4) classes.add("emote-effect-flip-y");
    if (flags & 8) classes.add("emote-effect-wide");
    if (flags & 2_048) classes.add("emote-effect-rainbow");
    if (flags & 4_096) classes.add("emote-effect-hyper");
    if (flags & 8_192) classes.add("emote-effect-shake");
    if (flags & 16_384) classes.add("emote-effect-cursed");
    if (flags & 32_768) classes.add("emote-effect-jam");
    if (flags & 65_536) classes.add("emote-effect-bounce");
  }
  return [...classes];
}
