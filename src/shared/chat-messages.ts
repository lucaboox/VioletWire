import type { ChatMessage } from "./chat";

export const CHAT_MESSAGE_LIMIT = 500;

/**
 * Applies one incoming chat message to a timestamp-ordered message list and
 * returns the next list. Live IRC messages almost always arrive in order, so
 * the common case is a plain append; a full ordered insertion only happens for
 * out-of-order arrivals such as asynchronously loaded history. Returns the
 * original array unchanged for duplicates and unmatched deletions.
 */
export function applyChatMessage(
  current: ChatMessage[],
  message: ChatMessage,
  limit = CHAT_MESSAGE_LIMIT,
): ChatMessage[] {
  if (message.deleted) {
    const index = current.findIndex((item) => item.id === message.id);
    if (index < 0) return current;
    const next = current.slice();
    next[index] = { ...next[index], deleted: true };
    return next;
  }

  if (current.some((item) => item.id === message.id)) return current;

  const last = current.at(-1);
  if (!last || message.sentAt >= last.sentAt) {
    const appended = [...current, message];
    return appended.length > limit ? appended.slice(-limit) : appended;
  }

  // Binary search for the first entry newer than the message, so equal
  // timestamps keep their arrival order exactly like the previous stable sort.
  let low = 0;
  let high = current.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (current[middle].sentAt <= message.sentAt) low = middle + 1;
    else high = middle;
  }
  const next = [...current.slice(0, low), message, ...current.slice(low)];
  return next.length > limit ? next.slice(-limit) : next;
}
