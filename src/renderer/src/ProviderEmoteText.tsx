import type { ReactNode } from "react";
import type { ProviderEmote } from "../../shared/emotes";
import {
  getLinkImagePreviewUrl,
  tokenizeChatLinks,
  tokenizeChatMentions,
} from "../../shared/chat-content";
import { ChatEmote } from "./ChatEmote";
import { chatEmoteVariant } from "./emote-scale";
import {
  getEmoteEffectClasses,
  isPrefixEmoteModifier,
} from "./emote-effects";

interface TextSegment {
  kind: "text";
  text: string;
}

interface EmoteSegment {
  kind: "emote";
  emote: ProviderEmote;
  modifiers: ProviderEmote[];
}

type Segment = TextSegment | EmoteSegment;

function appendText(segments: Segment[], text: string): void {
  if (!text) return;
  const last = segments.at(-1);
  if (last?.kind === "text") last.text += text;
  else segments.push({ kind: "text", text });
}

function plainTextSegments(
  text: string,
  emotes: Map<string, ProviderEmote>,
): Segment[] {
  const tokens = text.split(/(\s+)/);
  const segments: Segment[] = [];
  let pendingModifiers: ProviderEmote[] = [];

  const flushPendingAsText = () => {
    if (pendingModifiers.length === 0) return;
    appendText(segments, `${pendingModifiers.map((item) => item.name).join(" ")} `);
    pendingModifiers = [];
  };

  tokens.forEach((token, index) => {
    if (!token) return;
    if (/^\s+$/.test(token)) {
      if (pendingModifiers.length === 0) appendText(segments, token);
      return;
    }

    const emote = emotes.get(token);
    if (emote?.modifier) {
      const nextToken = tokens.slice(index + 1).find((item) => item && !/^\s+$/.test(item));
      const nextEmote = nextToken ? emotes.get(nextToken) : undefined;
      const actsAsPrefix =
        isPrefixEmoteModifier(emote) || Boolean(nextEmote && !nextEmote.modifier);

      if (actsAsPrefix) {
        pendingModifiers.push(emote);
        return;
      }

      let lastEmoteIndex = -1;
      for (let segmentIndex = segments.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
        if (segments[segmentIndex].kind === "emote") {
          lastEmoteIndex = segmentIndex;
          break;
        }
      }
      const onlyWhitespaceAfter =
        lastEmoteIndex >= 0 &&
        segments
          .slice(lastEmoteIndex + 1)
          .every((segment) => segment.kind === "text" && /^\s*$/.test(segment.text));
      if (onlyWhitespaceAfter) {
        segments.splice(lastEmoteIndex + 1);
        (segments[lastEmoteIndex] as EmoteSegment).modifiers.push(emote);
        return;
      }

      appendText(segments, token);
      return;
    }

    if (emote) {
      segments.push({ kind: "emote", emote, modifiers: pendingModifiers });
      pendingModifiers = [];
      return;
    }

    flushPendingAsText();
    appendText(segments, token);
  });

  flushPendingAsText();
  return segments;
}

export function renderProviderText(
  text: string,
  emotes: Map<string, ProviderEmote>,
  key: string,
  emoteClassName: string,
): ReactNode[] {
  return tokenizeChatLinks(text).flatMap((content, contentIndex) => {
    if (content.kind === "link") {
      const previewUrl = getLinkImagePreviewUrl(content.url);
      return (
        <a
          className="chat-link"
          href={content.url}
          key={`${key}-link-${contentIndex}`}
          onClick={(event) => {
            event.preventDefault();
            void window.desktop.system.openExternal(content.url);
          }}
          rel="noreferrer"
          title={content.url}
          {...(previewUrl
            ? {
                "data-violetwire-tooltip-image": previewUrl,
                "data-violetwire-tooltip-large": "",
              }
            : {})}
          data-violetwire-link-preview={content.url}
        >
          {content.text}
        </a>
      );
    }

    return plainTextSegments(content.text, emotes).map((segment, segmentIndex) => {
      if (segment.kind === "text") {
        return tokenizeChatMentions(segment.text).map((token, tokenIndex) =>
          token.kind === "mention" ? (
            <strong
              className="chat-text-mention"
              key={`${key}-${contentIndex}-${segmentIndex}-mention-${tokenIndex}`}
            >
              {token.text}
            </strong>
          ) : (
            token.text
          ),
        );
      }
      const variant = chatEmoteVariant(segment.emote.variants);
      if (!variant) return segment.emote.name;
      const effectClasses = getEmoteEffectClasses(segment.modifiers);
      const rendered = (
        <ChatEmote
          aspectRatio={variant.width / Math.max(variant.height, 1)}
          className={emoteClassName}
          imageUrl={variant.url}
          logicalHeight={variant.height / Math.max(variant.scale, 1)}
          name={segment.emote.name}
          provider={segment.emote.provider}
        />
      );
      return effectClasses.length > 0 ? (
        <span
          className={`chat-emote-effect ${effectClasses.join(" ")}`}
          key={`${key}-${contentIndex}-${segmentIndex}`}
        >
          {rendered}
        </span>
      ) : (
        <span key={`${key}-${contentIndex}-${segmentIndex}`}>{rendered}</span>
      );
    });
  });
}
