import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { FilteredHlsRelay } from "./filtered-hls-relay";
import { fragmentPieces, initSegment, join } from "./test-support/fmp4-fixtures";

const ORIGIN = "http://localhost:5173";

/**
 * A stand-in for Twitch's edge: two complete fragments, and two named as
 * in progress that are written only when a test says so. Like Twitch, it
 * names a fragment differently while it is being written than once it is
 * listed complete, so only its date links the two.
 */
class FakeTwitchEdge {
  readonly server: Server;
  /** How long the initialisation segment takes to arrive. */
  initDelayMs = 0;
  private completed = 2;
  private readonly writing = new Map<number, ServerResponse>();
  private readonly waiting = new Map<number, (response: ServerResponse) => void>();

  constructor() {
    this.server = createServer((request, response) => {
      const path = request.url ?? "/";
      if (path === "/index.m3u8") {
        response.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
        response.end(this.playlist());
        return;
      }
      if (path === "/init.mp4") {
        setTimeout(() => {
          response.writeHead(200, { "Content-Type": "video/mp4" });
          response.end(initSegment());
        }, this.initDelayMs);
        return;
      }
      const pending = /^\/pending-(\d+)\.mp4$/.exec(path);
      if (pending) {
        const index = Number(pending[1]);
        response.writeHead(200, { "Content-Type": "video/mp4" });
        response.flushHeaders();
        this.writing.set(index, response);
        this.waiting.get(index)?.(response);
        return;
      }
      response.writeHead(200, { "Content-Type": "video/mp4" });
      response.end(join(...fragmentPieces(0)));
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    return `http://127.0.0.1:${address.port}/index.m3u8`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** The response the relay is reading fragment `index` from, once it asks. */
  async stream(index: number): Promise<ServerResponse> {
    const open = this.writing.get(index);
    if (open) return open;
    return new Promise((resolve) => this.waiting.set(index, resolve));
  }

  /** Twitch lists fragment `index` complete and names two more in progress. */
  complete(index: number): void {
    this.completed = index;
  }

  private playlist(): string {
    const date = (index: number) => new Date(Date.UTC(2026, 8, 29, 12, 0, (index - 1) * 2)).toISOString();
    return [
      "#EXTM3U",
      "#EXT-X-VERSION:6",
      "#EXT-X-TARGETDURATION:2",
      '#EXT-X-MAP:URI="init.mp4"',
      ...Array.from({ length: this.completed }, (_, offset) => [
        `#EXT-X-PROGRAM-DATE-TIME:${date(offset + 1)}`,
        "#EXTINF:2.000,live",
        `fragment-${offset + 1}.mp4`,
      ]).flat(),
      `#EXT-X-TWITCH-PREFETCH:pending-${this.completed + 1}.mp4`,
      `#EXT-X-TWITCH-PREFETCH:pending-${this.completed + 2}.mp4`,
      "",
    ].join("\n");
  }
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the relay.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function getText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { Origin: ORIGIN } });
  expect(response.status).toBe(200);
  return response.text();
}

function partLines(playlist: string): string[] {
  return playlist.split("\n").filter((line) => line.startsWith("#EXT-X-PART:"));
}

function write(response: ServerResponse, pieces: Uint8Array[]): void {
  response.write(join(...pieces));
}

let edge: FakeTwitchEdge;
let relay: FilteredHlsRelay;

async function startRelay(publishParts = true, initDelayMs = 0): Promise<string> {
  edge = new FakeTwitchEdge();
  edge.initDelayMs = initDelayMs;
  const source = await edge.listen();
  relay = new FilteredHlsRelay(() => ORIGIN, "twitch", { publishParts });
  return relay.start(source);
}

afterEach(async () => {
  await relay?.close();
  await edge?.close();
});

describe("FilteredHlsRelay parts", () => {
  it("publishes the fragment being written as parts that open on its key frame", async () => {
    const playlistUrl = await startRelay();
    await getText(playlistUrl);
    const writing = await edge.stream(3);
    const pieces = fragmentPieces(4);
    // The event message and the first seven chunks: two whole parts.
    write(writing, pieces.slice(0, 8));

    const playlist = await waitFor(async () => {
      const text = await getText(playlistUrl);
      return partLines(text).length >= 2 ? text : undefined;
    });

    expect(playlist).toContain("#EXT-X-VERSION:9");
    expect(playlist).toMatch(/#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=\d/);
    expect(playlist).toMatch(/#EXT-X-PART-INF:PART-TARGET=0\.3\d\d/);
    const parts = partLines(playlist);
    expect(parts[0]).toContain("INDEPENDENT=YES");
    expect(parts[1]).not.toContain("INDEPENDENT");
    expect(parts[0]).toMatch(/DURATION=0\.321/);
    // The parts follow the last complete fragment, with its date carried on.
    const lines = playlist.trimEnd().split("\n");
    expect(lines.at(-2)).toBe(parts.at(-1));
    // And the part after them is named as coming next.
    expect(lines.at(-1)).toBe('#EXT-X-PRELOAD-HINT:TYPE=PART,URI="hint/2/2"');
    expect(playlist).toContain("#EXT-X-PROGRAM-DATE-TIME:2026-09-29T12:00:04.000Z");
    expect(playlist).not.toContain("pending-");

    // A part is the fragment's own bytes, from its start to a chunk boundary.
    const uri = /URI="([^"]+)"/.exec(parts[0])![1];
    const response = await fetch(new URL(uri, playlistUrl), { headers: { Origin: ORIGIN } });
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(join(...pieces.slice(0, 4)));
  });

  it("holds a blocking playlist request until the part it asks for is cut", async () => {
    const playlistUrl = await startRelay();
    await getText(playlistUrl);
    const writing = await edge.stream(3);
    const pieces = fragmentPieces(4);
    // A part is cut once the chunk after it starts arriving.
    write(writing, pieces.slice(0, 5));
    await waitFor(async () => (partLines(await getText(playlistUrl)).length >= 1 ? true : undefined));

    // Fragment 3 is the relay's sequence 2. Ask for its second part.
    const blocked = getText(`${playlistUrl}?_HLS_msn=2&_HLS_part=1`);
    const early = await Promise.race([
      blocked.then(() => "answered"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 300)),
    ]);
    expect(early).toBe("waiting");

    write(writing, pieces.slice(5, 8));
    const playlist = await blocked;
    expect(partLines(playlist)).toHaveLength(2);
  });

  it("answers a request for a part it already has at once", async () => {
    const playlistUrl = await startRelay();
    await getText(playlistUrl);
    const writing = await edge.stream(3);
    write(writing, fragmentPieces(4).slice(0, 8));
    await waitFor(async () => (partLines(await getText(playlistUrl)).length >= 2 ? true : undefined));

    const started = Date.now();
    await getText(`${playlistUrl}?_HLS_msn=1`);
    await getText(`${playlistUrl}?_HLS_msn=2&_HLS_part=0`);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("serves a hinted part once it is cut", async () => {
    const playlistUrl = await startRelay();
    await getText(playlistUrl);
    const writing = await edge.stream(3);
    const pieces = fragmentPieces(4);

    const hinted = fetch(new URL("hint/2/0", playlistUrl), { headers: { Origin: ORIGIN } });
    const early = await Promise.race([
      hinted.then(() => "answered"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 300)),
    ]);
    expect(early).toBe("waiting");

    write(writing, pieces.slice(0, 5));
    const response = await hinted;
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(join(...pieces.slice(0, 4)));
  });

  it("ignores a malformed blocking directive", async () => {
    const playlistUrl = await startRelay();
    await getText(playlistUrl);
    const started = Date.now();
    await getText(`${playlistUrl}?_HLS_msn=next&_HLS_part=-1`);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("lists a finished fragment once, keeping its parts, when Twitch renames it complete", async () => {
    const playlistUrl = await startRelay();
    await getText(playlistUrl);
    const writing = await edge.stream(3);
    write(writing, fragmentPieces(4));
    writing.end();

    const finished = await waitFor(async () => {
      const text = await getText(playlistUrl);
      return text.match(/#EXTINF:/g)?.length === 3 ? text : undefined;
    });
    // Its parts come before its EXTINF, and its closing part covers the rest.
    const lines = finished.trimEnd().split("\n");
    const extinf = lines.lastIndexOf("#EXTINF:2.000,live");
    expect(lines[extinf - 1]).toMatch(/^#EXT-X-PART:DURATION=0\.074,URI="part\//);
    expect(partLines(finished)).toHaveLength(7);

    // Twitch lists it complete under another name. The relay reads the list
    // on its own clock, and the fragment must not appear twice.
    edge.complete(3);
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    const after = await getText(playlistUrl);
    expect(after).toContain("#EXT-X-MEDIA-SEQUENCE:0");
    expect(after.match(/#EXTINF:/g)).toHaveLength(3);
    expect(after.match(/#EXT-X-PROGRAM-DATE-TIME:2026-09-29T12:00:04.000Z/g)).toHaveLength(1);
    // It keeps the address it was listed with when it finished (the URL it
    // was streamed from), because hls.js fails a stream whose URIs change.
    const address = finished.trimEnd().split("\n").at(-2);
    expect(address).toMatch(/^resource\/[a-f0-9]{32}$/);
    expect(after.trimEnd().split("\n").at(-2)).toBe(address);
    // With nothing of the next fragment yet, its first part is what is named
    // next, so the playlist never ends on a complete segment.
    expect(after.trimEnd().split("\n").at(-1)).toBe(
      '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="hint/3/0"',
    );
    expect(partLines(after)).toHaveLength(7);
    // Fragment 4 has started streaming as the next in progress.
    await edge.stream(4);
  });

  it("still cuts a fragment that finishes before the initialisation segment arrives", async () => {
    const playlistUrl = await startRelay(true, 300);
    await getText(playlistUrl);
    const writing = await edge.stream(3);
    write(writing, fragmentPieces(4));
    writing.end();

    const finished = await waitFor(async () => {
      const text = await getText(playlistUrl);
      return text.match(/#EXTINF:/g)?.length === 3 ? text : undefined;
    });
    expect(partLines(finished)).toHaveLength(7);
    expect(partLines(finished)[0]).toContain("INDEPENDENT=YES");
  });

  it("cuts the next fragment when it carries on from the last", async () => {
    const playlistUrl = await startRelay();
    await getText(playlistUrl);
    const third = await edge.stream(3);
    write(third, fragmentPieces(4));
    third.end();
    const fourth = await edge.stream(4);
    write(fourth, fragmentPieces(6).slice(0, 8));

    const playlist = await waitFor(async () => {
      const text = await getText(playlistUrl);
      return text.includes('URI="hint/3/2"') ? text : undefined;
    });
    expect(partLines(playlist)).toHaveLength(9);
  });

  it("leaves a fragment whole when its timestamps do not carry on", async () => {
    // What an advertisement Twitch has not marked yet looks like from here.
    const playlistUrl = await startRelay();
    await getText(playlistUrl);
    const third = await edge.stream(3);
    write(third, fragmentPieces(4));
    third.end();
    await waitFor(async () => ((await getText(playlistUrl)).includes('URI="hint/3/0"') ? true : undefined));
    const fourth = await edge.stream(4);
    write(fourth, fragmentPieces(100).slice(0, 8));

    await new Promise((resolve) => setTimeout(resolve, 400));
    const playlist = await getText(playlistUrl);
    expect(partLines(playlist)).toHaveLength(7);
    expect(playlist).toContain('URI="hint/3/0"');
  });

  it("does not answer for parts it no longer holds", async () => {
    const playlistUrl = await startRelay();
    const missing = playlistUrl.replace("index.m3u8", `part/${"0".repeat(32)}`);
    const response = await fetch(missing, { headers: { Origin: ORIGIN } });
    expect(response.status).toBe(404);
  });

  it("publishes no parts unless asked to", async () => {
    const playlistUrl = await startRelay(false);
    const playlist = await getText(playlistUrl);
    expect(playlist).not.toContain("#EXT-X-PART");
    expect(playlist).not.toContain("SERVER-CONTROL");
  });
});
