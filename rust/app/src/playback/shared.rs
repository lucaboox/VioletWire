//! State shared by the decoder threads, the audio callback and the UI.
//!
//! Audio is the master clock: it advances by the samples handed to the sound
//! card, and a video frame is shown once the clock reaches its time
//! (`index / fps`, since FFmpeg emits constant-rate video). Both start at zero
//! because FFmpeg aligns the two outputs to the same start.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use gpui::RenderImage;

/// Decoded frames held ahead of the clock. At 1080p each is 8.3 MB.
pub const VIDEO_QUEUE_FRAMES: usize = 16;
/// Decoded audio held ahead of the clock.
const AUDIO_QUEUE_SECONDS: f64 = 3.0;
/// Audio buffered before playback starts.
pub const START_AUDIO_SECONDS: f64 = 0.3;
/// Above this much buffered audio, skip ahead to `TRIM_TO_SECONDS`.
pub const MAX_AUDIO_SECONDS: f64 = 2.0;
pub const TRIM_TO_SECONDS: f64 = 0.8;

pub struct VideoFrame {
    pub index: u64,
    pub image: Arc<RenderImage>,
}

#[derive(Clone, Copy, Default)]
struct ClockState {
    /// Sample frames played before the latest audio callback.
    base: u64,
    /// Sample frames that callback handed over.
    span: u64,
    at: Option<Instant>,
}

pub struct Shared {
    pub sample_rate: u32,
    pub channels: usize,
    stop: AtomicBool,
    playing: AtomicBool,
    video_ended: AtomicBool,
    fps_millis: AtomicU64,
    /// `width << 32 | height` of FFmpeg's output; 0 until known.
    frame_size: AtomicU64,
    log_closed: AtomicBool,
    video: Mutex<VecDeque<VideoFrame>>,
    video_space: Condvar,
    video_len: AtomicUsize,
    pub(super) audio: Mutex<VecDeque<f32>>,
    audio_space: Condvar,
    audio_len: AtomicUsize,
    clock: Mutex<ClockState>,
    pub streamlink_error: Mutex<Option<String>>,
    pub ffmpeg_error: Mutex<Option<String>>,
}

pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Shared {
    pub fn new(sample_rate: u32, channels: usize) -> Self {
        Self {
            sample_rate,
            channels,
            stop: AtomicBool::new(false),
            playing: AtomicBool::new(false),
            video_ended: AtomicBool::new(false),
            fps_millis: AtomicU64::new(0),
            frame_size: AtomicU64::new(0),
            log_closed: AtomicBool::new(false),
            video: Mutex::default(),
            video_space: Condvar::new(),
            video_len: AtomicUsize::new(0),
            audio: Mutex::default(),
            audio_space: Condvar::new(),
            audio_len: AtomicUsize::new(0),
            clock: Mutex::default(),
            streamlink_error: Mutex::default(),
            ffmpeg_error: Mutex::default(),
        }
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        self.video_space.notify_all();
        self.audio_space.notify_all();
    }

    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    pub fn playing(&self) -> bool {
        self.playing.load(Ordering::SeqCst)
    }

    pub fn video_ended(&self) -> bool {
        self.video_ended.load(Ordering::SeqCst)
    }

    pub fn end_video(&self) {
        self.video_ended.store(true, Ordering::SeqCst);
    }

    pub fn set_fps(&self, fps: f64) {
        if fps.is_finite() && (1.0..=240.0).contains(&fps) {
            self.fps_millis.store((fps * 1000.0).round() as u64, Ordering::SeqCst);
        }
    }

    pub fn fps(&self) -> Option<f64> {
        match self.fps_millis.load(Ordering::SeqCst) {
            0 => None,
            millis => Some(millis as f64 / 1000.0),
        }
    }

    pub fn set_frame_size(&self, width: u32, height: u32) {
        self.frame_size
            .store(u64::from(width) << 32 | u64::from(height), Ordering::SeqCst);
    }

    pub fn frame_size(&self) -> Option<(u32, u32)> {
        match self.frame_size.load(Ordering::SeqCst) {
            0 => None,
            packed => Some(((packed >> 32) as u32, packed as u32)),
        }
    }

    /// FFmpeg's log ended, so no size or rate will arrive any more.
    pub fn close_log(&self) {
        self.log_closed.store(true, Ordering::SeqCst);
    }

    pub fn log_closed(&self) -> bool {
        self.log_closed.load(Ordering::SeqCst)
    }

    /// Seconds of media played, smoothed between audio callbacks.
    pub fn clock(&self) -> f64 {
        let state = *lock(&self.clock);
        let rate = f64::from(self.sample_rate);
        let since = state
            .at
            .map(|at| at.elapsed().as_secs_f64().min(state.span as f64 / rate))
            .unwrap_or_default();
        state.base as f64 / rate + since
    }

    fn samples_for(&self, seconds: f64) -> usize {
        (seconds * f64::from(self.sample_rate)) as usize * self.channels
    }

    // ----- Video ---------------------------------------------------------

    /// Queues a decoded frame, waiting while the queue is full. Returns false
    /// once playback is stopping.
    pub fn push_video(&self, frame: VideoFrame) -> bool {
        let mut queue = lock(&self.video);
        while queue.len() >= VIDEO_QUEUE_FRAMES {
            if self.stopped() {
                return false;
            }
            queue = self
                .video_space
                .wait_timeout(queue, Duration::from_millis(20))
                .unwrap_or_else(PoisonError::into_inner)
                .0;
            // Nothing draws while the window is minimised; frames the clock
            // has passed are stale either way.
            if let Some(fps) = self.fps() {
                let clock = self.clock();
                while queue.front().is_some_and(|frame| frame.index as f64 / fps < clock) {
                    queue.pop_front();
                }
            }
            // Video is full but audio ran dry: FFmpeg is blocked writing
            // video, so it cannot produce the audio the clock needs. Let a
            // frame go rather than stall both.
            if queue.len() >= VIDEO_QUEUE_FRAMES && self.audio_len.load(Ordering::SeqCst) < self.samples_for(0.1) {
                queue.pop_front();
            }
        }
        queue.push_back(frame);
        self.video_len.store(queue.len(), Ordering::SeqCst);
        !self.stopped()
    }

    /// Whether a queued frame's time has come. Cheap enough to ask on every
    /// display refresh.
    pub fn frame_due(&self) -> bool {
        if !self.playing() {
            return false;
        }
        let Some(fps) = self.fps() else {
            return false;
        };
        let clock = self.clock();
        lock(&self.video)
            .front()
            .is_some_and(|frame| frame.index as f64 / fps <= clock)
    }

    /// The newest frame whose time has come, dropping older ones.
    pub fn take_due_frame(&self) -> Option<Arc<RenderImage>> {
        if !self.playing() {
            return None;
        }
        let fps = self.fps()?;
        let clock = self.clock();
        let mut queue = lock(&self.video);
        let mut due = None;
        while queue.front().is_some_and(|frame| frame.index as f64 / fps <= clock) {
            due = queue.pop_front();
        }
        self.video_len.store(queue.len(), Ordering::SeqCst);
        drop(queue);
        self.video_space.notify_one();
        due.map(|frame| frame.image)
    }

    // ----- Audio ---------------------------------------------------------

    /// Queues decoded samples, waiting while plenty is buffered.
    pub fn push_audio(&self, samples: &[f32]) -> bool {
        let limit = self.samples_for(AUDIO_QUEUE_SECONDS);
        let mut queue = lock(&self.audio);
        while queue.len() >= limit {
            if self.stopped() {
                return false;
            }
            queue = self
                .audio_space
                .wait_timeout(queue, Duration::from_millis(50))
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        queue.extend(samples);
        self.audio_len.store(queue.len(), Ordering::SeqCst);
        !self.stopped()
    }

    /// Fills one sound-card buffer and advances the clock. `played` is the
    /// callback's running total of sample frames.
    pub fn fill_audio(&self, output: &mut [f32], played: &mut u64) {
        let channels = self.channels;
        let mut queue = lock(&self.audio);
        if !self.playing() {
            let ready = queue.len() >= self.samples_for(START_AUDIO_SECONDS)
                && self.video_len.load(Ordering::SeqCst) > 0
                && self.fps().is_some();
            if !ready {
                output.fill(0.0);
                return;
            }
            self.playing.store(true, Ordering::SeqCst);
        }
        // Keep latency bounded: skip ahead (video follows the clock).
        if queue.len() > self.samples_for(MAX_AUDIO_SECONDS) {
            let excess = queue.len() - self.samples_for(TRIM_TO_SECONDS);
            let excess = excess - excess % channels;
            queue.drain(..excess);
            *played += (excess / channels) as u64;
        }
        let available = queue.len().min(output.len());
        let available = available - available % channels;
        for (slot, sample) in output.iter_mut().zip(queue.drain(..available)) {
            *slot = sample;
        }
        output[available..].fill(0.0);
        self.audio_len.store(queue.len(), Ordering::SeqCst);
        drop(queue);
        self.audio_space.notify_one();

        let frames = (available / channels) as u64;
        *lock(&self.clock) = ClockState {
            base: *played,
            span: frames,
            at: Some(Instant::now()),
        };
        *played += frames;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(index: u64) -> VideoFrame {
        let pixels = image::RgbaImage::new(1, 1);
        VideoFrame {
            index,
            image: Arc::new(RenderImage::new(vec![image::Frame::new(pixels)])),
        }
    }

    #[test]
    fn waits_for_audio_video_and_fps_before_playing() {
        let shared = Shared::new(1_000, 2);
        let mut played = 0;
        let mut output = vec![1.0; 20];
        shared.push_audio(&vec![0.5; 2_000]);
        shared.fill_audio(&mut output, &mut played);
        assert!(!shared.playing(), "no video frame or fps yet");
        assert!(output.iter().all(|sample| *sample == 0.0));

        shared.set_fps(10.0);
        shared.push_video(frame(0));
        shared.fill_audio(&mut output, &mut played);
        assert!(shared.playing());
        assert_eq!(played, 10);
        assert!(output.iter().all(|sample| *sample == 0.5));
    }

    #[test]
    fn shows_the_newest_due_frame_and_keeps_future_ones() {
        let shared = Shared::new(1_000, 1);
        shared.set_fps(10.0);
        for index in 0..5 {
            shared.push_video(frame(index));
        }
        shared.push_audio(&vec![0.0; 1_000]);
        let mut played = 0;
        // 250 ms played: frames 0, 1 and 2 (0, 100, 200 ms) are due.
        let mut output = vec![0.0; 250];
        shared.fill_audio(&mut output, &mut played);
        *lock(&shared.clock) = ClockState { base: 250, span: 0, at: None };
        let due = shared.take_due_frame().expect("a frame is due");
        assert_eq!(lock(&shared.video).len(), 2);
        assert_eq!(lock(&shared.video).front().map(|frame| frame.index), Some(3));
        drop(due);
    }

    #[test]
    fn trims_audio_that_falls_too_far_behind() {
        let shared = Shared::new(1_000, 1);
        shared.set_fps(10.0);
        shared.push_video(frame(0));
        shared.push_audio(&vec![0.0; 2_500]);
        let mut played = 0;
        let mut output = vec![0.0; 100];
        shared.fill_audio(&mut output, &mut played);
        // 2.5 s buffered -> trimmed to 0.8 s, then 0.1 s played.
        assert_eq!(played, 1_700 + 100);
        assert_eq!(lock(&shared.audio).len(), 700);
    }
}
