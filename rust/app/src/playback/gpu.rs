//! Windows Media Engine frame-server: hardware decode and video processing on
//! GPUI's D3D11 device. BGRA surfaces go straight to the scene, never an atlas.
//!
//! Besides playing, this owns everything the control bar reports or changes:
//! the stream quality (switching keeps the current picture until the new one
//! is ready), the volume normaliser, playback statistics, and a watchdog that
//! recovers a stream whose picture stops — first by returning to the live edge,
//! then by reconnecting with a fresh playlist.
use super::{compressor, relay, resolver};
use anyhow::{Context as _, Result, bail};
use gpui::WindowsSurface;
use std::{
    collections::VecDeque,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use windows::{
    Win32::{
        Foundation::RECT,
        Graphics::{Direct3D11::*, Dxgi::Common::*},
        Media::MediaFoundation::*,
        System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance},
    },
    core::{BSTR, HRESULT, Interface, implement},
};

/// How long a playing stream may go without a new frame before the watchdog
/// returns it to the live edge, and then how long that may take before it
/// reconnects instead.
const FREEZE_AFTER: Duration = Duration::from_secs(4);
const RECONNECT_AFTER: Duration = Duration::from_secs(6);
/// A newly built engine (start, quality change, reconnect) gets this long to
/// show its first frame before the watchdog steps in.
const FIRST_FRAME_GRACE: Duration = Duration::from_secs(12);
/// Reconnects in a row without a single frame before playback gives up.
const MAX_RECONNECTS: u32 = 3;
/// How far behind the newest media playback sits: where the relay starts it,
/// where "Return to live" seeks to, and where a drift catch-up lands.
pub const LIVE_CUSHION_SECONDS: f64 = super::relay::START_CUSHION_SECONDS;
/// Drifting this far past the cushion for this long triggers a catch-up.
const DRIFT_SECONDS: f64 = 6.0;
const DRIFT_FOR: Duration = Duration::from_secs(5);
/// A lookup that has not answered by now has failed.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(25);
/// Statistics are cheap but not free; refresh them at most this often.
const STATS_EVERY: Duration = Duration::from_millis(500);

#[derive(Default)]
struct Events {
    error: AtomicU32,
    ended: AtomicBool,
}
#[implement(IMFMediaEngineNotify)]
struct Notify(Arc<Events>);
impl IMFMediaEngineNotify_Impl for Notify_Impl {
    fn EventNotify(&self, event: u32, param1: usize, _param2: u32) -> windows::core::Result<()> {
        if event == MF_MEDIA_ENGINE_EVENT_ERROR.0 as u32 {
            self.0.error.store(param1 as u32, Ordering::Release);
        }
        if event == MF_MEDIA_ENGINE_EVENT_ENDED.0 as u32 {
            self.0.ended.store(true, Ordering::Release);
        }
        Ok(())
    }
}

/// What a pending lookup is for.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Purpose {
    Start,
    Quality,
    Reconnect,
}

/// The freeze watchdog's progress through its recovery steps.
#[derive(Clone, Copy, PartialEq)]
enum Watchdog {
    Watching,
    ReturnedToLive(Instant),
    Reconnecting,
}

/// A quality change being prepared, silently, next to the playing engine. It
/// takes over when its first frame is ready, so the picture never stops.
struct Incoming {
    source: resolver::Resolved,
    relayed: Option<relay::Relayed>,
    engine: Option<Engine>,
    since: Instant,
}

/// A snapshot for the stats panel and the control bar.
#[derive(Clone, Default)]
pub struct Stats {
    /// Seconds behind the newest media Twitch has published.
    pub latency: Option<f64>,
    /// Seconds of media buffered ahead of the picture.
    pub buffer: Option<f64>,
    /// Seconds from Twitch receiving the frame on screen to now, from the
    /// segments' PROGRAM-DATE-TIME — comparable to Twitch's own player.
    pub broadcast_latency: Option<f64>,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub dropped_frames: Option<u64>,
    pub bitrate_kbps: Option<f64>,
    pub stall_recoveries: u32,
    /// The normaliser has processed audio (it can be unavailable for a format).
    pub compressor_active: bool,
}

