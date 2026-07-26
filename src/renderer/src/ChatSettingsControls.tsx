import { LoaderCircle, Play } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import type { TwitchChatColorInput } from "../../shared/twitch";
import type { MentionSoundId } from "../../shared/preferences";
import { MENTION_SOUNDS, playMentionSound } from "./mention-sound";
import "./chat-settings-controls.css";

const TWITCH_CHAT_COLORS: {
  label: string;
  name: TwitchChatColorInput;
  hex: string;
}[] = [
  { label: "Blue", name: "blue", hex: "#0000FF" },
  { label: "Blue violet", name: "blue_violet", hex: "#8A2BE2" },
  { label: "Cadet blue", name: "cadet_blue", hex: "#5F9EA0" },
  { label: "Chocolate", name: "chocolate", hex: "#D2691E" },
  { label: "Coral", name: "coral", hex: "#FF7F50" },
  { label: "Dodger blue", name: "dodger_blue", hex: "#1E90FF" },
  { label: "Firebrick", name: "firebrick", hex: "#B22222" },
  { label: "Golden rod", name: "golden_rod", hex: "#DAA520" },
  { label: "Green", name: "green", hex: "#008000" },
  { label: "Hot pink", name: "hot_pink", hex: "#FF69B4" },
  { label: "Orange red", name: "orange_red", hex: "#FF4500" },
  { label: "Red", name: "red", hex: "#FF0000" },
  { label: "Sea green", name: "sea_green", hex: "#2E8B57" },
  { label: "Spring green", name: "spring_green", hex: "#00FF7F" },
  { label: "Yellow green", name: "yellow_green", hex: "#9ACD32" },
];

export function TwitchChatColorControls() {
  const [color, setColor] = useState("");
  const [customColor, setCustomColor] = useState("#9146FF");
  const [canUpdate, setCanUpdate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    void window.desktop.twitch
      .getChatColor()
      .then((state) => {
        if (disposed) return;
        setColor(state.color);
        setCanUpdate(state.canUpdate);
        if (/^#[0-9a-f]{6}$/i.test(state.color)) setCustomColor(state.color);
      })
      .catch(() => {
        if (!disposed) setError("Sign in with Twitch to change your chat color.");
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  const applyColor = async (nextColor: TwitchChatColorInput) => {
    if (!canUpdate || saving) return;
    setSaving(true);
    setError("");
    try {
      const state = await window.desktop.twitch.updateChatColor(nextColor);
      setColor(state.color);
      setCanUpdate(state.canUpdate);
      if (/^#[0-9a-f]{6}$/i.test(state.color)) setCustomColor(state.color);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Twitch could not change the color.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="twitch-chat-color-controls">
      <div className="twitch-chat-color-heading">
        <span>Username color</span>
        {loading || saving ? (
          <LoaderCircle aria-label="Loading chat color" className="spin" size={13} />
        ) : (
          <span
            aria-label={color ? `Current color ${color}` : "No Twitch color selected"}
            className="twitch-chat-current-color"
            style={{ backgroundColor: color || "#9146ff" }}
          />
        )}
      </div>
      <div aria-label="Twitch username colors" className="twitch-chat-color-grid" role="group">
        {TWITCH_CHAT_COLORS.map((option) => (
          <button
            aria-label={option.label}
            aria-pressed={color.toUpperCase() === option.hex}
            className={color.toUpperCase() === option.hex ? "active" : ""}
            disabled={!canUpdate || saving}
            key={option.name}
            onClick={() => void applyColor(option.name)}
            style={{ "--chat-color": option.hex } as CSSProperties}
            type="button"
          />
        ))}
      </div>
      <div className="twitch-chat-custom-color">
        <input
          aria-label="Custom Twitch username color"
          disabled={!canUpdate || saving}
          onChange={(event) => setCustomColor(event.target.value)}
          type="color"
          value={customColor}
        />
        <button
          disabled={!canUpdate || saving}
          onClick={() => void applyColor(customColor)}
          type="button"
        >
          Apply custom
        </button>
      </div>
      {!loading && !canUpdate && !error && (
        <small>Sign in again once to enable chat-color and moderation permissions.</small>
      )}
      {error && <small className="twitch-chat-color-error">{error}</small>}
      <small>Custom colors require Twitch Prime or Turbo.</small>
    </section>
  );
}

interface ChatToggleSettingProps {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}

export function ChatToggleSetting({
  checked,
  label,
  onChange,
}: ChatToggleSettingProps) {
  return (
    <label className="chat-toggle-setting">
      <span>{label}</span>
      <span className="chat-toggle-switch">
        <input
          aria-label={label}
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
        <span aria-hidden="true" className="chat-toggle-track" />
      </span>
    </label>
  );
}

interface MentionSoundControlsProps {
  onVolumeChange: (volume: number) => void;
  volume: number;
  soundId: MentionSoundId;
  onSoundChange: (soundId: MentionSoundId) => void;
}

export function MentionSoundControls({
  onVolumeChange,
  volume,
  soundId,
  onSoundChange,
}: MentionSoundControlsProps) {
  return (
    <div className="mention-sound-controls">
      <div className="mention-sound-row">
        <label className="mention-sound-picker">
          <span>Sound</span>
          <select
            aria-label="Mention sound"
            onChange={(event) => onSoundChange(event.target.value as MentionSoundId)}
            value={soundId}
          >
            {MENTION_SOUNDS.map((sound) => (
              <option key={sound.id} value={sound.id}>
                {sound.label}
              </option>
            ))}
          </select>
        </label>
        <button
          aria-label="Play mention sound preview"
          className="mention-sound-preview"
          onClick={() => playMentionSound(soundId, volume)}
          title="Play mention sound"
          type="button"
        >
          <Play aria-hidden="true" size={12} />
          Test
        </button>
      </div>
      <label className="mention-sound-volume">
        <span>Volume: {volume}%</span>
        <input
          aria-label="Mention sound volume"
          max="200"
          min="0"
          onChange={(event) => onVolumeChange(Number(event.target.value))}
          step="5"
          type="range"
          value={volume}
        />
      </label>
    </div>
  );
}
