interface TooltipAnchor {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

/** All coordinates are CSS pixels in the tooltip's owning window. */
export function placeTooltip(
  anchor: TooltipAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number; maxHeight: number } {
  const margin = 10;
  const gap = 8;
  const safeTop = margin;
  const maxHeight = Math.max(0, viewport.height - margin - safeTop);
  const height = Math.min(size.height, maxHeight);
  const above = anchor.top - gap - height;
  const below = anchor.bottom + gap;
  const fitsBelow = below + height <= viewport.height - margin;
  const preferred = above >= safeTop ? above : fitsBelow ? below : safeTop;
  return {
    left: Math.max(margin, Math.min(
      anchor.left + anchor.width / 2 - size.width / 2,
      viewport.width - margin - size.width,
    )),
    top: Math.max(safeTop, Math.min(preferred, viewport.height - margin - height)),
    maxHeight,
  };
}