pub struct GpuPlayback {
    login: String,
    paused: bool,
    muted: bool,
    volume: f64,
    lookup: Option<(resolver::Resolution, Purpose, Instant)>,
    source: Option<resolver::Resolved>,
    /// The loopback relay's copy of `source`; dropping it ends the session.
    relayed: Option<relay::Relayed>,
    requested_quality: String,
    engine: Option<Engine>,
    incoming: Option<Incoming>,
    started: Instant,
    pub resolved_ms: Option<u128>,
    pub first_frame_ms: Option<u128>,
    pub frames: u64,
    /// Frames from the current engine; zero while a new one starts up.
    engine_frames: u64,
    reconnects_without_frames: u32,
    /// When playback was first seen drifting behind; reset at the live edge.
    drifting_since: Option<Instant>,
    live_seeks: u32,
    log_at: Option<Instant>,
    frame_times: VecDeque<Instant>,
    last_frame_at: Instant,
    last_poll_at: Option<Instant>,
    watchdog: Watchdog,
    stall_recoveries: u32,
    compressor: compressor::Switch,
    stats: Stats,
    stats_at: Option<Instant>,
    bytes_sample: Option<(Instant, u64)>,
}

impl GpuPlayback {
    pub fn new(login: &str, quality: &str, compression: bool) -> Result<Self> {
        if !crate::format::is_login(login) {
            bail!("Invalid Twitch channel.");
        }
        let quality = if resolver::is_quality(quality) { quality } else { "best" };
        let lookup = resolver::resolve(login, quality)?;
        let compressor = compressor::Switch::default();
        compressor.set(compression);
        Ok(Self {
            login: login.to_owned(),
            paused: false,
            muted: false,
            volume: 1.,
            lookup: Some((lookup, Purpose::Start, Instant::now())),
            source: None,
            relayed: None,
            requested_quality: quality.to_owned(),
            engine: None,
            incoming: None,
            started: Instant::now(),
            resolved_ms: None,
            first_frame_ms: None,
            frames: 0,
            engine_frames: 0,
            reconnects_without_frames: 0,
            drifting_since: None,
            live_seeks: 0,
            log_at: None,
            frame_times: VecDeque::new(),
            last_frame_at: Instant::now(),
            last_poll_at: None,
            watchdog: Watchdog::Watching,
            stall_recoveries: 0,
            compressor,
            stats: Stats::default(),
            stats_at: None,
            bytes_sample: None,
        })
    }

    pub fn set_audio(&mut self, muted: bool, volume: f64) {
        self.muted = muted;
        self.volume = volume.clamp(0., 1.);
        if let Some(engine) = &self.engine {
            engine.apply_audio(muted, self.volume);
        }
    }

    pub fn set_compression(&mut self, enabled: bool) {
        self.compressor.set(enabled);
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.paused = paused;
        if let Some(engine) = &self.engine {
            // SAFETY: as above.
            unsafe {
                if paused {
                    let _ = engine.engine().Pause();
                } else {
                    let _ = engine.engine().Play();
                }
            }
        }
        // Time spent paused is not a freeze.
        self.last_frame_at = Instant::now();
        self.watchdog = Watchdog::Watching;
    }

    pub fn go_live(&mut self) {
        if let Some(engine) = &self.engine {
            engine.seek_to_live();
        }
        self.set_paused(false);
    }

    /// Switches quality. The current picture keeps playing until the new
    /// playlist is ready, then the engine is replaced.
    pub fn set_quality(&mut self, quality: &str) -> Result<()> {
        if !resolver::is_quality(quality) || quality == self.requested_quality {
            return Ok(());
        }
        self.requested_quality = quality.to_owned();
        self.lookup = Some((
            resolver::resolve(&self.login, quality)?,
            Purpose::Quality,
            Instant::now(),
        ));
        Ok(())
    }

    /// The quality being played, or being switched to.
    pub fn quality(&self) -> &str {
        &self.requested_quality
    }

    /// What the channel offers, best first; empty until known.
    pub fn qualities(&self) -> &[String] {
        self.source
            .as_ref()
            .map(|source| source.qualities.as_slice())
            .unwrap_or_default()
    }

    /// Twitch is showing an ad in place of the stream (it is filtered out).
    pub fn ad_break(&self) -> bool {
        self.relayed.as_ref().is_some_and(relay::Relayed::ad_break)
    }

    /// The playlist is known but no live content has arrived yet: usually a
    /// pre-roll ad.
    pub fn waiting_for_stream(&self) -> bool {
        self.engine.is_none() && self.relayed.as_ref().is_some_and(|relayed| !relayed.ready())
    }

    pub fn ads_skipped(&self) -> u32 {
        self.relayed.as_ref().map_or(0, relay::Relayed::ads_skipped)
    }

