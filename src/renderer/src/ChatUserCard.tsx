import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ExternalLink, MessageSquare, X } from "lucide-react";
import type { ChatBadgeAsset, ChatMessage } from "../../shared/chat";
import type { ChatUserProfile } from "../../shared/twitch";
import { channelUrl, parseChannelKey } from "../../shared/platform";
import { ChatBadge } from "./ChatBadge";
import "./chat-user-card.css";

// Memoized so an open card doesn't re-tokenize every retained message each
// time the parent re-renders (the chat batch fires ~10x/second). A row's
// content is immutable once shown, so identity-stable props never re-render it.
const UserCardMessage = memo(function UserCardMessage({
  message,
  renderText,
}: {
  message: ChatMessage;
  renderText: (message: ChatMessage) => ReactNode;
}) {
  return (
    <article>
      <time>
        {new Date(message.sentAt).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })}
      </time>
      <div>{renderText(message)}</div>
    </article>
  );
});

interface ChatUserCardProps {
  /**
   * The document to open in. Chat can be rendered into a window of its own,
   * and a card that puts itself in this window is left behind on the wrong
   * screen, measured against the wrong viewport.
   */
  root?: Document;
  anchor?: DOMRect;
  badges: Map<string, ChatBadgeAsset>;
  channel: string;
  messages: ChatMessage[];
  onClose: () => void;
  renderText: (message: ChatMessage) => ReactNode;
  selected: ChatMessage;
}

interface CardPosition {
  left: number;
  top: number;
}

function clampCardPosition(
  position: CardPosition,
  width: number,
  height: number,
): CardPosition {
  const margin = 8;
  const left = Math.max(
    margin,
    Math.min(Math.max(margin, window.innerWidth - width - margin), position.left),
  );
  const top = Math.max(
    margin,
    Math.min(Math.max(margin, window.innerHeight - height - margin), position.top),
  );
  return left === position.left && top === position.top
    ? position
    : { left, top };
}

