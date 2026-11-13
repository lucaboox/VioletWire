//! Electron's mention sounds (`mention-sound.ts`): a few short oscillator
//! voices with exponential envelopes, synthesized rather than bundled. Here
//! they are rendered to a 16-bit WAV in memory and played with `PlaySoundW` on
//! a worker thread, so the UI never waits on audio.

use std::f32::consts::TAU;
use std::sync::{OnceLock, mpsc};

use windows::Win32::Media::Audio::{PlaySoundW, SND_MEMORY, SND_NODEFAULT, SND_SYNC};
use windows::core::PCWSTR;

const RATE: u32 = 44_100;

#[derive(Clone, Copy)]
enum Wave {
    Sine,
    Triangle,
}

struct Voice {
    wave: Wave,
    freq: f32,
    /// Glide target over the voice's duration.
    freq_end: Option<f32>,
    start: f32,
    duration: f32,
    gain: f32,
}

const fn voice(wave: Wave, freq: f32, freq_end: Option<f32>, start: f32, duration: f32, gain: f32) -> Voice {
    Voice { wave, freq, freq_end, start, duration, gain }
}

fn voices(id: &str) -> &'static [Voice] {
    use Wave::{Sine, Triangle};
    const PING: &[Voice] = &[
        voice(Sine, 740., None, 0., 0.22, 1.),
        voice(Sine, 987.77, None, 0.09, 0.22, 0.95),
    ];
    const CHIME: &[Voice] = &[
        voice(Sine, 659.25, None, 0., 0.5, 1.),
        voice(Sine, 830.61, None, 0.08, 0.5, 0.9),
        voice(Sine, 987.77, None, 0.16, 0.58, 0.85),
    ];
    const POP: &[Voice] = &[
        voice(Triangle, 900., Some(600.), 0., 0.17, 2.1),
        voice(Sine, 1800., None, 0., 0.09, 1.3),
    ];
    const KNOCK: &[Voice] = &[
        voice(Triangle, 220., Some(130.), 0., 0.16, 2.4),
        voice(Triangle, 1300., None, 0., 0.05, 1.4),
        voice(Triangle, 210., Some(125.), 0.17, 0.16, 2.3),
        voice(Triangle, 1250., None, 0.17, 0.05, 1.35),
    ];
    match id {
        "chime" => CHIME,
        "pop" => POP,
        "knock" => KNOCK,
        _ => PING,
    }
}

/// Mono samples in -1..1, matching WebAudio's exponential ramps: up to the
/// peak in 10 ms, then down to silence by the end of the voice.
fn render(id: &str, volume_percent: u8) -> Vec<f32> {
    let peak = f32::from(volume_percent.min(200)) / 100. * 0.3;
    let voices = voices(id);
    let length = voices
        .iter()
        .map(|voice| voice.start + voice.duration + 0.03)
        .fold(0., f32::max);
    let mut samples = vec![0f32; (length * RATE as f32) as usize];
    for voice in voices {
        let level = (peak * voice.gain).max(0.0001);
        let first = (voice.start * RATE as f32) as usize;
        let count = (voice.duration * RATE as f32) as usize;
        let mut phase = 0f32;
        for n in 0..count {
            let t = n as f32 / RATE as f32;
            let progress = t / voice.duration;
            let freq = match voice.freq_end {
                Some(end) => voice.freq * (end / voice.freq).powf(progress),
                None => voice.freq,
            };
            phase = (phase + freq / RATE as f32).fract();
            let wave = match voice.wave {
                Wave::Sine => (phase * TAU).sin(),
                Wave::Triangle => 1. - 4. * (phase - 0.5).abs(),
            };
            let envelope = if t < 0.01 {
                0.0001 * (level / 0.0001).powf(t / 0.01)
            } else {
                level * (0.0001 / level).powf((t - 0.01) / (voice.duration - 0.01))
            };
            if let Some(sample) = samples.get_mut(first + n) {
                *sample += wave * envelope;
            }
        }
    }
    samples
}

fn wav(samples: &[f32]) -> Vec<u8> {
    let data = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data.to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&((sample.clamp(-1., 1.) * 32767.) as i16).to_le_bytes());
    }
    out
}

/// Plays a mention sound. A sound already playing is not interrupted, and
/// requests that arrive meanwhile are dropped rather than queued.
pub fn play_mention(id: &str, volume_percent: u8) {
    if volume_percent == 0 {
        return;
    }
    static WORKER: OnceLock<mpsc::SyncSender<(String, u8)>> = OnceLock::new();
    let worker = WORKER.get_or_init(|| {
        let (send, receive) = mpsc::sync_channel::<(String, u8)>(1);
        std::thread::Builder::new()
            .name("mention-sound".into())
            .spawn(move || {
                while let Ok((id, volume)) = receive.recv() {
                    let sound = wav(&render(&id, volume));
                    // SAFETY: SND_MEMORY reads `sound`, which outlives the
                    // synchronous call.
                    unsafe {
                        let _ = PlaySoundW(
                            PCWSTR(sound.as_ptr().cast()),
                            None,
                            SND_MEMORY | SND_SYNC | SND_NODEFAULT,
                        );
                    }
                }
            })
            .ok();
        send
    });
    let _ = worker.try_send((id.to_owned(), volume_percent));
}

#[cfg(test)]
mod tests {
    use super::{render, wav};

    #[test]
    fn renders_every_sound_within_range() {
        for id in ["ping", "chime", "pop", "knock"] {
            let samples = render(id, 200);
            assert!(samples.len() > 4_000);
            assert!(samples.iter().all(|sample| sample.is_finite()));
            assert!(samples.iter().any(|sample| sample.abs() > 0.05));
            assert_eq!(wav(&samples).len(), 44 + samples.len() * 2);
        }
    }
}