    /// True while a frozen stream is reconnecting. (A quality change keeps
    /// the current picture playing, so it is not shown as a reconnect.)
    pub fn switching(&self) -> bool {
        self.lookup
            .as_ref()
            .is_some_and(|(_, purpose, _)| *purpose == Purpose::Reconnect)
            || self.watchdog == Watchdog::Reconnecting
    }

    pub fn ended(&self) -> bool {
        self.engine
            .as_ref()
            .is_some_and(|engine| engine.events.ended.load(Ordering::Acquire))
    }

    pub fn video_size(&self) -> (u32, u32) {
        self.engine
            .as_ref()
            .map(|engine| engine.size)
            .unwrap_or_default()
    }

    /// The statistics as last measured, without measuring again.
    pub fn last_stats(&self) -> Stats {
        self.stats.clone()
    }

    /// Current statistics, refreshed at most every half second.
    pub fn stats(&mut self) -> Stats {
        let fresh = self
            .stats_at
            .is_some_and(|at| at.elapsed() < STATS_EVERY);
        if fresh {
            return self.stats.clone();
        }
        let now = Instant::now();
        self.stats_at = Some(now);
        let (width, height) = self.video_size();
        let mut stats = Stats {
            width,
            height,
            fps: self.measured_fps(),
            stall_recoveries: self.stall_recoveries,
            compressor_active: self.compressor.is_active(),
            ..Stats::default()
        };
        if let Some(engine) = &self.engine {
            let timing = engine.timing();
            stats.latency = timing.latency;
            stats.buffer = timing.buffer;
            if let (Some(start), Some(position)) = (
                self.relayed.as_ref().and_then(relay::Relayed::start_date_ms),
                engine.position(),
            ) {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0., |elapsed| elapsed.as_secs_f64() * 1000.);
                let seconds = (now - start) / 1000. - position;
                stats.broadcast_latency = (0.0..120.0).contains(&seconds).then_some(seconds);
            }
            stats.dropped_frames = engine.statistic(MF_MEDIA_ENGINE_STATISTIC_FRAMES_DROPPED);
            if let Some(bytes) = engine.statistic(MF_MEDIA_ENGINE_STATISTIC_BYTES_DOWNLOADED) {
                match self.bytes_sample {
                    Some((at, previous)) if bytes >= previous => {
                        let seconds = now.duration_since(at).as_secs_f64();
                        if seconds >= 2. {
                            self.stats.bitrate_kbps =
                                Some((bytes - previous) as f64 * 8. / 1000. / seconds);
                            self.bytes_sample = Some((now, bytes));
                        }
                    }
                    _ => self.bytes_sample = Some((now, bytes)),
                }
            }
            stats.bitrate_kbps = self.stats.bitrate_kbps;
        }
        self.stats = stats;
        self.stats.clone()
    }

    fn measured_fps(&self) -> f64 {
        let Some(newest) = self.frame_times.back() else {
            return 0.;
        };
        if newest.elapsed() > Duration::from_secs(1) {
            return 0.;
        }
        let window = newest.duration_since(*self.frame_times.front().unwrap());
        if window.is_zero() || self.frame_times.len() < 2 {
            return 0.;
        }
        (self.frame_times.len() - 1) as f64 / window.as_secs_f64()
    }

    /// Called on the UI/render thread; only a new decoder timestamp causes a draw.
    pub fn poll(&mut self, device: ID3D11Device) -> Result<Option<WindowsSurface>> {
        let now = Instant::now();
        // Polling stops while the window is hidden; that gap is not a freeze.
        if self
            .last_poll_at
            .is_none_or(|at| now.duration_since(at) > Duration::from_secs(1))
        {
            self.last_frame_at = now;
        }
        self.last_poll_at = Some(now);

        self.receive_lookup()?;
        if let Some(frame) = self.advance_incoming(&device) {
            return Ok(Some(frame));
        }
        let Some(source) = &self.source else {
            return Ok(None);
        };
        if self
            .engine
            .as_ref()
            .is_some_and(|engine| engine.device != device)
        {
            self.engine = None;
        }
        if self.engine.is_none() {
            // The relay lists nothing until live content arrives; a pre-roll
            // ad is a wait, not a failure.
            if let Some(relayed) = &self.relayed {
                if let Some(failure) = relayed.failure() {
                    bail!(failure);
                }
                if !relayed.ready() {
                    self.last_frame_at = now;
                    return Ok(None);
                }
            }
            // Through the relay, so playback starts near the live edge; the
            // direct playlist still works if the relay is unavailable.
            let url = self
                .relayed
                .as_ref()
                .map_or(source.url.as_str(), |relayed| relayed.url.as_str());
            if std::env::var_os("VIOLETWIRE_PLAYBACK_LOG").is_some() {
                eprintln!("[start] relay ready, creating engine at {} ms", self.started.elapsed().as_millis());
            }
            let engine = Engine::new(device, url, &self.compressor)?;
            if std::env::var_os("VIOLETWIRE_PLAYBACK_LOG").is_some() {
                eprintln!("[start] engine created at {} ms", self.started.elapsed().as_millis());
            }
            // SAFETY: plain property set on the new engine.
            unsafe {
                engine.engine().SetAutoPlay(!self.paused)?;
            }
            self.engine = Some(engine);
            self.engine_frames = 0;
            self.last_frame_at = now;
            self.set_audio(self.muted, self.volume);
            self.set_paused(self.paused);
        }
        let engine = self.engine.as_mut().unwrap();
        let error = engine.events.error.load(Ordering::Acquire);
        if error != 0 {
            // A decode error mid-stream (often an ad break's format change) is
            // worth one reconnect before giving up.
            if self.frames > 0 && self.watchdog != Watchdog::Reconnecting {
                self.reconnect()?;
                return Ok(None);
            }
            bail!("Windows could not decode this stream (media error {error}).");
        }
        if engine.events.ended.load(Ordering::Acquire) {
            bail!("The stream ended.");
        }
        let frame = engine.frame()?;
        if frame.is_some() {
            if log_enabled() {
                let gap = now.duration_since(self.last_frame_at);
                if gap > Duration::from_millis(150) {
                    eprintln!(
                        "[gap] {} ms without a frame, at t={:.1}s",
                        gap.as_millis(),
                        self.started.elapsed().as_secs_f64()
                    );
                }
            }
            self.first_frame_ms
                .get_or_insert_with(|| self.started.elapsed().as_millis());
            self.frames += 1;
            self.engine_frames += 1;
            self.reconnects_without_frames = 0;
            self.last_frame_at = now;
            self.watchdog = Watchdog::Watching;
            self.frame_times.push_back(now);
            while self
                .frame_times
                .front()
                .is_some_and(|at| now.duration_since(*at) > Duration::from_secs(1))
            {
                self.frame_times.pop_front();
            }
            self.keep_near_live(now);
        } else {
            self.watch_for_freeze(now)?;
        }
        if !self.paused
            && self.frames == 0
            && !self.waiting_for_stream()
            && self.started.elapsed() > Duration::from_secs(35)
        {
            bail!("GPU playback produced no frames.");
        }
        Ok(frame)
    }

    fn receive_lookup(&mut self) -> Result<()> {
        let Some((lookup, purpose, started)) = &self.lookup else {
            return Ok(());
        };
        let (purpose, started) = (*purpose, *started);
        let result = match lookup.result.try_recv() {
            Ok(result) => result,
            Err(mpsc::TryRecvError::Empty) if started.elapsed() < LOOKUP_TIMEOUT => return Ok(()),
            _ => Err(anyhow::anyhow!("Stream lookup timed out.")),
        };
        self.lookup = None;
        match result {
            Ok(resolved) => {
                if self.resolved_ms.is_none() {
                    self.resolved_ms = Some(self.started.elapsed().as_millis());
                }
                let relayed = match relay::register(&resolved.url) {
                    Ok(relayed) => Some(relayed),
                    Err(error) => {
                        eprintln!("Playlist relay unavailable: {error}");
                        None
                    }
                };
                if purpose == Purpose::Quality && self.engine.is_some() && !self.paused {
                    self.incoming = Some(Incoming {
                        source: resolved,
                        relayed,
                        engine: None,
                        since: Instant::now(),
                    });
                    return Ok(());
                }
                // A new playlist: the next poll builds an engine for it. The
                // old surface stays on screen until the first new frame.
                self.engine = None;
                self.incoming = None;
                self.relayed = relayed;
                // A quality the channel lacks falls back to the best one.
                self.requested_quality = resolved.quality.clone();
                self.source = Some(resolved);
                self.last_frame_at = Instant::now();
                if purpose == Purpose::Reconnect {
                    // Watch the rebuilt engine like any other.
                    self.watchdog = Watchdog::Watching;
                }
                Ok(())
            }
            // A failed quality change leaves the current stream playing.
            Err(_) if purpose == Purpose::Quality && self.engine.is_some() => {
                if let Some(source) = &self.source {
                    self.requested_quality = source.quality.clone();
                }
                Ok(())
            }
            Err(error) if purpose == Purpose::Reconnect => {
                Err(error.context("The stream stopped and could not be reconnected."))
            }
            Err(error) => Err(error),
        }
    }

    /// Builds and polls the engine for a pending quality change. Returns its
    /// first frame once it has taken over from the playing engine.
    fn advance_incoming(&mut self, device: &ID3D11Device) -> Option<WindowsSurface> {
        let incoming = self.incoming.as_mut()?;
        if incoming.engine.is_none() {
            let relay_failed = incoming
                .relayed
                .as_ref()
                .is_some_and(|relayed| relayed.failure().is_some());
            if relay_failed {
                self.abandon_incoming();
                return None;
            }
            if incoming.relayed.as_ref().is_some_and(|relayed| !relayed.ready()) {
                return None;
            }
            incoming.since = Instant::now();
            let url = incoming
                .relayed
                .as_ref()
                .map_or(incoming.source.url.as_str(), |relayed| relayed.url.as_str());
            match Engine::new(device.clone(), url, &self.compressor) {
                // Silent until it takes over.
                Ok(engine) => {
                    engine.apply_audio(true, 0.);
                    incoming.engine = Some(engine);
                }
                Err(_) => {
                    self.abandon_incoming();
                    return None;
                }
            }
        }
        let engine = incoming.engine.as_mut()?;
        let failed = engine.events.error.load(Ordering::Acquire) != 0
            || engine.events.ended.load(Ordering::Acquire)
            || incoming.since.elapsed() > FIRST_FRAME_GRACE;
        let frame = if failed { Err(()) } else { engine.frame().map_err(drop) };
        let frame = match frame {
            Ok(Some(frame)) => frame,
            Ok(None) => return None,
            Err(()) => {
                self.abandon_incoming();
                return None;
            }
        };
        let incoming = self.incoming.take()?;
        self.requested_quality = incoming.source.quality.clone();
        self.engine = incoming.engine;
        self.source = Some(incoming.source);
        self.relayed = incoming.relayed;
        self.engine_frames = 1;
        self.frames += 1;
        self.last_frame_at = Instant::now();
        self.watchdog = Watchdog::Watching;
        self.set_audio(self.muted, self.volume);
        Some(frame)
    }

    /// A quality change that failed leaves the current stream as it was.
    fn abandon_incoming(&mut self) {
        self.incoming = None;
        if let Some(source) = &self.source {
            self.requested_quality = source.quality.clone();
        }
    }

    /// Start near the live edge rather than the start of the playlist window,
    /// and catch up if playback falls behind (after a stall, say).
    fn keep_near_live(&mut self, now: Instant) {
        if self.paused {
            self.drifting_since = None;
            return;
        }
        let Some(engine) = &self.engine else {
            return;
        };
        let Some(latency) = engine.timing().latency else {
            return;
        };
        if log_enabled() && self.log_at.is_none_or(|at| now.duration_since(at) > Duration::from_secs(2)) {
            self.log_at = Some(now);
            let timing = engine.timing();
            // SAFETY: plain reads.
            let (current, seekable) = unsafe {
                let e = engine.engine();
                let r = e.GetSeekable().ok();
                (
                    e.GetCurrentTime(),
                    r.map(|r| (r.GetStart(0).unwrap_or(-1.), r.GetEnd(r.GetLength().saturating_sub(1)).unwrap_or(-1.))),
                )
            };
            eprintln!(
                "[playback] t={:.1} current={current:.2} seekable={seekable:?} latency={:.2}s buffer={:?} frames={} live_seeks={}",
                self.started.elapsed().as_secs_f64(),
                latency,
                timing.buffer.map(|b| (b * 100.).round() / 100.),
                self.frames,
                self.live_seeks,
            );
        }
        if latency > LIVE_CUSHION_SECONDS + DRIFT_SECONDS {
            let since = *self.drifting_since.get_or_insert(now);
            if now.duration_since(since) > DRIFT_FOR {
                engine.seek_to(LIVE_CUSHION_SECONDS);
                self.live_seeks += 1;
                self.drifting_since = None;
            }
        } else {
            self.drifting_since = None;
        }
    }

    fn watch_for_freeze(&mut self, now: Instant) -> Result<()> {
        if self.paused || self.frames == 0 || self.engine.is_none() || self.lookup.is_some() {
            return Ok(());
        }
        // During an ad break the playlist stops growing and the picture waits
        // for the stream to come back; that is not a freeze.
        if self.ad_break() {
            self.last_frame_at = now;
            self.watchdog = Watchdog::Watching;
            return Ok(());
        }
        let quiet = now.duration_since(self.last_frame_at);
        let allowed = if self.engine_frames == 0 {
            FIRST_FRAME_GRACE
        } else {
            FREEZE_AFTER
        };
        match self.watchdog {
            Watchdog::Watching if quiet > allowed => {
                self.stall_recoveries += 1;
                if let Some(engine) = &self.engine {
                    engine.seek_to_live();
                    // SAFETY: plain call on a live engine.
                    unsafe {
                        let _ = engine.engine().Play();
                    }
                }
                self.watchdog = Watchdog::ReturnedToLive(now);
            }
            Watchdog::ReturnedToLive(at) if now.duration_since(at) > RECONNECT_AFTER => {
                if self.reconnects_without_frames >= MAX_RECONNECTS {
                    bail!("The stream stopped and could not be recovered.");
                }
                self.stall_recoveries += 1;
                self.reconnect()?;
            }
            _ => {}
        }
        Ok(())
    }

    /// Fetches a fresh playlist (signed URLs can expire) and rebuilds the
    /// engine when it arrives.
    fn reconnect(&mut self) -> Result<()> {
        self.watchdog = Watchdog::Reconnecting;
        self.reconnects_without_frames += 1;
        self.lookup = Some((
            resolver::resolve_fresh(&self.login, &self.requested_quality)?,
            Purpose::Reconnect,
            Instant::now(),
        ));
        Ok(())
    }
}

