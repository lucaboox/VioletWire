import { useEffect, useRef, useState } from "react";
import { MonitorSpeaker } from "lucide-react";
import type { ChatWindowDisplay } from "../../shared/chat";

/**
 * Stands the chat window against the side of a display the reader picks.
 *
 * The screens are drawn the same size as each other and in the order they are
 * arranged, left to right. Drawing them to their real proportions was worse to
 * read and no more useful — what is being picked is a screen and a side of it,
 * not a place measured out on the desk.
 */
export function ChatWindowPlacer() {
  const [open, setOpen] = useState(false);
  const [displays, setDisplays] = useState<ChatWindowDisplay[]>([]);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void window.desktop.chat.getDisplays().then(setDisplays);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      // Not `instanceof`: this listens on the chat window's document, and what
      // that window builds is not built from this window's constructors.
      const target = event.target as Node | null;
      if (!target || typeof target.nodeType !== "number") return;
      if (anchorRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    // The panel lives in the chat window, so its own document is the one that
    // hears these rather than the main window's.
    const scope = anchorRef.current?.ownerDocument ?? document;
    scope.addEventListener("pointerdown", closeOnOutside);
    scope.addEventListener("keydown", closeOnEscape);
    return () => {
      scope.removeEventListener("pointerdown", closeOnOutside);
      scope.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const ordered = [...displays].sort(
    (left, right) => left.bounds.x - right.bounds.x || left.bounds.y - right.bounds.y,
  );

  const place = (displayId: number, side: "left" | "right") => {
    void window.desktop.chat.placeWindow(displayId, side);
    setOpen(false);
  };

  return (
    <div className="chat-window-placer" ref={anchorRef}>
      <button
        aria-expanded={open}
        aria-label="Move chat to a screen edge"
        className={open ? "toolbar-icon active" : "toolbar-icon"}
        onClick={() => setOpen((current) => !current)}
        title="Move chat to a screen edge"
        type="button"
      >
        <MonitorSpeaker size={16} />
      </button>
      {open && (
        <div className="chat-window-placer-menu" role="dialog">
          <strong>Stand chat against</strong>
          <div className="chat-window-placer-screens">
            {ordered.map((display, index) => (
              <div
                className={
                  display.primary
                    ? "chat-window-placer-screen is-primary"
                    : "chat-window-placer-screen"
                }
                key={display.id}
                title={display.primary ? "Main screen" : `Screen ${index + 1}`}
              >
                <button
                  aria-label={`Left side of ${display.primary ? "the main screen" : `screen ${index + 1}`}`}
                  onClick={() => place(display.id, "left")}
                  title="Left side"
                  type="button"
                />
                <button
                  aria-label={`Right side of ${display.primary ? "the main screen" : `screen ${index + 1}`}`}
                  onClick={() => place(display.id, "right")}
                  title="Right side"
                  type="button"
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
