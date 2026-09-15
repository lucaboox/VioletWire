import { describe, expect, it } from "vitest";
import {
  moveTilePosition,
  swapTilePositions,
  tileDisplayOrder,
} from "./multi-stream-order";

describe("tileDisplayOrder", () => {
  it("shows tiles in the order they were added when nothing was arranged", () => {
    expect(tileDisplayOrder([1, 2, 3], [])).toEqual([1, 2, 3]);
  });

  it("keeps the arrangement the viewer chose", () => {
    expect(tileDisplayOrder([1, 2, 3], [3, 1, 2])).toEqual([3, 1, 2]);
  });

  it("puts a newly added tile after the arranged ones", () => {
    expect(tileDisplayOrder([1, 2, 3, 4], [3, 1, 2])).toEqual([3, 1, 2, 4]);
  });

  it("forgets a tile that has been closed without disturbing the rest", () => {
    expect(tileDisplayOrder([1, 3], [3, 1, 2])).toEqual([3, 1]);
  });

  it("ignores a repeated id rather than showing a tile twice", () => {
    expect(tileDisplayOrder([1, 2], [2, 2, 1])).toEqual([2, 1]);
  });
});

describe("swapTilePositions", () => {
  it("trades two tiles and leaves the others alone", () => {
    expect(swapTilePositions([1, 2, 3, 4], 1, 4)).toEqual([4, 2, 3, 1]);
  });

  it("returns the same order when a tile is dropped on itself", () => {
    const order = [1, 2, 3];
    expect(swapTilePositions(order, 2, 2)).toBe(order);
  });

  it("returns the same order for a tile that is no longer shown", () => {
    const order = [1, 2, 3];
    expect(swapTilePositions(order, 2, 9)).toBe(order);
  });
});

describe("moveTilePosition", () => {
  it("moves a tile one place earlier", () => {
    expect(moveTilePosition([1, 2, 3], 3, -1)).toEqual([1, 3, 2]);
  });

  it("moves a tile one place later", () => {
    expect(moveTilePosition([1, 2, 3], 1, 1)).toEqual([2, 1, 3]);
  });

  it("stops at the first position", () => {
    const order = [1, 2, 3];
    expect(moveTilePosition(order, 1, -1)).toBe(order);
  });

  it("stops at the last position", () => {
    const order = [1, 2, 3];
    expect(moveTilePosition(order, 3, 1)).toBe(order);
  });
});
