import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import type { ChatMessage } from "../../shared/chat";
import {
  RecentChatterIndex,
  type ChatMentionCandidate,
} from "../../shared/chat-content";
import {
  applyChatMessageBatch,
  CHAT_MESSAGE_LIMIT,
  CHAT_PAUSED_HARD_LIMIT,
  CHAT_PAUSED_TRIM_TO,
} from "../../shared/chat-messages";
import {
  captureChatScrollAnchor,
  restoreChatScrollAnchor,
  type ChatScrollAnchor,
} from "./chat-scroll";

// Chat renders in batches: one commit per interval instead of per message.
const CHAT_BATCH_INTERVAL = 100;
// A user scrolling up moves scrollTop upward; every app-generated scroll event
// (jump-to-bottom, composer padding transition, image loads, smooth scroll)
// moves down or clamps. Only an upward move past this slack pauses auto-scroll.
const SCROLL_PAUSE_SLACK = 1;
// Treat "within this many px of the bottom" as live.
const LIVE_EDGE_THRESHOLD = 36;
// Pausing additionally requires user input this recent. Direction alone is
// not proof of intent: lazy emote images can push content below the fold
// without any scroll event, after which a reflow above the viewport
// legitimately moves scrollTop DOWN — upward-looking, ≥36px from the bottom,
// and entirely browser-generated. Machine speed decides whether the
// text-to-image gap is wide enough to hit, which is why it only reproduced
// on some machines. A wheel tick or a pointer press cannot be forged by
// layout, so requiring one makes phantom pauses structurally impossible.
const USER_SCROLL_INTENT_WINDOW = 600;
const RECENT_CHATTER_CHANNEL_LIMIT = 20;
const recentChattersByChannel = new Map<string, RecentChatterIndex>();

function channelChatterIndex(channel: string): RecentChatterIndex {
  const key = channel.trim().toLowerCase();
  const existing = recentChattersByChannel.get(key);
  if (existing) {
    // Refresh channel recency as well, bounding retained session data.
    recentChattersByChannel.delete(key);
    recentChattersByChannel.set(key, existing);
    return existing;
  }
  const created = new RecentChatterIndex();
  recentChattersByChannel.set(key, created);
  if (recentChattersByChannel.size > RECENT_CHATTER_CHANNEL_LIMIT) {
    const oldest = recentChattersByChannel.keys().next().value;
    if (oldest) recentChattersByChannel.delete(oldest);
  }
  return created;
}

export interface ChatFeed {
  messages: ChatMessage[];
  recentChatters: ChatMentionCandidate[];
  autoScroll: boolean;
  /** New non-deleted messages that arrived while the reader was scrolled up. */
  pausedNewCount: number;
  revealedDeleted: Set<string>;
  messagesHostRef: RefObject<HTMLDivElement | null>;
  /** Mirrors `autoScroll` synchronously for scroll-time reads outside render. */
  autoScrollRef: MutableRefObject<boolean>;
  handleScroll: () => void;
  /** Attach to the scroller's onWheel: records upward-scroll intent. */
  handleWheel: (event: { deltaY: number }) => void;
  /** Attach to the scroller's onPointerDown: covers scrollbar grabs/touch. */
  handlePointerDown: () => void;
  scrollToCurrent: () => void;
  revealDeleted: (id: string) => void;
  reset: () => void;
}

/**
 * Owns the entire live-chat feed engine shared by the side chat and the native
 * overlay chat: 100ms batching, scroll-driven pause/resume, scroll anchoring
 * while paused, the CHAT_MESSAGE_LIMIT / paused-overflow trimming rules, and
 * deleted-message reveal state. Both surfaces render their own markup but must
 * share this logic — every past paused-chat bug lived here and was previously
 * fixed twice.
 *
 * @param onIncoming Called for each raw incoming message before batching (used
 *   for mention alerts). Read through a ref so the subscription stays stable.
 */
