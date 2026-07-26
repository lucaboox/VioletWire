import { Pin, X } from "lucide-react";
import type {
  TwitchPinnedChatFragment,
  TwitchPinnedChatMessage as PinnedMessage,
} from "../../shared/twitch";

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
        key={`${fragment.emote.id}:${index}`}
        loading="lazy"
        src={`https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(fragment.emote.id)}/${format}/dark/2.0`}
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
  return <span key={index}>{fragment.text}</span>;
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
          Pinned by {message.pinnedByName}
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
          : message.text}
      </div>
    </aside>
  );
}
