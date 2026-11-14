//! Electron's movable chat overlay: the strip along its top drags it about
//! the video, the corner handle resizes it from the top-left, and a
//! double-click on that handle puts it back in its default place. Where it
//! was left is saved (Electron's `chatOverlayPlaced` and its geometry).

use std::{cell::Cell, rc::Rc};

use gpui::{
    AnyElement, Bounds, Context, MouseButton, MouseDownEvent, MouseMoveEvent, Pixels, Point, Window, div, prelude::*,
    px, rgba,
};

use super::Root;
use crate::preferences::OverlayPlacement;
use crate::ui::{self, Icon};

const MIN_WIDTH: f32 = 280.;
const MAX_WIDTH: f32 = 560.;
const MIN_HEIGHT: f32 = 200.;
const MAX_HEIGHT: f32 = 1000.;
const MARGIN: f32 = 8.;

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Move,
    Resize,
}

pub(super) struct OverlayDrag {
    mode: Mode,
    pointer: Point<Pixels>,
    start: OverlayPlacement,
    container: (f32, f32),
}

/// Electron's `clampOverlayGeometry`: inside the video, within the limits.
fn clamp(geometry: OverlayPlacement, width: f32, height: f32) -> OverlayPlacement {
    let w = geometry.width.clamp(MIN_WIDTH, MAX_WIDTH).min((width - MARGIN * 2.).max(MIN_WIDTH)).round();
    let h = geometry.height.max(MIN_HEIGHT).min(MAX_HEIGHT.min((height - MARGIN * 2.).max(0.))).round();
    OverlayPlacement {
        left: geometry.left.min(width - w - MARGIN).max(MARGIN).round(),
        top: geometry.top.min(height - h - MARGIN).max(MARGIN).round(),
        width: w,
        height: h,
    }
}

impl Root {
    /// Where the overlay sits in a video area of this size.
    fn overlay_geometry(&self, area: (f32, f32), cx: &Context<Self>) -> Option<OverlayPlacement> {
        let placed = self.overlay_live.or(crate::preferences::get(cx).chat_overlay)?;
        Some(clamp(placed, area.0, area.1))
    }

    /// The default place: the right edge, clear of the player's controls.
    fn overlay_default(area: (f32, f32)) -> OverlayPlacement {
        OverlayPlacement { left: area.0 - 12. - 340., top: 12., width: 340., height: (area.1 - 12. - 64.).max(MIN_HEIGHT) }
    }

