import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("electron", () => ({
  app: {
    getPath: () => "C:\\VioletWire",
    getVersion: () => "0.3.2-alpha.1",
  },
}));

import { GitHubReleaseNotesService } from "./github-release-notes";

describe("GitHubReleaseNotesService", () => {
  let temporaryDirectory = "";
  let cachePath = "";
  let now = 1_000_000;

  beforeEach(async () => {
    temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "violetwire-release-notes-"),
    );
    cachePath = path.join(temporaryDirectory, "cache.json");
    now = 1_000_000;
  });

  afterEach(async () => {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("normalizes, caches, and reuses validated GitHub release notes", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify([
          {
            tag_name: "v0.3.2-alpha.1",
            body: "### Improvements\n\n- Reused the player.",
            draft: false,
            published_at: "2026-07-19T11:55:32Z",
          },
        ]),
        { status: 200 },
      ),
    );
    const service = new GitHubReleaseNotesService(
      cachePath,
      fetcher,
      () => now,
    );

    const first = await service.getMarkdown();
    const second = await service.getMarkdown();

    expect(first).toContain("## [0.3.2-alpha.1] - 2026-07-19");
    expect(first).toContain("- Reused the player.");
    expect(second).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("falls back to stale cached notes when GitHub is unavailable", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              tag_name: "v0.3.2-alpha.1",
              body: "## [0.3.2-alpha.1]\n\n### Fixes\n\n- Fixed one thing.",
              draft: false,
              published_at: "2026-07-19T11:55:32Z",
            },
          ]),
          { status: 200 },
        ),
      )
      .mockRejectedValueOnce(new Error("offline"));
    const service = new GitHubReleaseNotesService(
      cachePath,
      fetcher,
      () => now,
    );
    const cached = await service.getMarkdown();
    now += 16 * 60 * 1_000;

    expect(await service.getMarkdown()).toBe(cached);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not let a forced refresh join an in-flight cached read", async () => {
    await fs.writeFile(
      cachePath,
      JSON.stringify({ fetchedAt: now, markdown: "## [0.3.2-alpha.2]\n\n- Cached notes." }),
      "utf8",
    );
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify([
          {
            tag_name: "v0.3.2-alpha.3",
            body: "### Fixes\n\n- Fresh notes.",
            draft: false,
            published_at: "2026-07-19T13:00:00Z",
          },
        ]),
        { status: 200 },
      ),
    );
    const service = new GitHubReleaseNotesService(cachePath, fetcher, () => now);

    const cached = service.getMarkdown();
    const fresh = service.getMarkdown(true);

    expect(await cached).toContain("Cached notes.");
    expect(await fresh).toContain("Fresh notes.");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns null when neither GitHub nor a valid cache is available", async () => {
    const service = new GitHubReleaseNotesService(
      cachePath,
      vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
      () => now,
    );

    expect(await service.getMarkdown()).toBeNull();
  });
});
