import type { ChatMessage } from "./chat";

export interface ChatLinkToken {
  kind: "link";
  text: string;
  url: string;
}

export interface ChatTextToken {
  kind: "text";
  text: string;
}

export type ChatContentToken = ChatLinkToken | ChatTextToken;

export interface ChatMentionCandidate {
  color: string;
  displayName: string;
  login: string;
}

const linkPattern =
  /(?:https?:\/\/|www\.)[^\s<>"']+|(?<![@\w])(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{2,5})?(?:\/[^\s<>"']*)?/gi;
const trailingPunctuation = /[.,!?;:)\]}]+$/;

export function tokenizeChatLinks(text: string): ChatContentToken[] {
  const tokens: ChatContentToken[] = [];
  let cursor = 0;
  const pushText = (value: string) => {
    if (!value) return;
    const previous = tokens.at(-1);
    if (previous?.kind === "text") previous.text += value;
    else tokens.push({ kind: "text", text: value });
  };

  for (const match of text.matchAll(linkPattern)) {
    const start = match.index;
    const raw = match[0];
    if (start > cursor) pushText(text.slice(cursor, start));

    const visibleText = raw.replace(trailingPunctuation, "");
    const punctuation = raw.slice(visibleText.length);
    if (visibleText) {
      tokens.push({
        kind: "link",
        text: visibleText,
        url: /^https?:\/\//i.test(visibleText)
          ? visibleText
          : `https://${visibleText}`,
      });
    }
    pushText(punctuation);
    cursor = start + raw.length;
  }

  if (cursor < text.length) pushText(text.slice(cursor));
  return tokens.length > 0 ? tokens : [{ kind: "text", text }];
}

const imageExtensionPattern = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Maps a chat link to a directly loadable image URL for hover previews, or
 * null when the link is not a known image. Only https URLs qualify, and host
 * rewrites are limited to services with stable direct-image forms.
 */
export function getLinkImagePreviewUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (imageExtensionPattern.test(url.pathname)) return url.toString();

  const host = url.hostname.toLowerCase();
  if (host === "imgur.com" || host === "www.imgur.com") {
    // Single-image pages only; albums and galleries have no stable mapping.
    const match = /^\/([A-Za-z0-9]{5,10})$/.exec(url.pathname);
    return match ? `https://i.imgur.com/${match[1]}.jpg` : null;
  }
  if (host === "gyazo.com" || host === "www.gyazo.com") {
    const match = /^\/([a-f0-9]{32})$/i.exec(url.pathname);
    return match ? `https://i.gyazo.com/${match[1]}.jpg` : null;
  }
  return null;
}

export function getChatMentionCandidates(
  messages: ChatMessage[],
  query: string,
  limit = 8,
): ChatMentionCandidate[] {
  const normalizedQuery = query.toLowerCase();
  const seen = new Set<string>();
  const candidates: ChatMentionCandidate[] = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const login = message.login.toLowerCase();
    if (!login || seen.has(login)) continue;
    seen.add(login);
    if (
      normalizedQuery &&
      !login.startsWith(normalizedQuery) &&
      !message.displayName.toLowerCase().startsWith(normalizedQuery)
    ) {
      continue;
    }
    candidates.push({
      color: message.color,
      displayName: message.displayName,
      login,
    });
    if (candidates.length >= limit) break;
  }

  return candidates;
}
