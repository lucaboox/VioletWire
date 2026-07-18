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
