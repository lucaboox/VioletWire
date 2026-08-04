import type { ReactNode } from "react";
import type { ChatMessage } from "../../shared/chat";
import type { ProviderEmote } from "../../shared/emotes";
import { withoutRedundantReplyMention } from "./chat-display";
import { renderProviderText } from "./ProviderEmoteText";
import { ChatEmote } from "./ChatEmote";

/** A chat message's text, with Twitch and third-party emotes rendered in place. */
export function renderChatMessageText(
  message: ChatMessage,
  providerEmotes: Map<string, ProviderEmote>,
): ReactNode[] {
  const displayMessage = withoutRedundantReplyMention(message);
  const ranges = [...displayMessage.twitchEmotes].sort(
    (left, right) => left.start - right.start,
  );
  if (ranges.length === 0) {
    return renderProviderText(
      displayMessage.text,
      providerEmotes,
      message.id,
      "chat-emote",
    );
  }
  const output: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) {
      output.push(
        ...renderProviderText(
          displayMessage.text.slice(cursor, range.start),
          providerEmotes,
          `${message.id}-text-${index}`,
          "chat-emote",
        ),
      );
    }
    const name = displayMessage.text.slice(range.start, range.end + 1);
    output.push(
      <ChatEmote
        className="chat-emote"
        imageUrl={
          range.imageUrl ??
          `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(range.id)}/default/dark/2.0`
        }
        key={`${message.id}-twitch-${index}`}
        name={name}
        provider={range.provider ?? "twitch"}
      />,
    );
    cursor = range.end + 1;
  });
  if (cursor < displayMessage.text.length) {
    output.push(
      ...renderProviderText(
        displayMessage.text.slice(cursor),
        providerEmotes,
        `${message.id}-tail`,
        "chat-emote",
      ),
    );
  }
  return output;
}
