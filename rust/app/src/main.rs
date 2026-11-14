// Release builds are a windowed app with no console.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cache;
mod chat;
mod format;
mod http;
mod images;
mod input;
mod kick;
mod kick_web;
mod playback;
mod playback_link;
mod player;
mod preferences;
mod root;
mod session;
mod settings;
mod sound;
mod theme;
mod twitch;
mod ui;

use gpui::{
    App, Application, Bounds, TitlebarOptions, WindowBounds, WindowOptions, prelude::*, px, size,
};

use root::Root;

fn main() {
    // GPUI scales by each monitor's DPI, but only if Windows is told the app
    // can (Zed does this in its manifest). Without it, a 125 % display gave
    // the app 100 % sizes, so the whole UI drew a size smaller than Electron.
    // SAFETY: a process-wide setting, made before any window exists.
    unsafe {
        let _ = windows::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(
            windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        );
    }
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
    let app_probe = arguments
        .windows(2)
        .find(|pair| pair[0] == "--app-probe-seconds")
        .and_then(|pair| pair[1].parse::<u64>().ok())
        .map(|seconds| seconds.clamp(5, 120));
    if arguments.iter().any(|arg| arg == "--chat-probe") {
        if let Err(error) = chat::probe(play.as_deref().unwrap_or("summit1g")) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    // `--qualities-probe a,b,c`: each channel's qualities as this account sees
    // them (names only, never addresses).
    if let Some(logins) = arguments
        .windows(2)
        .find(|pair| pair[0] == "--qualities-probe")
        .map(|pair| pair[1].clone())
    {
        playback::resolver::warm_up();
        for login in logins.split(',').filter(|login| format::is_channel(login)) {
            let qualities = playback::resolver::resolve_fresh(login, "best").and_then(|lookup| {
                lookup
                    .result
                    .recv_timeout(std::time::Duration::from_secs(25))
                    .map_err(|_| anyhow::anyhow!("timed out"))?
            });
            match qualities {
                Ok(resolved) => println!("{login}: {}", resolved.qualities.join(" ")),
                // Only the top message: the chain can hold a signed address.
                Err(error) => println!("{login}: {error}"),
            }
        }
        playback::resolver::shutdown();
        playback::kick::shutdown();
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
                playback::kick::shutdown();
                std::process::exit(1);
            }
        }
        playback::resolver::shutdown();
        playback::kick::shutdown();
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
            if let Err(error) = cx
                .text_system()
                .add_fonts(theme::FONTS.iter().map(|font| std::borrow::Cow::Borrowed(*font)).collect())
            {
                eprintln!("Could not load the UI font: {error}");
            }
            input::init(cx);
            preferences::initialize(cx);
            // Keep the emote caches within their size limits.
            std::thread::spawn(cache::prune);
            if (probe_seconds.is_some() || ui_probe.is_some() || app_probe.is_some())
                && arguments.iter().any(|arg| arg == "--probe-balanced")
            {
                playback::relay::set_low_latency(false);
            }
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
            // Reopen where the window was last, if that monitor is still
            // there and the window would be visible on it.
            let restored =
                (probe_seconds.is_none() && ui_probe.is_none())
                    .then(|| preferences::get(cx).window)
                    .flatten()
                    .and_then(|placement| {
                        let displays = cx.displays();
                        let display = displays.iter().find(|display| {
                            placement.display.as_deref()
                                == display.uuid().ok().map(|uuid| uuid.to_string()).as_deref()
                        })?;
                        let saved = Bounds::new(
                            gpui::point(px(placement.x), px(placement.y)),
                            size(px(placement.width), px(placement.height)),
                        );
                        let visible = display.bounds().intersect(&saved);
                        (visible.size.width > px(200.) && visible.size.height > px(120.))
                            .then_some((display.id(), saved, placement.maximized))
                    });
            let options = WindowOptions {
                show: probe_seconds.is_none() && ui_probe.is_none(),
                focus: probe_seconds.is_none() && ui_probe.is_none(),
                display_id: restored.as_ref().map(|(display, _, _)| *display),
                window_bounds: Some(match restored {
                    Some((_, saved, true)) => WindowBounds::Maximized(saved),
                    Some((_, saved, false)) => WindowBounds::Windowed(saved),
                    None => WindowBounds::Windowed(bounds),
                }),
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
                    .open_window(options, |_, cx| {
                        cx.new(|cx| {
                            let mut preferences = crate::preferences::get(cx);
                            if let Some(quality) = arguments
                                .windows(2)
                                .find(|pair| pair[0] == "--probe-initial-quality")
                                .map(|pair| pair[1].as_str())
                                .filter(|quality| playback::resolver::is_quality(quality))
                            {
                                preferences.player_quality = quality.to_owned();
                            }
                            player::Player::new(&login, &preferences)
                        })
                    })
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
            // `--link-probe-seconds N`: open the twitch.tv sign-in window on
            // its own, log what it shows, and quit. Nothing is linked unless
            // someone signs in.
            if let Some(seconds) = arguments
                .windows(2)
                .find(|pair| pair[0] == "--link-probe-seconds")
                .and_then(|pair| pair[1].parse::<u64>().ok())
            {
                playback_link::open(None, cx, |result, cx| {
                    match result {
                        Ok(playback_link::Outcome::Linked(_)) => println!("link_probe=linked"),
                        Ok(playback_link::Outcome::Cancelled) => println!("link_probe=closed"),
                        Err(error) => println!("link_probe=error {error}"),
                    }
                    cx.quit();
                });
                cx.spawn(async move |cx| {
                    cx.background_executor()
                        .timer(std::time::Duration::from_secs(seconds))
                        .await;
                    println!("link_probe=timeout");
                    let _ = cx.update(|cx| cx.quit());
                })
                .detach();
                return;
            }
            let Ok(window) = cx.open_window(options, |_, cx| cx.new(|cx| Root::new(play, cx)))
            else {
                cx.quit();
                return;
            };
            if let Some(seconds) = app_probe {
                // A normal visible window: natural display-driven rendering,
                // real chat and sidebar, without the hidden probe's forced ticks.
                cx.spawn(async move |cx| {
                    cx.background_executor()
                        .timer(std::time::Duration::from_secs(seconds))
                        .await;
                    let _ = cx.update(|cx| {
                        let _ = window.update(cx, |root, window, cx| {
                            println!("{}", root.diagnostics(cx));
                            probe_result.store(
                                root.probe_succeeded(cx),
                                std::sync::atomic::Ordering::Release,
                            );
                            if let Some(directory) = &snapshot_dir {
                                let saved = window.capture_rendered_frame().and_then(
                                    |(width, height, pixels)| {
                                        std::fs::create_dir_all(directory)?;
                                        image::save_buffer(
                                            directory.join("app.png"),
                                            &pixels,
                                            width,
                                            height,
                                            image::ColorType::Rgba8,
                                        )?;
                                        Ok(())
                                    },
                                );
                                if saved.is_err() {
                                    eprintln!("App snapshot failed.");
                                }
                            }
                        });
                        cx.quit();
                    });
                })
                .detach();
            } else {
                cx.activate(true);
            }
        });
    playback::resolver::shutdown();
    playback::kick::shutdown();
    if (probe_seconds.is_some() || ui_probe.is_some() || app_probe.is_some())
        && !probe_passed.load(std::sync::atomic::Ordering::Acquire)
    {
        std::process::exit(1);
    }
}

