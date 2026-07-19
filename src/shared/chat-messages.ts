import type { ChatMessage } from "./chat";

export const CHAT_MESSAGE_LIMIT = 500;
// While the reader has scrolled up, appending below them never moves their
// view, so the list may grow past the live cap. Trimming the top (which
// shifts every row) only happens once the hard limit is reached, cutting
// back far enough that the next trim is hundreds of messages away.
export const CHAT_PAUSED_HARD_LIMIT = 1_500;
export const CHAT_PAUSED_TRIM_TO = 1_000;

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
    if (message.moderation?.type === "timeout" || message.moderation?.type === "ban") {
      let changed = false;
      const next = current.map((item) => {
        if (item.login.toLowerCase() !== message.login.toLowerCase() || item.deleted) {
          return item;
        }
        changed = true;
        return {
          ...item,
          deleted: true,
          moderation: message.moderation,
        };
      });
      return changed ? next : current;
    }
    const index = current.findIndex((item) => item.id === message.id);
    if (index < 0) return current;
    const next = current.slice();
    next[index] = {
      ...next[index],
      deleted: true,
      moderation: message.moderation ?? { type: "message-deleted" },
    };
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

/**
 * Applies a batch of messages in arrival order. Callers batch on a short
 * interval so heavy chats cost a handful of React commits per second instead
 * of one per message. Pass Infinity as the limit to defer trimming to the
 * caller (needed while the reader is scrolled up, where trimming must be
 * rare and anchored).
 */
export function applyChatMessageBatch(
  current: ChatMessage[],
  batch: ChatMessage[],
  limit = CHAT_MESSAGE_LIMIT,
): ChatMessage[] {
  let next = current;
  for (const message of batch) next = applyChatMessage(next, message, limit);
  return next;
}