fn log_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("VIOLETWIRE_PLAYBACK_LOG").is_some())
}

struct Timing {
    latency: Option<f64>,
    buffer: Option<f64>,
}

struct Engine {
    engine: Option<IMFMediaEngine>,
    device: ID3D11Device,
    _manager: IMFDXGIDeviceManager,
    events: Arc<Events>,
    surface: Option<WindowsSurface>,
    size: (u32, u32),
    _platform: MfPlatform,
}

struct MfPlatform;
impl Drop for MfPlatform {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
        }
    }
}

impl Engine {
    fn new(device: ID3D11Device, source: &str, compressor: &compressor::Switch) -> Result<Self> {
        // SAFETY: device and context are live COM references. Media Engine's
        // worker threads share this device with GPUI, so enable D3D locking.
        unsafe {
            let context = device.GetImmediateContext()?;
            let multithread: ID3D11Multithread = context.cast()?;
            let _ = multithread.SetMultithreadProtected(true);
            MFStartup(MF_VERSION, MFSTARTUP_FULL)?;
            Self::create(device, source, compressor, MfPlatform)
        }
    }

    fn engine(&self) -> &IMFMediaEngine {
        self.engine.as_ref().expect("engine is only taken on drop")
    }

    fn apply_audio(&self, muted: bool, volume: f64) {
        // SAFETY: plain property sets on a live engine.
        unsafe {
            let _ = self
                .engine()
                .SetMuted(muted || std::env::args().any(|a| a == "--mute-video"));
            let _ = self.engine().SetVolume(volume.clamp(0., 1.));
        }
    }

