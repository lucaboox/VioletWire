//! The video view and its control bar.
//!
//! GPU playback (Windows Media Engine) draws a new frame only when the decoder
//! has one. The bar mirrors the Electron player: play/pause, mute, volume, the
//! volume normaliser, the live indicator, video stats with the latency read-out,
//! stream quality, chat layout, theater and fullscreen.

use gpui::AnimationExt;
use std::sync::Arc;

use gpui::{
    AnyElement, App, Context, EntityId, FontWeight, ImageSource, ObjectFit, Render, RenderImage,
    SharedString, Window, div, img, prelude::*, px, rgb, rgba,
};

use crate::format::{compact_count, quality_label, sort_qualities};
use crate::playback::gpu::{GpuPlayback, Stats};
use crate::playback::{Pipeline, Watch};
use crate::preferences::Preferences;
use crate::theme;
use crate::ui::{self, Icon};

#[derive(Clone)]
pub enum PlayerAction {
    Settings,
    Chat,
    Overlay,
    Theater,
}
impl gpui::EventEmitter<PlayerAction> for Player {}

/// Past this many seconds behind the newest media, the indicator says
/// "Behind live" and offers to jump forward.
const BEHIND_LIVE_SECONDS: f64 = 9.0;
/// The same against the latency to the broadcaster.
const BEHIND_BROADCAST_SECONDS: f64 = 12.0;

pub struct Player {
    focus: Option<gpui::FocusHandle>,
    controls_hovered: bool,
    controls_width: f32,
    presentation: (bool, bool, bool),
    controls_hide_delay: std::time::Duration,
    paused: bool,
    muted: bool,
    volume: f64,
    compression: bool,
    fps_overlay: bool,
    quality_menu: bool,
    stats_open: bool,
    stats_hovered: bool,
    controls_visible: bool,
    last_pointer: std::time::Instant,
    controls_task: Option<gpui::Task<()>>,
    volume_bounds: std::rc::Rc<std::cell::Cell<Option<gpui::Bounds<gpui::Pixels>>>>,
    poll_scheduled: bool,
    /// Bumped to abandon a scheduled poll. Upstream GPUI dropped next-frame
    /// callbacks when a frame was requested during an update: Media Engine's
    /// COM calls (mute, volume) pump messages on this thread. A lost poll left
    /// the picture frozen while the sound played. The vendored GPUI now keeps
    /// them (see vendor/GPUI-PATCH.md); this remains a safety net.
    poll_generation: u64,
    last_polled: std::time::Instant,
    login: String,
    gpu: Option<GpuPlayback>,
    gpu_frame: Option<gpui::WindowsSurface>,
    pipeline: Option<Pipeline>,
    frame: Option<Arc<RenderImage>>,
    failure: Option<SharedString>,
}

impl Player {
    pub fn configure(&mut self, preferences: &Preferences) {
        self.volume = f64::from(preferences.player_volume) / 100.;
        self.controls_hide_delay =
            std::time::Duration::from_millis(u64::from(preferences.controls_hide_delay));
        self.compression = preferences.audio_compression;
        self.fps_overlay = preferences.show_fps_overlay;
        if let Some(gpu) = &mut self.gpu {
            gpu.set_compression(self.compression);
        }
        self.apply_audio();
    }
    pub fn set_controls_delay(&mut self, delay: u16) {
        self.controls_hide_delay = std::time::Duration::from_millis(u64::from(delay));
    }
    pub fn keep_controls_visible(&mut self) {
        self.controls_visible = true;
        self.last_pointer = std::time::Instant::now();
    }
    /// For the hidden UI probe: show the stats panel or the quality menu.
    pub fn probe_menus(&mut self, stats: bool, quality: bool) {
        self.stats_open = stats;
        self.quality_menu = quality;
    }
    pub fn probe_succeeded(&self) -> bool {
        self.gpu.as_ref().is_some_and(|gpu| gpu.frames > 0)
            || (self
                .pipeline
                .as_ref()
                .is_some_and(|pipeline| pipeline.is_playing())
                && self.frame.is_some())
    }
    pub fn probe_tick(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.gpu.is_some() {
            let before = self.gpu.as_ref().unwrap().frames;
            self.poll_gpu(window, cx);
            self.gpu.as_ref().is_none_or(|gpu| gpu.frames != before)
        } else if self.pipeline.is_some() {
            let changed = self.pipeline.as_ref().unwrap().watch().changed();
            if changed {
                cx.notify();
            }
            changed
        } else {
            false
        }
    }
    /// For the bounded playback probe: switch quality as a click would, but
    /// without saving it as the user's preference.
    pub fn probe_select_quality(&mut self, quality: &str, cx: &mut Context<Self>) {
        if let Some(gpu) = &mut self.gpu {
            let _ = gpu.set_quality(quality);
        }
        cx.notify();
    }

