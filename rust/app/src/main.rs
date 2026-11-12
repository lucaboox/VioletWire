// Release builds are a windowed app with no console.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod format;
mod http;
mod images;
mod root;
mod session;
mod theme;
mod twitch;

use gpui::{App, Application, Bounds, TitlebarOptions, WindowBounds, WindowOptions, prelude::*, px, size};

use root::Root;

fn main() {
    Application::new().run(|cx: &mut App| {
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        let bounds = Bounds::centered(None, size(px(1280.), px(800.)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            // VioletWire draws its own dark title bar; GPUI still gives
            // Windows the real caption areas, so snap layouts keep working.
            titlebar: Some(TitlebarOptions {
                title: Some("VioletWire".into()),
                appears_transparent: true,
                traffic_light_position: None,
            }),
            window_min_size: Some(size(px(760.), px(480.))),
            app_id: Some("VioletWire".into()),
            ..Default::default()
        };
        if cx.open_window(options, |_, cx| cx.new(Root::new)).is_err() {
            cx.quit();
            return;
        }
        cx.activate(true);
    });
}
