//! Native visual settings using the same controls and grouping as Electron.
use crate::{
    preferences::{self, Preferences},
    theme,
    ui::{self, ButtonStyle, Icon},
};
use gpui::{Context, Entity, Render, Subscription, Window, div, prelude::*, px};
pub struct Closed;
pub struct Settings;
impl gpui::EventEmitter<Closed> for Settings {}
pub fn subscribe<T: 'static>(
    view: &Entity<Settings>,
    cx: &mut Context<T>,
    close: impl Fn(&mut T, &mut Context<T>) + 'static,
) -> Subscription {
    cx.subscribe(view, move |this, _, _: &Closed, cx| close(this, cx))
}
fn card(title: &str, description: &str, control: impl IntoElement) -> impl IntoElement {
    div()
        .flex_none()
        .p_3()
        .rounded(px(10.))
        .border_1()
        .border_color(theme::border())
        .bg(theme::surface())
        .flex()
        .items_center()
        .gap_4()
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap_1()
                .child(
                    div()
                        .text_size(px(13.))
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .child(title.to_owned()),
                )
                .child(
                    div()
                        .text_size(px(11.))
                        .text_color(theme::text_dim())
                        .child(description.to_owned()),
                ),
        )
        .child(control)
}
fn toggle(id: &'static str, on: bool) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .w(px(38.))
        .h(px(22.))
        .flex_none()
        .rounded_full()
        .p(px(3.))
        .flex()
        .items_center()
        .when(on, |v| v.justify_end())
        .bg(if on {
            theme::primary()
        } else {
            theme::button_border()
        })
        .cursor_pointer()
        .child(div().size(px(16.)).rounded_full().bg(gpui::white()))
}
impl Render for Settings {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let settings = preferences::get(cx);
        let font = stepper(
            "font-down",
            "font-up",
            settings.chat_font_size.to_string(),
            |s| s.chat_font_size = s.chat_font_size.saturating_sub(1),
            |s| s.chat_font_size = s.chat_font_size.saturating_add(1),
            cx,
        );
        let emotes = stepper(
            "emotes-down",
            "emotes-up",
            settings.chat_emote_size.to_string(),
            |s| s.chat_emote_size = s.chat_emote_size.saturating_sub(1),
            |s| s.chat_emote_size = s.chat_emote_size.saturating_add(1),
            cx,
        );
        let width = stepper(
            "width-down",
            "width-up",
            settings.chat_sidebar_width.to_string(),
            |s| s.chat_sidebar_width = s.chat_sidebar_width.saturating_sub(10),
            |s| s.chat_sidebar_width = s.chat_sidebar_width.saturating_add(10),
            cx,
        );
        let opacity = stepper(
            "opacity-down",
            "opacity-up",
            format!("{}%", settings.chat_overlay_opacity),
            |s| s.chat_overlay_opacity = s.chat_overlay_opacity.saturating_sub(5),
            |s| s.chat_overlay_opacity = s.chat_overlay_opacity.saturating_add(5),
            cx,
        );
        let history = stepper(
            "history-down",
            "history-up",
            settings.chat_history_limit.to_string(),
            |s| s.chat_history_limit = s.chat_history_limit.saturating_sub(10),
            |s| s.chat_history_limit = s.chat_history_limit.saturating_add(10),
            cx,
        );
        div()
            .occlude()
            .w(px(560.))
            .max_w(gpui::relative(0.94))
            .h(px(660.))
            .max_h((window.viewport_size().height - px(80.)).max(px(200.)))
            .rounded(px(14.))
            .border_1()
            .border_color(theme::button_border())
            .bg(theme::background())
            .shadow_xl()
            .flex()
            .flex_col()
            .overflow_hidden()
            .child(
                div()
                    .flex_none()
                    .p_5()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_3()
                            .child(ui::icon(Icon::Settings, 20.).text_color(theme::violet_hover()))
                            .child(
                                div()
                                    .text_size(px(22.))
                                    .font_weight(gpui::FontWeight::BOLD)
                                    .child("Settings"),
                            ),
                    )
                    .child(
                        ui::icon_button(
                            "close-settings",
                            Icon::Close,
                            "Close settings · Escape",
                            false,
                        )
                        .on_click(cx.listener(|_, _, _, cx| cx.emit(Closed))),
                    ),
            )
            .child(
                div()
                    .id("preferences-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px_5()
                    .pb_5()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(heading("APPEARANCE"))
                    .child(card(
                        "OLED mode",
                        "Use pure black backgrounds.",
                        toggle("oled", settings.oled_mode).on_click(cx.listener(|_, _, _, cx| {
                            preferences::update(cx, |s| s.oled_mode = !s.oled_mode)
                        })),
                    ))
                    .child(heading("CHAT"))
                    .child(card(
                        "Recent messages",
                        "Load recent chat when opening a channel. Set to 0 to disable.",
                        history,
                    ))
                    .child(card(
                        "Message timestamps",
                        "Show the local time beside each message.",
                        toggle("timestamps", settings.chat_timestamps).on_click(cx.listener(
                            |_, _, _, cx| {
                                preferences::update(cx, |s| s.chat_timestamps = !s.chat_timestamps)
                            },
                        )),
                    ))
                    .child(card("Text size", "Message text size in pixels.", font))
                    .child(card(
                        "Emote size",
                        "Keep emotes comfortable to read.",
                        emotes,
                    ))
                    .child(card(
                        "Chat width",
                        "Width of the chat sidebar in pixels.",
                        width,
                    ))
                    .child(card(
                        "Overlay opacity",
                        "Background opacity over the video.",
                        opacity,
                    ))
                    .child(heading("PLAYER"))
                    .child(card(
                        "Hide controls after",
                        "Controls stay visible while hovered or paused.",
                        div().flex().gap_1().children(
                            [1000u16, 3000, 5000, 10000].into_iter().map(|delay| {
                                ui::button(
                                    match delay {
                                        1000 => "delay-1",
                                        3000 => "delay-3",
                                        5000 => "delay-5",
                                        _ => "delay-10",
                                    },
                                    format!("{}s", delay / 1000),
                                    None,
                                    if settings.controls_hide_delay == delay {
                                        ButtonStyle::Selected
                                    } else {
                                        ButtonStyle::Secondary
                                    },
                                )
                                .px_2()
                                .h(px(30.))
                                .on_click(cx.listener(
                                    move |_, _, _, cx| {
                                        preferences::update(cx, |s| s.controls_hide_delay = delay)
                                    },
                                ))
                            }),
                        ),
                    ))
                    .child(
                        div()
                            .pt_2()
                            .text_size(px(11.))
                            .text_color(theme::text_dim())
                            .child("Changes save automatically."),
                    ),
            )
    }
}
fn heading(title: &str) -> impl IntoElement {
    div()
        .flex_none()
        .pt_2()
        .text_size(px(10.))
        .font_weight(gpui::FontWeight::BOLD)
        .text_color(theme::text_dim())
        .child(title.to_owned())
}
fn stepper(
    down: &'static str,
    up: &'static str,
    label: String,
    decrease: fn(&mut Preferences),
    increase: fn(&mut Preferences),
    cx: &Context<Settings>,
) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .gap_1()
        .child(
            ui::button(down, "−", None, ButtonStyle::Secondary)
                .w(px(28.))
                .h(px(28.))
                .px_0()
                .on_click(cx.listener(move |_, _, _, cx| preferences::update(cx, decrease))),
        )
        .child(
            div()
                .w(px(36.))
                .flex()
                .justify_center()
                .text_size(px(12.))
                .child(label),
        )
        .child(
            ui::button(up, "+", None, ButtonStyle::Secondary)
                .w(px(28.))
                .h(px(28.))
                .px_0()
                .on_click(cx.listener(move |_, _, _, cx| preferences::update(cx, increase))),
        )
}
