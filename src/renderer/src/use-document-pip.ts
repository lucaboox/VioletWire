import { useCallback, useEffect, useState } from "react";

/**
 * Picture in picture built from the app's own markup.
 *
 * Chromium's ordinary picture in picture takes the video element and draws its
 * own controls over it, which cannot be styled and which name the origin the
 * video came from. A document picture-in-picture window is an empty window this
 * page fills instead, so the player that goes into it is the player, with the
 * app's own controls, and the same video element keeps playing — it is moved,
 * not opened a second time.
 */

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  window: Window | null;
}

function api(): DocumentPictureInPicture | null {
  const value = (window as unknown as { documentPictureInPicture?: DocumentPictureInPicture })
    .documentPictureInPicture;
  return value ?? null;
}

/** Copies the app's styles in, so the player looks the same in its own window. */
function adoptStyles(target: Window): void {
  const base = target.document.createElement("base");
  base.href = document.baseURI;
  target.document.head.append(base);
  for (const node of document.querySelectorAll('style, link[rel="stylesheet"]')) {
    target.document.head.append(node.cloneNode(true));
  }
}

export interface DocumentPip {
  /** The window the player is showing in, or null while it is in the app. */
  target: Window | null;
  supported: boolean;
  /** Resolves false when the window could not be opened, so a caller can fall back. */
  open: (size?: { width: number; height: number }) => Promise<boolean>;
  close: () => void;
}

export function useDocumentPip(): DocumentPip {
  const [target, setTarget] = useState<Window | null>(null);
  const supported = api() !== null;

  const open = useCallback(async (size?: { width: number; height: number }) => {
    const available = api();
    if (!available) return false;
    if (available.window && !available.window.closed) {
      available.window.focus();
      return true;
    }
    let opened: Window;
    try {
      opened = await available.requestWindow({
        width: Math.round(size?.width ?? 640),
        height: Math.round(size?.height ?? 360),
      });
    } catch (error) {
      // Refused, most often because the request did not come from something the
      // reader did. Saying so beats a button that appears to do nothing.
      console.warn("Could not open the picture-in-picture window", error);
      return false;
    }
    opened.document.documentElement.className = "pip-window-root";
    opened.document.body.className = "pip-window-body";
    adoptStyles(opened);
    setTarget(opened);
    return true;
  }, []);

  const close = useCallback(() => {
    setTarget((current) => {
      current?.close();
      return current;
    });
  }, []);

  useEffect(() => {
    if (!target) return;
    // Closing the window is what puts the player back, including when it is
    // closed from its own controls rather than from the app.
    const handleClosed = () => setTarget(null);
    target.addEventListener("pagehide", handleClosed);
    const poll = window.setInterval(() => {
      if (target.closed) setTarget(null);
    }, 500);
    const closeOnUnload = () => target.close();
    window.addEventListener("pagehide", closeOnUnload);
    return () => {
      target.removeEventListener("pagehide", handleClosed);
      window.removeEventListener("pagehide", closeOnUnload);
      window.clearInterval(poll);
    };
  }, [target]);

  return { target, supported, open, close };
}
