//! Multistream, as in Electron's `MultiStreamView` and `use-multi-stream`: up
//! to four streams in a grid. The active tile has the audio and its chat
//! shows, with a tab per stream; the others are muted. While multistream is
//! open, choosing a channel anywhere adds it as a tile. Line-ups can be saved
//! as presets (Electron's `multiStreamPresets`).
//!
//! Every tile is an ordinary player with its own controls, relay session and
//! chat connection; removing a tile or leaving multistream releases them.

use gpui::{AnyElement, Context, FontWeight, SharedString, Window, div, prelude::*, px, rgb, rgba};

use super::{Auth, Playing, Root};
use crate::theme;
use crate::ui::{self, ButtonStyle, Icon};

/// Electron's `MAX_MULTISTREAM_TILES`.
pub(super) const MAX_TILES: usize = 4;

pub(super) struct Multi {
    pub(super) tiles: Vec<Playing>,
    pub(super) active: usize,
    pub(super) chat_visible: bool,
    pub(super) presets_open: bool,
}

impl Root {
    /// The stream keyboard shortcuts and the chat act on: the open stream, or
    /// multistream's active tile.
    pub(super) fn current(&self) -> Option<&Playing> {
        self.playing
            .as_ref()
            .or_else(|| self.multi.as_ref().and_then(|multi| multi.tiles.get(multi.active)))
    }

    pub(super) fn enter_multi(&mut self, cx: &mut Context<Self>) {
        if self.multi.is_some() {
            return;
        }
        let tiles: Vec<Playing> = self.playing.take().into_iter().collect();
        self.multi = Some(Multi {
            tiles,
            active: 0,
            chat_visible: self.chat_visible,
            presets_open: false,
        });
        self.overlay_chat = false;
        self.sync_multi_audio(cx);
        cx.notify();
    }

    /// Back to one stream: the active tile stays, the rest close.
    pub(super) fn exit_multi(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(mut multi) = self.multi.take() else {
            return;
        };
        let keep = (!multi.tiles.is_empty())
            .then(|| multi.tiles.remove(multi.active.min(multi.tiles.len() - 1)));
        for tile in multi.tiles {
            tile.view.update(cx, |player, cx| player.close(window, cx));
        }
        if let Some(keep) = keep {
            keep.view.update(cx, |player, cx| player.set_muted(false, cx));
            self.playing = Some(keep);
        }
        self.chat_visible = multi.chat_visible;
        cx.notify();
    }

    /// Adds a stream, or makes it active if it is already a tile.
    pub(super) fn add_tile(&mut self, login: &str, name: SharedString, cx: &mut Context<Self>) {
        let Some(multi) = &mut self.multi else {
            return;
        };
        if let Some(index) = multi.tiles.iter().position(|tile| tile.login == login) {
            self.activate_tile(index, cx);
            return;
        }
        if multi.tiles.len() >= MAX_TILES {
            self.show_notice("Multistream holds up to four streams. Remove one first.", cx);
            return;
        }
        let tile = self.open_playing(login, name, cx);
        let multi = self.multi.as_mut().unwrap();
        multi.tiles.push(tile);
        multi.active = multi.tiles.len() - 1;
        self.sync_multi_audio(cx);
        cx.notify();
    }

    pub(super) fn remove_tile(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(multi) = &mut self.multi else {
            return;
        };
        if index >= multi.tiles.len() {
            return;
        }
        let tile = multi.tiles.remove(index);
        tile.view.update(cx, |player, cx| player.close(window, cx));
        if multi.active >= multi.tiles.len() || multi.active > index {
            multi.active = multi.active.saturating_sub(1);
        }
        self.sync_multi_audio(cx);
        cx.notify();
    }

    pub(super) fn activate_tile(&mut self, index: usize, cx: &mut Context<Self>) {
        if let Some(multi) = &mut self.multi
            && index < multi.tiles.len()
            && multi.active != index
        {
            multi.active = index;
            self.sync_multi_audio(cx);
            cx.notify();
        }
    }

