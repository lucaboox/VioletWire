//! The video view. On each display refresh it checks, cheaply, whether a new
//! video frame is due, and only then redraws to show the newest frame the
//! audio clock has reached. A 30 fps stream on a 144 Hz screen redraws 30
//! times a second, not 144.

use std::sync::Arc;

use gpui::{
    App, Context, EntityId, ImageSource, ObjectFit, Render, RenderImage, SharedString, Window, div,
    img, prelude::*, rgb, rgba,
};

use crate::playback::{Pipeline, Watch};

pub struct Player {
    pipeline: Option<Pipeline>,
    frame: Option<Arc<RenderImage>>,
    failure: Option<SharedString>,
}

impl Player {
    pub fn new(login: &str) -> Self {
        match Pipeline::start(login) {
            Ok(pipeline) => Self {
                pipeline: Some(pipeline),
                frame: None,
                failure: None,
            },
            Err(error) => Self {
                pipeline: None,
                frame: None,
                failure: Some(error.to_string().into()),
            },
        }
    }

    /// Stops playback and frees the frame on screen from the GPU atlas.
    pub fn close(&mut self, window: &mut Window, cx: &mut App) {
        self.pipeline = None;
        if let Some(frame) = self.frame.take() {
            cx.drop_image(frame, Some(window));
        }
    }
}

impl Render for Player {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut status = self.failure.clone();
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
                        status = Some("Starting the stream…".into());
                    }
                    redraw_when_changed(window, pipeline.watch(), cx.entity_id());
                }
            }
        }
        div()
            .size_full()
            .relative()
            .overflow_hidden()
            .bg(rgb(0x000000))
            .when_some(self.frame.clone(), |view, frame| {
                view.child(
                    img(ImageSource::Render(frame))
                        .size_full()
                        .object_fit(ObjectFit::Contain),
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
                                .max_w(gpui::px(560.))
                                .px_4()
                                .py_2()
                                .rounded_md()
                                .bg(rgba(0x000000b0))
                                .text_color(gpui::white())
                                .child(text),
                        ),
                )
            })
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
