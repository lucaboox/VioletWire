import { useEffect, useRef, useState } from "react";
import { MonitorSpeaker } from "lucide-react";
import type { ChatWindowDisplay } from "../../shared/chat";

const MAP_WIDTH = 208;
const MAP_HEIGHT = 132;

/**
 * Stands the chat window against the side of a display the reader picks.
 *
 * The displays are drawn where they actually sit relative to one another, so a
 * second screen to the left is drawn to the left, and each is split down the
 * middle into the two sides chat can take.
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
      if (!(event.target instanceof Node)) return;
      if (anchorRef.current?.contains(event.target)) return;
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

  // Sizes arrive already divided by each display's scaling, so a big screen at
  // a high scaling reads as barely larger than a small one. Multiplying it back
  // out draws the screens at the sizes they actually are.
  const real = (display: ChatWindowDisplay) => ({
    x: display.bounds.x * display.scaleFactor,
    y: display.bounds.y * display.scaleFactor,
    width: display.bounds.width * display.scaleFactor,
    height: display.bounds.height * display.scaleFactor,
  });

  // The rectangle every display fits inside, so the map can be drawn to scale.
  const extent = displays.reduce(
    (box, display) => ({
      left: Math.min(box.left, real(display).x),
      top: Math.min(box.top, real(display).y),
      right: Math.max(box.right, real(display).x + real(display).width),
      bottom: Math.max(box.bottom, real(display).y + real(display).height),
    }),
    {
      left: Number.POSITIVE_INFINITY,
      top: Number.POSITIVE_INFINITY,
      right: Number.NEGATIVE_INFINITY,
      bottom: Number.NEGATIVE_INFINITY,
    },
  );
  const spanWidth = Math.max(1, extent.right - extent.left);
  const spanHeight = Math.max(1, extent.bottom - extent.top);
  const scale = Math.min(MAP_WIDTH / spanWidth, MAP_HEIGHT / spanHeight);

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
          <div
            className="chat-window-placer-map"
            style={{
              width: `${Math.round(spanWidth * scale)}px`,
              height: `${Math.round(spanHeight * scale)}px`,
            }}
          >
            {displays.map((display) => (
              <div
                className="chat-window-placer-screen"
                key={display.id}
                style={{
                  left: `${Math.round((real(display).x - extent.left) * scale)}px`,
                  top: `${Math.round((real(display).y - extent.top) * scale)}px`,
                  width: `${Math.round(real(display).width * scale)}px`,
                  height: `${Math.round(real(display).height * scale)}px`,
                }}
              >
                <button
                  aria-label={`Left side of ${display.primary ? "the main screen" : "this screen"}`}
                  onClick={() => place(display.id, "left")}
                  title="Left side"
                  type="button"
                />
                <button
                  aria-label={`Right side of ${display.primary ? "the main screen" : "this screen"}`}
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
