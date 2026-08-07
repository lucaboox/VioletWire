import type { Session } from "electron";
import { describe, expect, it, vi } from "vitest";

import { HLS_MEDIA_SCHEME, HlsMediaProtocol } from "./hls-media-protocol";

describe("HlsMediaProtocol", () => {
  it("streams registered media through the Chromium session fetcher", async () => {
    let handler: ((request: Request) => Promise<Response>) | null = null;
    const chromiumFetch = vi.fn(
      async () =>
        new Response("segment-bytes", {
          status: 200,
          headers: { "Content-Type": "video/mp2t" },
        }),
    );
    const browserSession = {
      fetch: chromiumFetch,
      protocol: {
        handle: vi.fn(
          async (
            _scheme: string,
            nextHandler: (request: Request) => Promise<Response>,
          ) => {
            handler = nextHandler;
          },
        ),
        unhandle: vi.fn(),
      },
    } as unknown as Session;
    const transport = new HlsMediaProtocol();
    const sessionToken = "a".repeat(32);
    const resourceId = "b".repeat(32);

    await transport.initialize(browserSession);
    const unregister = transport.registerSession(sessionToken, (id) =>
      id === resourceId
        ? { platform: "twitch", url: "https://video.example/segment.ts" }
        : null,
    );

    expect(handler).not.toBeNull();
    const request = new Request(
      transport.resourceUrl(sessionToken, resourceId),
      {
        headers: { Range: "bytes=0-99" },
      },
    );
    const response = await handler!(request);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("segment-bytes");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(chromiumFetch).toHaveBeenCalledWith(
      "https://video.example/segment.ts",
      expect.objectContaining({
        bypassCustomProtocolHandlers: true,
        // Video shares a session with the interface. Cached, it evicts the
        // emote and avatar images the interface is holding there.
        cache: "no-store",
        headers: expect.objectContaining({ Range: "bytes=0-99" }),
      }),
    );

    unregister();
    expect(
      (
        await handler!(
          new Request(transport.resourceUrl(sessionToken, resourceId)),
        )
      ).status,
    ).toBe(404);
    await transport.close();
    expect(browserSession.protocol.unhandle).toHaveBeenCalledWith(
      HLS_MEDIA_SCHEME,
    );
  });

  it("rejects arbitrary and insecure upstream resources", async () => {
    let handler: ((request: Request) => Promise<Response>) | null = null;
    const browserSession = {
      fetch: vi.fn(),
      protocol: {
        handle: vi.fn(
          async (
            _scheme: string,
            nextHandler: (request: Request) => Promise<Response>,
          ) => {
            handler = nextHandler;
          },
        ),
        unhandle: vi.fn(),
      },
    } as unknown as Session;
    const transport = new HlsMediaProtocol();
    const sessionToken = "c".repeat(32);
    const resourceId = "d".repeat(32);
    await transport.initialize(browserSession);
    transport.registerSession(sessionToken, () => ({
      platform: "twitch",
      url: "http://attacker.invalid/media.ts",
    }));

    const response = await handler!(
      new Request(transport.resourceUrl(sessionToken, resourceId)),
    );
    expect(response.status).toBe(404);
    expect(browserSession.fetch).not.toHaveBeenCalled();
  });
});
