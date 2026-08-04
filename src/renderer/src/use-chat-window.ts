import { useCallback, useEffect, useState } from "react";

/**
 * A window for chat to be rendered into.
 *
 * Chat is not reimplemented there — the panel stays where it is in the
 * component tree and is portalled into this window's document, so it is the
 * same component instance with the same history, scroll position, and every
 * feature it has here. Moving it out is also what hides it in the main window.
 */

export const CHAT_WINDOW_NAME = "violetwire-chat";

/** Copies the app's styles in, so chat looks the same in the new document. */
function adoptStyles(target: Window): void {
  for (const node of document.querySelectorAll('style, link[rel="stylesheet"]')) {
    target.document.head.append(node.cloneNode(true));
  }
  // Vite adds styles as it reloads during development; keep the copy in step.
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (
          node instanceof HTMLStyleElement ||
          (node instanceof HTMLLinkElement && node.rel === "stylesheet")
        ) {
          target.document.head.append(node.cloneNode(true));
        }
      }
    }
  });
  observer.observe(document.head, { childList: true });
  target.addEventListener("pagehide", () => observer.disconnect());
}

export interface ChatWindow {
  /** The window chat is showing in, or null while it is docked. */
  target: Window | null;
  open: () => void;
  close: () => void;
}

export function useChatWindow(): ChatWindow {
  const [target, setTarget] = useState<Window | null>(null);

  const open = useCallback(() => {
    setTarget((current) => {
      if (current && !current.closed) {
        current.focus();
        return current;
      }
      const opened = window.open("", CHAT_WINDOW_NAME, "width=420,height=720");
      if (!opened) return current;
      opened.document.title = "VioletWire Chat";
      opened.document.documentElement.className = "chat-window-root";
      opened.document.body.className = "chat-window-body";
      adoptStyles(opened);
      return opened;
    });
  }, []);

  const close = useCallback(() => {
    setTarget((current) => {
      current?.close();
      return current;
    });
  }, []);

  useEffect(() => {
    if (!target) return;
    // Closing the window is how chat docks again, including when it is closed
    // from its own title bar rather than from the app.
    const handleClosed = () => setTarget(null);
    target.addEventListener("pagehide", handleClosed);
    // A window closed by the operating system fires nothing dependable, so the
    // state is polled as well.
    const poll = window.setInterval(() => {
      if (target.closed) setTarget(null);
    }, 500);
    // The window belongs to this one, so leaving should not strand it.
    const closeOnUnload = () => target.close();
    window.addEventListener("pagehide", closeOnUnload);
    return () => {
      target.removeEventListener("pagehide", handleClosed);
      window.removeEventListener("pagehide", closeOnUnload);
      window.clearInterval(poll);
    };
  }, [target]);

  return { target, open, close };
}
