import type { ReactNode } from "react";
import type { ChatMessage } from "../../shared/chat";
import type { ProviderEmote } from "../../shared/emotes";
import { withoutRedundantReplyMention } from "./chat-display";
import { renderProviderText } from "./ProviderEmoteText";
import { ChatEmote } from "./ChatEmote";
import { ChatGif } from "./ChatGif";
import { emoteImageUrl } from "./emote-image-url";

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
  // Twitch counts these positions in characters, not in the pairs JavaScript
  // stores them as, so a message with an emoji earlier in it would otherwise
  // cut the wrong span — visibly wrong for a GIF, which stands for a whole
  // bracketed description rather than one short name.
  const points = [...displayMessage.text];
  const between = (from: number, to?: number) => points.slice(from, to).join("");
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) {
      output.push(
        ...renderProviderText(
          between(cursor, range.start),
          providerEmotes,
          `${message.id}-text-${index}`,
          "chat-emote",
        ),
      );
    }
    const name = between(range.start, range.end + 1);
    output.push(
      range.kind === "gif" && range.imageUrl ? (
        <ChatGif
          description={name}
          imageUrl={range.imageUrl}
          key={`${message.id}-gif-${index}`}
        />
      ) : (
        <ChatEmote
          className="chat-emote"
          imageUrl={emoteImageUrl(
            range.imageUrl ??
              `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(range.id)}/default/dark/2.0`,
          )}
          key={`${message.id}-twitch-${index}`}
          name={name}
          provider={range.provider ?? "twitch"}
        />
      ),
    );
    cursor = range.end + 1;
  });
  if (cursor < points.length) {
    output.push(
      ...renderProviderText(
        between(cursor),
        providerEmotes,
        `${message.id}-tail`,
        "chat-emote",
      ),
    );
  }
  return output;
}
