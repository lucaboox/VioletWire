import { afterEach, describe, expect, it, vi } from "vitest";
import type { TwitchService } from "./twitch-service";
import { LinkPreviewService } from "./link-preview-service";

function service(
  kickPreview: Awaited<ReturnType<import("./kick-service").KickService["getClipPreview"]>> = null,
): LinkPreviewService {
  return new LinkPreviewService(
    {
      getClipPreview: vi.fn(),
    } as unknown as TwitchService,
    {
      getClipPreview: vi.fn().mockResolvedValue(kickPreview),
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LinkPreviewService Imgur albums", () => {
  it("uses the allow-listed Imgur album cover as the hover preview", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        '<html><head><meta property="og:image" content="https://i.imgur.com/sEm0d0x.jpeg?fb"></head></html>',
        { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(service().getPreview("https://imgur.com/a/dnEym2w")).resolves.toEqual({
      kind: "imgur-album",
      url: "https://imgur.com/a/dnEym2w",
      title: "Imgur album",
      author: "Imgur",
      thumbnailUrl: "https://i.imgur.com/sEm0d0x.jpeg?fb",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://imgur.com/a/dnEym2w",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("rejects album metadata that points outside Imgur's image host", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          '<meta property="og:image" content="https://attacker.example/cover.jpg">',
          { status: 200, headers: { "Content-Type": "text/html" } },
        ),
      ),
    );

    await expect(service().getPreview("https://imgur.com/a/dnEym2w")).resolves.toBeNull();
  });

  it("does not fetch malformed or non-album Imgur paths", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const previews = service();

    await expect(previews.getPreview("https://imgur.com/a/not/valid")).resolves.toBeNull();
    await expect(previews.getPreview("https://imgur.com/gallery/dnEym2w")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("LinkPreviewService YouTube channels", () => {
  it("previews handle links automatically without generic previews enabled", async () => {
    const resolvePreview = vi.fn().mockResolvedValue({
      kind: "generic",
      url: "https://www.youtube.com/@Psi",
      title: "Psi - YouTube",
      author: "YouTube",
      description: "The official Psi channel.",
      thumbnailUrl: "https://yt3.googleusercontent.com/channel-avatar",
    });
    const previews = new LinkPreviewService(
      { getClipPreview: vi.fn() } as unknown as TwitchService,
      { getClipPreview: vi.fn() },
      resolvePreview,
    );

    await expect(previews.getPreview("https://www.youtube.com/@Psi")).resolves.toEqual({
      kind: "youtube",
      url: "https://www.youtube.com/@Psi",
      title: "Psi",
      author: "YouTube channel",
      description: "The official Psi channel.",
      thumbnailUrl: "https://yt3.googleusercontent.com/channel-avatar",
      thumbnailPresentation: "avatar",
    });
    expect(resolvePreview).toHaveBeenCalledWith(
      new URL("https://www.youtube.com/@Psi"),
      1_000_000,
    );
  });

  it("does not treat arbitrary YouTube paths as trusted channel pages", async () => {
    const resolvePreview = vi.fn();
    const previews = new LinkPreviewService(
      { getClipPreview: vi.fn() } as unknown as TwitchService,
      { getClipPreview: vi.fn() },
      resolvePreview,
    );

    await expect(
      previews.getPreview("https://www.youtube.com/results?search_query=Psi"),
    ).resolves.toBeNull();
    expect(resolvePreview).not.toHaveBeenCalled();
  });
});

describe("LinkPreviewService Kick clips", () => {
  it("returns rich metadata for current Kick clip links", async () => {
    const previews = service({
      id: "clip_01JGJHB6CEVFCQRYTVPM8DW892",
      title: "MonkaW",
      channelSlug: "xqc",
      thumbnailUrl:
        "https://clips.kick.com/clips/7a/clip_01JGJHB6CEVFCQRYTVPM8DW892/thumbnail.webp",
      durationSeconds: 50,
      createdAt: "2025-01-02T03:37:13.559Z",
      viewCount: 11_793,
    });

    await expect(
      previews.getPreview(
        "https://kick.com/xqc/clips/clip_01JGJHB6CEVFCQRYTVPM8DW892",
      ),
    ).resolves.toEqual({
      kind: "kick-clip",
      url: "https://kick.com/xqc/clips/clip_01JGJHB6CEVFCQRYTVPM8DW892",
      title: "MonkaW",
      author: "xqc",
      thumbnailUrl:
        "https://clips.kick.com/clips/7a/clip_01JGJHB6CEVFCQRYTVPM8DW892/thumbnail.webp",
      durationSeconds: 50,
      createdAt: "2025-01-02T03:37:13.559Z",
      viewCount: 11_793,
    });
  });

  it("supports legacy query-style Kick clip links", async () => {
    const getClipPreview = vi.fn().mockResolvedValue(null);
    const previews = new LinkPreviewService(
      { getClipPreview: vi.fn() } as unknown as TwitchService,
      { getClipPreview },
    );

    await previews.getPreview(
      "https://kick.com/xqc?clip=clip_01JGJHB6CEVFCQRYTVPM8DW892",
    );
    expect(getClipPreview).toHaveBeenCalledWith(
      "clip_01JGJHB6CEVFCQRYTVPM8DW892",
    );
  });

  it("rejects a thumbnail outside Kick's clip CDN", async () => {
    const previews = service({
      id: "clip_01JGJHB6CEVFCQRYTVPM8DW892",
      title: "Unsafe",
      channelSlug: "xqc",
      thumbnailUrl: "https://attacker.example/thumbnail.webp",
    });

    await expect(
      previews.getPreview(
        "https://kick.com/xqc/clips/clip_01JGJHB6CEVFCQRYTVPM8DW892",
      ),
    ).resolves.toBeNull();
  });
});
