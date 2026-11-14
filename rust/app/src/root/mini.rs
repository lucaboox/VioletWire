//! Electron's mini player: leaving the player for Home or Browse keeps the
//! stream playing in a small window in the corner. Dragging moves it, its
//! corner handle resizes it, and a click brings the full player back.

use gpui::{
    AnyElement, Context, FontWeight, MouseButton, MouseDownEvent, MouseMoveEvent, Pixels, Point, Window, div,
    point, prelude::*, px, rgb, rgba,
};

use super::Root;
use crate::ui::{self, Icon};

const MARGIN: f32 = 8.;
const MIN_WIDTH: f32 = 240.;
const MAX_WIDTH: f32 = 560.;

#[derive(Default)]
pub(super) struct Mini {
    /// The top-left corner, once moved; until then it sits bottom-right.
    position: Option<Point<Pixels>>,
    width: Option<f32>,
    drag: Option<Drag>,
}

enum Drag {
    /// Where in the mini player it was grabbed, where the press began, and
    /// whether it has moved far enough to be a drag rather than a click.
    Move { grab: Point<Pixels>, start: Point<Pixels>, moved: bool },
    /// Resizing from the top-left handle, the bottom-right corner planted.
    Resize { start_width: f32, start_x: Pixels, anchor: Point<Pixels> },
}

impl Mini {
    fn width(&self) -> f32 {
        self.width.unwrap_or(320.)
    }

    /// The mini player's bounds: origin and width (16:9).
    fn rect(&self, viewport: gpui::Size<Pixels>) -> (Point<Pixels>, f32) {
        let width = self.width();
        let height = width * 9. / 16.;
        let origin = self.position.unwrap_or_else(|| {
            point(viewport.width - px(width + 18.), viewport.height - px(height + 18.))
        });
        (clamp(origin, width, viewport), width)
    }
}

fn clamp(origin: Point<Pixels>, width: f32, viewport: gpui::Size<Pixels>) -> Point<Pixels> {
    let height = width * 9. / 16.;
    let x = f32::from(origin.x).min(f32::from(viewport.width) - width - MARGIN).max(MARGIN);
    let y = f32::from(origin.y).min(f32::from(viewport.height) - height - MARGIN).max(MARGIN);
    point(px(x), px(y))
}

impl Root {
    /// Shrinks the open stream into the corner rather than closing it.
    pub(super) fn minimize_player(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.mini.is_none() {
            self.mini = Some(Mini::default());
        }
        self.theater = false;
        if window.is_fullscreen() {
            window.toggle_fullscreen();
        }
        cx.notify();
    }

    pub(super) fn restore_player(&mut self, cx: &mut Context<Self>) {
        if self.mini.take().is_some() {
            cx.notify();
        }
    }

    fn mini_mouse_move(&mut self, position: Point<Pixels>, window: &Window, cx: &mut Context<Self>) {
        let viewport = window.viewport_size();
        let Some(mini) = &mut self.mini else { return };
        let width = mini.width();
        match &mut mini.drag {
            Some(Drag::Move { grab, start, moved }) => {
                if !*moved && (position.x - start.x).abs() < px(4.) && (position.y - start.y).abs() < px(4.) {
                    return;
                }
                *moved = true;
                mini.position = Some(clamp(position - *grab, width, viewport));
            }
            Some(Drag::Resize { start_width, start_x, anchor }) => {
                let next = (*start_width + f32::from(*start_x - position.x)).clamp(MIN_WIDTH, MAX_WIDTH);
                let anchor = *anchor;
                mini.width = Some(next);
                mini.position = Some(point(
                    (anchor.x - px(next)).max(px(MARGIN)),
                    (anchor.y - px(next * 9. / 16.)).max(px(MARGIN)),
                ));
            }
            None => return,
        }
        cx.notify();
    }

    fn mini_mouse_up(&mut self, cx: &mut Context<Self>) {
        let Some(mini) = &mut self.mini else { return };
        // A press without a drag is a click: bring the player back.
        let clicked = matches!(mini.drag.take(), Some(Drag::Move { moved: false, .. }));
        if clicked {
            self.restore_player(cx);
        }
        cx.notify();
    }

