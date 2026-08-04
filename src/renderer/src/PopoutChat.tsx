import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppPreferences } from "../../shared/preferences";
import type { ChatBadgeAsset, ChatMessage } from "../../shared/chat";
import { messageMentionsLogin } from "../../shared/chat";
import type { ProviderEmote } from "../../shared/emotes";
import { ChatMessageRow } from "./ChatMessageRow";
import { useChatFeed } from "./chat-feed";

/**
 * Chat on its own, in its own window. It renders the same message rows the
 * docked panel does and reads the same event stream, so what is said here is
 * what is said there; what it deliberately does not carry is everything tied to
 * the player, which stays in the main window.
 */
export function PopoutChat() {
  const [channel, setChannel] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<AppPreferences | null>(null);
  const [viewerLogin, setViewerLogin] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const composerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void window.desktop.chat.getActiveChannel().then(setChannel);
    return window.desktop.chat.onActiveChannel(setChannel);
  }, []);

  useEffect(() => {
    void window.desktop.preferences.getOrMigrate().then(setPreferences);
    return window.desktop.preferences.onChanged(setPreferences);
  }, []);

  useEffect(() => {
    void window.desktop.twitch
      .getAuthState()
      .then((state) => setViewerLogin(state.account?.login ?? ""))
      .catch(() => undefined);
  }, []);

  const {
    messages,
    autoScroll,
    pausedNewCount,
    revealedDeleted,
    messagesHostRef,
    handleScroll,
    handleWheel,
    handlePointerDown,
    scrollToCurrent,
    revealDeleted,
  } = useChatFeed(channel);

  const badges = useMemo(() => new Map<string, ChatBadgeAsset>(), []);
  const providerEmotes = useMemo(() => new Map<string, ProviderEmote>(), []);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || !channel || sending) return;
    setSending(true);
    try {
      await window.desktop.chat.send(channel, text);
      setDraft("");
    } catch {
      // The message stays in the box so it can be sent again.
    } finally {
      setSending(false);
      composerRef.current?.focus();
    }
  }, [channel, draft, sending]);

  const noop = useCallback(() => undefined, []);

  if (!channel) {
    return (
      <div className="popout-chat">
        <div className="chat-empty-state">Open a stream to see its chat.</div>
      </div>
    );
  }

  return (
    <div className="popout-chat">
      <div
        className="popout-chat-messages"
        onPointerDown={handlePointerDown}
        onScroll={handleScroll}
        onWheel={handleWheel}
        ref={messagesHostRef}
      >
        {messages.map((message: ChatMessage) => (
          <ChatMessageRow
            badges={badges}
            deletedMessageStyle={preferences?.chatDeletedMessageStyle ?? "dimmed"}
            deletedRevealed={revealedDeleted.has(message.id)}
            key={message.id}
            mentioned={
              viewerLogin.length > 0 && messageMentionsLogin(message, viewerLogin)
            }
            message={message}
            oledMode={preferences?.oledMode ?? false}
            onOpenThread={noop}
            onOpenUser={noop}
            onReply={noop}
            onRevealDeleted={revealDeleted}
            providerEmotes={providerEmotes}
            showTimestamp={preferences?.chatTimestamps ?? false}
          />
        ))}
      </div>
      {!autoScroll && (
        <button
          className="popout-chat-resume"
          onClick={scrollToCurrent}
          type="button"
        >
          {pausedNewCount > 0
            ? `${pausedNewCount} new message${pausedNewCount === 1 ? "" : "s"}`
            : "Back to live"}
        </button>
      )}
      <form
        className="popout-chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <input
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Send a message"
          ref={composerRef}
          value={draft}
        />
        <button disabled={sending || draft.trim().length === 0} type="submit">
          Chat
        </button>
      </form>
    </div>
  );
}
