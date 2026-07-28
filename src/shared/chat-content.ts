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
export type ChatMentionTextToken =
  | ChatTextToken
  | { kind: "mention"; text: string };

export interface ChatMentionCandidate {
  color: string;
  displayName: string;
  login: string;
}

export const RECENT_CHATTER_LIMIT = 2_000;

/** A per-channel, bounded index independent of the rendered message history. */
export class RecentChatterIndex {
  private readonly items = new Map<string, ChatMentionCandidate>();

  add(candidate: ChatMentionCandidate): void {
    const login = candidate.login.trim().toLowerCase();
    if (!login) return;
    // Map insertion order gives us a small LRU: refresh an existing user by
    // moving them to the newest end, then evict the oldest if needed.
    this.items.delete(login);
    this.items.set(login, { ...candidate, login });
    if (this.items.size > RECENT_CHATTER_LIMIT) {
      const oldest = this.items.keys().next().value;
      if (oldest) this.items.delete(oldest);
    }
  }

  allNewestFirst(): ChatMentionCandidate[] {
    return [...this.items.values()].reverse();
  }
}

const linkPattern =
  /(?:https?:\/\/|www\.)[^\s<>"']+|(?<![@\w])(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{2,5})?(?:\/[^\s<>"']*)?/gi;
const trailingPunctuation = /[.,!?;:)\]}]+$/;
const mentionPattern = /(?<![\w@])@[a-z0-9_]{1,25}(?![a-z0-9_])/gi;

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

export function tokenizeChatMentions(text: string): ChatMentionTextToken[] {
  const tokens: ChatMentionTextToken[] = [];
  let cursor = 0;
  for (const match of text.matchAll(mentionPattern)) {
    const start = match.index;
    if (start > cursor) tokens.push({ kind: "text", text: text.slice(cursor, start) });
    tokens.push({ kind: "mention", text: match[0] });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) tokens.push({ kind: "text", text: text.slice(cursor) });
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
  preferred?: ChatMentionCandidate,
): ChatMentionCandidate[] {
  const recentChatters: ChatMentionCandidate[] = [];
  const seen = new Set<string>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const login = message.login.toLowerCase();
    if (!login || seen.has(login)) continue;
    seen.add(login);
    recentChatters.push({
      color: message.color,
      displayName: message.displayName,
      login,
    });
  }
  return filterChatMentionCandidates(recentChatters, query, limit, preferred);
}

export function filterChatMentionCandidates(
  recentChatters: readonly ChatMentionCandidate[],
  query: string,
  limit = 8,
  preferred?: ChatMentionCandidate,
): ChatMentionCandidate[] {
  if (limit <= 0) return [];
  const normalizedQuery = query.toLowerCase();
  const seen = new Set<string>();
  const candidates: ChatMentionCandidate[] = [];
  const matchesQuery = (candidate: Pick<ChatMentionCandidate, "displayName" | "login">) =>
    !normalizedQuery ||
    candidate.login.toLowerCase().startsWith(normalizedQuery) ||
    candidate.displayName.toLowerCase().startsWith(normalizedQuery);

  if (preferred?.login) {
    const normalizedPreferred = {
      ...preferred,
      login: preferred.login.toLowerCase(),
    };
    if (matchesQuery(normalizedPreferred)) {
      candidates.push(normalizedPreferred);
      seen.add(normalizedPreferred.login);
      if (candidates.length >= limit) return candidates;
    }
  }

  for (const chatter of recentChatters) {
    const login = chatter.login.toLowerCase();
    if (!login || seen.has(login)) continue;
    seen.add(login);
    if (!matchesQuery({ displayName: chatter.displayName, login })) continue;
    candidates.push({
      color: chatter.color,
      displayName: chatter.displayName,
      login,
    });
    if (candidates.length >= limit) break;
  }

  return candidates;
}