    /// The floating mini player, and while it is dragged, a layer over the
    /// whole window that follows the pointer wherever it goes.
    pub(super) fn mini_player(&self, window: &Window, cx: &Context<Self>) -> Option<AnyElement> {
        let mini = self.mini.as_ref()?;
        let playing = self.playing.as_ref()?;
        if self.player_popped.is_some() {
            return None;
        }
        let viewport = window.viewport_size();
        let (origin, width) = mini.rect(viewport);
        let height = width * 9. / 16.;
        let (paused, muted) = {
            let player = playing.view.read(cx);
            (player.paused(), player.muted())
        };
        let view = playing.view.clone();
        let (pause_view, mute_view) = (view.clone(), view.clone());
        let overlay_button = |id: &'static str, icon: Icon, tip: &'static str| {
            ui::icon_button(id, icon, tip, false).w(px(28.)).h(px(26.)).rounded(px(6.)).bg(rgba(0x0a0a0cb8))
        };
        let box_ = div()
            .id("mini-player")
            .group("mini")
            .absolute()
            .left(origin.x)
            .top(origin.y)
            .w(px(width))
            .h(px(height))
            .overflow_hidden()
            .border_1()
            .border_color(if crate::preferences::get(cx).oled_mode { rgb(0x2a2a30) } else { rgb(0x3a3a42) })
            .bg(rgb(0x000000))
            .shadow_xl()
            .child(div().absolute().inset_0().child(view))
            // The grip: everything not a button. It takes the video's
            // presses, so the stream itself never sees them.
            .child(
                div()
                    .id("mini-grab")
                    .absolute()
                    .inset_0()
                    .occlude()
                    .cursor_pointer()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                            if let Some(mini) = &mut this.mini {
                                mini.position = Some(origin);
                                mini.drag = Some(Drag::Move {
                                    grab: event.position - origin,
                                    start: event.position,
                                    moved: false,
                                });
                                cx.notify();
                            }
                        }),
                    )
                    // Middle-click mutes, as on the full player.
                    .on_mouse_down(
                        MouseButton::Middle,
                        cx.listener(|this, _, _, cx| {
                            if let Some(playing) = &this.playing {
                                playing.view.update(cx, |player, cx| player.toggle_mute(cx));
                            }
                        }),
                    ),
            )
            .child(
                div()
                    .absolute()
                    .top(px(6.))
                    .left(px(6.))
                    .occlude()
                    .invisible()
                    .group_hover("mini", |style| style.visible())
                    .child(
                        overlay_button("mini-resize", Icon::Resize, "Drag to resize")
                            .cursor(gpui::CursorStyle::ResizeUpLeftDownRight)
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                                    if let Some(mini) = &mut this.mini {
                                        mini.drag = Some(Drag::Resize {
                                            start_width: width,
                                            start_x: event.position.x,
                                            anchor: origin + point(px(width), px(height)),
                                        });
                                        cx.stop_propagation();
                                        cx.notify();
                                    }
                                }),
                            ),
                    ),
            )
            .child(
                div()
                    .absolute()
                    .top(px(6.))
                    .right(px(6.))
                    .occlude()
                    .invisible()
                    .group_hover("mini", |style| style.visible())
                    .child(
                        overlay_button("mini-close", Icon::Close, "Close the stream")
                            .on_click(cx.listener(|this, _, window, cx| this.close_player(window, cx))),
                    ),
            )
            .child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom_0()
                    .px(px(7.))
                    .py(px(6.))
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .occlude()
                    .bg(gpui::linear_gradient(
                        180.,
                        gpui::linear_color_stop(rgba(0x03030500), 0.),
                        gpui::linear_color_stop(rgba(0x040406eb), 1.),
                    ))
                    .invisible()
                    .group_hover("mini", |style| style.visible())
                    .child(
                        ui::icon_button("mini-pause", if paused { Icon::Play } else { Icon::Pause }, if paused { "Play" } else { "Pause" }, false)
                            .w(px(28.))
                            .h(px(26.))
                            .on_click(move |_, _, cx| pause_view.update(cx, |player, cx| player.toggle_pause(cx))),
                    )
                    .child(
                        ui::icon_button("mini-mute", if muted { Icon::Muted } else { Icon::Volume }, if muted { "Unmute" } else { "Mute" }, false)
                            .w(px(28.))
                            .h(px(26.))
                            .on_click(move |_, _, cx| mute_view.update(cx, |player, cx| player.toggle_mute(cx))),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .truncate()
                            .text_size(px(12.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(rgb(0xe4e4e7))
                            .child(playing.name.clone()),
                    ),
            );
        let dragging = mini.drag.is_some();
        Some(
            div()
                .absolute()
                .inset_0()
                .child(box_)
                // Over the mini player too, so it keeps the pointer as it moves.
                .when(dragging, |layer| {
                    layer.child(
                        div()
                            .id("mini-drag-layer")
                            .absolute()
                            .inset_0()
                            .occlude()
                            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                                this.mini_mouse_move(event.position, window, cx)
                            }))
                            .on_mouse_up(MouseButton::Left, cx.listener(|this, _, _, cx| this.mini_mouse_up(cx)))
                            .on_mouse_up_out(MouseButton::Left, cx.listener(|this, _, _, cx| this.mini_mouse_up(cx))),
                    )
                })
                .into_any_element(),
        )
    }
}