    /// The chat overlay, placed where it was left, with its move strip and
    /// resize handle. `measured` holds the video area's bounds from layout.
    pub(super) fn chat_overlay(
        &self,
        chat: gpui::AnyView,
        measured: Rc<Cell<Bounds<Pixels>>>,
        cx: &Context<Self>,
    ) -> AnyElement {
        let size = measured.get().size;
        let area = (f32::from(size.width), f32::from(size.height));
        let placed = (area.0 > 0.).then(|| self.overlay_geometry(area, cx)).flatten();
        let begin = move |mode: Mode| {
            let measured = measured.clone();
            move |this: &mut Root, event: &MouseDownEvent, _: &mut Window, cx: &mut Context<Root>| {
                cx.stop_propagation();
                // A double-click on the resize handle resets the place.
                if mode == Mode::Resize && event.click_count >= 2 {
                    this.overlay_drag = None;
                    this.overlay_live = None;
                    crate::preferences::update(cx, |s| s.chat_overlay = None);
                    cx.notify();
                    return;
                }
                let size = measured.get().size;
                let area = (f32::from(size.width), f32::from(size.height));
                let start = this.overlay_geometry(area, cx).unwrap_or_else(|| Root::overlay_default(area));
                this.overlay_drag = Some(OverlayDrag { mode, pointer: event.position, start, container: area });
                this.overlay_live = Some(start);
                cx.notify();
            }
        };
        let strip = div()
            .id("overlay-move")
            .absolute()
            .top_0()
            .left(px(34.))
            .right(px(34.))
            .h(px(18.))
            .flex()
            .justify_center()
            .items_center()
            .occlude()
            .cursor_grab()
            .opacity(0.)
            .group_hover("chat-overlay", |style| style.opacity(1.))
            .child(div().w(px(46.)).h(px(4.)).rounded_full().bg(rgba(0xffffff55)))
            .tooltip(|_, cx| cx.new(|_| ui::Tooltip("Drag to move the chat".into())).into())
            .on_mouse_down(MouseButton::Left, cx.listener(begin(Mode::Move)));
        let handle = div()
            .id("overlay-resize")
            .absolute()
            .top(px(4.))
            .left(px(4.))
            .occlude()
            .opacity(0.)
            .group_hover("chat-overlay", |style| style.opacity(1.))
            .child(
                ui::icon_button("overlay-resize-button", Icon::Resize, "Drag to resize · double-click to reset", false)
                    .w(px(26.))
                    .h(px(26.))
                    .rounded(px(6.))
                    .bg(rgba(0x0a0a0cb8))
                    .cursor(gpui::CursorStyle::ResizeUpLeftDownRight)
                    .on_mouse_down(MouseButton::Left, cx.listener(begin(Mode::Resize))),
            );
        let base = div()
            .id("chat-overlay")
            .group("chat-overlay")
            .absolute()
            .rounded(px(11.))
            .border_1()
            .border_color(rgba(0xffffff1a));
        let placed_box = match placed {
            Some(geometry) => base
                .left(px(geometry.left))
                .top(px(geometry.top))
                .w(px(geometry.width))
                .h(px(geometry.height)),
            None => base.right_3().top_3().bottom(px(64.)).w(px(340.)),
        };
        placed_box
            .child(chat.cached(gpui::StyleRefinement::default().size_full()))
            .child(strip)
            .child(handle)
            .into_any_element()
    }

    /// While the overlay is dragged: a layer over the window that follows
    /// the pointer, and saves the place on release.
    pub(super) fn overlay_drag_layer(&self, cx: &Context<Self>) -> Option<AnyElement> {
        self.overlay_drag.as_ref()?;
        Some(
            div()
                .id("overlay-drag-layer")
                .absolute()
                .inset_0()
                .occlude()
                .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _, cx| {
                    let Some(drag) = &this.overlay_drag else { return };
                    let dx = f32::from(event.position.x - drag.pointer.x);
                    let dy = f32::from(event.position.y - drag.pointer.y);
                    let start = drag.start;
                    let next = match drag.mode {
                        Mode::Move => OverlayPlacement { left: start.left + dx, top: start.top + dy, ..start },
                        Mode::Resize => {
                            // The bottom-right corner stays where it is.
                            let width = (start.width - dx).clamp(MIN_WIDTH, MAX_WIDTH);
                            let height = (start.height - dy).clamp(MIN_HEIGHT, MAX_HEIGHT);
                            OverlayPlacement {
                                left: start.left + start.width - width,
                                top: start.top + start.height - height,
                                width,
                                height,
                            }
                        }
                    };
                    this.overlay_live = Some(clamp(next, drag.container.0, drag.container.1));
                    cx.notify();
                }))
                .on_mouse_up(MouseButton::Left, cx.listener(|this, _, _, cx| this.end_overlay_drag(cx)))
                .on_mouse_up_out(MouseButton::Left, cx.listener(|this, _, _, cx| this.end_overlay_drag(cx)))
                .into_any_element(),
        )
    }

    fn end_overlay_drag(&mut self, cx: &mut Context<Self>) {
        if self.overlay_drag.take().is_none() {
            return;
        }
        if let Some(geometry) = self.overlay_live.take() {
            crate::preferences::update(cx, |s| s.chat_overlay = Some(geometry));
        }
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_overlay_inside_the_video() {
        let inside = clamp(OverlayPlacement { left: -50., top: 900., width: 900., height: 100. }, 1200., 700.);
        assert_eq!(inside.width, MAX_WIDTH);
        assert_eq!(inside.height, MIN_HEIGHT);
        assert_eq!(inside.left, MARGIN);
        assert_eq!(inside.top, 700. - MIN_HEIGHT - MARGIN);
    }
}
