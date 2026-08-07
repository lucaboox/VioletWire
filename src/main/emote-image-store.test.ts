import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/violetwire-test" },
}));

const { allowedEmoteUrl, imageContentType, storeKeyFor } = await import(
  "./emote-image-store"
);

describe("allowedEmoteUrl", () => {
  it("accepts the services that publish emote artwork", () => {
    for (const url of [
      "https://cdn.7tv.app/emote/01F6MZGCKG/2x.webp",
      "https://cdn.betterttv.net/emote/abc/2x.webp",
      "https://cdn.frankerfacez.com/emote/1/2",
      "https://static-cdn.jtvnw.net/emoticons/v2/1/default/dark/2.0",
      "https://files.kick.com/emotes/1/fullsize",
    ]) {
      expect(allowedEmoteUrl(url), url).not.toBeNull();
    }
  });

  it("refuses anywhere else, however the address is dressed up", () => {
    for (const url of [
      "https://example.test/emote.webp",
      // A host that merely ends with an allowed name.
      "https://cdn.7tv.app.example.test/emote/1/2x.webp",
      // Credentials in the address.
      "https://cdn.7tv.app:pass@example.test/x.webp",
      // Anything not fetched over https.
      "http://cdn.7tv.app/emote/1/2x.webp",
      "file:///c:/windows/system32/config",
      "not a url",
    ]) {
      expect(allowedEmoteUrl(url), url).toBeNull();
    }
  });
});

describe("storeKeyFor", () => {
  it("names a file with nothing of the address left in it", () => {
    const key = storeKeyFor("https://cdn.7tv.app/emote/01F6MZGCKG/2x.webp");
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  it("gives each size and each emote its own name", () => {
    const one = storeKeyFor("https://cdn.7tv.app/emote/a/1x.webp");
    const two = storeKeyFor("https://cdn.7tv.app/emote/a/2x.webp");
    const other = storeKeyFor("https://cdn.7tv.app/emote/b/1x.webp");
    expect(new Set([one, two, other]).size).toBe(3);
  });

  it("gives the same address the same name every time", () => {
    expect(storeKeyFor("https://cdn.7tv.app/emote/a/1x.webp")).toBe(
      storeKeyFor("https://cdn.7tv.app/emote/a/1x.webp"),
    );
  });
});

describe("imageContentType", () => {
  const withHeader = (header: number[], length = 32) => {
    const bytes = Buffer.alloc(length);
    Buffer.from(header).copy(bytes);
    return bytes;
  };
  const ascii = (text: string, at = 0, length = 32) => {
    const bytes = Buffer.alloc(length);
    bytes.write(text, at, "ascii");
    return bytes;
  };

  it("reads the kind from the bytes, not the address", () => {
    const webp = Buffer.alloc(32);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBP", 8, "ascii");
    expect(imageContentType(webp)).toBe("image/webp");
    expect(imageContentType(withHeader([0x89, 0x50, 0x4e, 0x47]))).toBe("image/png");
    expect(imageContentType(ascii("GIF89a"))).toBe("image/gif");
    expect(imageContentType(withHeader([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  });

  it("recognises AVIF by the brand in its ftyp box", () => {
    const avif = Buffer.alloc(32);
    avif.write("ftyp", 4, "ascii");
    avif.write("avif", 8, "ascii");
    expect(imageContentType(avif)).toBe("image/avif");
  });

  it("refuses anything that is not an image, so an error page is never served", () => {
    expect(imageContentType(ascii("<!doctype html><html>"))).toBeNull();
    expect(imageContentType(ascii("{\"error\":\"not found\"}"))).toBeNull();
    expect(imageContentType(Buffer.alloc(4))).toBeNull();
  });
});
