import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Renders `children` into the chat window when there is one, or in place.
 *
 * Theme classes live on the app shell, which the panel is no longer inside once
 * it is portalled, so they are carried across on a wrapper of its own rather
 * than by reaching into the other document and setting them there.
 */
export function ChatWindowPortal({
  target,
  className,
  children,
}: {
  target: Window | null;
  className: string;
  children: ReactNode;
}) {
  if (!target || target.closed) return <>{children}</>;
  return createPortal(
    <div className={className}>{children}</div>,
    target.document.body,
  );
}