    /// Only the active tile is heard.
    fn sync_multi_audio(&self, cx: &mut Context<Self>) {
        if let Some(multi) = &self.multi {
            for (index, tile) in multi.tiles.iter().enumerate() {
                let muted = index != multi.active;
                tile.view.update(cx, |player, cx| player.set_muted(muted, cx));
            }
        }
    }

    /// Replaces the tiles with a saved line-up.
    pub(super) fn open_preset(&mut self, channels: Vec<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.top_presets = false;
        self.enter_multi(cx);
        if let Some(multi) = &mut self.multi {
            for tile in multi.tiles.drain(..) {
                tile.view.update(cx, |player, cx| player.close(window, cx));
            }
            multi.active = 0;
            multi.presets_open = false;
        }
        for login in channels.into_iter().take(MAX_TILES) {
            let name = self
                .channels
                .iter()
                .find(|channel| channel.login == login)
                .map_or_else(|| SharedString::from(login.clone()), |channel| channel.display_name.clone().into());
            self.add_tile(&login, name, cx);
        }
        self.activate_tile(0, cx);
    }

    fn save_preset(&mut self, cx: &mut Context<Self>) {
        let Some(multi) = &self.multi else {
            return;
        };
        let channels: Vec<String> = multi.tiles.iter().map(|tile| tile.login.clone()).collect();
        if channels.is_empty() {
            return;
        }
        let mut name: String = multi
            .tiles
            .iter()
            .take(2)
            .map(|tile| tile.name.to_string())
            .collect::<Vec<_>>()
            .join(" + ");
        if multi.tiles.len() > 2 {
            name.push_str(&format!(" +{}", multi.tiles.len() - 2));
        }
        let name: String = name.chars().take(40).collect();
        crate::preferences::update(cx, |preferences| {
            preferences.multi_stream_presets.retain(|preset| preset.channels != channels);
            preferences
                .multi_stream_presets
                .insert(0, crate::preferences::MultiPreset { name, channels });
        });
        self.show_notice("Line-up saved to presets.", cx);
    }

    /// Per-frame settings for every tile's player and chat, as for one stream.
    pub(super) fn sync_tiles(&self, cx: &mut Context<Self>) {
        let Some(multi) = &self.multi else {
            return;
        };
        let session = if let Auth::SignedIn(session) = &self.auth {
            Some(session.clone())
        } else {
            None
        };
        let preferences = crate::preferences::get(cx);
        for tile in &multi.tiles {
            let room = self
                .channels
                .iter()
                .find(|channel| channel.login == tile.login)
                .map(|channel| channel.id.clone());
            let (session, preferences) = (session.clone(), preferences.clone());
            tile.chat.update(cx, |chat, cx| {
                chat.set_session(session, cx);
                if let Some(room) = &room {
                    chat.set_room(room, cx);
                }
                chat.set_overlay(false, cx);
                chat.set_preferences(preferences, cx);
            });
            let delay = crate::preferences::get(cx).controls_hide_delay;
            tile.view.update(cx, |player, cx| {
                player.set_presentation(multi.chat_visible, false, self.theater, cx);
                player.set_controls_delay(delay);
            });
        }
    }