function formatDate(value: string | undefined): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : date.toLocaleDateString([], {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

function badgeSubscriptionLabel(badgeKeys: string[]): string | null {
  const founder = badgeKeys.find((key) => key.startsWith("founder/"));
  if (founder) return "Founder";
  const subscriber = badgeKeys.find((key) => key.startsWith("subscriber/"));
  if (!subscriber) return null;
  const months = Number(subscriber.split("/")[1]);
  return Number.isFinite(months) && months > 0 ? `Subscriber badge (${months}+ months)` : "Subscriber";
}

function tierLabel(tier: string | undefined): string {
  if (tier === "3000" || tier === "3") return "Tier 3";
  if (tier === "2000" || tier === "2") return "Tier 2";
  return "Tier 1";
}

export function ChatUserCard({
  anchor,
  badges,
  channel,
  messages,
  onClose,
  renderText,
  root = document,
  selected,
}: ChatUserCardProps) {
  // The window the card opens in, so it is measured against that viewport.
  const view = root.defaultView ?? window;
  const [profile, setProfile] = useState<ChatUserProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<CardPosition | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  const dragOffset = useRef<{ x: number; y: number } | null>(null);
  const messagesHost = useRef<HTMLDivElement>(null);
  // Newest messages sit at the bottom; open there and stay pinned while the
  // reader hasn't scrolled up into the history.
  const stickToNewest = useRef(true);
  const userMessages = useMemo(
    () => messages.filter((message) => message.login.toLowerCase() === selected.login.toLowerCase()).slice(-40),
    [messages, selected.login],
  );
  const badgeKeys = useMemo(
    () => [...new Set([...selected.badges, ...userMessages.flatMap((message) => message.badges)])],
    [selected.badges, userMessages],
  );
  const badgeAssets = useMemo(() => {
    const assets = new Map<string, ChatBadgeAsset>();
    for (const asset of [
      ...(selected.badgeAssets ?? []),
      ...userMessages.flatMap((message) => message.badgeAssets ?? []),
    ]) {
      assets.set(asset.key, asset);
    }
    return [...assets.values()];
  }, [selected.badgeAssets, userMessages]);
  const badgeSubscription = badgeSubscriptionLabel(badgeKeys);
  const target = useMemo(() => parseChannelKey(channel), [channel]);

  useEffect(() => {
    let cancelled = false;
    const request =
      target.platform === "kick"
        ? window.desktop.kick.getChatUserProfile(target.login, selected.login)
        : window.desktop.twitch.getChatUserProfile(target.login, selected.login);
    void request
      .then((value) => {
        if (!cancelled) setProfile(value);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Profile details unavailable.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected.login, target.login, target.platform]);

  useLayoutEffect(() => {
    const host = messagesHost.current;
    if (host && stickToNewest.current) host.scrollTop = host.scrollHeight;
  }, [userMessages]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    view.addEventListener("keydown", closeOnEscape);
    return () => view.removeEventListener("keydown", closeOnEscape);
  }, [onClose, view]);

  useLayoutEffect(() => {
    if (!anchor || !cardRef.current) return;
    const card = cardRef.current;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const margin = 8;
    let left = anchor.right + 10;
    if (left + width > view.innerWidth - margin) left = anchor.left - width - 10;
    left = Math.max(margin, Math.min(view.innerWidth - width - margin, left));
    const top = Math.max(
      margin,
      Math.min(view.innerHeight - height - margin, anchor.top - 8),
    );
    setPosition({ left, top });
  }, [anchor, selected.login, view]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    setPosition((current) =>
      current
        ? clampCardPosition(current, card.offsetWidth, card.offsetHeight)
        : current,
    );
  }, [error, profile]);

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const keepCardOnScreen = () => {
      setPosition((current) =>
        current
          ? clampCardPosition(current, card.offsetWidth, card.offsetHeight)
          : current,
      );
    };
    const observer = new ResizeObserver(keepCardOnScreen);
    observer.observe(card);
    view.addEventListener("resize", keepCardOnScreen);
    return () => {
      observer.disconnect();
      view.removeEventListener("resize", keepCardOnScreen);
    };
  }, [view]);

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && typeof target.nodeType === "number" && !cardRef.current?.contains(target)) {
        onClose();
      }
    };
    const moveCard = (event: PointerEvent) => {
      const offset = dragOffset.current;
      const card = cardRef.current;
      if (!offset || !card) return;
      const width = card.offsetWidth;
      const height = card.offsetHeight;
      setPosition(
        clampCardPosition(
          { left: event.clientX - offset.x, top: event.clientY - offset.y },
          width,
          height,
        ),
      );
    };
    const stopDrag = () => {
      dragOffset.current = null;
    };
    view.addEventListener("pointerdown", closeOnOutsidePointer);
    view.addEventListener("pointermove", moveCard);
    view.addEventListener("pointerup", stopDrag);
    return () => {
      view.removeEventListener("pointerdown", closeOnOutsidePointer);
      view.removeEventListener("pointermove", moveCard);
      view.removeEventListener("pointerup", stopDrag);
    };
  }, [onClose, view]);

  const ivrSubscription = profile?.subage?.subscription;
  const subscription = profile?.relationship?.subscription;
  const subscriptionText = ivrSubscription
    ? ivrSubscription.isHidden
      ? "Subscription status hidden"
      : ivrSubscription.isSubscribed
        ? `${tierLabel(ivrSubscription.tier)} · ${ivrSubscription.cumulativeMonths} months`
        : ivrSubscription.cumulativeMonths > 0
          ? `Previously subscribed · ${ivrSubscription.cumulativeMonths} months`
          : "Not subscribed"
    : subscription
      ? subscription.isSubscribed
        ? `${tierLabel(subscription.tier)}${subscription.isGift ? " (gifted)" : ""}`
        : "Not subscribed"
      : (badgeSubscription ?? "Unavailable");

  const beginDrag = (event: React.PointerEvent<HTMLElement>) => {
    const pressed = event.target as Element | null;
    // Not `instanceof`: failing this in the chat window started a drag on every
    // button, which then swallowed the click that should have followed.
    const onButton = pressed?.nodeType === 1 && pressed.closest("button") !== null;
    if (event.button !== 0 || onButton) return;
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    dragOffset.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    setPosition({ left: rect.left, top: rect.top });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  return createPortal(
    <section
      aria-label={`${selected.displayName} profile`}
      className={`chat-user-card${position ? " positioned" : ""}`}
      ref={cardRef}
      style={position ?? undefined}
    >
        <header onPointerDown={beginDrag}>
          {profile?.profileImageUrl ? (
            <img alt="" className="chat-user-avatar" src={profile.profileImageUrl} />
          ) : (
            <span className="chat-user-avatar fallback">{selected.displayName.slice(0, 1).toUpperCase()}</span>
          )}
          <div>
            <strong style={{ color: selected.color || undefined }}>
              {profile?.displayName ?? selected.displayName}
            </strong>
            <small>@{profile?.login ?? selected.login}</small>
          </div>
          <button
            aria-label={`Open ${target.platform === "kick" ? "Kick" : "Twitch"} profile`}
            onClick={() =>
              window.desktop.system.openExternal(
                channelUrl(target.platform, selected.login),
              )
            }
            title={`Open ${target.platform === "kick" ? "Kick" : "Twitch"} profile`}
            type="button"
          >
            <ExternalLink size={16} />
          </button>
          <button aria-label="Close user card" onClick={onClose} title="Close" type="button">
            <X size={17} />
          </button>
        </header>

        {profile?.description && <p className="chat-user-description">{profile.description}</p>}

        <div className="chat-user-badges">
          {badgeAssets.map((badge) => (
            <ChatBadge badge={badge} key={badge.key} />
          ))}
          {badgeKeys.map((badgeKey) => {
            const badge = badges.get(badgeKey);
            return badge ? <ChatBadge badge={badge} key={badgeKey} /> : null;
          })}
        </div>

        <dl>
          <div>
            <dt>Account created</dt>
            <dd>{profile ? formatDate(profile.createdAt) : error ? "Unavailable" : "Loading…"}</dd>
          </div>
          <div>
            <dt>Following since</dt>
            <dd>
              {profile?.subage
                ? profile.subage.followingSince
                  ? formatDate(profile.subage.followingSince)
                  : "Not following"
                : profile?.relationship
                  ? profile.relationship.isFollowing
                    ? formatDate(profile.relationship.followedAt)
                    : "Not following"
                : profile
                  ? "Unavailable"
                  : error
                    ? "Unavailable"
                    : "Loading…"}
            </dd>
          </div>
          <div>
            <dt>Subscription</dt>
            <dd>{profile ? subscriptionText : (badgeSubscription ?? (error ? "Unavailable" : "Loading…"))}</dd>
          </div>
        </dl>

        {error && <p className="chat-user-error">{error}</p>}

        <div className="chat-user-message-heading">
          <span>
            <MessageSquare size={14} /> Messages in current chat
          </span>
          <small>{userMessages.length}</small>
        </div>
        <div
          className="chat-user-messages"
          onScroll={() => {
            const host = messagesHost.current;
            if (!host) return;
            stickToNewest.current =
              host.scrollHeight - host.scrollTop - host.clientHeight < 24;
          }}
          ref={messagesHost}
        >
          {userMessages.length === 0 ? (
            <p>No retained messages.</p>
          ) : (
            userMessages.map((message) => (
              <UserCardMessage key={message.id} message={message} renderText={renderText} />
            ))
          )}
        </div>
    </section>,
    root.body,
  );
}
