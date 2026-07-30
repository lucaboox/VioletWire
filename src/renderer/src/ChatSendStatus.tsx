import { AlertCircle, Clock3, X } from "lucide-react";
import type { ChatSendStatus as ChatSendStatusValue } from "./use-chat-send-queue";

export function ChatSendStatus({
  onDismiss,
  status,
}: {
  onDismiss: () => void;
  status: ChatSendStatusValue | null;
}) {
  if (!status) return null;
  const Icon = status.kind === "queued" ? Clock3 : AlertCircle;
  return (
    <div className={`chat-send-status ${status.kind}`} role="status">
      <Icon aria-hidden="true" size={13} />
      <span>{status.message}</span>
      <button aria-label="Dismiss chat status" onClick={onDismiss} type="button">
        <X aria-hidden="true" size={12} />
      </button>
    </div>
  );
}
