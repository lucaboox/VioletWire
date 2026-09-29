import { X } from "lucide-react";
import "./keyboard-shortcuts.css";

interface Shortcut {
  keys: string[];
  /** The keys are alternatives (either one) rather than pressed together. */
  either?: boolean;
  action: string;
}

interface ShortcutGroup {
  title: string;
  note?: string;
  shortcuts: Shortcut[];
}

interface KeyboardShortcutsProps {
  /** The key held over a link to preview a website, or null when that is off. */
  linkPreviewKey: "Ctrl" | "Alt" | null;
  onClose: () => void;
}

/**
 * Every shortcut VioletWire has, in one place. Each entry here is backed by a
 * handler in the code — App's player keys, use-multi-stream's grid keys, the
 * composer, the emote picker and the main process's window keys — so this list
 * has to change whenever one of those does.
 */
export function KeyboardShortcuts({ linkPreviewKey, onClose }: KeyboardShortcutsProps) {
  const groups: ShortcutGroup[] = [
    {
      title: "Watching a stream",
      note: "While you are not typing in chat or a search box.",
      shortcuts: [
        { keys: ["Space"], action: "Pause, or resume at live" },
        { keys: ["M"], action: "Mute or unmute" },
        { keys: ["F"], action: "Fullscreen" },
        { keys: ["T"], action: "Theater mode" },
        { keys: ["C"], action: "Show or hide chat" },
        { keys: ["Esc"], action: "Leave fullscreen, then theater mode" },
      ],
    },
    {
      title: "Multistream",
      shortcuts: [
        { keys: ["F"], action: "Fullscreen" },
        { keys: ["T"], action: "Theater mode" },
        { keys: ["Esc"], action: "Leave fullscreen or theater mode" },
        {
          keys: ["←", "→"],
          either: true,
          action: "Move a stream along the grid, with its name plate focused",
        },
      ],
    },
    {
      title: "Chat",
      shortcuts: [
        { keys: ["Enter"], action: "Send, or take the highlighted suggestion" },
        { keys: ["Tab"], action: "Complete an emote or @name" },
        { keys: ["↑", "↓"], either: true, action: "Move through suggestions" },
        { keys: ["Esc"], action: "Close suggestions" },
        ...(linkPreviewKey
          ? [
              {
                keys: [linkPreviewKey],
                action: "Hold over a link to preview the website",
              },
            ]
          : []),
      ],
    },
    {
      title: "Emote picker",
      shortcuts: [
        { keys: ["Alt", "Click"], action: "Add or remove a favorite" },
        { keys: ["Ctrl", "Click"], action: "Insert and keep the picker open" },
      ],
    },
    {
      title: "Window",
      shortcuts: [
        { keys: ["F11"], action: "Leave fullscreen" },
        { keys: ["F12"], action: "Developer tools" },
        { keys: ["?"], action: "This list" },
      ],
    },
  ];

  return (
    <div
      className="settings-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <section
        aria-labelledby="shortcuts-modal-title"
        aria-modal="true"
        className="settings-modal-panel shortcuts-modal-panel"
        // Focus starts on the close button, so Escape lands here. The player's
        // own Escape handling ignores anything inside a dialog.
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        role="dialog"
      >
        <header className="settings-modal-header">
          <div>
            <span>KEYBOARD</span>
            <h2 id="shortcuts-modal-title">Shortcuts</h2>
            <p>Press ? anywhere outside a text box to open this again.</p>
          </div>
          <button aria-label="Close shortcuts" autoFocus onClick={onClose} title="Close" type="button">
            <X size={19} />
          </button>
        </header>
        <div className="shortcuts-modal-content">
          {groups.map((group) => (
            <section className="shortcuts-group" key={group.title}>
              <h3>{group.title}</h3>
              {group.note && <p className="shortcuts-note">{group.note}</p>}
              <dl>
                {group.shortcuts.map((shortcut) => (
                  <div className="shortcuts-row" key={`${group.title}-${shortcut.action}`}>
                    <dt>
                      {shortcut.keys.map((key, index) => (
                        <span key={key}>
                          {index > 0 && (
                            <span className="shortcuts-join">{shortcut.either ? "or" : "+"}</span>
                          )}
                          <kbd>{key}</kbd>
                        </span>
                      ))}
                    </dt>
                    <dd>{shortcut.action}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}
