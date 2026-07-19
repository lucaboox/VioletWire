import { describe, expect, it } from "vitest";
import { parseChangelog } from "./changelog";

describe("parseChangelog", () => {
  it("parses dated and unreleased additions, improvements, and fixes with wrapped lines", () => {
    const result = parseChangelog(`# Changelog

## [Unreleased]

### Additions

- Added one thing.

### Improvements

- Improved one thing that
  continued on another line.

### Fixes

- Fixed a long issue that
  continued on another line.

## [1.2.3] - 2026-07-18

### Additions

- Shipped a release.
`);

    expect(result).toEqual([
      {
        version: "Unreleased",
        date: undefined,
        additions: ["Added one thing."],
        improvements: ["Improved one thing that continued on another line."],
        fixes: ["Fixed a long issue that continued on another line."],
      },
      {
        version: "1.2.3",
        date: "2026-07-18",
        additions: ["Shipped a release."],
        improvements: [],
        fixes: [],
      },
    ]);
  });
});