    unsafe fn create(
        device: ID3D11Device,
        source: &str,
        compressor: &compressor::Switch,
        platform: MfPlatform,
    ) -> Result<Self> {
        // SAFETY: all output pointers are initialized and COM parameters stay
        // alive through construction; failure unwinds their owned references.
        unsafe {
            let mut token = 0;
            let mut manager = None;
            MFCreateDXGIDeviceManager(&mut token, &mut manager)?;
            let manager = manager.context("Missing DXGI manager")?;
            manager.ResetDevice(&device, token)?;
            let mut attributes = None;
            MFCreateAttributes(&mut attributes, 3)?;
            let attributes = attributes.unwrap();
            let events = Arc::new(Events::default());
            let notify: IMFMediaEngineNotify = Notify(events.clone()).into();
            attributes.SetUnknown(&MF_MEDIA_ENGINE_CALLBACK, &notify)?;
            attributes.SetUnknown(&MF_MEDIA_ENGINE_DXGI_MANAGER, &manager)?;
            attributes.SetUINT32(
                &MF_MEDIA_ENGINE_VIDEO_OUTPUT_FORMAT,
                DXGI_FORMAT_B8G8R8A8_UNORM.0 as u32,
            )?;
            let factory: IMFMediaEngineClassFactory =
                CoCreateInstance(&CLSID_MFMediaEngineClassFactory, None, CLSCTX_INPROC_SERVER)?;
            let engine =
                // Not MF_MEDIA_ENGINE_REAL_TIME_MODE: its low-latency decoding
                // hands frames out without B-frame reordering, and streams that
                // use B-frames (sodapoppin's, for one) smeared into blocks. The
                // relay keeps latency low instead.
                factory.CreateInstance(0, &attributes)?;
            // Effects only take hold for sources loaded after insertion. It is
            // optional: if the audio format does not suit it, playback goes on.
            if let Ok(extended) = engine.cast::<IMFMediaEngineEx>() {
                let effect: IMFTransform = compressor::Compressor::new(compressor.clone()).into();
                let _ = extended.InsertAudioEffect(&effect, true);
            }
            let playback = Self {
                engine: Some(engine),
                device,
                _manager: manager,
                events,
                surface: None,
                size: (0, 0),
                _platform: platform,
            };
            let engine = playback.engine();
            engine.SetAutoPlay(true)?;
            engine.SetMuted(std::env::args().any(|arg| arg == "--mute-video"))?;
            engine.SetSource(&BSTR::from(source))?;
            engine.Load()?;
            Ok(playback)
        }
    }