    pub fn diagnostics(&self) -> String {
        if let Some(gpu) = &self.gpu {
            let (width, height) = gpu.video_size();
            let stats = gpu.last_stats();
            format!(
                "backend=gpu frames={} size={width}x{height} cpu_frame_uploads=0 resolved_ms={:?} first_frame_ms={:?} quality={} latency={:?} broadcast={:?} buffer={:?} dropped={:?} recoveries={} compressor_active={}",
                gpu.frames,
                gpu.resolved_ms,
                gpu.first_frame_ms,
                gpu.quality(),
                stats.latency,
                stats.broadcast_latency,
                stats.buffer,
                stats.dropped_frames,
                stats.stall_recoveries,
                stats.compressor_active,
            )
        } else if let Some(pipeline) = &self.pipeline {
            format!("backend=cpu playing={}", pipeline.is_playing())
        } else {
            format!(
                "backend=failed error={}",
                self.failure
                    .as_deref()
                    .map(|s| s.as_ref())
                    .unwrap_or("none")
            )
        }
    }

    fn blank(login: &str) -> Self {
        Self {
            focus: None,
            controls_hovered: false,
            controls_width: 0.,
            presentation: (true, false, false),
            controls_hide_delay: std::time::Duration::from_millis(5000),
            paused: false,
            muted: false,
            volume: 1.,
            compression: false,
            fps_overlay: false,
            quality_menu: false,
            stats_open: false,
            stats_hovered: false,
            controls_visible: true,
            last_pointer: std::time::Instant::now(),
            controls_task: None,
            volume_bounds: Default::default(),
            poll_scheduled: false,
            poll_generation: 0,
            last_polled: std::time::Instant::now(),
            login: login.to_owned(),
            gpu: None,
            gpu_frame: None,
            pipeline: None,
            frame: None,
            failure: None,
        }
    }

    pub fn new(login: &str, preferences: &Preferences) -> Self {
        let mut player = Self::blank(login);
        let probe = std::env::args().any(|arg| arg == "--video-probe-seconds");
        if !std::env::args().any(|arg| arg == "--cpu-video") {
            match GpuPlayback::new(
                login,
                &preferences.player_quality,
                preferences.audio_compression,
            ) {
                Ok(gpu) => {
                    player.gpu = Some(gpu);
                    player.configure(preferences);
                    return player;
                }
                Err(error) if probe => {
                    player.failure = Some(error.to_string().into());
                    return player;
                }
                Err(error) => eprintln!("GPU video unavailable: {error}. Using CPU video."),
            }
        }
        match Pipeline::start(login) {
            Ok(pipeline) => player.pipeline = Some(pipeline),
            Err(error) => player.failure = Some(error.to_string().into()),
        }
        player.configure(preferences);
        player
    }

    fn schedule_gpu_poll(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.poll_scheduled || self.gpu.is_none() {
            return;
        }
        self.poll_scheduled = true;
        let generation = self.poll_generation;
        let view = cx.entity().downgrade();
        window.on_next_frame(move |window, cx| {
            let _ = view.update(cx, |player, cx| {
                // A newer poll replaced this one.
                if player.poll_generation != generation {
                    return;
                }
                player.poll_scheduled = false;
                player.poll_gpu(window, cx);
            });
        });
    }

