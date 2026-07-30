import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../shared/chat";
import { parseChannelKey } from "../../shared/platform";
import {
  cleanChatSendError,
  isTwitchDuplicateMessageError,
  makeTwitchMessageDistinct,
} from "./chat-send-errors";

export interface ChatSendStatus {
  kind: "queued" | "error";
  message: string;
}

interface OutgoingChat {
  channel: string;
  message: string;
  originalMessage?: string;
  reply?: ChatMessage;
}

/**
 * Keeps slow-mode timing beside the composer instead of surfacing expected
 * chat rejections as application-wide errors. One pending message is allowed:
 * silently building a large queue would be surprising if the viewer changes
 * channels or the room changes modes.
 */
export function useChatSendQueue(
  channel: string | null,
  slowModeSeconds: number | undefined,
  restore: (message: string, reply?: ChatMessage) => void,
) {
  const [status, setStatus] = useState<ChatSendStatus | null>(null);
  const lastSentAt = useRef(0);
  const queued = useRef<OutgoingChat | null>(null);
  const queueTimer = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (queueTimer.current !== null) {
      window.clearTimeout(queueTimer.current);
      queueTimer.current = null;
    }
  }, []);

  const performSend = useCallback(
    async function sendOutgoing(outgoing: OutgoingChat, allowRetry = true) {
      try {
        await window.desktop.chat.send(
          outgoing.channel,
          outgoing.message,
          outgoing.reply?.id,
        );
        lastSentAt.current = Date.now();
        setStatus(null);
      } catch (reason) {
        const message = cleanChatSendError(reason);
        if (
          allowRetry &&
          parseChannelKey(outgoing.channel).platform === "twitch" &&
          isTwitchDuplicateMessageError(message)
        ) {
          const distinctMessage = makeTwitchMessageDistinct(outgoing.message);
          if (distinctMessage !== null) {
            await sendOutgoing(
              {
                ...outgoing,
                message: distinctMessage,
                originalMessage: outgoing.originalMessage ?? outgoing.message,
              },
              false,
            );
            return;
          }
        }
        if (
          allowRetry &&
          /(too (?:quickly|fast)|slow.?mode|rate.?limit|wait\s+\d+)/i.test(message)
        ) {
          const secondsInMessage = /(\d+(?:\.\d+)?)\s*(?:s|sec|second)/i.exec(message);
          const delay = Math.max(
            1_000,
            secondsInMessage
              ? Number(secondsInMessage[1]) * 1_000
              : Math.max(1, slowModeSeconds ?? 1) * 1_000,
          );
          queued.current = outgoing;
          setStatus({
            kind: "queued",
            message: `Rate limited · retrying in ${Math.ceil(delay / 1_000)}s`,
          });
          queueTimer.current = window.setTimeout(() => {
            queueTimer.current = null;
            const pending = queued.current;
            queued.current = null;
            if (pending) void sendOutgoing(pending, false);
          }, delay);
          return;
        }
        restore(outgoing.originalMessage ?? outgoing.message, outgoing.reply);
        setStatus({
          kind: "error",
          message,
        });
      }
    },
    [restore, slowModeSeconds],
  );

  const send = useCallback(
    async (message: string, reply?: ChatMessage): Promise<boolean> => {
      if (!channel) return false;
      const outgoing = { channel, message, reply };
      if (queued.current !== null) {
        restore(message, reply);
        setStatus({
          kind: "error",
          message: "One message is already queued for chat.",
        });
        return false;
      }
      const interval = Math.max(0, slowModeSeconds ?? 0) * 1_000;
      const remaining = Math.max(0, lastSentAt.current + interval - Date.now());

      if (remaining <= 50) {
        setStatus(null);
        await performSend(outgoing);
        return true;
      }
      queued.current = outgoing;
      setStatus({
        kind: "queued",
        message: `Queued for slow mode · sending in ${Math.max(1, Math.ceil(remaining / 1_000))}s`,
      });
      queueTimer.current = window.setTimeout(() => {
        queueTimer.current = null;
        const pending = queued.current;
        queued.current = null;
        if (pending) void performSend(pending);
      }, remaining);
      return true;
    },
    [channel, performSend, restore, slowModeSeconds],
  );

  const showError = useCallback((message: string) => {
    setStatus({ kind: "error", message });
  }, []);

  useEffect(() => {
    setStatus(null);
    lastSentAt.current = 0;
    return () => {
      clearTimer();
      queued.current = null;
    };
  }, [channel, clearTimer]);

  return {
    dismiss: () => setStatus(null),
    send,
    showError,
    status,
  };
}
