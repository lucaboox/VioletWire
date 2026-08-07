import type { EmoteImageVariant } from "../../shared/emotes";

/**
 * Chooses which size of an emote to fetch.
 *
 * Every emote used to be fetched at 2x — 64 pixels tall — and drawn into a line
 * of chat 24 pixels high. On an ordinary display that is four times the pixels
 * the screen can show, and for an animated emote it is the difference between
 * 66 KB and 158 KB. Measured against a large channel's set: 44 MB at 1x against
 * 104 MB at 2x, all of it competing with the video stream for the same
 * connection. Oversized images are why an emote can sit blank for seconds
 * before it appears.
 *
 * So the size is chosen from what will actually be drawn: the chat emote height
 * the viewer has set, multiplied by the pixel density of their display. A
 * higher-density screen or a larger emote setting picks a larger variant, as it
 * should — nothing here trades away sharpness, it only stops paying for detail
 * that cannot be seen.
 */

const DEFAULT_CHAT_EMOTE_HEIGHT = 27;
/**
 * A variant is accepted when it covers all but a tenth of the pixels wanted.
 * Without this an emote whose 1x is 32 pixels tall would jump to 2x to cover a
 * request for 33, doubling the download to gain nothing anybody can see.
 */
const COVERAGE_TOLERANCE = 0.9;

let wantedPixelHeight = DEFAULT_CHAT_EMOTE_HEIGHT;

/**
 * Called when the chat emote size changes, and once at startup. The pixel
 * density is read here rather than stored, so moving the window to a display
 * with different scaling is picked up the next time this runs.
 */
export function setChatEmoteHeight(cssHeight: number): void {
  const density =
    typeof window === "undefined" ? 1 : Math.max(1, window.devicePixelRatio || 1);
  wantedPixelHeight = Math.max(1, cssHeight) * density;
}

/** The pixels being asked for, for tests and for the warm planner. */
export function chatEmotePixelHeight(): number {
  return wantedPixelHeight;
}

/**
 * The smallest variant that covers a given height, falling back to the largest
 * there is. Variants arrive sorted smallest first from every provider.
 */
export function variantForPixelHeight(
  variants: readonly EmoteImageVariant[],
  pixelHeight: number,
): EmoteImageVariant | undefined {
  if (variants.length === 0) return undefined;
  const wanted = pixelHeight * COVERAGE_TOLERANCE;
  return (
    [...variants]
      .sort((left, right) => left.scale - right.scale)
      .find((variant) => variant.height >= wanted) ?? variants.at(-1)
  );
}

/** The variant chat, the composer, and the autocomplete list all draw. */
export function chatEmoteVariant(
  variants: readonly EmoteImageVariant[],
): EmoteImageVariant | undefined {
  return variantForPixelHeight(variants, wantedPixelHeight);
}

/**
 * The picker draws its grid at roughly 40 CSS pixels, larger than a line of
 * chat, and its tiles are the emote itself rather than punctuation in a
 * sentence — so it keeps asking for the crisper size.
 */
export function pickerEmoteVariant(
  variants: readonly EmoteImageVariant[],
): EmoteImageVariant | undefined {
  return (
    variants.find((variant) => variant.scale === 2) ?? variants.at(-1)
  );
}