    fn poll_gpu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.last_polled = std::time::Instant::now();
        let Some(gpu) = &mut self.gpu else {
            return;
        };
        let switching = gpu.switching();
        let result = window
            .d3d11_device()
            .ok_or_else(|| anyhow::anyhow!("No D3D11 device"))
            .and_then(|device| {
                if self
                    .gpu_frame
                    .as_ref()
                    .is_some_and(|frame| !frame.belongs_to(&device))
                {
                    self.gpu_frame = None;
                    cx.notify();
                }
                gpu.poll(device)
            });
        if gpu.switching() != switching {
            cx.notify();
        }
        match result {
            Ok(Some(frame)) => {
                self.gpu_frame = Some(frame);
                cx.notify();
            }
            Ok(None) => {}
            Err(error) => {
                let ended = gpu.ended();
                let probe = std::env::args().any(|arg| arg == "--video-probe-seconds");
                eprintln!("GPU video stopped: {error}.");
                self.gpu = None;
                self.gpu_frame = None;
                if probe || ended {
                    self.failure = Some(error.to_string().into());
                } else {
                    eprintln!("Using CPU compatibility playback.");
                    match Pipeline::start(&self.login) {
                        Ok(pipeline) => {
                            pipeline.set_audio(self.muted, self.volume);
                            pipeline.set_paused(self.paused);
                            self.pipeline = Some(pipeline);
                        }
                        Err(error) => self.failure = Some(error.to_string().into()),
                    }
                }
                cx.notify();
            }
        }
        self.schedule_gpu_poll(window, cx);
    }

    pub fn toggle_pause(&mut self, cx: &mut Context<Self>) {
        self.paused = !self.paused;
        self.controls_visible = true;
        if let Some(gpu) = &mut self.gpu {
            if self.paused {
                gpu.set_paused(true);
            } else {
                gpu.go_live();
            }
        }
        if let Some(cpu) = &self.pipeline {
            cpu.set_paused(self.paused);
        }
        cx.notify();
    }
    pub fn set_presentation(
        &mut self,
        chat: bool,
        overlay: bool,
        theater: bool,
        cx: &mut Context<Self>,
    ) {
        let mode = (chat, overlay, theater);
        if self.presentation != mode {
            self.presentation = mode;
            cx.notify();
        }
    }
    pub fn toggle_mute(&mut self, cx: &mut Context<Self>) {
        self.muted = !self.muted;
        self.apply_audio();
        cx.notify();
    }
    pub fn change_volume(&mut self, delta: f64, cx: &mut Context<Self>) {
        self.volume = (self.volume + delta).clamp(0., 1.);
        if self.volume > 0. {
            self.muted = false;
        }
        self.apply_audio();
        self.save_volume(cx);
        cx.notify();
    }
    fn apply_audio(&mut self) {
        if let Some(gpu) = &mut self.gpu {
            gpu.set_audio(self.muted, self.volume);
        }
        if let Some(cpu) = &self.pipeline {
            cpu.set_audio(self.muted, self.volume);
        }
    }
    fn save_volume(&self, cx: &mut Context<Self>) {
        crate::preferences::update(cx, |prefs| {
            prefs.player_volume = (self.volume * 100.).round() as u8
        });
    }
    fn toggle_compression(&mut self, cx: &mut Context<Self>) {
        self.compression = !self.compression;
        if let Some(gpu) = &mut self.gpu {
            gpu.set_compression(self.compression);
        }
        let enabled = self.compression;
        crate::preferences::update(cx, |prefs| prefs.audio_compression = enabled);
        cx.notify();
    }
    fn set_fps_overlay(&mut self, enabled: bool, cx: &mut Context<Self>) {
        self.fps_overlay = enabled;
        crate::preferences::update(cx, |prefs| prefs.show_fps_overlay = enabled);
        cx.notify();
    }
    fn select_quality(&mut self, quality: String, cx: &mut Context<Self>) {
        self.quality_menu = false;
        if let Some(gpu) = &mut self.gpu
            && let Err(error) = gpu.set_quality(&quality)
        {
            eprintln!("Quality change failed: {error}");
        }
        crate::preferences::update(cx, |prefs| prefs.player_quality = quality);
        cx.notify();
    }
    pub fn go_live(&mut self, cx: &mut Context<Self>) {
        self.paused = false;
        if let Some(gpu) = &mut self.gpu {
            gpu.go_live();
        } else if self.pipeline.is_some() {
            self.pipeline = None;
            match Pipeline::start(&self.login) {
                Ok(pipeline) => {
                    pipeline.set_audio(self.muted, self.volume);
                    self.pipeline = Some(pipeline);
                }
                Err(error) => self.failure = Some(error.to_string().into()),
            }
        }
        cx.notify();
    }

    fn quality_text(&self) -> String {
        let Some(gpu) = &self.gpu else {
            return "Auto".into();
        };
        let quality = gpu.quality();
        if quality == "best" {
            match gpu.video_size() {
                (_, 0) => "Auto".into(),
                (_, height) => format!("Auto ({height}p)"),
            }
        } else {
            quality_label(quality)
        }
    }

    fn volume_slider(&self, width: f32, cx: &Context<Self>) -> AnyElement {
        let bounds = self.volume_bounds.clone();
        let down = self.volume_bounds.clone();
        let drag = self.volume_bounds.clone();
        div()
            .id("volume-slider")
            .w(px(width))
            .h(px(22.))
            .flex_none()
            .cursor_pointer()
            .relative()
            .child(
                gpui::canvas(
                    move |rect, _, _| {
                        bounds.set(Some(rect));
                    },
                    |_, _, _, _| {},
                )
                .size_full(),
            )
            .child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .top(px(9.))
                    .h(px(4.))
                    .rounded_full()
                    .bg(rgba(0xffffff40))
                    .child(
                        div()
                            .h_full()
                            .w(gpui::relative(if self.muted { 0. } else { self.volume as f32 }))
                            .rounded_full()
                            .bg(theme::violet_hover()),
                    ),
            )
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(move |this, event: &gpui::MouseDownEvent, _, cx| {
                    if let Some(b) = down.get() {
                        this.volume =
                            f64::from(((event.position.x - b.left()) / b.size.width).clamp(0., 1.));
                        this.muted = false;
                        this.apply_audio();
                        this.save_volume(cx);
                        cx.notify();
                    }
                    cx.stop_propagation();
                }),
            )
            .on_mouse_move(
                cx.listener(move |this, event: &gpui::MouseMoveEvent, _, cx| {
                    if event.pressed_button == Some(gpui::MouseButton::Left)
                        && let Some(b) = drag.get()
                    {
                        this.volume =
                            f64::from(((event.position.x - b.left()) / b.size.width).clamp(0., 1.));
                        this.muted = false;
                        this.apply_audio();
                        this.save_volume(cx);
                        cx.notify();
                    }
                }),
            )
            .into_any_element()
    }

    fn controls(&self, stats: Option<&Stats>, window: &Window, cx: &Context<Self>) -> AnyElement {
        let width = self.controls_width;
        let wide = width >= 480.;
        // Latency to the broadcaster when Twitch's timestamps allow it.
        let behind = self.paused
            || stats.is_some_and(|stats| match stats.broadcast_latency {
                Some(seconds) => seconds > BEHIND_BROADCAST_SECONDS,
                None => stats.latency.is_some_and(|latency| latency > BEHIND_LIVE_SECONDS),
            });
        let live_label = if self.paused {
            "Paused"
        } else if behind {
            "Behind live"
        } else {
            "Live"
        };
        let compression_hint = if self.compression {
            "Disable audio compression"
        } else {
            "Enable audio compression"
        };
        div()
            .id("video-controls")
            .absolute()
            .left_0()
            .right_0()
            .bottom_0()
            .h(px(78.))
            .pt(px(28.))
            .px(px(10.))
            .flex()
            .items_center()
            .gap(px(6.))
            .bg(gpui::linear_gradient(
                180.,
                gpui::linear_color_stop(rgba(0x03030500), 0.),
                gpui::linear_color_stop(rgba(0x040406f0), 1.),
            ))
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                this.controls_hovered = *hovered;
                this.last_pointer = std::time::Instant::now();
                cx.notify();
            }))
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down(gpui::MouseButton::Middle, |_, _, cx| cx.stop_propagation())
            .child(
                ui::video_button(
                    "pause",
                    if self.paused { Icon::Play } else { Icon::Pause },
                    if self.paused {
                        "Play and return to live · Space"
                    } else {
                        "Pause · Space"
                    },
                    false,
                )
                .on_click(cx.listener(|this, _, _, cx| this.toggle_pause(cx))),
            )
            .child(
                ui::video_button(
                    "mute",
                    if self.muted || self.volume == 0. {
                        Icon::Muted
                    } else {
                        Icon::Volume
                    },
                    if self.muted || self.volume == 0. {
                        "Unmute · M"
                    } else {
                        "Mute · M"
                    },
                    false,
                )
                .on_click(cx.listener(|this, _, _, cx| this.toggle_mute(cx))),
            )
            .child(self.volume_slider(if width >= 620. { 105. } else { 64. }, cx))
            .when(width >= 680., |bar| {
                bar.child(
                    div()
                        .w(px(32.))
                        .flex_none()
                        .text_size(px(10.))
                        .text_color(rgb(0xa1a1aa))
                        .child(format!("{}%", (self.volume * 100.).round())),
                )
            })
            .when(self.gpu.is_some(), |bar| {
                bar.child(
                    ui::video_button(
                        "compression",
                        if self.compression {
                            Icon::AudioLines
                        } else {
                            Icon::AudioLinesOff
                        },
                        compression_hint,
                        false,
                    )
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_compression(cx))),
                )
            })
            .child(div().flex_1())
            .when(width >= 360., |bar| {
                bar.child(
                    div()
                        .id("live-state")
                        .flex_none()
                        .h(px(25.))
                        .px_1()
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .text_size(px(10.))
                        .font_weight(FontWeight::BOLD)
                        .text_color(if behind { rgb(0xa1a1aa) } else { rgb(0xf4f4f5) })
                        .when(!behind, |state| {
                            state.child(div().size(px(6.)).rounded_full().bg(rgb(0xef4444)))
                        })
                        .child(live_label)
                        .when(behind, |state| {
                            state
                                .cursor_pointer()
                                .rounded(px(6.))
                                .hover(|style| style.text_color(rgb(0xffffff)))
                                .tooltip(|_, cx| {
                                    cx.new(|_| ui::Tooltip("Return to live · G".into())).into()
                                })
                                .on_click(cx.listener(|this, _, _, cx| this.go_live(cx)))
                        }),
                )
            })
            .when(self.gpu.is_some(), |bar| {
                bar.child(self.stats_button(stats, width >= 520., cx))
            })
            .when(self.gpu.is_some(), |bar| {
                bar.child(
                    ui::video_button("quality", Icon::Quality, "Stream quality", self.quality_menu)
                        .w_auto()
                        .px(px(9.))
                        .gap(px(6.))
                        .when(width >= 560., |button| {
                            button.child(
                                div()
                                    .text_size(px(10.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme::text())
                                    .child(self.quality_text()),
                            )
                        })
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.quality_menu = !this.quality_menu;
                            this.stats_hovered = false;
                            cx.notify();
                        })),
                )
            })
            .child(
                ui::video_button("chat", Icon::Chat, "Toggle chat · C", self.presentation.0)
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(PlayerAction::Chat))),
            )
            .when(wide, |bar| {
                bar.child(
                    ui::video_button(
                        "overlay-chat",
                        Icon::Overlay,
                        if self.presentation.1 {
                            "Disable chat overlay · O"
                        } else {
                            "Enable chat overlay · O"
                        },
                        self.presentation.1,
                    )
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(PlayerAction::Overlay))),
                )
            })
            .when(wide, |bar| {
                bar.child(
                    ui::video_button(
                        "theater",
                        Icon::Theater,
                        "Theater mode · T",
                        self.presentation.2,
                    )
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(PlayerAction::Theater))),
                )
            })
            .child(
                ui::video_button(
                    "fullscreen",
                    if window.is_fullscreen() {
                        Icon::ExitFullscreen
                    } else {
                        Icon::Fullscreen
                    },
                    if window.is_fullscreen() {
                        "Exit fullscreen · F"
                    } else {
                        "Fullscreen · F"
                    },
                    false,
                )
                .on_click(cx.listener(|_, _, window, cx| {
                    window.toggle_fullscreen();
                    cx.notify();
                })),
            )
            .into_any_element()
    }

    /// Gauge plus the latency read-out; hover for a summary, click for the panel.
    fn stats_button(&self, stats: Option<&Stats>, show_latency: bool, cx: &Context<Self>) -> AnyElement {
        let latency = stats
            .and_then(|stats| stats.broadcast_latency.or(stats.latency))
            .map(|latency| format!("{latency:.2}s"));
        let label = latency.clone();
        div()
            .relative()
            .flex_none()
            .child(
                div()
                    .id("stats")
                    .h(px(34.))
                    .min_w(px(34.))
                    .px(px(8.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .gap(px(5.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(rgba(0))
                    .cursor_pointer()
                    .hover(|style| style.bg(rgba(0x23232ae0)).border_color(rgba(0xffffff26)))
                    .child(ui::icon(Icon::Gauge, 17.).text_color(theme::text()))
                    .when_some(label.filter(|_| show_latency), |button, text| {
                        button.child(
                            div()
                                .text_size(px(10.))
                                .font_weight(FontWeight::BOLD)
                                .text_color(theme::text())
                                .child(text),
                        )
                    })
                    .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                        this.stats_hovered = *hovered;
                        cx.notify();
                    }))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.stats_open = !this.stats_open;
                        this.stats_hovered = false;
                        this.quality_menu = false;
                        cx.notify();
                    })),
            )
            .when(self.stats_hovered && !self.stats_open, |control| {
                control.child(
                    div()
                        .absolute()
                        .right_0()
                        .bottom(px(40.))
                        .w(px(238.))
                        .rounded(px(10.))
                        .border_1()
                        .border_color(rgba(0xffffff24))
                        .bg(rgba(0x141417f7))
                        .shadow_lg()
                        .child(
                            div()
                                .px_3()
                                .pt(px(10.))
                                .pb(px(8.))
                                .text_size(px(13.))
                                .font_weight(FontWeight::BOLD)
                                .child("Video Player Stats"),
                        )
                        .child(match stats {
                            Some(stats) => stat_rows(&self.stat_values(stats), 12., true)
                                .px_3()
                                .pb(px(11.))
                                .into_any_element(),
                            None => div()
                                .px_3()
                                .pb_3()
                                .text_size(px(12.))
                                .text_color(rgb(0xa1a1aa))
                                .child("Measuring playback…")
                                .into_any_element(),
                        }),
                )
            })
            .into_any_element()
    }

    fn stat_values(&self, stats: &Stats) -> Vec<(&'static str, String)> {
        let seconds = |value: Option<f64>| {
            value.map_or_else(|| "Measuring".into(), |value| format!("{value:.2}s"))
        };
        let normaliser = if !self.compression {
            "Off".into()
        } else if stats.compressor_active {
            "On".into()
        } else {
            "Waiting for audio".into()
        };
        vec![
            ("Latency to broadcaster", seconds(stats.broadcast_latency)),
            ("Latency", seconds(stats.latency)),
            ("Buffer size", seconds(stats.buffer)),
            (
                "Resolution",
                if stats.height == 0 {
                    "Measuring".into()
                } else {
                    format!("{} × {}", stats.width, stats.height)
                },
            ),
            ("Framerate", format!("{:.0}", stats.fps)),
            (
                "Bitrate",
                stats
                    .bitrate_kbps
                    .map_or_else(|| "Measuring".into(), |kbps| format!("{} kbps", compact_count(kbps.round() as u64))),
            ),
            (
                "Dropped frames",
                stats
                    .dropped_frames
                    .map_or_else(|| "–".into(), |dropped| dropped.to_string()),
            ),
            ("Quality", self.quality_text()),
            ("Stall recoveries", stats.stall_recoveries.to_string()),
            (
                "Ad segments skipped",
                self.gpu.as_ref().map_or(0, GpuPlayback::ads_skipped).to_string(),
            ),
            ("Audio compression", normaliser),
            ("Video", "Windows Media Engine (GPU)".into()),
        ]
    }

    fn stats_panel(&self, stats: Option<&Stats>, cx: &Context<Self>) -> AnyElement {
        let checked = self.fps_overlay;
        div()
            .id("stats-panel")
            .absolute()
            .top(px(14.))
            .left(px(14.))
            .w(px(272.))
            .rounded(px(11.))
            .border_1()
            .border_color(rgba(0xffffff1f))
            .bg(rgba(0x0f0f12f5))
            .shadow_lg()
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down(gpui::MouseButton::Middle, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .pl(px(13.))
                    .pr(px(8.))
                    .py(px(8.))
                    .border_b_1()
                    .border_color(rgba(0xffffff1a))
                    .child(
                        div()
                            .text_size(px(12.))
                            .font_weight(FontWeight::BOLD)
                            .child("VIDEO PLAYER STATS"),
                    )
                    .child(
                        ui::video_button("close-stats", Icon::Close, "Close video stats", false)
                            .size(px(26.))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.stats_open = false;
                                cx.notify();
                            })),
                    ),
            )
            .child(match stats {
                Some(stats) => stat_rows(&self.stat_values(stats), 13., false)
                    .px(px(13.))
                    .pt(px(11.))
                    .pb(px(13.))
                    .into_any_element(),
                None => div()
                    .p(px(13.))
                    .text_size(px(12.))
                    .text_color(rgb(0xa1a1aa))
                    .child("Stats are only available on GPU playback.")
                    .into_any_element(),
            })
            .child(
                div()
                    .id("fps-toggle")
                    .flex()
                    .items_center()
                    .gap_2()
                    .px(px(13.))
                    .py(px(11.))
                    .border_t_1()
                    .border_color(rgb(0x26262d))
                    .text_size(px(12.))
                    .text_color(theme::text_secondary())
                    .cursor_pointer()
                    .child(
                        div()
                            .size(px(15.))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(4.))
                            .border_1()
                            .border_color(if checked { theme::violet() } else { rgb(0x52525b) })
                            .bg(if checked { theme::violet() } else { rgba(0) })
                            .when(checked, |box_| {
                                box_.child(ui::icon(Icon::Check, 11.).text_color(rgb(0xffffff)))
                            }),
                    )
                    .child("Show FPS in the corner")
                    .on_click(cx.listener(move |this, _, _, cx| this.set_fps_overlay(!checked, cx))),
            )
            .into_any_element()
    }

    fn quality_menu(&self, cx: &Context<Self>) -> AnyElement {
        let Some(gpu) = &self.gpu else {
            return div().into_any_element();
        };
        let current = gpu.quality().to_owned();
        let mut names: Vec<String> = gpu
            .qualities()
            .iter()
            .filter(|name| *name != "best" && *name != "worst")
            .cloned()
            .collect();
        sort_qualities(&mut names);
        names.insert(0, "best".into());
        let loading = gpu.qualities().is_empty();
        div()
            .id("quality-menu")
            .absolute()
            .right(px(if self.presentation.0 && self.presentation.1 { 370. } else { 112. }))
            .bottom(px(58.))
            .w(px(230.))
            .rounded(px(11.))
            .border_1()
            .border_color(rgba(0xffffff1f))
            .bg(rgba(0x151519f7))
            .shadow_lg()
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down(gpui::MouseButton::Middle, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .px_3()
                    .pt_3()
                    .pb(px(9.))
                    .border_b_1()
                    .border_color(rgba(0xffffff14))
                    .child(
                        div()
                            .text_size(px(12.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(rgb(0xfafafa))
                            .child("Stream quality"),
                    )
                    .child(
                        div()
                            .mt(px(3.))
                            .text_size(px(10.))
                            .text_color(rgb(0x8b8b95))
                            .child(if loading {
                                "Loading this channel's qualities…"
                            } else {
                                "Changing quality briefly reconnects playback."
                            }),
                    ),
            )
            .child(
                div()
                    .id("quality-options")
                    .max_h(px(252.))
                    .overflow_y_scroll()
                    .p(px(6.))
                    .flex()
                    .flex_col()
                    .children(names.into_iter().map(|name| {
                        let selected = name == current;
                        let label = quality_label(&name);
                        div()
                            .id(SharedString::from(format!("quality-{name}")))
                            .min_h(px(34.))
                            .px(px(9.))
                            .py(px(7.))
                            .flex()
                            .items_center()
                            .gap(px(9.))
                            .rounded(px(7.))
                            .text_size(px(11.))
                            .text_color(if selected { rgb(0xffffff) } else { rgb(0xc4c4cc) })
                            .when(selected, |option| option.bg(rgba(0x352d3fe0)))
                            .hover(|style| style.bg(rgba(0x352d3fe0)).text_color(rgb(0xffffff)))
                            .cursor_pointer()
                            .child(div().flex_1().child(label))
                            .when(selected, |option| {
                                option.child(ui::icon(Icon::Check, 15.).text_color(theme::violet_hover()))
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.select_quality(name.clone(), cx)
                            }))
                    })),
            )
            .into_any_element()
    }

    /// Stops playback and frees the frame on screen from the GPU atlas.
    pub fn close(&mut self, window: &mut Window, cx: &mut App) {
        self.gpu = None;
        self.gpu_frame = None;
        self.pipeline = None;
        if let Some(frame) = self.frame.take() {
            cx.drop_image(frame, Some(window));
        }
    }
}

