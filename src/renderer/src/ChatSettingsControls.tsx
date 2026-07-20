import { Play } from "lucide-react";
import type { MentionSoundId } from "../../shared/preferences";
import { MENTION_SOUNDS, playMentionSound } from "./mention-sound";
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
