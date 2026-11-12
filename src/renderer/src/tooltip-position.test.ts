import { describe, expect, it } from "vitest";
import { placeTooltip } from "./tooltip-position";

describe("measured tooltip placement", () => {
  const viewport = { width: 1200, height: 800 };

  it("flips a multiline channel tooltip below when it would leave the viewport", () => {
    const position = placeTooltip({ left: 1140, top: 98, bottom: 132, width: 40 }, { width: 320, height: 90 }, viewport);
    expect(position.top).toBe(140);
    expect(position.left + 320).toBeLessThanOrEqual(1190);
  });

  it("uses the measured height when a preview image makes the tooltip taller", () => {
    const anchor = { left: 900, top: 200, bottom: 230, width: 40 };
    expect(placeTooltip(anchor, { width: 320, height: 40 }, viewport).top).toBe(152);
    expect(placeTooltip(anchor, { width: 320, height: 340 }, viewport).top).toBe(238);
  });

  it("clamps oversized previews inside the content area", () => {
    const position = placeTooltip({ left: 5, top: 50, bottom: 80, width: 20 }, { width: 320, height: 900 }, viewport);
    expect(position).toEqual({ left: 10, top: 10, maxHeight: 780 });
  });

  it("allows tooltips over the custom title bar, including the caption buttons", () => {
    const position = placeTooltip({ left: 50, top: 60, bottom: 90, width: 30 }, { width: 100, height: 40 }, viewport);
    expect(position.top).toBe(12);
  });
});
