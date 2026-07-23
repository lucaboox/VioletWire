import { afterEach, describe, expect, it, vi } from "vitest";
import { ThirdPartyEmoteService } from "./third-party-emote-service";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ThirdPartyEmoteService", () => {
  it("normalizes FFZ global sets and image scales", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            sets: {
              "3": {
                emoticons: [
                  {
                    id: 9,
                    name: "ZrehplaR",
                    width: 33,
                    height: 30,
                    modifier: true,
                    modifier_flags: 2049,
                    urls: {
                      "1": "//cdn.frankerfacez.com/emote/9/1",
                      "2": "https://cdn.frankerfacez.com/emote/9/2",
                    },
                  },
                ],
              },
            },
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await new ThirdPartyEmoteService().getFfzGlobal();

    expect(result).toMatchObject({ provider: "ffz", scope: "global", stale: false });
    expect(result.emotes[0]).toMatchObject({
      id: "9",
      name: "ZrehplaR",
      provider: "ffz",
      modifier: true,
      modifierFlags: 2049,
    });
    expect(result.emotes[0].variants[1]).toMatchObject({
      url: "https://cdn.frankerfacez.com/emote/9/2",
      width: 66,
      height: 60,
      scale: 2,
    });
  });

  it("combines BetterTTV channel and shared emotes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            channelEmotes: [
              {
                id: "channel-id",
                code: "ChannelWave",
                imageType: "png",
                modifier: true,
              },
            ],
            sharedEmotes: [
              { id: "shared-id", code: "SharedDance", imageType: "gif", animated: true },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await new ThirdPartyEmoteService().getBttvChannel("71092938");

    expect(result).toMatchObject({ provider: "bttv", scope: "channel" });
    expect(result.emotes.map((emote) => emote.name)).toEqual([
      "ChannelWave",
      "SharedDance",
    ]);
    expect(result.emotes[0]).toMatchObject({ modifier: true, provider: "bttv" });
    expect(result.emotes[1]).toMatchObject({ animated: true, modifier: false, provider: "bttv" });
    expect(result.emotes[1].variants[2].url).toBe(
      "https://cdn.betterttv.net/emote/shared-id/3x.webp",
    );
  });

  it("returns empty for a non-numeric broadcaster id without calling a provider", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);

    const service = new ThirdPartyEmoteService();
    expect((await service.getFfzChannel("../bad")).emotes).toEqual([]);
    expect((await service.getBttvChannel("../bad")).emotes).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
});
