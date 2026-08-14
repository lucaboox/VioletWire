import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import {
  FilteredHlsRelay,
  isDirectTwitchMediaUrl,
  parseTwitchMediaPlaylist,
} from "./filtered-hls-relay";

describe("isDirectTwitchMediaUrl", () => {
  it.each([
    "https://video-weaver.example.hls.ttvnw.net/segment.ts",
    "https://assets.twitchcdn.net/init.mp4",
  ])("accepts an HTTPS Twitch CDN resource: %s", (url) => {
    expect(isDirectTwitchMediaUrl(url)).toBe(true);
  });

  it.each([
    "http://video-weaver.example.hls.ttvnw.net/segment.ts",
    "https://ttvnw.net.attacker.example/segment.ts",
    "https://example.com/segment.ts",
    "not a url",
  ])("rejects a non-Twitch media resource: %s", (url) => {
    expect(isDirectTwitchMediaUrl(url)).toBe(false);
  });
});

describe("parseTwitchMediaPlaylist", () => {
  it("marks Twitch stitched-ad date ranges and Amazon-titled segments as ads", () => {
    const playlist = parseTwitchMediaPlaylist(
      `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:2
#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-07-25T12:00:02.000Z",DURATION=2
#EXT-X-MAP:URI="init.mp4"
#EXT-X-PROGRAM-DATE-TIME:2026-07-25T12:00:00.000Z
#EXTINF:2.000,live
segment-1.mp4
#EXT-X-DISCONTINUITY
#EXT-X-PROGRAM-DATE-TIME:2026-07-25T12:00:02.000Z
#EXTINF:2.000,live
segment-ad.mp4
#EXT-X-PROGRAM-DATE-TIME:2026-07-25T12:00:04.500Z
#EXTINF:2.000,Amazon stitched
segment-amazon.mp4
#EXT-X-PROGRAM-DATE-TIME:2026-07-25T12:00:07.000Z
#EXTINF:2.000,live
segment-2.mp4
`,
      "https://video.example/live/index.m3u8",
    );

    expect(playlist.version).toBe(6);
    expect(playlist.targetDuration).toBe(2);
    expect(playlist.segments.map((segment) => segment.ad)).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect(playlist.segments[0].uri).toBe(
      "https://video.example/live/segment-1.mp4",
    );
    expect(playlist.segments[1].discontinuity).toBe(true);
  });

  it("converts Twitch prefetch entries into inferred live segments", () => {
    const playlist = parseTwitchMediaPlaylist(
      `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:6
#EXT-X-PROGRAM-DATE-TIME:2026-08-02T06:21:40.000Z
#EXTINF:2.000,live
segment-1.ts
#EXT-X-PROGRAM-DATE-TIME:2026-08-02T06:21:42.000Z
#EXTINF:2.000,live
segment-2.ts
#EXT-X-TWITCH-PREFETCH:segment-3.ts
#EXT-X-TWITCH-PREFETCH:segment-4.ts
`,
      "https://video.example/live/index.m3u8",
    );

    expect(playlist.segments).toHaveLength(4);
    expect(playlist.segments.slice(-2).map((segment) => segment.prefetch)).toEqual([
      true,
      true,
    ]);
    expect(playlist.segments[2]).toMatchObject({
      duration: 2,
      date: Date.parse("2026-08-02T06:21:44.000Z"),
      uri: "https://video.example/live/segment-3.ts",
    });
    expect(playlist.segments[3].date).toBe(
      Date.parse("2026-08-02T06:21:46.000Z"),
    );
  });

  it("can omit in-progress Twitch prefetch entries for balanced playback", () => {
    const playlist = parseTwitchMediaPlaylist(
      `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-PROGRAM-DATE-TIME:2026-08-02T06:21:40.000Z
#EXTINF:2.000,live
segment-1.ts
#EXT-X-TWITCH-PREFETCH:segment-2.ts
`,
      "https://video.example/live/index.m3u8",
      false,
    );

    expect(playlist.segments).toHaveLength(1);
    expect(playlist.segments[0].prefetch).toBe(false);
  });

  it("serves an opaque local playlist with ad segments removed", async () => {
    const upstream = createServer((request, response) => {
      if (request.url === "/index.m3u8") {
        response.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
        response.end(`#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:6
#EXT-X-DATERANGE:ID="stitched-ad-2",CLASS="twitch-stitched-ad",START-DATE="2026-07-25T12:00:02.000Z",DURATION=2
#EXT-X-MAP:URI="init.mp4"
#EXT-X-PROGRAM-DATE-TIME:2026-07-25T12:00:00.000Z
#EXTINF:2.000,live
content.mp4
#EXT-X-PROGRAM-DATE-TIME:2026-07-25T12:00:02.000Z
#EXTINF:2.000,live
advertisement.mp4
#EXT-X-TWITCH-PREFETCH:prefetch.mp4
`);
        return;
      }
      response.writeHead(200, { "Content-Type": "video/mp4" });
      response.end(request.url === "/content.mp4" ? "content" : "other");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    const relay = new FilteredHlsRelay(() => "http://localhost:5173");

    try {
      const playlistUrl = await relay.start(
        `http://127.0.0.1:${address.port}/index.m3u8`,
      );
      const playlistResponse = await fetch(playlistUrl, {
        headers: { Origin: "http://localhost:5173" },
      });
      const playlist = await playlistResponse.text();
      expect(playlistResponse.status).toBe(200);
      expect(playlist).toContain("#EXT-X-TARGETDURATION:2");
      expect(playlist.match(/#EXT-X-MEDIA-SEQUENCE:/g)).toHaveLength(1);
      expect(playlist).not.toContain("EXT-X-TWITCH-PREFETCH");
      expect(playlist.match(/#EXTINF:/g)).toHaveLength(2);
      expect(playlist).not.toContain("advertisement.mp4");
      expect(playlist).not.toContain(`127.0.0.1:${address.port}`);
      expect(playlist.match(/resource\/[a-f0-9]{32}/g)?.length).toBeGreaterThan(0);
    } finally {
      await relay.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("keeps media sequences stable when Twitch renews signed segment URLs", async () => {
    let playlistRequest = 0;
    const upstream = createServer((request, response) => {
      if (request.url?.startsWith("/index.m3u8")) {
        const generation = playlistRequest++;
        const firstSegment = Math.min(generation, 1);
        response.writeHead(200, {
          "Content-Type": "application/vnd.apple.mpegurl",
        });
        response.end(`#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:1
${Array.from({ length: 29 }, (_, offset) => {
  const segment = firstSegment + offset;
  return `#EXT-X-PROGRAM-DATE-TIME:2026-08-14T17:45:${String(segment).padStart(2, "0")}.000Z
#EXTINF:1.000,live
segment-${segment}.ts?signature=${generation}`;
}).join("\n")}
`);
        return;
      }
      response.writeHead(200, { "Content-Type": "video/mp2t" });
      response.end("media");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    const relay = new FilteredHlsRelay(() => "http://localhost:5173");

    try {
      const playlistUrl = await relay.start(
        `http://127.0.0.1:${address.port}/index.m3u8`,
      );
      const first = await (
        await fetch(playlistUrl, { headers: { Origin: "http://localhost:5173" } })
      ).text();
      await new Promise((resolve) => setTimeout(resolve, 350));
      const second = await (
        await fetch(playlistUrl, { headers: { Origin: "http://localhost:5173" } })
      ).text();

      expect(first).toContain("#EXT-X-MEDIA-SEQUENCE:11");
      expect(second).toContain("#EXT-X-MEDIA-SEQUENCE:12");
      expect(second.match(/#EXTINF:/g)).toHaveLength(18);
      expect(second).toContain("2026-08-14T17:45:29.000Z");
    } finally {
      await relay.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("uses Kick's player origin when fetching a Kick playlist", async () => {
    let receivedOrigin: string | undefined;
    let receivedReferer: string | undefined;
    const upstream = createServer((request, response) => {
      receivedOrigin = request.headers.origin;
      receivedReferer = request.headers.referer;
      response.writeHead(200, {
        "Content-Type": "application/vnd.apple.mpegurl",
      });
      response.end(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXTINF:2.000,live
segment.ts
`);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    const relay = new FilteredHlsRelay(
      () => "http://localhost:5173",
      "kick",
    );

    try {
      const playlistUrl = await relay.start(
        `http://127.0.0.1:${address.port}/index.m3u8`,
      );
      const response = await fetch(playlistUrl, {
        headers: { Origin: "http://localhost:5173" },
      });
      expect(response.status).toBe(200);
      expect(receivedOrigin).toBe("https://kick.com");
      expect(receivedReferer).toBe("https://kick.com/");
    } finally {
      await relay.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
