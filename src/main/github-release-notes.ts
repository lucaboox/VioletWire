import { app } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

const RELEASES_URL =
  "https://api.github.com/repos/lucaboox/VioletWire/releases?per_page=20";
const CACHE_TTL_MS = 15 * 60 * 1_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_MARKDOWN_BYTES = 750_000;

const githubReleaseSchema = z.object({
  tag_name: z.string().min(1).max(100),
  body: z.string().max(250_000).nullable(),
  draft: z.boolean(),
  published_at: z.string().nullable(),
});

const githubReleasesSchema = z.array(githubReleaseSchema).max(30);

const releaseNotesCacheSchema = z.object({
  fetchedAt: z.number().finite().nonnegative(),
  markdown: z.string().max(MAX_MARKDOWN_BYTES),
});

type Fetcher = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

interface ReleaseNotesCache {
  fetchedAt: number;
  markdown: string;
}

export class GitHubReleaseNotesService {
  private refreshInFlight: Promise<string | null> | null = null;

  constructor(
    private readonly cachePath = path.join(
      app.getPath("userData"),
      "github-release-notes-cache.json",
    ),
    private readonly fetcher: Fetcher = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  getMarkdown(forceRefresh = false): Promise<string | null> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.resolveMarkdown(forceRefresh).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async resolveMarkdown(forceRefresh: boolean): Promise<string | null> {
    const cached = await this.readCache();
    if (
      !forceRefresh &&
      cached &&
      this.now() - cached.fetchedAt < CACHE_TTL_MS
    ) {
      return cached.markdown;
    }

    try {
      const markdown = await this.fetchMarkdown();
      await this.writeCache({
        fetchedAt: this.now(),
        markdown,
      });
      return markdown;
    } catch {
      return cached?.markdown ?? null;
    }
  }

  private async fetchMarkdown(): Promise<string> {
    const response = await this.fetcher(RELEASES_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `VioletWire/${app.getVersion()}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      throw new Error(`GitHub release notes request failed (${response.status}).`);
    }
    const responseText = await response.text();
    if (Buffer.byteLength(responseText, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("GitHub release notes response was unexpectedly large.");
    }
    const releases = githubReleasesSchema.parse(JSON.parse(responseText));
    const markdown = releases
      .filter((release) => !release.draft && release.body?.trim())
      .map((release) => this.normalizeRelease(release))
      .join("\n\n");
    if (!markdown) throw new Error("GitHub returned no release notes.");
    if (Buffer.byteLength(markdown, "utf8") > MAX_MARKDOWN_BYTES) {
      throw new Error("GitHub release notes exceeded the local cache limit.");
    }
    return markdown;
  }

  private normalizeRelease(
    release: z.infer<typeof githubReleaseSchema>,
  ): string {
    const body = release.body?.trim() ?? "";
    if (/^## \[[^\]]+\]/m.test(body)) return body;
    const version = release.tag_name.replace(/^v/i, "");
    const date = release.published_at?.slice(0, 10);
    return `## [${version}]${date ? ` - ${date}` : ""}\n\n${body}`;
  }

  private async readCache(): Promise<ReleaseNotesCache | null> {
    try {
      return releaseNotesCacheSchema.parse(
        JSON.parse(await fs.readFile(this.cachePath, "utf8")),
      );
    } catch {
      return null;
    }
  }

  private async writeCache(cache: ReleaseNotesCache): Promise<void> {
    await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
    const temporaryPath = `${this.cachePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(cache), {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.rename(temporaryPath, this.cachePath);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
