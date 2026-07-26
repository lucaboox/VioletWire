import { describe, expect, it } from "vitest";
import { mergeChangelogEntries, parseChangelog } from "./changelog";

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

  it("prefers remote versioned notes while retaining bundled unreleased and missing releases", () => {
    const bundled = parseChangelog(`
## [Unreleased]

### Fixes

- Pending fix.

## [1.0.0]

### Additions

- Bundled old notes.

## [0.9.0]

### Fixes

- Offline-only notes.
`);
    const remote = parseChangelog(`
## [1.0.0]

### Improvements

- Corrected GitHub notes.
`);

    expect(
      mergeChangelogEntries(remote, bundled).map((entry) => ({
        version: entry.version,
        improvements: entry.improvements,
      })),
    ).toEqual([
      { version: "Unreleased", improvements: [] },
      { version: "1.0.0", improvements: ["Corrected GitHub notes."] },
      { version: "0.9.0", improvements: [] },
    ]);
  });

  it("sorts bundled newer prereleases ahead of stale remote entries", () => {
    const bundled = parseChangelog(`
## [Unreleased]

## [0.3.3-alpha.12]

### Additions

- Bundled newest notes.

## [0.3.3-alpha.11]

## [0.3.3-alpha.10]

## [0.3.3-alpha.9]
`);
    const staleRemote = parseChangelog(`
## [0.3.3-alpha.9]

### Fixes

- Remote notes.

## [0.3.3-alpha.8]
`);

    expect(
      mergeChangelogEntries(staleRemote, bundled).map((entry) => entry.version),
    ).toEqual([
      "Unreleased",
      "0.3.3-alpha.12",
      "0.3.3-alpha.11",
      "0.3.3-alpha.10",
      "0.3.3-alpha.9",
      "0.3.3-alpha.8",
    ]);
  });
});
