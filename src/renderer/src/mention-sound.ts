let mentionAudioContext: AudioContext | null = null;

export function playMentionPing(volumePercent: number): void {
  const AudioContextConstructor =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextConstructor) return;

  mentionAudioContext ??= new AudioContextConstructor();
  const context = mentionAudioContext;
  const normalizedVolume = Math.min(100, Math.max(0, volumePercent)) / 100;
  const peakGain = Math.max(0.0001, normalizedVolume * 0.3);

  void context.resume().then(() => {
    const now = context.currentTime;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peakGain, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
    gain.connect(context.destination);

    for (const [frequency, offset] of [[740, 0], [980, 0.09]] as const) {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, now + offset);
      oscillator.connect(gain);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + 0.2);
    }
  }).catch(() => undefined);
}