    fn seek_to_live(&self) {
        self.seek_to(LIVE_CUSHION_SECONDS);
    }

    /// Seeks to `behind` seconds before the newest media.
    fn seek_to(&self, behind: f64) {
        // SAFETY: plain reads and a seek on a live engine.
        unsafe {
            let engine = self.engine();
            if let Ok(range) = engine.GetSeekable() {
                let n = range.GetLength();
                if n > 0
                    && let Ok(start) = range.GetStart(n - 1)
                    && let Ok(end) = range.GetEnd(n - 1)
                    && end.is_finite()
                    && end > behind
                {
                    let target = (end - behind).max(start);
                    let before = engine.GetCurrentTime();
                    let result = engine.SetCurrentTime(target);
                    if log_enabled() {
                        let buffered = engine.GetBuffered().ok().map(|r| {
                            (0..r.GetLength())
                                .filter_map(|i| Some((r.GetStart(i).ok()?, r.GetEnd(i).ok()?)))
                                .collect::<Vec<_>>()
                        });
                        eprintln!(
                            "[seek] seekable={start:.2}..{end:.2} current={before:.2} target={target:.2} ok={} seeking={} after={:.2} buffered={buffered:?} rate={}",
                            result.is_ok(),
                            engine.IsSeeking().as_bool(),
                            engine.GetCurrentTime(),
                            engine.GetPlaybackRate(),
                        );
                    }
                }
            }
        }
    }

