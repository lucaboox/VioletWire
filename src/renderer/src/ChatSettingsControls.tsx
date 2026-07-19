import { Play } from "lucide-react";
import { playMentionPing } from "./mention-sound";
import "./chat-settings-controls.css";

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
}

export function MentionSoundControls({
  onVolumeChange,
  volume,
}: MentionSoundControlsProps) {
  return (
    <div className="mention-sound-controls">
      <button
        aria-label="Play mention sound preview"
        className="mention-sound-preview"
        onClick={() => playMentionPing(volume)}
        title="Play mention sound"
        type="button"
      >
        <Play aria-hidden="true" size={12} />
        Play
      </button>
      <label className="mention-sound-volume">
        <span>Volume: {volume}%</span>
        <input
          aria-label="Mention sound volume"
          max="100"
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
