// Release builds are a windowed app with no console.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod chat;
mod format;
mod http;
mod images;
mod input;
mod playback;
mod player;
mod preferences;
mod root;
mod session;
mod settings;
mod theme;
mod twitch;
mod ui;

use gpui::{
    App, Application, Bounds, TitlebarOptions, WindowBounds, WindowOptions, prelude::*, px, size,
};

use root::Root;

fn main() {
    // Developer shortcut: `violetwire --play <channel>` opens that channel.
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let play = arguments
        .windows(2)
        .find(|pair| pair[0] == "--play")
        .map(|pair| pair[1].to_ascii_lowercase());
    let probe_seconds = arguments
        .windows(2)
        .find(|pair| pair[0] == "--video-probe-seconds")
        .and_then(|pair| pair[1].parse::<u64>().ok())
        .map(|seconds| seconds.clamp(5, 120));
    if arguments.iter().any(|arg| arg == "--chat-probe") {
        if let Err(error) = chat::probe(play.as_deref().unwrap_or("summit1g")) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    if arguments.iter().any(|arg| arg == "--resolver-probe") {
        let login = play.as_deref().unwrap_or("ufdtech");
        playback::resolver::warm_up();
        let started = std::time::Instant::now();
        let cold = playback::resolver::probe_cold(login);
        println!(
            "resolver_cold_ms={} success={}",
            started.elapsed().as_millis(),
            cold.is_ok()
        );
        for attempt in 1..=3 {
            let started = std::time::Instant::now();
            let result = playback::resolver::resolve(login, "best").and_then(|lookup| {
                lookup
                    .result
                    .recv_timeout(std::time::Duration::from_secs(25))
                    .map_err(|_| anyhow::anyhow!("Stream lookup timed out."))?
            });
            println!(
                "resolver_attempt={attempt} elapsed_ms={} success={}",
                started.elapsed().as_millis(),
                result.is_ok()
            );
            if result.is_err() {
                playback::resolver::shutdown();
                std::process::exit(1);
            }
        }
        playback::resolver::shutdown();
        return;
    }
    playback::resolver::warm_up();
    let ui_probe = arguments
        .windows(2)
        .find(|pair| pair[0] == "--ui-probe-seconds")
        .and_then(|pair| pair[1].parse::<u64>().ok())
        .map(|n| n.clamp(5, 120));
    let probe_passed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let snapshot_dir = arguments
        .windows(2)
        .find(|pair| pair[0] == "--ui-snapshot-dir")
        .map(|pair| std::path::PathBuf::from(&pair[1]));
    let small_probe = ui_probe.is_some()
        && arguments
            .iter()
            .any(|argument| argument == "--ui-probe-small");
    let home_probe = ui_probe.is_some()
        && arguments
            .iter()
            .any(|argument| argument == "--ui-probe-home");
    let probe_result = probe_passed.clone();

    Application::new()
        .with_assets(ui::Assets)
        .run(move |cx: &mut App| {
            input::init(cx);
            preferences::initialize(cx);
            cx.on_window_closed(|cx| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();

            let bounds = Bounds::centered(
                None,
                if small_probe {
                    size(px(760.), px(480.))
                } else {
                    size(px(1280.), px(800.))
                },
                cx,
            );
            let options = WindowOptions {
                show: probe_seconds.is_none() && ui_probe.is_none(),
                focus: probe_seconds.is_none() && ui_probe.is_none(),
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
            if let Some(seconds) = ui_probe {
                let window = cx
                    .open_window(options, |_, cx| {
                        cx.new(|cx| Root::new(if home_probe { None } else { play }, cx))
                    })
                    .expect("Could not open UI probe");
                // Hidden Windows windows defer their initial placement until
                // shown. Resize explicitly so compact probes test real bounds.
                let _ = window.update(cx, |_, window, _| window.resize(bounds.size));
                cx.spawn(async move |cx| {
                    let started = std::time::Instant::now();
                    let deadline = started + std::time::Duration::from_secs(seconds);
                    let mut last_snapshot = None;
                    let mut caption_result = None;
                    while std::time::Instant::now() < deadline {
                        cx.background_executor()
                            .timer(std::time::Duration::from_millis(100))
                            .await;
                        let _ = cx.update(|cx| {
                            let _ = window.update(cx, |root, window, cx| {
                                root.probe_tick(
                                    started.elapsed().as_secs() / 8,
                                    snapshot_dir.is_some(),
                                    window,
                                    cx,
                                )
                            });
                            let _ = cx.update_window(window.into(), |_, window, cx| {
                                window.render_video_probe_frame(cx);
                                if caption_result.is_none() {
                                    let width = window.viewport_size().width;
                                    let passed = [
                                        (px(50.), gpui::WindowControlArea::Drag),
                                        (width - px(115.), gpui::WindowControlArea::Min),
                                        (width - px(69.), gpui::WindowControlArea::Max),
                                        (width - px(23.), gpui::WindowControlArea::Close),
                                    ]
                                    .into_iter()
                                    .all(|(x, area)| {
                                        let position = gpui::point(x, px(15.));
                                        let hit = window.window_control_area_at(position);
                                        // Dispatch only inside this hidden test window;
                                        // never move the desktop pointer or invoke OS controls.
                                        let result = window.dispatch_event(
                                            gpui::PlatformInput::MouseDown(gpui::MouseDownEvent {
                                                button: gpui::MouseButton::Left,
                                                position,
                                                modifiers: Default::default(),
                                                click_count: 1,
                                                first_mouse: false,
                                            }),
                                            cx,
                                        );
                                        hit == Some(area)
                                            && result.propagate
                                            && !result.default_prevented
                                    });
                                    println!("caption_hit_tests={passed}");
                                    caption_result = Some(passed);
                                    let _ = window.dispatch_event(
                                        gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                                            position: gpui::point(px(-1.), px(-1.)),
                                            pressed_button: None,
                                            modifiers: Default::default(),
                                        }),
                                        cx,
                                    );
                                }
                                let elapsed = started.elapsed().as_secs();
                                let phase = elapsed / 8;
                                if (elapsed % 8 >= 6 || elapsed + 1 >= seconds)
                                    && last_snapshot != Some(phase)
                                    && let Some(directory) = &snapshot_dir
                                {
                                    match window.capture_rendered_frame().and_then(
                                        |(width, height, pixels)| {
                                            std::fs::create_dir_all(directory)?;
                                            image::save_buffer(
                                                directory.join(format!("layout-{phase}.png")),
                                                &pixels,
                                                width,
                                                height,
                                                image::ColorType::Rgba8,
                                            )?;
                                            Ok(())
                                        },
                                    ) {
                                        Ok(()) => last_snapshot = Some(phase),
                                        Err(error) => eprintln!("UI snapshot failed: {error}"),
                                    }
                                }
                            });
                        });
                    }
                    let _ = cx.update(|cx| {
                        if let Ok((d, passed)) = window.update(cx, |root, _, cx| {
                            (
                                root.diagnostics(cx),
                                if home_probe {
                                    root.home_probe_succeeded()
                                } else {
                                    root.probe_succeeded(cx)
                                },
                            )
                        }) {
                            println!("{d}");
                            probe_result.store(
                                passed && caption_result == Some(true),
                                std::sync::atomic::Ordering::Release,
                            );
                        }
                        cx.quit();
                    });
                })
                .detach();
                return;
            }
            if let Some(seconds) = probe_seconds {
                let login = play.unwrap_or_else(|| "summit1g".to_owned());
                // `--probe-quality <name>` switches quality halfway through.
                let switch_quality = arguments
                    .windows(2)
                    .find(|pair| pair[0] == "--probe-quality")
                    .map(|pair| pair[1].clone());
                let window = cx
                    .open_window(options, |_, cx| cx.new(|cx| player::Player::new(&login, &crate::preferences::get(cx))))
                    .expect("Could not open probe window");
                cx.spawn(async move |cx| {
                    let started = std::time::Instant::now();
                    let deadline = started + std::time::Duration::from_secs(seconds);
                    let mut switch_quality = switch_quality;
                    while std::time::Instant::now() < deadline {
                        cx.background_executor()
                            .timer(std::time::Duration::from_millis(8))
                            .await;
                        if started.elapsed() * 2 >= deadline - started
                            && let Some(quality) = switch_quality.take()
                        {
                            let _ = cx.update(|cx| {
                                window.update(cx, |player, _, cx| {
                                    player.probe_select_quality(&quality, cx)
                                })
                            });
                        }
                        let _ = cx.update(|cx| {
                            if window
                                .update(cx, |player, window, cx| player.probe_tick(window, cx))
                                .unwrap_or(false)
                            {
                                let _ = cx.update_window(window.into(), |_, window, cx| {
                                    window.render_video_probe_frame(cx)
                                });
                            }
                        });
                    }
                    let _ = cx.update(|cx| {
                        if let Ok((diagnostics, passed)) = window.update(cx, |player, _, _| {
                            (player.diagnostics(), player.probe_succeeded())
                        }) {
                            println!("{diagnostics}");
                            probe_result.store(passed, std::sync::atomic::Ordering::Release);
                        }
                        cx.quit();
                    });
                })
                .detach();
                return;
            }
            if cx
                .open_window(options, |_, cx| cx.new(|cx| Root::new(play, cx)))
                .is_err()
            {
                cx.quit();
                return;
            }
            cx.activate(true);
        });
    playback::resolver::shutdown();
    if (probe_seconds.is_some() || ui_probe.is_some())
        && !probe_passed.load(std::sync::atomic::Ordering::Acquire)
    {
        std::process::exit(1);
    }
}