    fn position(&self) -> Option<f64> {
        // SAFETY: plain read on a live engine.
        let now = unsafe { self.engine().GetCurrentTime() };
        now.is_finite().then_some(now)
    }

    fn timing(&self) -> Timing {
        // SAFETY: plain reads on a live engine.
        unsafe {
            let engine = self.engine();
            let now = engine.GetCurrentTime();
            let end_of = |range: windows::core::Result<IMFMediaTimeRange>| {
                range.ok().and_then(|range| {
                    let n = range.GetLength();
                    (n > 0)
                        .then(|| range.GetEnd(n - 1).ok())
                        .flatten()
                        .filter(|end| end.is_finite())
                })
            };
            let ahead = |end: Option<f64>| end.map(|end| (end - now).max(0.)).filter(|_| now.is_finite());
            Timing {
                latency: ahead(end_of(engine.GetSeekable())),
                buffer: ahead(end_of(engine.GetBuffered())),
            }
        }
    }

    fn statistic(&self, which: MF_MEDIA_ENGINE_STATISTIC) -> Option<u64> {
        // SAFETY: GetStatistics fills a PROPVARIANT this function owns.
        unsafe {
            let extended = self.engine().cast::<IMFMediaEngineEx>().ok()?;
            let value = extended.GetStatistics(which).ok()?;
            u64::try_from(&value).ok()
        }
    }

