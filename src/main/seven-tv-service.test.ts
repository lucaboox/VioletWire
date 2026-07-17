import { afterEach, describe, expect, it, vi } from "vitest";
import { SevenTvService } from "./seven-tv-service";

const sevenTvPayload = {
  emotes: [
    {
      id: "01TEST",
      name: "Wave",
      data: {
        animated: true,
        host: {
          url: "//cdn.7tv.app/emote/01TEST",
          files: [
            { name: "1x.webp", width: 32, height: 32, format: "WEBP" },
            { name: "2x.avif", width: 64, height: 64, format: "AVIF" },
          ],
        },
      },
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SevenTvService", () => {
  it("validates and normalizes global emotes", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(sevenTvPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", request);

    const service = new SevenTvService();
    const result = await service.getGlobal();

    expect(result.scope).toBe("global");
    expect(result.stale).toBe(false);
    expect(result.emotes[0]).toMatchObject({
      id: "01TEST",
      name: "Wave",
      provider: "7tv",
      animated: true,
    });
    expect(result.emotes[0].variants).toEqual([
      {
        url: "https://cdn.7tv.app/emote/01TEST/1x.webp",
        width: 32,
        height: 32,
        format: "webp",
        scale: 1,
      },
      {
        url: "https://cdn.7tv.app/emote/01TEST/2x.avif",
        width: 64,
        height: 64,
        format: "avif",
        scale: 2,
      },
    ]);
  });

  it("uses its memory cache without making another request", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(sevenTvPayload), { status: 200 }),
    );
    vi.stubGlobal("fetch", request);

    const service = new SevenTvService();
    await service.getGlobal();
    await service.getGlobal();

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid broadcaster identifiers before requesting 7TV", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);

    await expect(new SevenTvService().getChannel("../bad")).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
