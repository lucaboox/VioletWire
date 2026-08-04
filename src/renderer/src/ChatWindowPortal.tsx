import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/** Renders `children` into the chat window when there is one, or in place. */
export function ChatWindowPortal({
  target,
  children,
}: {
  target: Window | null;
  children: ReactNode;
}) {
  if (!target || target.closed) return <>{children}</>;
  return createPortal(children, target.document.body);
}
