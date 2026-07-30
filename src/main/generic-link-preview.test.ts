import { describe, expect, it } from "vitest";
import {
  isPublicLinkPreviewAddress,
  parseGenericLinkPreviewHtml,
} from "./generic-link-preview";

describe("generic link preview address validation", () => {
  it.each([
    "127.0.0.1",
    "10.20.30.40",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "192.0.2.10",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
  ])("rejects private or reserved address %s", (address) => {
    expect(isPublicLinkPreviewAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])(
    "allows public address %s",
    (address) => {
      expect(isPublicLinkPreviewAddress(address)).toBe(true);
    },
  );
});

describe("generic link preview metadata parsing", () => {
  it("prefers Open Graph metadata and resolves relative thumbnails", () => {
    const preview = parseGenericLinkPreviewHtml(
      `
        <html>
          <head>
            <title>Fallback title</title>
            <meta property="og:title" content="A &amp; B">
            <meta property="og:description" content="A useful description.">
            <meta property="og:site_name" content="Example News">
            <meta property="og:image" content="/images/preview.jpg">
          </head>
        </html>
      `,
      new URL("https://news.example/articles/1"),
    );

    expect(preview).toEqual({
      kind: "generic",
      url: "https://news.example/articles/1",
      title: "A & B",
      author: "Example News",
      description: "A useful description.",
      thumbnailUrl: "https://news.example/images/preview.jpg",
    });
  });

  it("falls back to the page title and omits unsafe thumbnail protocols", () => {
    const preview = parseGenericLinkPreviewHtml(
      `
        <title>  Plain page  </title>
        <meta property="og:image" content="http://example.com/preview.jpg">
      `,
      new URL("https://www.example.com/page"),
    );

    expect(preview.title).toBe("Plain page");
    expect(preview.author).toBe("example.com");
    expect(preview.thumbnailUrl).toBeUndefined();
  });
});