    pub(super) fn multi_panel(&self, fullscreen: bool, window: &Window, cx: &Context<Self>) -> AnyElement {
        let multi = self.multi.as_ref().unwrap();
        let count = multi.tiles.len();
        let bar = div()
            .h(px(52.))
            .flex_none()
            .px_3()
            .flex()
            .items_center()
            .gap_2()
            .border_b_1()
            .border_color(theme::border())
            .bg(theme::background())
            .child(
                ui::icon_button("multi-exit", Icon::Back, "Exit multistream", false)
                    .on_click(cx.listener(|this, _, window, cx| this.exit_multi(window, cx))),
            )
            .child(div().text_size(px(16.)).font_weight(FontWeight::BOLD).child("Multistream"))
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(theme::text_dim())
                    .child(format!("{count}/{MAX_TILES} streams")),
            )
            .child(div().flex_1())
            .child(
                ui::button(
                    "multi-presets",
                    "Presets",
                    Some(Icon::Star),
                    if multi.presets_open { ButtonStyle::Selected } else { ButtonStyle::Secondary },
                )
                .h(px(34.))
                .px_3()
                .on_click(cx.listener(|this, _, _, cx| {
                    if let Some(multi) = &mut this.multi {
                        multi.presets_open = !multi.presets_open;
                    }
                    cx.notify();
                })),
            )
            .child(
                ui::icon_button(
                    "multi-chat",
                    Icon::Chat,
                    if multi.chat_visible { "Hide chat · C" } else { "Show chat · C" },
                    multi.chat_visible,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    if let Some(multi) = &mut this.multi {
                        multi.chat_visible = !multi.chat_visible;
                    }
                    cx.notify();
                })),
            )
            .child(
                ui::icon_button("multi-theater", Icon::Theater, "Theater mode · T", self.theater)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.theater = !this.theater;
                        cx.notify();
                    })),
            )
            .child(
                ui::icon_button(
                    "multi-fullscreen",
                    if fullscreen { Icon::ExitFullscreen } else { Icon::Fullscreen },
                    "Fullscreen · F",
                    fullscreen,
                )
                .on_click(cx.listener(|_, _, window, cx| {
                    window.toggle_fullscreen();
                    cx.notify();
                })),
            );

        // Electron's layouts: one fills the area, two sit side by side, three
        // or four share a two-by-two grid.
        let (width, height) = match count {
            0 | 1 => (1., 1.),
            2 => (0.5, 1.),
            _ => (0.5, 0.5),
        };
        let tiles = multi.tiles.iter().enumerate().map(|(index, tile)| {
            let active = index == multi.active;
            div()
                .w(gpui::relative(width))
                .h(gpui::relative(height))
                .p(px(2.))
                .child(
                    div()
                        .id(SharedString::from(format!("tile-{}", tile.login)))
                        .group("tile")
                        .relative()
                        .size_full()
                        .overflow_hidden()
                        .rounded(px(6.))
                        .border_2()
                        .border_color(if active { theme::violet() } else { rgba(0x00000000) })
                        .capture_any_mouse_down(cx.listener(move |this, _, _, cx| this.activate_tile(index, cx)))
                        .child(tile.view.clone())
                        .child(
                            div()
                                .absolute()
                                .top(px(8.))
                                .left(px(8.))
                                .px(px(8.))
                                .h(px(24.))
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .rounded(px(6.))
                                .bg(rgba(0x000000a8))
                                .text_size(px(12.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme::text())
                                .when(active, |chip| {
                                    chip.child(div().size(px(7.)).rounded_full().bg(rgb(0x22c55e)))
                                })
                                .child(tile.name.clone()),
                        )
                        .child(
                            div()
                                .absolute()
                                .top(px(6.))
                                .right(px(6.))
                                .invisible()
                                .group_hover("tile", |style| style.visible())
                                .child(
                                    ui::icon_button("tile-remove", Icon::Close, "Remove stream", false)
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.remove_tile(index, window, cx)
                                        })),
                                ),
                        ),
                )
        });
        let grid = div()
            .id("multi-grid")
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .flex_wrap()
            .bg(rgb(0x000000))
            .children(tiles)
            .when(count == 0, |grid| {
                grid.items_center().justify_center().child(
                    div()
                        .max_w(px(420.))
                        .text_center()
                        .text_size(px(14.))
                        .text_color(theme::text_dim())
                        .child("Choose live channels in the sidebar or search to add up to four streams."),
                )
            });
        let chat = (multi.chat_visible && count > 0).then(|| {
            let active = &multi.tiles[multi.active.min(count - 1)];
            div()
                .w(px(f32::from(crate::preferences::get(cx).chat_sidebar_width)))
                .flex_none()
                .h_full()
                .flex()
                .flex_col()
                .border_l_1()
                .border_color(theme::border())
                .child(
                    div()
                        .flex_none()
                        .flex()
                        .gap_1()
                        .p_1()
                        .bg(theme::chat_header())
                        .children(multi.tiles.iter().enumerate().map(|(index, tile)| {
                            ui::button(
                                ["chat-tab-0", "chat-tab-1", "chat-tab-2", "chat-tab-3"][index.min(3)],
                                tile.name.clone(),
                                None,
                                if index == multi.active { ButtonStyle::Selected } else { ButtonStyle::Ghost },
                            )
                            .h(px(28.))
                            .px_2()
                            .text_size(px(12.))
                            .on_click(cx.listener(move |this, _, _, cx| this.activate_tile(index, cx)))
                        })),
                )
                .child(
                    div().flex_1().min_h_0().child(
                        gpui::AnyView::from(active.chat.clone())
                            .cached(gpui::StyleRefinement::default().size_full()),
                    ),
                )
        });
        let presets = multi.presets_open.then(|| self.presets_menu(window, cx));
        div()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .relative()
            .when(!fullscreen, |panel| panel.child(bar))
            .child(div().flex_1().min_h_0().flex().child(grid).when_some(chat, |row, chat| row.child(chat)))
            .when_some(presets, |panel, menu| panel.child(menu))
            .into_any_element()
    }

    fn presets_menu(&self, _window: &Window, cx: &Context<Self>) -> AnyElement {
        let presets = crate::preferences::get(cx).multi_stream_presets;
        let can_save = self.multi.as_ref().is_some_and(|multi| !multi.tiles.is_empty());
        div()
            .id("multi-presets-menu")
            .occlude()
            .absolute()
            .top(px(50.))
            .right(px(120.))
            .w(px(300.))
            .max_h(px(420.))
            .overflow_y_scroll()
            .p(px(8.))
            .flex()
            .flex_col()
            .gap(px(4.))
            .rounded(px(10.))
            .border_1()
            .border_color(theme::button_border())
            .bg(theme::popup())
            .shadow_xl()
            .child(
                ui::button(
                    "save-preset",
                    "Save these streams",
                    Some(Icon::Check),
                    if can_save { ButtonStyle::Primary } else { ButtonStyle::Disabled },
                )
                .h(px(32.))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if can_save {
                        this.save_preset(cx);
                    }
                })),
            )
            .when(presets.is_empty(), |menu| {
                menu.child(
                    div()
                        .p_2()
                        .text_size(px(12.))
                        .text_color(theme::text_dim())
                        .child("No saved line-ups yet."),
                )
            })
            .children(presets.into_iter().enumerate().map(|(index, preset)| {
                let channels = preset.channels.clone();
                let delete = preset.channels.clone();
                div()
                    .id(SharedString::from(format!("preset-{index}")))
                    .p(px(8.))
                    .flex()
                    .items_center()
                    .gap_2()
                    .rounded(px(7.))
                    .cursor_pointer()
                    .hover(|style| style.bg(theme::surface_hover()))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .truncate()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(preset.name.clone()),
                            )
                            .child(
                                div()
                                    .truncate()
                                    .text_size(px(11.))
                                    .text_color(theme::text_dim())
                                    .child(preset.channels.join(", ")),
                            ),
                    )
                    .child(
                        ui::icon_button("delete-preset", Icon::Close, "Delete preset", false).on_click(
                            cx.listener(move |_, _, _, cx| {
                                let delete = delete.clone();
                                crate::preferences::update(cx, |preferences| {
                                    preferences.multi_stream_presets.retain(|preset| preset.channels != delete)
                                });
                                cx.stop_propagation();
                            }),
                        ),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open_preset(channels.clone(), window, cx)
                    }))
            }))
            .into_any_element()
    }
}
