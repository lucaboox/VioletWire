/**
 * Where each multistream tile sits in the grid.
 *
 * The tiles themselves keep a fixed place in the DOM — reordering them there
 * would move a playing `<video>` element, which costs a re-attach and a black
 * flash — so the grid position is a CSS `order` index instead, and this module
 * owns the list of tile ids that produces it.
 */

/** Tile ids in display order: the saved arrangement first, new tiles after. */
export function tileDisplayOrder(ids: number[], saved: number[]): number[] {
  const present = new Set(ids);
  const placed = new Set<number>();
  const ordered: number[] = [];
  for (const id of saved) {
    if (!present.has(id) || placed.has(id)) continue;
    placed.add(id);
    ordered.push(id);
  }
  return [...ordered, ...ids.filter((id) => !placed.has(id))];
}

/** Trades two tiles' positions, leaving every other tile where it was. */
export function swapTilePositions(order: number[], one: number, other: number): number[] {
  const from = order.indexOf(one);
  const to = order.indexOf(other);
  if (from < 0 || to < 0 || from === to) return order;
  const next = order.slice();
  next[from] = other;
  next[to] = one;
  return next;
}

/** Moves a tile `delta` places along the grid, for reordering from the keyboard. */
export function moveTilePosition(order: number[], id: number, delta: number): number[] {
  const from = order.indexOf(id);
  if (from < 0) return order;
  const to = from + delta;
  if (to < 0 || to >= order.length) return order;
  return swapTilePositions(order, id, order[to]);
}
