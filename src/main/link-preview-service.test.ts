import { afterEach, describe, expect, it, vi } from "vitest";
import type { TwitchService } from "./twitch-service";
import { LinkPreviewService } from "./link-preview-service";

function service(): LinkPreviewService {
  return new LinkPreviewService({
    getClipPreview: vi.fn(),
  } as unknown as TwitchService);
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