    fn frame(&mut self) -> Result<Option<WindowsSurface>> {
        // SAFETY: ticks and transfers run on GPUI's thread, into a texture
        // allocated on its render device. No CPU mapping or staging textures.
        unsafe {
            let engine = self.engine();
            let mut timestamp = 0;
            let result = (engine.vtable().OnVideoStreamTick)(engine.as_raw(), &mut timestamp);
            // The generated wrapper treats S_FALSE as success. It means there
            // is no new frame, and must not trigger a redraw or transfer.
            if result == HRESULT(1) {
                return Ok(None);
            }
            result.ok()?;
            let (mut width, mut height) = (0, 0);
            engine.GetNativeVideoSize(Some(&mut width), Some(&mut height))?;
            if width == 0 || height == 0 {
                return Ok(None);
            }
            if self.size != (width, height) {
                let mut texture = None;
                self.device.CreateTexture2D(
                    &D3D11_TEXTURE2D_DESC {
                        Width: width,
                        Height: height,
                        MipLevels: 1,
                        ArraySize: 1,
                        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                        SampleDesc: DXGI_SAMPLE_DESC {
                            Count: 1,
                            Quality: 0,
                        },
                        Usage: D3D11_USAGE_DEFAULT,
                        BindFlags: (D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET).0 as u32,
                        ..Default::default()
                    },
                    None,
                    Some(&mut texture),
                )?;
                self.surface = Some(WindowsSurface::new(texture.unwrap())?);
                self.size = (width, height);
            }
            let surface = self.surface.as_ref().unwrap();
            let engine = self.engine();
            // Windows performs YUV -> BGRA on the GPU into the texture GPUI samples.
            engine.TransferVideoFrame(
                surface.texture(),
                None,
                &RECT {
                    left: 0,
                    top: 0,
                    right: width as i32,
                    bottom: height as i32,
                },
                None,
            )?;
            Ok(Some(surface.clone()))
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // SAFETY: shutdown stops callbacks and decode work before device/texture
        // references are released, then balances this instance's MFStartup.
        unsafe {
            if let Some(engine) = self.engine.take() {
                let _ = engine.Shutdown();
                drop(engine);
            }
            self.surface = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::{Foundation::HMODULE, Graphics::Direct3D::D3D_DRIVER_TYPE_WARP};

    #[test]
    fn rejects_invalid_channels_before_launching_any_process() {
        assert!(GpuPlayback::new("../not-a-channel", "best", false).is_err());
        assert!(GpuPlayback::new("channel --extra-option", "best", false).is_err());
    }

    #[test]
    fn callback_records_only_error_and_ended_events() {
        let events = Arc::new(Events::default());
        let notify: IMFMediaEngineNotify = Notify(events.clone()).into();
        unsafe {
            notify
                .EventNotify(MF_MEDIA_ENGINE_EVENT_CANPLAY.0 as u32, 0, 0)
                .unwrap();
            assert_eq!(events.error.load(Ordering::Acquire), 0);
            notify
                .EventNotify(MF_MEDIA_ENGINE_EVENT_ERROR.0 as u32, 3, 0)
                .unwrap();
            notify
                .EventNotify(MF_MEDIA_ENGINE_EVENT_ENDED.0 as u32, 0, 0)
                .unwrap();
        }
        assert_eq!(events.error.load(Ordering::Acquire), 3);
        assert!(events.ended.load(Ordering::Acquire));
    }

    #[test]
    fn gpu_surface_wraps_shader_readable_bgra_and_rejects_other_formats() {
        // WARP makes this deterministic without depending on a particular GPU.
        unsafe {
            let mut device = None;
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_WARP,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )
            .unwrap();
            let device = device.unwrap();
            for format in [DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R8G8B8A8_UNORM] {
                let mut texture = None;
                device
                    .CreateTexture2D(
                        &D3D11_TEXTURE2D_DESC {
                            Width: 2,
                            Height: 2,
                            MipLevels: 1,
                            ArraySize: 1,
                            Format: format,
                            SampleDesc: DXGI_SAMPLE_DESC {
                                Count: 1,
                                Quality: 0,
                            },
                            Usage: D3D11_USAGE_DEFAULT,
                            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
                            ..Default::default()
                        },
                        None,
                        Some(&mut texture),
                    )
                    .unwrap();
                let surface = WindowsSurface::new(texture.unwrap());
                if format == DXGI_FORMAT_B8G8R8A8_UNORM {
                    assert!(surface.unwrap().belongs_to(&device));
                } else {
                    assert!(surface.is_err());
                }
            }
        }
    }
}
