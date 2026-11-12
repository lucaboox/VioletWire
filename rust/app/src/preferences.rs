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
}
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
    settings.validate();
    crate::theme::set_oled(settings.oled_mode);
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
    let redraw = previous != settings;
    crate::theme::set_oled(settings.oled_mode);
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
