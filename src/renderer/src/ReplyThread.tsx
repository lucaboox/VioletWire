import type { ReactNode } from "react";
import { Reply, X } from "lucide-react";
import type { ChatBadgeAsset, ChatMessage } from "../../shared/chat";
import { formatChatTimestamp } from "../../shared/chat";
import { readableUsernameColor } from "../../shared/chat-color";
import { ChatBadge } from "./ChatBadge";
import "./reply-thread.css";

interface ReplyThreadProps {
  badges: Map<string, ChatBadgeAsset>;
  messages: ChatMessage[];
  oledMode: boolean;
  onClose: () => void;
  onReply: (message: ChatMessage) => void;
  renderText: (message: ChatMessage) => ReactNode;
  selected: ChatMessage;
}

function getThreadMessages(messages: ChatMessage[], selected: ChatMessage) {
  const rootId = selected.reply?.threadMessageId
    ?? selected.reply?.parentMessageId
    ?? selected.id;
  const related = messages.filter((message) =>
    message.id === rootId
    || message.id === selected.id
    || message.reply?.threadMessageId === rootId
    || message.reply?.parentMessageId === rootId,
  );
  return [...new Map(related.map((message) => [message.id, message])).values()]
    .sort((left, right) => left.sentAt - right.sentAt);
}

export function ReplyThread({
  badges,
  messages,
  oledMode,
  onClose,
  onReply,
  renderText,
  selected,
}: ReplyThreadProps) {
  const thread = getThreadMessages(messages, selected);
  const parentIsRetained = Boolean(
    selected.reply && messages.some((message) => message.id === selected.reply?.parentMessageId),
  );

  return (
    <section aria-label="Reply thread" className="reply-thread-panel">
      <header>
        <span><Reply size={15} /> Reply thread</span>
        <button aria-label="Close reply thread" onClick={onClose} title="Close" type="button">
          <X size={16} />
        </button>
      </header>
      <div className="reply-thread-messages">
        {selected.reply && !parentIsRetained && (
          <article className="reply-thread-message older-context">
            <div>
              <strong>{selected.reply.parentDisplayName || selected.reply.parentUserLogin}</strong>
              <small>Older context</small>
            </div>
            <p>{selected.reply.parentMessageBody || "The earlier message is no longer available."}</p>
          </article>
        )}
        {thread.map((message) => (
          <article
            className={`reply-thread-message${message.id === selected.id ? " selected" : ""}`}
            key={message.id}
          >
            <div className="reply-thread-author">
              <span>
                {message.badges.slice(0, 3).map((badgeKey) => {
                  const badge = badges.get(badgeKey);
                  return badge ? <ChatBadge badge={badge} key={badgeKey} /> : null;
                })}
                <strong
                  style={{
                    color: readableUsernameColor(
                      message.color,
                      oledMode ? "#000000" : "#18181b",
                    ),
                  }}
                >
                  {message.displayName}
                </strong>
              </span>
              <time dateTime={new Date(message.sentAt).toISOString()}>
                {formatChatTimestamp(message.sentAt)}
              </time>
            </div>
            <div className="reply-thread-body">{renderText(message)}</div>
            {!message.deleted && (
              <button
                className="reply-thread-action"
                onClick={() => {
                  onReply(message);
                  onClose();
                }}
                type="button"
              >
                <Reply size={12} /> Reply
              </button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
