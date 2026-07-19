import type { ChatMessage } from "../../shared/chat";

export function withoutRedundantReplyMention(message: ChatMessage): ChatMessage {
  if (!message.reply || !message.text.startsWith("@")) return message;
  const names = [message.reply.parentUserLogin, message.reply.parentDisplayName].filter(Boolean);
  const normalized = message.text.toLowerCase();
  const prefix = names
    .map((name) => `@${name.toLowerCase()}`)
    .find((candidate) => normalized.startsWith(`${candidate} `) || normalized === candidate);
  if (!prefix) return message;
  const removedLength = prefix.length + (message.text[prefix.length] === " " ? 1 : 0);
  return {
    ...message,
    text: message.text.slice(removedLength),
    twitchEmotes: message.twitchEmotes
      .filter((range) => range.end >= removedLength)
      .map((range) => ({
        ...range,
        start: Math.max(0, range.start - removedLength),
        end: range.end - removedLength,
      })),
  };
}
