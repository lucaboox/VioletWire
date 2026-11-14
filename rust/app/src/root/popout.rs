//! Chat in a window of its own (Electron's `ChatWindowPortal`): the same chat
//! view, moved out of the main window and back. GPUI can draw a view in any
//! window, so messages, the composer and scroll position all come along.

use gpui::{
    AnyView, App, AppContext as _, Bounds, Context, Entity, IntoElement, ParentElement as _, Render,
    Styled as _, TitlebarOptions, Window, WindowBounds, WindowOptions, div, px, size,
};

use super::Root;
use crate::theme;

pub struct ChatWindow {
    chat: Entity<crate::chat::Chat>,
}

/// The video in a window of its own: the same player view, so playback,
/// controls and fullscreen (now of that window) carry on uninterrupted.
pub struct PlayerWindow {
    player: Entity<crate::player::Player>,
}

impl Render for PlayerWindow {
    fn render(&mut self, window: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        crate::ui::set_scale(window.scale_factor());
        div()
            .size_full()
            .flex()
            .bg(gpui::black())
            .text_color(theme::text())
            .font_family(theme::UI_FONT)
            .text_size(px(14.))
            .line_height(gpui::relative(theme::LINE_HEIGHT))
            .child(AnyView::from(self.player.clone()))
    }
}

impl Render for ChatWindow {
    fn render(&mut self, window: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        crate::ui::set_scale(window.scale_factor());
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(theme::surface())
            .text_color(theme::text())
            .font_family(theme::UI_FONT)
            .text_size(px(14.))
            .line_height(gpui::relative(theme::LINE_HEIGHT))
            .child(AnyView::from(self.chat.clone()))
    }
}

impl Root {
    /// Moves the current channel's chat into its own window, or back.
    pub(super) fn toggle_chat_window(&mut self, cx: &mut Context<Self>) {
        if self.chat_popped.is_some() {
            self.close_chat_window(cx);
            return;
        }
        let Some(chat) = self.playing.as_ref().map(|playing| playing.chat.clone()) else {
            return;
        };
        let root = cx.entity().downgrade();
        let options = WindowOptions {
            titlebar: Some(TitlebarOptions {
                title: Some("VioletWire chat".into()),
                ..Default::default()
            }),
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(420.), px(820.)), cx))),
            ..Default::default()
        };
        let started = std::time::Instant::now();
        let opened = cx.open_window(options, move |window, cx| {
            // Closing the window puts chat back beside the stream.
            window.on_window_should_close(cx, move |_, cx| {
                let _ = root.update(cx, |this, cx| {
                    this.chat_popped = None;
                    this.chat_visible = true;
                    cx.notify();
                });
                true
            });
            cx.new(|_| ChatWindow { chat })
        });
        if std::env::var_os("VIOLETWIRE_PLAYBACK_LOG").is_some() {
            eprintln!("[popout] chat window opened in {} ms", started.elapsed().as_millis());
        }
        match opened {
            Ok(handle) => {
                self.chat_popped = Some(handle.into());
                cx.notify();
            }
            Err(error) => self.show_notice(format!("Could not open the chat window: {error}"), cx),
        }
    }

    /// Closes the chat window (chat returns beside the stream).
    pub(super) fn close_chat_window(&mut self, cx: &mut App) {
        if let Some(handle) = self.chat_popped.take() {
            self.chat_visible = true;
            let _ = handle.update(cx, |_, window, _| window.remove_window());
        }
    }

    /// Moves the current stream's video into its own window, or back.
    pub(super) fn toggle_player_window(&mut self, cx: &mut Context<Self>) {
        if self.player_popped.is_some() {
            self.close_player_window(cx);
            return;
        }
        let Some(playing) = self.playing.as_ref() else {
            return;
        };
        let player = playing.view.clone();
        let title = format!("VioletWire · {}", playing.name);
        let root = cx.entity().downgrade();
        let options = WindowOptions {
            titlebar: Some(TitlebarOptions { title: Some(title.into()), ..Default::default() }),
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(1280.), px(720.)), cx))),
            ..Default::default()
        };
        let opened = cx.open_window(options, move |window, cx| {
            // Closing the window puts the video back in the main window.
            window.on_window_should_close(cx, move |_, cx| {
                let _ = root.update(cx, |this, cx| {
                    this.player_popped = None;
                    cx.notify();
                });
                true
            });
            cx.new(|_| PlayerWindow { player })
        });
        match opened {
            Ok(handle) => {
                self.player_popped = Some(handle.into());
                cx.notify();
            }
            Err(error) => self.show_notice(format!("Could not open the player window: {error}"), cx),
        }
    }

    /// Closes the player window (the video returns to the main window).
    pub(super) fn close_player_window(&mut self, cx: &mut App) {
        if let Some(handle) = self.player_popped.take() {
            let _ = handle.update(cx, |_, window, _| window.remove_window());
        }
    }

    /// Chat shows in the main window: visible, and not in its own window.
    pub(super) fn chat_in_main(&self) -> bool {
        self.chat_visible && self.chat_popped.is_none()
    }
}
