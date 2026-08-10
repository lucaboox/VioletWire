import { memo } from "react";
import { Reply, Star } from "lucide-react";
import {
  formatChatTimestamp,
  formatModerationAction,
  type ChatBadgeAsset,
  type ChatMessage,
} from "../../shared/chat";
import type { ProviderEmote } from "../../shared/emotes";
import type { AppPreferences } from "../../shared/preferences";
import { readableUsernameColor } from "../../shared/chat-color";
import { ChatBadge } from "./ChatBadge";
import { renderChatMessageText } from "./chat-message-text";

/**
 * One rendered chat message. This is shared by every surface that shows chat —
 * the docked panel, the overlay over the player, and the pop-out window — so a
 * message looks and behaves the same wherever it is read.
 */

export interface ChatMessageRowProps {
  message: ChatMessage;
  showTimestamp: boolean;
  badges: Map<string, ChatBadgeAsset>;
  oledMode: boolean;
  mentioned: boolean;
  deletedRevealed: boolean;
  deletedMessageStyle: AppPreferences["chatDeletedMessageStyle"];
  onRevealDeleted: (id: string) => void;
  onReply: (message: ChatMessage) => void;
  onOpenThread: (message: ChatMessage) => void;
  onOpenUser: (message: ChatMessage, anchor: DOMRect) => void;
  providerEmotes: Map<string, ProviderEmote>;
}

// Memoized so a new chat message only renders its own row instead of
// re-rendering (and re-tokenizing emotes for) every message in the list.
export const ChatMessageRow = memo(function ChatMessageRow({
  message,
  showTimestamp,
  badges,
  oledMode,
  mentioned,
  deletedRevealed,
  deletedMessageStyle,
  onRevealDeleted,
  onReply,
  onOpenThread,
  onOpenUser,
  providerEmotes,
}: ChatMessageRowProps) {
  if (message.notice) {
    return (
      <div
        className="native-chat-message chat-notice-message"
        data-chat-message-id={message.id}
      >
        <div className="chat-notice-heading">
          <Star fill="currentColor" size={15} />
          <strong>{message.notice.systemMessage}</strong>
        </div>
        <div className="chat-notice-facts">
          {message.notice.tier && <span>{message.notice.tier}</span>}
          {message.notice.cumulativeMonths && (
            <span>{message.notice.cumulativeMonths} months</span>
          )}
          {message.notice.streakMonths && (
            <span>{message.notice.streakMonths} month streak</span>
          )}
          {message.notice.giftCount && <span>{message.notice.giftCount} gifts</span>}
        </div>
        {message.text && (
          <div className="chat-notice-text">
            {showTimestamp && (
              <time dateTime={new Date(message.sentAt).toISOString()}>
                {formatChatTimestamp(message.sentAt)}
              </time>
            )}
            {message.badgeAssets && message.badgeAssets.length > 0 ? (
              <span className="native-chat-badges">
                {message.badgeAssets.slice(0, 4).map((badge) => (
                  <ChatBadge badge={badge} key={badge.key} />
                ))}
              </span>
            ) : (
              message.badges.length > 0 && (
                <span className="native-chat-badges" title={message.badges.join(", ")}>
                  {message.badges.slice(0, 4).map((badgeKey) => {
                    const badge = badges.get(badgeKey);
                    return badge ? <ChatBadge badge={badge} key={badgeKey} /> : null;
                  })}
                </span>
              )
            )}
            <button
              className="chat-username"
              onClick={(event) => onOpenUser(message, event.currentTarget.getBoundingClientRect())}
              style={{
                color: readableUsernameColor(
                  message.color,
                  oledMode ? "#000000" : "#18181b",
                ),
              }}
              type="button"
            >
              {message.displayName}
            </button>
            <span className="chat-colon">:</span>{" "}
            {renderChatMessageText(message, providerEmotes)}
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      className={[
        "native-chat-message",
        message.firstMessage ? "first-message" : "",
        mentioned ? "mentioned" : "",
        message.deleted && deletedMessageStyle === "dimmed" ? "deleted-dimmed" : "",
      ].filter(Boolean).join(" ")}
      data-chat-message-id={message.id}
    >
      {message.firstMessage && (
        <span className="chat-new-chatter-label">New Chatter</span>
      )}
      {message.reply && (
        <button
          className="chat-reply-parent"
          onClick={() => onOpenThread(message)}
          title={message.reply.parentMessageBody}
          type="button"
        >
          Replying to {message.reply.parentDisplayName || message.reply.parentUserLogin}:{" "}
          {message.reply.parentMessageBody}
        </button>
      )}
      {showTimestamp && (
        <time
          className="chat-timestamp"
          dateTime={new Date(message.sentAt).toISOString()}
        >
          {formatChatTimestamp(message.sentAt)}
        </time>
      )}
      {message.badgeAssets && message.badgeAssets.length > 0 ? (
        <span className="native-chat-badges">
          {message.badgeAssets.slice(0, 4).map((badge) => (
            <ChatBadge badge={badge} key={badge.key} />
          ))}
        </span>
      ) : (
        message.badges.length > 0 && (
          <span className="native-chat-badges" title={message.badges.join(", ")}>
            {message.badges.slice(0, 4).map((badgeKey) => {
              const badge = badges.get(badgeKey);
              return badge ? <ChatBadge badge={badge} key={badgeKey} /> : null;
            })}
          </span>
        )
      )}
      <button
        className="chat-username"
        onClick={(event) => onOpenUser(message, event.currentTarget.getBoundingClientRect())}
        style={{
          color: readableUsernameColor(
            message.color,
            oledMode ? "#000000" : "#18181b",
          ),
        }}
        type="button"
      >
        {message.displayName}
      </button>
      {message.action ? " " : <><span className="chat-colon">:</span>{" "}</>}
      <span
        className="native-chat-text"
        style={
          message.action
            ? {
                color: readableUsernameColor(
                  message.color,
                  oledMode ? "#000000" : "#18181b",
                ),
              }
            : undefined
        }
      >
        {message.deleted && deletedMessageStyle === "placeholder" && !deletedRevealed ? (
          <button
            className="deleted-message-toggle"
            onClick={() => onRevealDeleted(message.id)}
            title="Show the deleted message locally"
            type="button"
          >
            &lt;{formatModerationAction(message)}&gt;
          </button>
        ) : (
          <>
            <span className={message.deleted ? "deleted-original-content" : undefined}>
              {renderChatMessageText(message, providerEmotes)}
            </span>
            {message.deleted && deletedMessageStyle === "dimmed" && (
              <span className="moderation-reason">
                {" "}({formatModerationAction(message)})
              </span>
            )}
          </>
        )}
      </span>
      {!message.deleted && (
        <button
          aria-label={`Reply to ${message.displayName}`}
          className="chat-message-reply"
          onClick={() => onReply(message)}
          title={`Reply to ${message.displayName}`}
          type="button"
        >
          <Reply size={14} />
        </button>
      )}
    </div>
  );
});