/// Debug aid (VIOLETWIRE_FRAME_LOG): how often each view renders and for how
/// long, printed every two seconds.
pub mod render_stats {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    type Counts = Vec<(&'static str, u32, Duration)>;
    static STATS: Mutex<Option<(Instant, Counts)>> = Mutex::new(None);
    pub struct Timer(&'static str, Instant);
    pub fn start(name: &'static str) -> Option<Timer> {
        std::env::var_os("VIOLETWIRE_FRAME_LOG").map(|_| Timer(name, Instant::now()))
    }
    impl Drop for Timer {
        fn drop(&mut self) {
            let took = self.1.elapsed();
            let mut stats = STATS
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let (since, entries) = stats.get_or_insert_with(|| (Instant::now(), Vec::new()));
            match entries.iter_mut().find(|entry| entry.0 == self.0) {
                Some(entry) => {
                    entry.1 += 1;
                    entry.2 += took;
                }
                None => entries.push((self.0, 1, took)),
            }
            if since.elapsed() > Duration::from_secs(2) {
                let line: Vec<String> = entries
                    .iter()
                    .map(|(name, count, total)| {
                        format!("{name} {count}x {:.1}ms", total.as_secs_f64() * 1000.)
                    })
                    .collect();
                eprintln!("[renders] {}", line.join(", "));
                *stats = None;
            }
        }
    }
}
