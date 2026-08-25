import type { ChatMessage } from "../../shared/chat";

export function withoutRedundantReplyMention(message: ChatMessage): ChatMessage {
  if (!message.reply || !message.text.startsWith("@")) return message;
  const names = [message.reply.parentUserLogin, message.reply.parentDisplayName].filter(Boolean);
  const normalized = message.text.toLowerCase();
  const prefix = names
    .map((name) => `@${name.toLowerCase()}`)
    .find((candidate) => normalized.startsWith(`${candidate} `) || normalized === candidate);
  if (!prefix) return message;
  // Counted in characters as Twitch counts them, so the emote and GIF
  // positions this shifts stay lined up with the text they point at.
  const points = [...message.text];
  const prefixLength = [...prefix].length;
  const removedLength = prefixLength + (points[prefixLength] === " " ? 1 : 0);
  return {
    ...message,
    text: points.slice(removedLength).join(""),
    twitchEmotes: message.twitchEmotes
      .filter((range) => range.end >= removedLength)
      .map((range) => ({
        ...range,
        start: Math.max(0, range.start - removedLength),
        end: range.end - removedLength,
      })),
  };
}
