//! Visual preferences only. Import matching fields from Electron on first use;
//! always save Rust changes separately, leaving the shipping client's file alone.
use gpui::{App, Global};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{OnceLock, mpsc},
    time::Duration,
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub oled_mode: bool,
    pub chat_timestamps: bool,
    pub chat_history_limit: u16,
    pub chat_font_size: u8,
    pub chat_emote_size: u8,
    pub chat_sidebar_width: u16,
    pub chat_overlay_opacity: u8,
    pub controls_hide_delay: u16,
    pub sidebar_collapsed: bool,
    pub player_volume: u8,
    /// Streamlink quality name; `best` is Auto.
    pub player_quality: String,
    /// The volume normaliser (Electron's "audio compression").
    pub audio_compression: bool,
    pub show_fps_overlay: bool,
    /// Followed-channel logins pinned to the top of their sidebar group.
    pub favorite_channels: Vec<String>,
    /// Electron's favourites were copied in once; later edits are the user's.
    pub favorites_imported: bool,
    /// The main window's last normal bounds, maximized state and monitor.
    pub window: Option<WindowPlacement>,
    pub chat_on_left: bool,
    /// `placeholder` ("Message deleted") or `dimmed` (the text, faded).
    pub chat_deleted_message_style: String,
    pub mention_sound_enabled: bool,
    /// 0–200 %.
    pub mention_sound_volume: u8,
    /// `ping`, `chime`, `pop` or `knock`.
    pub mention_sound_id: String,
    /// The chat and mention settings above were copied from Electron once.
    pub chat_settings_imported: bool,
    /// `ultra-low` (start on the fragment being written) or `balanced`.
    pub playback_latency_mode: String,
    pub playback_settings_imported: bool,
    /// Logins whose chat messages are hidden here (Electron's block list;
    /// nothing is sent to Twitch).
    pub blocked_chat_users: Vec<String>,
    pub blocked_imported: bool,
}

/// Logical pixels, as GPUI reports them for the window's monitor.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowPlacement {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub maximized: bool,
    /// The monitor's GPUI UUID, so the window reopens where it was.
    pub display: Option<String>,
}

pub const MENTION_SOUNDS: [(&str, &str); 4] =
    [("ping", "Ping"), ("chime", "Chime"), ("pop", "Pop"), ("knock", "Knock")];
