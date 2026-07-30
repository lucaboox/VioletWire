import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { LinkPreview } from "../shared/link-preview";

const MAX_HTML_BYTES = 512_000;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 5_000;

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

export function isPublicLinkPreviewAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !blockedAddresses.check(address, "ipv4");
  if (version === 6) return !blockedAddresses.check(address, "ipv6");
  return false;
}

async function resolvePublicAddress(url: URL): Promise<{
  address: string;
  family: 4 | 6;
}> {
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Generic previews require a public HTTPS URL.");
  }

  const hostname = normalizedHostname(url);
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Local addresses cannot be previewed.");
  }

  const literalVersion = isIP(hostname);
  if (literalVersion) {
    if (!isPublicLinkPreviewAddress(hostname)) {
      throw new Error("Private addresses cannot be previewed.");
    }
    return { address: hostname, family: literalVersion as 4 | 6 };
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicLinkPreviewAddress(address))
  ) {
    throw new Error("The preview host did not resolve to a public address.");
  }
  const selected = addresses[0];
  if (selected.family !== 4 && selected.family !== 6) {
    throw new Error("The preview host returned an unsupported address.");
  }
  return { address: selected.address, family: selected.family };
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, hexadecimal: string) =>
      String.fromCodePoint(Number.parseInt(hexadecimal, 16)),
    )
    .replace(
      /&(amp|quot|apos|lt|gt|nbsp);/gi,
      (_match, entity: string) =>
        ({
          amp: "&",
          quot: "\"",
          apos: "'",
          lt: "<",
          gt: ">",
          nbsp: " ",
        })[entity.toLowerCase()] ?? _match,
    )
    .replace(/\s+/g, " ")
    .trim();
}

function htmlAttribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(tag);
  return match?.[2] ?? null;
}

function htmlMetaContent(html: string, names: readonly string[]): string | null {
  const normalizedNames = new Set(names.map((name) => name.toLowerCase()));
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = htmlAttribute(tag, "property") ?? htmlAttribute(tag, "name");
    if (!key || !normalizedNames.has(key.toLowerCase())) continue;
    const content = htmlAttribute(tag, "content");
    if (content?.trim()) return decodeHtmlText(content);
  }
  return null;
}

function htmlTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? decodeHtmlText(match[1]) : null;
}

export function parseGenericLinkPreviewHtml(
  html: string,
  pageUrl: URL,
): LinkPreview {
  const title =
    htmlMetaContent(html, ["og:title", "twitter:title"]) ??
    htmlTitle(html) ??
    pageUrl.hostname;
  const description = htmlMetaContent(html, [
    "og:description",
    "twitter:description",
    "description",
  ]);
  const siteName =
    htmlMetaContent(html, ["og:site_name", "twitter:site"]) ??
    pageUrl.hostname.replace(/^www\./i, "");
  const rawThumbnail = htmlMetaContent(html, [
    "og:image:secure_url",
    "og:image",
    "twitter:image",
    "twitter:image:src",
  ]);

  let thumbnailUrl: string | undefined;
  if (rawThumbnail) {
    try {
      const thumbnail = new URL(rawThumbnail, pageUrl);
      if (thumbnail.protocol === "https:" && !thumbnail.username && !thumbnail.password) {
        thumbnailUrl = thumbnail.toString();
      }
    } catch {
      // A malformed image URL should not discard otherwise useful metadata.
    }
  }

  return {
    kind: "generic",
    url: pageUrl.toString(),
    title: title.slice(0, 300),
    author: siteName.slice(0, 120),
    description: description?.slice(0, 500),
    thumbnailUrl,
  };
}

async function loadHtml(
  url: URL,
  redirectsRemaining = MAX_REDIRECTS,
): Promise<{ body: string; finalUrl: URL }> {
  const selectedAddress = await resolvePublicAddress(url);

  return new Promise((resolve, reject) => {
    const requestHandle = request(
      url,
      {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Encoding": "identity",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": "VioletWire link-preview/1.0",
        },
        lookup: ((
          _hostname,
          options,
          callback,
        ) => {
          if (options.all) {
            callback(null, [selectedAddress]);
            return;
          }
          callback(null, selectedAddress.address, selectedAddress.family);
        }) satisfies LookupFunction,
        method: "GET",
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirectsRemaining <= 0) {
            reject(new Error("Too many link-preview redirects."));
            return;
          }
          let redirectedUrl: URL;
          try {
            redirectedUrl = new URL(response.headers.location, url);
          } catch {
            reject(new Error("The preview returned an invalid redirect."));
            return;
          }
          resolve(loadHtml(redirectedUrl, redirectsRemaining - 1));
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`The preview returned HTTP ${status}.`));
          return;
        }

        const contentType = response.headers["content-type"]?.toLowerCase() ?? "";
        if (
          !contentType.startsWith("text/html") &&
          !contentType.startsWith("application/xhtml+xml")
        ) {
          response.resume();
          reject(new Error("The preview URL is not an HTML page."));
          return;
        }
        const declaredLength = Number(response.headers["content-length"]);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_HTML_BYTES) {
          response.resume();
          reject(new Error("The preview page is too large."));
          return;
        }

        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        response.on("data", (chunk: Buffer) => {
          receivedBytes += chunk.length;
          if (receivedBytes > MAX_HTML_BYTES) {
            response.destroy(new Error("The preview page is too large."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            finalUrl: url,
          });
        });
        response.on("error", reject);
      },
    );
    requestHandle.setTimeout(REQUEST_TIMEOUT_MS, () => {
      requestHandle.destroy(new Error("The link preview timed out."));
    });
    requestHandle.on("error", reject);
    requestHandle.end();
  });
}

export async function resolveGenericLinkPreview(url: URL): Promise<LinkPreview> {
  const { body, finalUrl } = await loadHtml(url);
  const preview = parseGenericLinkPreviewHtml(body, finalUrl);
  if (preview.thumbnailUrl) {
    try {
      await resolvePublicAddress(new URL(preview.thumbnailUrl));
    } catch {
      preview.thumbnailUrl = undefined;
    }
  }
  return preview;
}