export function useChatFeed(
  channel: string | null | undefined,
  onIncoming?: (message: ChatMessage) => void,
): ChatFeed {
  const channelKey = channel?.trim().toLowerCase() ?? "";
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [recentChatterState, setRecentChatterState] = useState<{
    channel: string;
    items: ChatMentionCandidate[];
  }>(() => ({
    channel: channelKey,
    items: channelKey
      ? (recentChattersByChannel.get(channelKey)?.allNewestFirst() ?? [])
      : [],
  }));
  const [autoScroll, setAutoScroll] = useState(true);
  const [pausedNewCount, setPausedNewCount] = useState(0);
  const [revealedDeleted, setRevealedDeleted] = useState<Set<string>>(new Set());

  const messagesHostRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const scrollAnchor = useRef<ChatScrollAnchor | null>(null);
  const lastScrollTop = useRef(0);
  const lastUserScrollIntentAt = useRef(0);
  const messageCount = useRef(0);
  const channelRef = useRef(channelKey);
  const recentChattersDirty = useRef(false);
  const batch = useRef<ChatMessage[]>([]);
  const batchTimer = useRef<number | null>(null);
  const onIncomingRef = useRef(onIncoming);
  useEffect(() => {
    onIncomingRef.current = onIncoming;
  }, [onIncoming]);
  useEffect(() => {
    channelRef.current = channelKey;
  }, [channelKey]);
  const recentChatters =
    recentChatterState.channel === channelKey
      ? recentChatterState.items
      : channelKey
        ? (recentChattersByChannel.get(channelKey)?.allNewestFirst() ?? [])
        : [];

  const flushBatch = useCallback(() => {
    if (batchTimer.current !== null) {
      window.clearTimeout(batchTimer.current);
      batchTimer.current = null;
    }
    const pending = batch.current;
    if (pending.length === 0) return;
    batch.current = [];
    if (recentChattersDirty.current) {
      recentChattersDirty.current = false;
      const key = channelRef.current;
      setRecentChatterState({
        channel: key,
        items: key ? channelChatterIndex(key).allNewestFirst() : [],
      });
    }
    const paused = !autoScrollRef.current;
    if (paused) {
      const newMessageCount = pending.filter(
        (message) => !message.historical && !message.deleted,
      ).length;
      if (newMessageCount > 0) {
        setPausedNewCount((current) => Math.min(999, current + newMessageCount));
      }
      // Plain live appends occur below the reader and do not need anchoring.
      // Restoring an anchor for every batch can fight a fast user scroll when
      // the pointer moves between capture and React's layout commit. Anchor
      // only operations that can alter content above the viewport.
      const mayChangeContentAbove =
        pending.some((message) => message.deleted || message.historical) ||
        messageCount.current + pending.length > CHAT_PAUSED_HARD_LIMIT;
      if (mayChangeContentAbove && messagesHostRef.current) {
        scrollAnchor.current = captureChatScrollAnchor(messagesHostRef.current);
      } else {
        scrollAnchor.current = null;
      }
    }
    setMessages((current) => {
      let next = applyChatMessageBatch(current, pending, Number.POSITIVE_INFINITY);
      if (paused) {
        if (next.length > CHAT_PAUSED_HARD_LIMIT) next = next.slice(-CHAT_PAUSED_TRIM_TO);
      } else if (next.length > CHAT_MESSAGE_LIMIT) {
        next = next.slice(-CHAT_MESSAGE_LIMIT);
      }
      messageCount.current = next.length;
      return next;
    });
  }, []);

  useEffect(() => {
    const removeListener = window.desktop.chat.onMessage((message) => {
      if (message.deleted) {
        setRevealedDeleted((revealed) => {
          if (!revealed.has(message.id)) return revealed;
          const next = new Set(revealed);
          next.delete(message.id);
          return next;
        });
      }
      if (!message.deleted && message.login) {
        const key = channelRef.current;
        if (key) {
          channelChatterIndex(key).add({
            color: message.color,
            displayName: message.displayName,
            login: message.login,
          });
          recentChattersDirty.current = true;
        }
      }
      onIncomingRef.current?.(message);
      batch.current.push(message);
      batchTimer.current ??= window.setTimeout(flushBatch, CHAT_BATCH_INTERVAL);
    });
    return () => {
      removeListener();
      if (batchTimer.current !== null) window.clearTimeout(batchTimer.current);
      batchTimer.current = null;
      batch.current = [];
    };
  }, [flushBatch]);

  useLayoutEffect(() => {
    const host = messagesHostRef.current;
    if (!host) return;
    if (autoScroll) {
      host.scrollTop = host.scrollHeight;
    } else if (scrollAnchor.current) {
      restoreChatScrollAnchor(host, scrollAnchor.current);
      scrollAnchor.current = null;
    }
  }, [autoScroll, messages]);

  const resumeLive = useCallback(() => {
    // Apply anything still buffered, then cut the paused overflow back to the
    // live cap; the reader is jumping to the bottom anyway.
    flushBatch();
    setMessages((current) => {
      const next =
        current.length > CHAT_MESSAGE_LIMIT
          ? current.slice(-CHAT_MESSAGE_LIMIT)
          : current;
      messageCount.current = next.length;
      return next;
    });
    setPausedNewCount(0);
  }, [flushBatch]);

  const handleWheel = useCallback((event: { deltaY: number }) => {
    if (event.deltaY < 0) lastUserScrollIntentAt.current = Date.now();
  }, []);

  const handlePointerDown = useCallback(() => {
    lastUserScrollIntentAt.current = Date.now();
  }, []);

  const handleScroll = useCallback(() => {
    const host = messagesHostRef.current;
    if (!host) return;
    const previousTop = lastScrollTop.current;
    lastScrollTop.current = host.scrollTop;
    const distanceFromBottom = host.scrollHeight - host.scrollTop - host.clientHeight;
    if (distanceFromBottom < LIVE_EDGE_THRESHOLD) {
      autoScrollRef.current = true;
      setAutoScroll(true);
      resumeLive();
      return;
    }
    // Pausing requires BOTH an upward movement and recent real user input
    // (wheel-up or a pointer press on the scroller). Browser layout can
    // legitimately move scrollTop down without any input — see the intent
    // window comment above — so direction alone is not proof of a scroll.
    if (
      host.scrollTop < previousTop - SCROLL_PAUSE_SLACK &&
      Date.now() - lastUserScrollIntentAt.current < USER_SCROLL_INTENT_WINDOW
    ) {
      autoScrollRef.current = false;
      setAutoScroll(false);
    }
  }, [resumeLive]);

  const scrollToCurrent = useCallback(() => {
    const host = messagesHostRef.current;
    if (!host) return;
    autoScrollRef.current = true;
    messageCount.current = 0;
    setAutoScroll(true);
    resumeLive();
    host.scrollTo({ top: host.scrollHeight, behavior: "smooth" });
  }, [resumeLive]);

  const revealDeleted = useCallback((id: string) => {
    setRevealedDeleted((revealed) => {
      const next = new Set(revealed);
      next.add(id);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    if (batchTimer.current !== null) window.clearTimeout(batchTimer.current);
    batchTimer.current = null;
    batch.current = [];
    scrollAnchor.current = null;
    lastScrollTop.current = 0;
    lastUserScrollIntentAt.current = 0;
    autoScrollRef.current = true;
    setMessages([]);
    setRevealedDeleted(new Set());
    setAutoScroll(true);
    setPausedNewCount(0);
  }, []);

  return {
    messages,
    recentChatters,
    autoScroll,
    pausedNewCount,
    revealedDeleted,
    messagesHostRef,
    autoScrollRef,
    handleScroll,
    handleWheel,
    handlePointerDown,
    scrollToCurrent,
    revealDeleted,
    reset,
  };
}
