import { describe, expect, it } from "vitest";
import type { EmoteImageVariant } from "../../shared/emotes";
import { pickerEmoteVariant, variantForPixelHeight } from "./emote-scale";

/** The four sizes 7TV publishes, at the heights it publishes them. */
const sevenTvVariants: EmoteImageVariant[] = [1, 2, 3, 4].map((scale) => ({
  url: `${scale}x.webp`,
  width: 32 * scale,
  height: 32 * scale,
  format: "webp",
  scale,
}));

describe("variantForPixelHeight", () => {
  it("takes 1x for chat on an ordinary display", () => {
    // 27px of chat on a 1x screen.
    expect(variantForPixelHeight(sevenTvVariants, 27)?.url).toBe("1x.webp");
  });

  it("still takes 1x at the scaling this machine uses", () => {
    // 24px drawn on a 1.25x display wants 30 pixels; 1x is 32 tall.
    expect(variantForPixelHeight(sevenTvVariants, 30)?.url).toBe("1x.webp");
  });

  it("moves up on a high-density display", () => {
    // 27px at 2x wants 54 pixels, which 1x cannot cover.
    expect(variantForPixelHeight(sevenTvVariants, 54)?.url).toBe("2x.webp");
  });

  it("moves up when the viewer enlarges chat emotes", () => {
    expect(variantForPixelHeight(sevenTvVariants, 48)?.url).toBe("2x.webp");
    expect(variantForPixelHeight(sevenTvVariants, 96)?.url).toBe("3x.webp");
  });

  it("allows a tenth short rather than doubling the download for it", () => {
    // 34 pixels wanted against a 32-pixel image: close enough to see no
    // difference, and half the bytes.
    expect(variantForPixelHeight(sevenTvVariants, 34)?.url).toBe("1x.webp");
    expect(variantForPixelHeight(sevenTvVariants, 40)?.url).toBe("2x.webp");
  });

  it("falls back to the largest there is when nothing covers the height", () => {
    expect(variantForPixelHeight(sevenTvVariants, 500)?.url).toBe("4x.webp");
  });

  it("copes with a provider that publishes one size", () => {
    const single: EmoteImageVariant[] = [
      { url: "only.png", width: 28, height: 28, format: "png", scale: 1 },
    ];
    expect(variantForPixelHeight(single, 96)?.url).toBe("only.png");
  });

  it("has nothing to choose from an empty set", () => {
    expect(variantForPixelHeight([], 27)).toBeUndefined();
  });

  it("chooses by height, not by the order it is given", () => {
    const shuffled = [...sevenTvVariants].reverse();
    expect(variantForPixelHeight(shuffled, 27)?.url).toBe("1x.webp");
  });
});

describe("pickerEmoteVariant", () => {
  it("keeps the crisper size for the grid", () => {
    expect(pickerEmoteVariant(sevenTvVariants)?.url).toBe("2x.webp");
  });

  it("falls back to the largest when there is no 2x", () => {
    const smallOnly: EmoteImageVariant[] = [
      { url: "1x.webp", width: 32, height: 32, format: "webp", scale: 1 },
    ];
    expect(pickerEmoteVariant(smallOnly)?.url).toBe("1x.webp");
  });
});