/// Two columns of label/value, with dividers after the timing and picture
/// groups, as in Electron's panel.
fn stat_rows(rows: &[(&'static str, String)], size: f32, compact: bool) -> gpui::Div {
    div()
        .flex()
        .flex_col()
        .gap(px(if compact { 4. } else { 5. }))
        .text_size(px(size))
        .children(rows.iter().enumerate().flat_map(|(index, (label, value))| {
            let mut items = Vec::new();
            if index == 3 || index == 7 {
                items.push(
                    div()
                        .h(px(1.))
                        .my(px(3.))
                        .bg(rgba(0xffffff1c))
                        .into_any_element(),
                );
            }
            items.push(
                div()
                    .flex()
                    .justify_between()
                    .gap(px(14.))
                    .child(
                        div()
                            .flex_none()
                            .text_color(if compact { rgb(0xd4d4d8) } else { rgb(0xa1a1aa) })
                            .child(*label),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .when(compact, |value| value.font_weight(FontWeight::SEMIBOLD))
                            .child(value.clone()),
                    )
                    .into_any_element(),
            );
            items
        }))
}

impl Render for Player {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let focus = self.focus.get_or_insert_with(|| cx.focus_handle()).clone();
        let measured_view = cx.entity().downgrade();
        if self.controls_task.is_none() {
            self.controls_task = Some(cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor()
                        .timer(std::time::Duration::from_millis(250))
                        .await;
                    if this
                        .update(cx, |this, cx| {
                            // Polling should run every display frame. If the
                            // scheduled poll was lost, start a new one (the
                            // next render schedules it).
                            if this.gpu.is_some()
                                && this.poll_scheduled
                                && this.last_polled.elapsed() > std::time::Duration::from_millis(750)
                            {
                                this.poll_generation += 1;
                                this.poll_scheduled = false;
                                this.last_polled = std::time::Instant::now();
                                cx.notify();
                            }
                            if !this.paused
                                && !this.controls_hovered
                                && !this.quality_menu
                                && this.controls_visible
                                && this.last_pointer.elapsed() > this.controls_hide_delay
                            {
                                this.controls_visible = false;
                                cx.notify();
                            }
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            }));
        }
        let stats = self.gpu.as_mut().map(GpuPlayback::stats);
        let show_controls = self.controls_visible || self.paused || self.quality_menu;
        let controls = show_controls.then(|| self.controls(stats.as_ref(), window, cx));
        let mut status = self.failure.clone();
        let mut starting = false;
        let switching = self.gpu.as_ref().is_some_and(GpuPlayback::switching);
        // A pre-roll ad, or one in the middle of the stream: Twitch's ads are
        // filtered out, so the picture waits for the stream to come back.
        let ad_wait = self
            .gpu
            .as_ref()
            .is_some_and(|gpu| gpu.waiting_for_stream() && gpu.ad_break());
        let ad_now =
            self.gpu_frame.is_some() && self.gpu.as_ref().is_some_and(GpuPlayback::ad_break);
        if self.gpu.is_some() {
            if self.gpu_frame.is_none() {
                starting = true;
                status = Some(if ad_wait { "Ad break" } else { "Loading stream…" }.into());
            }
            self.schedule_gpu_poll(window, cx);
        }
        if let Some(pipeline) = &self.pipeline {
            if let Some(frame) = pipeline.take_due_frame()
                && let Some(previous) = self.frame.replace(frame)
            {
                // Each frame is its own atlas texture; free the one replaced.
                let _ = window.drop_image(previous);
            }
            match pipeline.ended() {
                Some(reason) => status = Some(reason.into()),
                None => {
                    if !pipeline.is_playing() {
                        starting = true;
                        status = Some("Loading stream…".into());
                    }
                    redraw_when_changed(window, pipeline.watch(), cx.entity_id());
                }
            }
        }
        let fps_badge = (self.fps_overlay && self.gpu_frame.is_some())
            .then(|| stats.as_ref().map(|stats| stats.fps))
            .flatten()
            .filter(|fps| *fps > 0.);
        div()
            .id("native-video")
            .track_focus(&focus)
            // Electron hides the pointer with the controls; moving it brings
            // both back.
            .when(!self.controls_visible, |video| video.cursor(gpui::CursorStyle::None))
            .capture_any_mouse_down(move |_, window, _| window.focus(&focus))
            .on_mouse_move(cx.listener(|this, _, _, cx| {
                this.last_pointer = std::time::Instant::now();
                if !this.controls_visible {
                    this.controls_visible = true;
                    cx.notify();
                }
            }))
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(|this, event: &gpui::MouseDownEvent, window, cx| {
                    if this.quality_menu {
                        this.quality_menu = false;
                        cx.notify();
                        return;
                    }
                    if event.click_count == 2 {
                        window.toggle_fullscreen();
                        cx.notify();
                    }
                }),
            )
            // Middle-click mutes or unmutes, as in Electron.
            .on_mouse_down(
                gpui::MouseButton::Middle,
                cx.listener(|this, _, _, cx| {
                    this.toggle_mute(cx);
                    cx.stop_propagation();
                }),
            )
            .size_full()
            .relative()
            .overflow_hidden()
            .bg(rgb(0x000000))
            .child(
                gpui::canvas(
                    move |bounds, _, cx| {
                        let _ = measured_view.update(cx, |this, cx| {
                            let width = f32::from(bounds.size.width);
                            let previous = this.controls_width;
                            this.controls_width = width;
                            let crossed = |edge: f32| (previous >= edge) != (width >= edge);
                            if [360., 480., 520., 560., 620., 680.].into_iter().any(crossed) {
                                cx.notify();
                            }
                        });
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .when_some(self.gpu_frame.clone(), |view, frame| {
                view.child(
                    gpui::surface(frame)
                        .size_full()
                        .object_fit(ObjectFit::Contain),
                )
            })
            .when_some(self.frame.clone(), |view, frame| {
                view.child(
                    img(ImageSource::Render(frame))
                        .size_full()
                        .object_fit(ObjectFit::Contain),
                )
            })
            .when_some(fps_badge, |view, fps| {
                view.child(
                    div()
                        .absolute()
                        .top(px(10.))
                        .left(px(12.))
                        .px(px(8.))
                        .py(px(3.))
                        .rounded(px(6.))
                        .bg(rgba(0x0000008c))
                        .text_size(px(12.))
                        .font_weight(FontWeight::BOLD)
                        .text_color(rgb(0xd9ffdc))
                        .child(format!("{fps:.0} FPS")),
                )
            })
            .when((switching || ad_now) && self.gpu_frame.is_some(), |view| {
                view.child(
                    div()
                        .absolute()
                        .top(px(14.))
                        .left_0()
                        .right_0()
                        .flex()
                        .justify_center()
                        .child(
                            div()
                                .px_3()
                                .py(px(5.))
                                .rounded_full()
                                .bg(rgba(0x000000b0))
                                .text_size(px(12.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme::text())
                                .child(if switching {
                                    "Reconnecting…"
                                } else {
                                    "Ad break · the stream continues after Twitch's ad"
                                }),
                        ),
                )
            })
            .when_some(status, |view, text| {
                view.child(
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(
                            div()
                                .max_w(px(560.))
                                .p_6()
                                .flex()
                                .flex_col()
                                .items_center()
                                .gap_3()
                                .bg(rgba(0x000000b0))
                                .text_color(theme::text())
                                .when(starting, |v| {
                                    v.child(
                                        ui::icon(Icon::Refresh, 26.)
                                            .text_color(theme::violet())
                                            .with_animation(
                                                "loading",
                                                gpui::Animation::new(
                                                    std::time::Duration::from_secs(1),
                                                )
                                                .repeat(),
                                                |icon, progress| {
                                                    icon.with_transformation(
                                                        gpui::Transformation::rotate(
                                                            gpui::percentage(progress),
                                                        ),
                                                    )
                                                },
                                            ),
                                    )
                                })
                                .child(
                                    div()
                                        .text_size(px(if starting { 18. } else { 14. }))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .child(text),
                                )
                                .when(starting, |v| {
                                    v.child(
                                        div()
                                            .text_size(px(13.))
                                            .text_color(theme::text_dim())
                                            .child(if ad_wait {
                                                "Twitch is showing an ad. The stream starts as soon as it ends."
                                            } else {
                                                "Connecting to the live stream"
                                            }),
                                    )
                                })
                                .when(!starting, |v| {
                                    v.child(
                                        ui::button(
                                            "retry-playback",
                                            "Try again",
                                            Some(Icon::Refresh),
                                            ui::ButtonStyle::Primary,
                                        )
                                        .on_click(
                                            cx.listener(|this, _, window, cx| {
                                                let login = this.login.clone();
                                                let settings = crate::preferences::get(cx);
                                                this.close(window, cx);
                                                *this = Player::new(&login, &settings);
                                                cx.notify();
                                            }),
                                        ),
                                    )
                                }),
                        ),
                )
            })
            .when(self.stats_open, |view| {
                view.child(self.stats_panel(stats.as_ref(), cx))
            })
            .when(self.quality_menu, |view| view.child(self.quality_menu(cx)))
            .when_some(controls, |view, controls| view.child(controls))
    }
}

/// Checks once per display refresh without drawing; notifies the view only
/// when there is something new to show.
fn redraw_when_changed(window: &mut Window, watch: Watch, view: EntityId) {
    window.on_next_frame(move |window, cx| {
        if watch.changed() {
            cx.notify(view);
        } else {
            redraw_when_changed(window, watch, view);
        }
    });
}
