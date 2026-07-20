import type { MentionSoundId } from "../../shared/preferences";

export const MENTION_SOUNDS: { id: MentionSoundId; label: string }[] = [
  { id: "ping", label: "Ping" },
  { id: "chime", label: "Chime" },
  { id: "pop", label: "Pop" },
  { id: "knock", label: "Knock" },
];

interface Voice {
  type: OscillatorType;
  freq: number;
  // Optional glide target for a pitch sweep over the voice's duration.
  freqEnd?: number;
  // Seconds after trigger this voice begins.
  start: number;
  duration: number;
  // Relative loudness within the sound (0-1).
  gain?: number;
}

// Each sound is a handful of short oscillator voices with per-voice decay
// envelopes. Synthesized rather than bundled so there are no external audio
// assets to license, load, or allow through the renderer CSP.
const SOUND_VOICES: Record<MentionSoundId, Voice[]> = {
  // Two-tone rising notification.
  ping: [
    { type: "sine", freq: 740, start: 0, duration: 0.22 },
    { type: "sine", freq: 987.77, start: 0.09, duration: 0.22, gain: 0.95 },
  ],
  // Three-note ascending bell (E major triad) with longer decay.
  chime: [
    { type: "sine", freq: 659.25, start: 0, duration: 0.5 },
    { type: "sine", freq: 830.61, start: 0.08, duration: 0.5, gain: 0.9 },
    { type: "sine", freq: 987.77, start: 0.16, duration: 0.58, gain: 0.85 },
  ],
  // Bright blip with a downward drop, plus a high sparkle. Short sounds read
  // quieter than the sustained Chime, so these carry higher gain to match.
  pop: [
    { type: "triangle", freq: 900, freqEnd: 600, start: 0, duration: 0.17, gain: 2.1 },
    { type: "sine", freq: 1800, start: 0, duration: 0.09, gain: 1.3 },
  ],
  // Two thumps, each with a high click transient. The low body plus the loud
  // clicks keep it clearly audible on small speakers.
  knock: [
    { type: "triangle", freq: 220, freqEnd: 130, start: 0, duration: 0.16, gain: 2.4 },
    { type: "triangle", freq: 1300, start: 0, duration: 0.05, gain: 1.4 },
    { type: "triangle", freq: 210, freqEnd: 125, start: 0.17, duration: 0.16, gain: 2.3 },
    { type: "triangle", freq: 1250, start: 0.17, duration: 0.05, gain: 1.35 },
  ],
};

let mentionAudioContext: AudioContext | null = null;

export function playMentionSound(soundId: MentionSoundId, volumePercent: number): void {
  const AudioContextConstructor =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextConstructor) return;

  // Volume ranges 0-200%, so it can be pushed above unity for extra loudness.
  const normalizedVolume = Math.min(200, Math.max(0, volumePercent)) / 100;
  if (normalizedVolume <= 0) return;

  mentionAudioContext ??= new AudioContextConstructor();
  const context = mentionAudioContext;
  const peakGain = normalizedVolume * 0.3;
  const voices = SOUND_VOICES[soundId] ?? SOUND_VOICES.ping;

  void context
    .resume()
    .then(() => {
      const now = context.currentTime;
      for (const voice of voices) {
        const startAt = now + voice.start;
        const level = Math.max(0.0001, peakGain * (voice.gain ?? 1));
        const gain = context.createGain();
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(level, startAt + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + voice.duration);
        gain.connect(context.destination);

        const oscillator = context.createOscillator();
        oscillator.type = voice.type;
        oscillator.frequency.setValueAtTime(voice.freq, startAt);
        if (voice.freqEnd) {
          oscillator.frequency.exponentialRampToValueAtTime(
            voice.freqEnd,
            startAt + voice.duration,
          );
        }
        oscillator.connect(gain);
        oscillator.start(startAt);
        oscillator.stop(startAt + voice.duration + 0.03);
      }
    })
    .catch(() => undefined);
}

// Retained for callers that always want the default sound.
export function playMentionPing(volumePercent: number): void {
  playMentionSound("ping", volumePercent);
}
