import { describe, expect, it } from "vitest";
import { parseChangelog } from "./changelog";

describe("parseChangelog", () => {
  it("parses dated and unreleased additions and fixes with wrapped lines", () => {
    const result = parseChangelog(`# Changelog

## [Unreleased]

### Additions

- Added one thing.

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
        fixes: ["Fixed a long issue that continued on another line."],
      },
      {
        version: "1.2.3",
        date: "2026-07-18",
        additions: ["Shipped a release."],
        fixes: [],
      },
    ]);
  });
});
