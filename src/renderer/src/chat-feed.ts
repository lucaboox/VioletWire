import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import type { ChatMessage } from "../../shared/chat";
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

export interface ChatFeed {
  messages: ChatMessage[];
  autoScroll: boolean;
  /** New non-deleted messages that arrived while the reader was scrolled up. */
  pausedNewCount: number;
  revealedDeleted: Set<string>;
  messagesHostRef: RefObject<HTMLDivElement | null>;
  /** Mirrors `autoScroll` synchronously for scroll-time reads outside render. */
  autoScrollRef: MutableRefObject<boolean>;
  handleScroll: () => void;
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
export function useChatFeed(onIncoming?: (message: ChatMessage) => void): ChatFeed {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [pausedNewCount, setPausedNewCount] = useState(0);
  const [revealedDeleted, setRevealedDeleted] = useState<Set<string>>(new Set());

  const messagesHostRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const scrollAnchor = useRef<ChatScrollAnchor | null>(null);
  const lastScrollTop = useRef(0);
  const batch = useRef<ChatMessage[]>([]);
  const batchTimer = useRef<number | null>(null);
  const onIncomingRef = useRef(onIncoming);
  useEffect(() => {
    onIncomingRef.current = onIncoming;
  }, [onIncoming]);

  const flushBatch = useCallback(() => {
    if (batchTimer.current !== null) {
      window.clearTimeout(batchTimer.current);
      batchTimer.current = null;
    }
    const pending = batch.current;
    if (pending.length === 0) return;
    batch.current = [];
    const paused = !autoScrollRef.current;
    if (paused) {
      const newMessageCount = pending.filter(
        (message) => !message.historical && !message.deleted,
      ).length;
      if (newMessageCount > 0) {
        setPausedNewCount((current) => Math.min(999, current + newMessageCount));
      }
      // Appends below the reader never move their view; the anchor only
      // matters for the rare hard-limit trim and deletion height changes.
      if (messagesHostRef.current) {
        scrollAnchor.current = captureChatScrollAnchor(messagesHostRef.current);
      }
    }
    setMessages((current) => {
      let next = applyChatMessageBatch(current, pending, Number.POSITIVE_INFINITY);
      if (paused) {
        if (next.length > CHAT_PAUSED_HARD_LIMIT) next = next.slice(-CHAT_PAUSED_TRIM_TO);
      } else if (next.length > CHAT_MESSAGE_LIMIT) {
        next = next.slice(-CHAT_MESSAGE_LIMIT);
      }
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
    setMessages((current) =>
      current.length > CHAT_MESSAGE_LIMIT ? current.slice(-CHAT_MESSAGE_LIMIT) : current,
    );
    setPausedNewCount(0);
  }, [flushBatch]);

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
    if (host.scrollTop < previousTop - SCROLL_PAUSE_SLACK) {
      autoScrollRef.current = false;
      setAutoScroll(false);
    }
  }, [resumeLive]);

  const scrollToCurrent = useCallback(() => {
    const host = messagesHostRef.current;
    if (!host) return;
    autoScrollRef.current = true;
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
    autoScrollRef.current = true;
    setMessages([]);
    setRevealedDeleted(new Set());
    setAutoScroll(true);
    setPausedNewCount(0);
  }, []);

  return {
    messages,
    autoScroll,
    pausedNewCount,
    revealedDeleted,
    messagesHostRef,
    autoScrollRef,
    handleScroll,
    scrollToCurrent,
    revealDeleted,
    reset,
  };
}