impl Global for Preferences {}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            oled_mode: false,
            chat_timestamps: true,
            chat_history_limit: 20,
            chat_font_size: 14,
            chat_emote_size: 27,
            chat_sidebar_width: 384,
            chat_overlay_opacity: 88,
            controls_hide_delay: 5000,
            sidebar_collapsed: false,
            player_volume: 100,
            player_quality: "best".into(),
            audio_compression: false,
            show_fps_overlay: false,
            favorite_channels: Vec::new(),
            favorites_imported: false,
            window: None,
            chat_on_left: false,
            chat_deleted_message_style: "placeholder".into(),
            mention_sound_enabled: false,
            mention_sound_volume: 100,
            mention_sound_id: "ping".into(),
            chat_settings_imported: false,
            playback_latency_mode: "ultra-low".into(),
            playback_settings_imported: false,
            blocked_chat_users: Vec::new(),
            blocked_imported: false,
        }
    }
}
impl Preferences {
    pub fn validate(&mut self) {
        self.chat_font_size = self.chat_font_size.clamp(14, 25);
        self.chat_history_limit = self.chat_history_limit.min(500);
        self.chat_emote_size = self.chat_emote_size.clamp(20, 40);
        self.chat_sidebar_width = self.chat_sidebar_width.clamp(330, 600);
        self.chat_overlay_opacity = self.chat_overlay_opacity.clamp(20, 100);
        self.controls_hide_delay = self.controls_hide_delay.clamp(1000, 10000);
        self.player_volume = self.player_volume.min(100);
        if !crate::playback::resolver::is_quality(&self.player_quality) {
            self.player_quality = "best".into();
        }
        let mut favorites: Vec<String> = Vec::new();
        for login in &self.favorite_channels {
            let login = login.trim().to_ascii_lowercase();
            if crate::format::is_login(&login) && !favorites.contains(&login) && favorites.len() < 500 {
                favorites.push(login);
            }
        }
        self.favorite_channels = favorites;
        let mut blocked: Vec<String> = Vec::new();
        for login in &self.blocked_chat_users {
            let login = login.trim().to_ascii_lowercase();
            if crate::format::is_login(&login) && !blocked.contains(&login) && blocked.len() < 1000 {
                blocked.push(login);
            }
        }
        self.blocked_chat_users = blocked;
        if !matches!(self.chat_deleted_message_style.as_str(), "placeholder" | "dimmed") {
            self.chat_deleted_message_style = "placeholder".into();
        }
        self.mention_sound_volume = self.mention_sound_volume.min(200);
        if !matches!(self.playback_latency_mode.as_str(), "ultra-low" | "balanced") {
            self.playback_latency_mode = "ultra-low".into();
        }
        if !MENTION_SOUNDS.iter().any(|(id, _)| *id == self.mention_sound_id) {
            self.mention_sound_id = "ping".into();
        }
        if let Some(window) = &self.window
            && !([window.x, window.y, window.width, window.height].iter().all(|v| v.is_finite())
                && (760.0..=20_000.0).contains(&window.width)
                && (480.0..=20_000.0).contains(&window.height)
                && window.x.abs() < 100_000.
                && window.y.abs() < 100_000.
                && window.display.as_ref().is_none_or(|uuid| uuid.len() <= 64))
        {
            self.window = None;
        }
    }
}
fn directory() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|path| PathBuf::from(path).join("VioletWireRust"))
}
fn read(path: PathBuf) -> Option<Preferences> {
    let file = std::fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > 256 * 1024 {
        return None;
    }
    serde_json::from_reader(file).ok()
}
pub fn initialize(cx: &mut App) {
    let mut settings = directory()
        .and_then(|path| read(path.join("preferences.json")))
        .or_else(|| {
            std::env::var_os("APPDATA").and_then(|path| {
                read(PathBuf::from(path).join("twitch-windows-viewer/preferences.json"))
            })
        })
        .unwrap_or_default();
    if !settings.favorites_imported {
        // Bring the Electron client's favourites across once.
        if let Some(electron) = std::env::var_os("APPDATA").and_then(|path| {
            read(PathBuf::from(path).join("twitch-windows-viewer/preferences.json"))
        }) && settings.favorite_channels.is_empty()
        {
            settings.favorite_channels = electron.favorite_channels;
        }
        settings.favorites_imported = true;
    }
    if !settings.chat_settings_imported {
        // Chat side, deleted-message style and the mention sound, once.
        if let Some(electron) = std::env::var_os("APPDATA").and_then(|path| {
            read(PathBuf::from(path).join("twitch-windows-viewer/preferences.json"))
        }) {
            settings.chat_on_left = electron.chat_on_left;
            settings.chat_deleted_message_style = electron.chat_deleted_message_style;
            settings.mention_sound_enabled = electron.mention_sound_enabled;
            settings.mention_sound_volume = electron.mention_sound_volume;
            settings.mention_sound_id = electron.mention_sound_id;
        }
        settings.chat_settings_imported = true;
    }
    if !settings.blocked_imported {
        if let Some(electron) = std::env::var_os("APPDATA").and_then(|path| {
            read(PathBuf::from(path).join("twitch-windows-viewer/preferences.json"))
        }) && settings.blocked_chat_users.is_empty()
        {
            settings.blocked_chat_users = electron.blocked_chat_users;
        }
        settings.blocked_imported = true;
    }
    if !settings.playback_settings_imported {
        if let Some(electron) = std::env::var_os("APPDATA").and_then(|path| {
            read(PathBuf::from(path).join("twitch-windows-viewer/preferences.json"))
        }) {
            settings.playback_latency_mode = electron.playback_latency_mode;
        }
        settings.playback_settings_imported = true;
    }
    settings.validate();
    crate::theme::set_oled(settings.oled_mode);
    crate::playback::relay::set_low_latency(settings.playback_latency_mode != "balanced");
    cx.set_global(settings);
}
pub fn get(cx: &App) -> Preferences {
    cx.try_global::<Preferences>().cloned().unwrap_or_default()
}
pub fn update(cx: &mut App, edit: impl FnOnce(&mut Preferences)) {
    let mut previous = get(cx);
    let mut settings = previous.clone();
    edit(&mut settings);
    settings.validate();
    if settings == previous {
        return;
    }
    previous.player_volume = settings.player_volume;
    // Moving or resizing the window is not a reason to redraw everything.
    previous.window = settings.window.clone();
    let redraw = previous != settings;
    crate::theme::set_oled(settings.oled_mode);
    crate::playback::relay::set_low_latency(settings.playback_latency_mode != "balanced");
    cx.set_global(settings.clone());
    if redraw {
        cx.refresh_windows();
    }
    static WRITER: OnceLock<mpsc::Sender<Preferences>> = OnceLock::new();
    let writer = WRITER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Preferences>();
        std::thread::spawn(move || {
            while let Ok(mut settings) = rx.recv() {
                while let Ok(newer) = rx.recv_timeout(Duration::from_millis(300)) {
                    settings = newer;
                }
                if let Some(path) = directory() {
                    let _ = (|| -> anyhow::Result<()> {
                        std::fs::create_dir_all(&path)?;
                        let temporary =
                            path.join(format!("preferences.{}.tmp", std::process::id()));
                        std::fs::write(&temporary, serde_json::to_vec_pretty(&settings)?)?;
                        std::fs::rename(temporary, path.join("preferences.json"))?;
                        Ok(())
                    })();
                }
            }
        });
        tx
    });
    let _ = writer.send(settings);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_only_visual_fields_and_clamps_values() {
        let mut prefs:Preferences=serde_json::from_str(r#"{"oledMode":true,"chatFontSize":100,"chatEmoteSize":1,"playerVolume":200,"unrelated":"ignored"}"#).unwrap();
        prefs.validate();
        assert!(prefs.oled_mode);
        assert_eq!(prefs.chat_font_size, 25);
        assert_eq!(prefs.chat_emote_size, 20);
        assert_eq!(prefs.player_volume, 100);
        assert!(!serde_json::to_string(&prefs).unwrap().contains("unrelated"));
    }
}
