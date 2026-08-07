import { Fragment } from "react";
import { Pin, X } from "lucide-react";
import { getLinkImagePreviewUrl, tokenizeChatLinks } from "../../shared/chat-content";
import type {
  TwitchPinnedChatFragment,
  TwitchPinnedChatMessage as PinnedMessage,
} from "../../shared/twitch";

function renderText(text: string, key: string) {
  return tokenizeChatLinks(text).map((content, index) => {
    if (content.kind === "text") {
      return <span key={`${key}-text-${index}`}>{content.text}</span>;
    }

    const previewUrl = getLinkImagePreviewUrl(content.url);
    return (
      <a
        className="chat-link"
        data-violetwire-link-preview={content.url}
        href={content.url}
        key={`${key}-link-${index}`}
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
      >
        {content.text}
      </a>
    );
  });
}

function renderFragment(fragment: TwitchPinnedChatFragment, index: number) {
  if (fragment.type === "emote" && fragment.emote) {
    const format = fragment.emote.formats.includes("animated")
      ? "animated"
      : "static";
    return (
      <img
        alt={fragment.text}
        className="pinned-chat-emote"
        decoding="async"
        // A pinned message is always on screen; it should never show a gap.
        fetchPriority="high"
        key={`${fragment.emote.id}:${index}`}
        loading="eager"
        src={
          fragment.emote.imageUrl ??
          `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(fragment.emote.id)}/${format}/dark/2.0`
        }
      />
    );
  }
  if (fragment.type === "mention") {
    return (
      <span className="pinned-chat-mention" key={index}>
        {fragment.text}
      </span>
    );
  }
  return (
    <Fragment key={index}>
      {renderText(fragment.text, `fragment-${index}`)}
    </Fragment>
  );
}

export function PinnedChatMessage({
  message,
  onDismiss,
}: {
  message: PinnedMessage;
  onDismiss: () => void;
}) {
  return (
    <aside className="pinned-chat-banner" aria-label="Pinned chat message">
      <div className="pinned-chat-heading">
        <span>
          <Pin aria-hidden="true" size={13} />
          {message.pinnedByName
            ? `Pinned by ${message.pinnedByName}`
            : "Pinned message"}
        </span>
        <button
          aria-label="Hide pinned message"
          data-tooltip="Hide pinned message"
          onClick={onDismiss}
          type="button"
        >
          <X size={14} />
        </button>
      </div>
      <div className="pinned-chat-content">
        <strong>{message.senderName}</strong>
        <span className="pinned-chat-separator">:</span>{" "}
        {message.fragments.length > 0
          ? message.fragments.map(renderFragment)
          : renderText(message.text, "message")}
      </div>
    </aside>
  );
}
