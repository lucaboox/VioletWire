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

export function ChatUserCard({ anchor, badges, channel, messages, onClose, renderText, selected }: ChatUserCardProps) {
  const [profile, setProfile] = useState<ChatUserProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<CardPosition | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  const dragOffset = useRef<{ x: number; y: number } | null>(null);
  const userMessages = useMemo(
    () => messages.filter((message) => message.login.toLowerCase() === selected.login.toLowerCase()).slice(-40),
    [messages, selected.login],
  );
  const badgeKeys = useMemo(
    () => [...new Set([...selected.badges, ...userMessages.flatMap((message) => message.badges)])],
    [selected.badges, userMessages],
  );
  const badgeSubscription = badgeSubscriptionLabel(badgeKeys);

  useEffect(() => {
    let cancelled = false;
    void window.desktop.twitch
      .getChatUserProfile(channel, selected.login)
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
  }, [channel, selected.login]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  useLayoutEffect(() => {
    if (!anchor || !cardRef.current) return;
    const card = cardRef.current;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const margin = 8;
    let left = anchor.right + 10;
    if (left + width > window.innerWidth - margin) left = anchor.left - width - 10;
    left = Math.max(margin, Math.min(window.innerWidth - width - margin, left));
    const top = Math.max(
      margin,
      Math.min(window.innerHeight - height - margin, anchor.top - 8),
    );
    setPosition({ left, top });
  }, [anchor, selected.login]);

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
    window.addEventListener("resize", keepCardOnScreen);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", keepCardOnScreen);
    };
  }, []);

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !cardRef.current?.contains(event.target)) onClose();
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
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("pointermove", moveCard);
    window.addEventListener("pointerup", stopDrag);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("pointermove", moveCard);
      window.removeEventListener("pointerup", stopDrag);
    };
  }, [onClose]);

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
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button"))) return;
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
            aria-label="Open Twitch profile"
            onClick={() =>
              window.desktop.system.openExternal(`https://www.twitch.tv/${encodeURIComponent(selected.login)}`)
            }
            title="Open Twitch profile"
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
        <div className="chat-user-messages">
          {userMessages.length === 0 ? (
            <p>No retained messages.</p>
          ) : (
            userMessages.map((message) => (
              <UserCardMessage key={message.id} message={message} renderText={renderText} />
            ))
          )}
        </div>
    </section>,
    document.body,
  );
}
