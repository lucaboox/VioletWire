//! The main window: a custom title bar, the followed-channels sidebar and the
//! Home grid of live channels.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::anyhow;
use gpui::{
    AnyElement, App, Context, Div, Entity, FontWeight, Image, ImageSource, ObjectFit, Render,
    SharedString, Stateful, Task, Window, WindowControlArea, div, img, prelude::*, px, rgb, rgba,
};

mod browse;
mod multi;
use browse::Section;

use crate::format::{compact_count, is_login, uptime};
use crate::player::Player;
use crate::session::{self, Failure, Followed, Session};
use crate::twitch::auth::{self, Poll};
use crate::twitch::helix::FollowedChannel;
use crate::twitch::token_store;
use crate::ui::{self, ButtonStyle, Icon};
use crate::{http, images, theme};

/// How often the followed list (and its live state) refreshes.
const REFRESH_EVERY: Duration = Duration::from_secs(120);
/// Concurrent image downloads.
const IMAGE_WORKERS: usize = 6;
/// Twitch regenerates live thumbnails about every five minutes.
const THUMBNAIL_PERIOD_SECONDS: u64 = 300;

enum Auth {
    Restoring,
    /// The saved sign-in could not be checked (Twitch unreachable). It is kept.
    Unreachable,
    SignedOut,
    Requesting,
    AwaitingApproval {
        user_code: SharedString,
        verification_uri: String,
    },
    SignedIn(Session),
}

/// One image by its stable URL. Live thumbnails are re-fetched each period
/// while the previous frame stays on screen.
struct CachedImage {
    image: Option<Arc<Image>>,
    version: u64,
    pending: bool,
}

struct ImageJob {
    url: String,
    fetch_url: String,
    version: u64,
}

struct Playing {
    login: String,
    name: SharedString,
    view: Entity<Player>,
    chat: Entity<crate::chat::Chat>,
    _controls: gpui::Subscription,
    _chat_controls: gpui::Subscription,
}

pub struct Root {
    agent: ureq::Agent,
    auth: Auth,
    channels: Vec<FollowedChannel>,
    loaded: bool,
    loading: bool,
    message: Option<SharedString>,
    images: HashMap<String, CachedImage>,
    image_queue: Rc<RefCell<VecDeque<ImageJob>>>,
    image_workers: Rc<Cell<usize>>,
    playing: Option<Playing>,
    chat_visible: bool,
    overlay_chat: bool,
    theater: bool,
    probe_fullscreen: bool,
    sidebar_collapsed: bool,
    sidebar_force_expanded: bool,
    settings_open: bool,
    /// The keyboard shortcuts list ("?").
    shortcuts_open: bool,
    /// This window's handle, to own the twitch.tv sign-in window.
    hwnd: Option<isize>,
    /// Multistream's tiles, while it is open; `playing` is then empty.
    multi: Option<multi::Multi>,
    /// Kick channels opened this session, for the player header.
    kick_channels: Vec<FollowedChannel>,
    /// The signed-in Kick account's followed channels.
    kick_followed: Vec<FollowedChannel>,
    kick_task: Option<Task<()>>,
    /// Refusals in a row of the stored Kick account; three sign it out.
    kick_refusals: u8,
    _kick_info: Option<Task<()>>,
    /// The signed-in account's profile picture (Electron's account chip).
    account_image: Option<String>,
    account_image_task: Option<Task<()>>,
    /// Saves the window's position and size as it changes.
    window_observer: Option<gpui::Subscription>,
    settings: Entity<crate::settings::Settings>,
    _settings_close: gpui::Subscription,
    focus: gpui::FocusHandle,
    channel_input: Entity<crate::input::TextInput>,
    channel_subscription: Option<gpui::Subscription>,
    section: Section,
    browse: browse::BrowseState,
    search: browse::SearchState,
    category_input: Entity<crate::input::TextInput>,
    account_menu: bool,
    /// The saved line-ups menu under the top bar's Multistream button.
    top_presets: bool,
    input_observers: Vec<gpui::Subscription>,
    /// A short message at the bottom of the window (Electron's notice).
    notice: Option<SharedString>,
    notice_task: Option<Task<()>>,
    clip_task: Option<Task<()>>,
    hover_task: Option<Task<()>>,
    /// The sidebar's right-click menu: which channel, and where.
    channel_menu: Option<(String, gpui::Point<gpui::Pixels>)>,
    // A held task is cancelled when it is replaced or dropped.
    auth_task: Option<Task<()>>,
    followed_task: Option<Task<()>>,
    refresh_task: Option<Task<()>>,
}

impl Root {
    pub fn probe_tick(
        &mut self,
        phase: u64,
        keep_controls: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.overlay_chat = phase % 2 == 1;
        self.theater = phase == 2 || phase == 3;
        self.settings_open = keep_controls && phase == 4;
        // Exercise the fullscreen layout offscreen without changing any desktop
        // window state. Normal use follows Window::is_fullscreen exclusively.
        self.probe_fullscreen = phase == 3;
        // `--ui-probe-dialogs`: the shortcuts list, then a sidebar channel menu.
        if std::env::args().any(|arg| arg == "--ui-probe-dialogs") {
            self.shortcuts_open = phase == 1 && self.playing.is_none();
            if let Some(playing) = &self.playing {
                playing.chat.update(cx, |chat, cx| chat.probe_card(cx));
                return;
            }
            if phase >= 3 {
                self.settings_open = true;
                let section = if phase == 3 {
                    crate::settings::Section::Account
                } else {
                    crate::settings::Section::Chat
                };
                self.settings.update(cx, |settings, cx| settings.probe_section(section, cx));
            }
            self.channel_menu = (phase == 2)
                .then(|| self.channels.first())
                .flatten()
                .map(|channel| (channel.login.clone(), gpui::point(px(150.), px(250.))));
        }
        // `--ui-probe-browse`: Browse, a category, the search dropdown, then
        // the search page, one per phase.
        if std::env::args().any(|arg| arg == "--ui-probe-browse")
            && matches!(self.auth, Auth::SignedIn(_))
            && self.loaded
        {
            self.overlay_chat = false;
            self.theater = false;
            self.probe_fullscreen = false;
            match phase {
                0 if self.section != Section::Browse => self.show_section(Section::Browse, window, cx),
                1 if self.browse.selected.is_none() => {
                    if let Some(category) = self.browse.categories.first().cloned() {
                        self.open_category(category, window, cx);
                    }
                }
                2 if !self.search.open => {
                    self.show_section(Section::Home, window, cx);
                    self.channel_input.update(cx, |input, cx| {
                        input.clear(cx);
                        input.append("summit", cx);
                    });
                }
                3 if self.section != Section::Search => self.submit_search(window, cx),
                _ => {}
            }
        }
        if let Some(playing) = &self.playing {
            playing.view.update(cx, |p, cx| {
                if keep_controls {
                    p.keep_controls_visible();
                    p.probe_menus(phase == 1, phase == 2);
                }
                p.probe_tick(window, cx);
            });
            playing.chat.update(cx, |chat, cx| {
                chat.probe_layout(phase == 1 || phase == 2, phase == 5, cx)
            });
        }
        cx.notify();
    }
    pub fn probe_succeeded(&self, cx: &App) -> bool {
        self.playing.as_ref().is_some_and(|playing| {
            playing.view.read(cx).probe_succeeded() && playing.chat.read(cx).probe_succeeded()
        })
    }
    pub fn home_probe_succeeded(&self) -> bool {
        match self.auth {
            Auth::SignedIn(_) => self.loaded,
            Auth::SignedOut => true,
            _ => false,
        }
    }
    pub fn diagnostics(&self, cx: &App) -> String {
        self.playing
            .as_ref()
            .map(|p| {
                format!(
                    "{} {} fullscreen_layout={} overlay={} theater={}",
                    p.view.read(cx).diagnostics(),
                    p.chat.read(cx).diagnostics(),
                    self.probe_fullscreen,
                    self.overlay_chat,
                    self.theater
                )
            })
            .unwrap_or_else(|| "no player".into())
    }
    /// `play` opens a channel's player at once (the `--play` developer flag);
    /// it plays anonymously and does not need a sign-in.
    pub fn new(play: Option<String>, cx: &mut Context<Self>) -> Self {
        let playing = play.filter(|login| crate::format::is_channel(login)).map(|login| {
            let view = cx.new(|cx| Player::new(&login, &crate::preferences::get(cx)));
            let controls = cx.subscribe(
                &view,
                |this, _, action: &crate::player::PlayerAction, cx| this.player_action(action, cx),
            );
            let chat = cx.new(|cx| crate::chat::Chat::new(&login, None, cx));
            let chat_controls = cx.subscribe(
                &chat,
                |this, _, action: &crate::player::PlayerAction, cx| this.player_action(action, cx),
            );
            Playing {
                name: login.clone().into(),
                chat,
                view,
                login,
                _controls: controls,
                _chat_controls: chat_controls,
            }
        });
        let settings = cx.new(|_| crate::settings::Settings::default());
        let settings_close = crate::settings::subscribe(&settings, cx, |this, event, cx| {
            match event {
                crate::settings::Event::Closed => this.settings_open = false,
                crate::settings::Event::Shortcuts => {
                    this.settings_open = false;
                    this.shortcuts_open = true;
                }
                crate::settings::Event::LinkPlayback => this.link_playback(cx),
                crate::settings::Event::UnlinkPlayback => {
                    match crate::twitch::playback_session::unlink() {
                        Ok(()) => this.show_notice("Playback session unlinked.", cx),
                        Err(error) => this.show_notice(error.to_string(), cx),
                    }
                    this.settings.update(cx, |_, cx| cx.notify());
                }
                crate::settings::Event::KickSignIn => this.kick_sign_in(cx),
                crate::settings::Event::LoadChatColors => this.load_chat_colors(cx),
                &crate::settings::Event::SetChatColor { kick, name, hex } => this.set_chat_color(kick, name, hex, cx),
                crate::settings::Event::KickSignOut => this.kick_sign_out(cx),
            }
            cx.notify();
        });
        let mut root = Self {
            agent: http::agent(),
            auth: Auth::Restoring,
            channels: Vec::new(),
            loaded: false,
            loading: false,
            message: None,
            images: HashMap::new(),
            image_queue: Rc::default(),
            image_workers: Rc::default(),
            playing,
            chat_visible: true,
            overlay_chat: false,
            theater: false,
            probe_fullscreen: false,
            sidebar_collapsed: crate::preferences::get(cx).sidebar_collapsed,
            sidebar_force_expanded: false,
            settings_open: false,
            shortcuts_open: false,
            hwnd: None,
            multi: None,
            kick_channels: Vec::new(),
            kick_followed: Vec::new(),
            kick_task: None,
            kick_refusals: 0,
            _kick_info: None,
            account_image: None,
            account_image_task: None,
            window_observer: None,
            settings,
            _settings_close: settings_close,
            focus: cx.focus_handle(),
            channel_input: cx.new(|cx| {
                crate::input::TextInput::new("Search channels and categories", cx)
            }),
            channel_subscription: None,
            section: Section::Home,
            browse: Default::default(),
            search: Default::default(),
            category_input: cx.new(|cx| crate::input::TextInput::new("Search categories", cx)),
            account_menu: false,
            top_presets: false,
            input_observers: Vec::new(),
            notice: None,
            notice_task: None,
            clip_task: None,
            hover_task: None,
            channel_menu: None,
            auth_task: None,
            followed_task: None,
            refresh_task: None,
        };
        root.restore(cx);
        root.start_kick(cx);
        // A Kick channel opened at launch still gets its header details.
        if let Some(slug) = root.playing.as_ref().and_then(|playing| crate::kick::slug(&playing.login)).map(str::to_owned) {
            root.load_kick_info(slug, cx);
        }
        root
    }

    // ----- Sign-in -------------------------------------------------------

    fn restore(&mut self, cx: &mut Context<Self>) {
        self.auth = Auth::Restoring;
        self.message = None;
        cx.notify();
        let agent = self.agent.clone();
        self.auth_task = Some(cx.spawn(async move |this, cx| {
            let restored = cx
                .background_executor()
                .spawn(async move { session::restore(&agent) })
                .await;
            this.update(cx, |this, cx| {
                match restored {
                    Ok(Some(session)) => this.start_session(session, cx),
                    Ok(None) => this.auth = Auth::SignedOut,
                    Err(error) => {
                        this.auth = Auth::Unreachable;
                        this.message = Some(error.to_string().into());
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    fn begin_sign_in(&mut self, cx: &mut Context<Self>) {
        // A new sign-in replaces whatever was saved before.
        let epoch = token_store::end_epoch();
        self.auth = Auth::Requesting;
        self.message = None;
        cx.notify();
        let agent = self.agent.clone();
        self.auth_task = Some(cx.spawn(async move |this, cx| {
            let started = cx
                .background_executor()
                .spawn({
                    let agent = agent.clone();
                    async move { auth::start_device_flow(&agent) }
                })
                .await;
            let device = match started {
                Ok(device) => device,
                Err(error) => {
                    this.update(cx, |this, cx| this.sign_in_failed(error, cx))
                        .ok();
                    return;
                }
            };
            let deadline = Instant::now() + Duration::from_secs(device.expires_in);
            let shown = this.update(cx, |this, cx| {
                open_activation(&device.verification_uri, cx);
                this.auth = Auth::AwaitingApproval {
                    user_code: device.user_code.clone().into(),
                    verification_uri: device.verification_uri.clone(),
                };
                cx.notify();
            });
            if shown.is_err() {
                return;
            }

            enum Step {
                Wait,
                SlowDown,
                Done(Session),
            }
            let mut interval = Duration::from_secs(device.interval.clamp(1, 30));
            loop {
                cx.background_executor().timer(interval).await;
                if Instant::now() >= deadline {
                    let expired = anyhow!("The sign-in code expired. Start again.");
                    this.update(cx, |this, cx| this.sign_in_failed(expired, cx))
                        .ok();
                    return;
                }
                let device_code = device.device_code.clone();
                let agent = agent.clone();
                let step = cx
                    .background_executor()
                    .spawn(async move {
                        anyhow::Ok(match auth::poll_device_flow(&agent, &device_code)? {
                            Poll::Pending => Step::Wait,
                            Poll::SlowDown => Step::SlowDown,
                            Poll::Approved(token) => {
                                Step::Done(session::begin(&agent, token, epoch)?)
                            }
                        })
                    })
                    .await;
                match step {
                    Ok(Step::Wait) => {}
                    Ok(Step::SlowDown) => interval += Duration::from_secs(5),
                    Ok(Step::Done(session)) => {
                        this.update(cx, |this, cx| {
                            this.start_session(session, cx);
                            cx.notify();
                        })
                        .ok();
                        return;
                    }
                    Err(error) => {
                        this.update(cx, |this, cx| this.sign_in_failed(error, cx))
                            .ok();
                        return;
                    }
                }
            }
        }));
    }

    fn cancel_sign_in(&mut self, cx: &mut Context<Self>) {
        token_store::end_epoch();
        self.auth_task = None;
        self.auth = Auth::SignedOut;
        self.message = None;
        cx.notify();
    }

    fn sign_in_failed(&mut self, error: anyhow::Error, cx: &mut Context<Self>) {
        self.auth = Auth::SignedOut;
        self.message = Some(error.to_string().into());
        cx.notify();
    }

    fn start_session(&mut self, session: Session, cx: &mut Context<Self>) {
        self.auth = Auth::SignedIn(session);
        self.message = None;
        self.channels.clear();
        self.loaded = false;
        self.loading = false;
        self.load_followed(cx);
        self.refresh_task = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(REFRESH_EVERY).await;
                if this.update(cx, |this, cx| this.load_followed(cx)).is_err() {
                    break;
                }
            }
        }));
    }

    /// Signs out (or reacts to Twitch ending the session): forgets the token
    /// on this PC, revokes it, and drops everything tied to the account.
    fn end_session(&mut self, message: Option<&str>, cx: &mut Context<Self>) {
        token_store::end_epoch();
        let previous = std::mem::replace(&mut self.auth, Auth::SignedOut);
        self.channels.clear();
        self.loaded = false;
        self.loading = false;
        self.images.clear();
        self.image_queue.borrow_mut().clear();
        self.followed_task = None;
        self.refresh_task = None;
        self.account_image = None;
        self.account_image_task = None;
        // Dropping the player stops Streamlink and FFmpeg.
        self.playing = None;
        self.clip_task = None;
        self.message = message.map(|text| SharedString::from(text.to_string()));
        if let Auth::SignedIn(session) = previous {
            let agent = self.agent.clone();
            cx.background_executor()
                .spawn(async move {
                    let _ = session::sign_out(&agent, &session.token);
                })
                .detach();
        }
        cx.notify();
    }

    // ----- Playback ------------------------------------------------------

    fn play(
        &mut self,
        login: &str,
        name: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !crate::format::is_channel(login) {
            return;
        }
        if self.multi.is_some() {
            self.add_tile(login, name, cx);
            return;
        }
        self.close_player(window, cx);
        self.playing = Some(self.open_playing(login, name, cx));
        cx.notify();
    }

    /// A player and chat for one channel, wired to the window's controls.
    fn open_playing(&mut self, login: &str, name: SharedString, cx: &mut Context<Self>) -> Playing {
        if let Some(slug) = crate::kick::slug(login) {
            self.load_kick_info(slug.to_owned(), cx);
        }
        let view = cx.new(|cx| Player::new(login, &crate::preferences::get(cx)));
        let controls = cx.subscribe(
            &view,
            |this, _, action: &crate::player::PlayerAction, cx| this.player_action(action, cx),
        );
        let session = if let Auth::SignedIn(session) = &self.auth {
            Some(session.clone())
        } else {
            None
        };
        let chat = cx.new(|cx| crate::chat::Chat::new(login, session, cx));
        let chat_controls = cx.subscribe(
            &chat,
            |this, _, action: &crate::player::PlayerAction, cx| this.player_action(action, cx),
        );
        Playing {
            login: login.to_string(),
            name,
            view,
            chat,
            _controls: controls,
            _chat_controls: chat_controls,
        }
    }

    // ----- Chat name colours ------------------------------------------------

    fn show_color(&mut self, kick: bool, color: crate::settings::ChatColor, cx: &mut Context<Self>) {
        self.settings.update(cx, |settings, cx| settings.set_chat_color(kick, color, cx));
    }

    /// Twitch's colour through Helix, Kick's from the signed-in Kick page
    /// (Electron's `getChatColor`).
    fn load_chat_colors(&mut self, cx: &mut Context<Self>) {
        if let Auth::SignedIn(session) = &self.auth {
            let user_id = session.identity.user_id.clone();
            let task = self.helix_task(
                cx,
                move |helix| helix.chat_color(&user_id),
                |this, result, cx| {
                    let color = match result {
                        Ok(color) => crate::settings::ChatColor { color: Some(color), ..Default::default() },
                        Err(error) => crate::settings::ChatColor { note: Some(error.to_string()), ..Default::default() },
                    };
                    this.show_color(false, color, cx);
                },
            );
            if let Some(task) = task {
                task.detach();
            }
        }
        if crate::preferences::get(cx).kick_account.is_some() {
            cx.spawn(async move |this, cx| {
                let color = async {
                    let (status, user) = crate::kick_web::request(cx, "GET", "/api/v1/user", None).await?;
                    anyhow::ensure!(status == 200, "Kick answered {status}.");
                    let id = anyhow::Context::context(user["id"].as_u64(), "Kick sent no account.")?;
                    let (_, identity) = crate::kick_web::request(
                        cx,
                        "GET",
                        &format!("/api/internal/v1/chatroom/users/{id}/identity"),
                        None,
                    )
                    .await?;
                    let color = [&identity["color"], &identity["data"]["color"], &user["identity"]["color"], &user["chat_color"]]
                        .into_iter()
                        .find_map(|value| value.as_str().filter(|color| is_hex_color(color)))
                        .unwrap_or_default()
                        .to_owned();
                    anyhow::Ok(color)
                }
                .await;
                this.update(cx, |this, cx| {
                    let color = match color {
                        Ok(color) => crate::settings::ChatColor { color: Some(color), ..Default::default() },
                        Err(error) => crate::settings::ChatColor { note: Some(error.to_string()), ..Default::default() },
                    };
                    this.show_color(true, color, cx);
                })
                .ok();
            })
            .detach();
        }
    }

    fn set_chat_color(&mut self, kick: bool, name: &'static str, hex: &'static str, cx: &mut Context<Self>) {
        self.show_color(kick, crate::settings::ChatColor { busy: true, ..Default::default() }, cx);
        if kick {
            cx.spawn(async move |this, cx| {
                let body = serde_json::json!({ "color": hex });
                let result = crate::kick_web::request(cx, "PUT", "/api/internal/v1/chatroom/identity", Some(&body)).await;
                this.update(cx, |this, cx| {
                    let color = match result {
                        Ok((200..=299, _)) => crate::settings::ChatColor { color: Some(hex.to_owned()), ..Default::default() },
                        Ok((401 | 403 | 419, _)) => crate::settings::ChatColor {
                            note: Some("Kick rejected the session. Sign in to Kick again.".into()),
                            ..Default::default()
                        },
                        Ok(_) => crate::settings::ChatColor {
                            note: Some("Kick would not change the name colour.".into()),
                            ..Default::default()
                        },
                        Err(error) => crate::settings::ChatColor { note: Some(error.to_string()), ..Default::default() },
                    };
                    this.show_color(true, color, cx);
                })
                .ok();
            })
            .detach();
            return;
        }
        let Auth::SignedIn(session) = &self.auth else { return };
        // A sign-in from before this permission was asked for cannot change it;
        // asking Twitch anyway would read as a lost session.
        if !session.token.scopes.iter().any(|scope| scope == "user:manage:chat_color") {
            self.show_color(
                false,
                crate::settings::ChatColor {
                    note: Some("Sign out and in with Twitch once to let VioletWire change your colour.".into()),
                    ..Default::default()
                },
                cx,
            );
            return;
        }
        let user_id = session.identity.user_id.clone();
        let task = self.helix_task(
            cx,
            move |helix| helix.set_chat_color(&user_id, name),
            move |this, result, cx| {
                let color = match result {
                    Ok(()) => crate::settings::ChatColor { color: Some(hex.to_owned()), ..Default::default() },
                    Err(error) => crate::settings::ChatColor { note: Some(error.to_string()), ..Default::default() },
                };
                this.show_color(false, color, cx);
            },
        );
        if let Some(task) = task {
            task.detach();
        }
    }

    // ----- Kick account ---------------------------------------------------

    fn kick_sign_in(&mut self, cx: &mut Context<Self>) {
        let root = cx.entity().downgrade();
        crate::kick_web::sign_in(self.hwnd, cx, move |result, cx| {
            let _ = root.update(cx, |this, cx| {
                match result {
                    Ok(Some(account)) => {
                        this.show_notice(format!("Signed in to Kick as {}.", account.username), cx);
                        crate::preferences::update(cx, |prefs| prefs.kick_account = Some(account));
                        this.start_kick(cx);
                    }
                    Ok(None) => {}
                    Err(error) => this.show_notice(error.to_string(), cx),
                }
                this.settings.update(cx, |_, cx| cx.notify());
                cx.notify();
            });
        });
    }

    fn kick_sign_out(&mut self, cx: &mut Context<Self>) {
        self.kick_task = None;
        self.kick_followed.clear();
        crate::preferences::update(cx, |prefs| prefs.kick_account = None);
        self.settings.update(cx, |_, cx| cx.notify());
        cx.spawn(async move |this, cx| {
            let result = crate::kick_web::sign_out(cx).await;
            this.update(cx, |this, cx| {
                this.show_notice(
                    match result {
                        Ok(()) => "Signed out of Kick.".to_owned(),
                        Err(error) => format!("Kick sign-out did not finish: {error}"),
                    },
                    cx,
                );
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Keeps the followed Kick channels current while signed in to Kick.
    fn start_kick(&mut self, cx: &mut Context<Self>) {
        if crate::preferences::get(cx).kick_account.is_none() {
            return;
        }
        self.kick_task = Some(cx.spawn(async move |this, cx| {
            loop {
                let result = load_kick_followed(cx).await;
                let keep = this.update(cx, |this, cx| this.kick_followed_loaded(result, cx)).unwrap_or(false);
                if !keep {
                    break;
                }
                cx.background_executor().timer(REFRESH_EVERY).await;
            }
        }));
    }

    /// `None` means Kick refused the account. Returns whether to keep polling.
    fn kick_followed_loaded(&mut self, result: anyhow::Result<Option<Vec<FollowedChannel>>>, cx: &mut Context<Self>) -> bool {
        match result {
            Ok(Some(channels)) => {
                self.kick_refusals = 0;
                self.kick_followed = channels;
                self.queue_images(cx);
            }
            Ok(None) => {
                // One refusal can be Kick's edge; several in a row mean the
                // session really ended (Electron's EXPIRY_CONFIRMATIONS).
                self.kick_refusals += 1;
                if self.kick_refusals >= 3 {
                    self.kick_refusals = 0;
                    self.kick_followed.clear();
                    crate::preferences::update(cx, |prefs| prefs.kick_account = None);
                    self.show_notice("Kick signed you out. Sign in again in Settings.", cx);
                    self.settings.update(cx, |_, cx| cx.notify());
                    cx.notify();
                    return false;
                }
            }
            // Offline or Kick down: keep what we have.
            Err(_) => {}
        }
        cx.notify();
        true
    }

    /// A Kick channel's title, viewers and picture for the header.
    fn load_kick_info(&mut self, slug: String, cx: &mut Context<Self>) {
        self._kick_info = Some(cx.spawn(async move |this, cx| {
            let channel = cx
                .background_executor()
                .spawn(async move { crate::kick::channel(&slug) })
                .await;
            let Ok(channel) = channel else { return };
            this.update(cx, |this, cx| {
                let followed = channel.followed();
                this.kick_channels.retain(|known| known.login != followed.login);
                this.kick_channels.push(followed);
                this.queue_images(cx);
                cx.notify();
            })
            .ok();
        }));
    }

    /// Hovering a live channel starts looking it up, so a click plays sooner
    /// (Electron's pre-resolve). Leaving it within 150 ms cancels that.
    fn hover_preresolve(&mut self, login: &str, hovered: bool, cx: &mut Context<Self>) {
        if !hovered {
            self.hover_task = None;
            return;
        }
        let login = login.to_owned();
        let quality = crate::preferences::get(cx).player_quality;
        self.hover_task = Some(cx.spawn(async move |_, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(150))
                .await;
            crate::playback::resolver::preresolve(&login, &quality);
        }));
    }

    /// Shows `text` at the bottom of the window for a few seconds.
    /// Opens twitch.tv's sign-in in its own window (Electron's "link playback
    /// session").
    fn link_playback(&mut self, cx: &mut Context<Self>) {
        let root = cx.entity().downgrade();
        crate::playback_link::open(self.hwnd, cx, move |result, cx| {
            let _ = root.update(cx, |this, cx| {
                match result {
                    Ok(crate::playback_link::Outcome::Linked(login)) => this.show_notice(
                        match login {
                            Some(login) => format!(
                                "Linked as {login}. Streams you open now come without ads if you have Turbo or a subscription."
                            ),
                            None => "Linked. Streams you open now come without ads if you have Turbo or a subscription.".to_owned(),
                        },
                        cx,
                    ),
                    Ok(crate::playback_link::Outcome::Cancelled) => {}
                    Err(error) => this.show_notice(error.to_string(), cx),
                }
                this.settings.update(cx, |_, cx| cx.notify());
                cx.notify();
            });
        });
    }

    fn show_notice(&mut self, text: impl Into<SharedString>, cx: &mut Context<Self>) {
        self.notice = Some(text.into());
        self.notice_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_secs(5))
                .await;
            this.update(cx, |this, cx| {
                this.notice = None;
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Clips the live moment with Twitch's official API and opens Twitch's
    /// editor in the browser, as the Electron client's Clip button does.
    fn create_clip(&mut self, login: String, cx: &mut Context<Self>) {
        if self.clip_task.is_some() {
            return;
        }
        let known = self.channel_info(&login).map(|channel| channel.id.clone());
        let task = self.helix_task(
            cx,
            move |helix| {
                let id = match &known {
                    Some(id) => id.clone(),
                    None => helix
                        .user_id(&login)?
                        .ok_or_else(|| anyhow!("That channel was not found."))?,
                };
                helix.create_clip(&id)
            },
            |this, result, cx| {
                this.clip_task = None;
                match result {
                    Ok(url) if crate::twitch::helix::is_clip_editor_url(&url) => {
                        cx.open_url(&url);
                        this.show_notice("Clip created. Twitch's editor opened in your browser.", cx);
                    }
                    Ok(_) => this.show_notice("Clip created.", cx),
                    Err(error) => this.show_notice(error, cx),
                }
            },
        );
        if task.is_some() {
            self.clip_task = task;
            self.show_notice("Creating a clip at the current live moment…", cx);
        } else {
            self.show_notice("Sign in with Twitch to create clips.", cx);
        }
    }

    fn player_action(&mut self, action: &crate::player::PlayerAction, cx: &mut Context<Self>) {
        if let Some(multi) = &mut self.multi {
            match action {
                crate::player::PlayerAction::Settings => self.settings_open = true,
                crate::player::PlayerAction::Chat => multi.chat_visible = !multi.chat_visible,
                crate::player::PlayerAction::Overlay => {}
                crate::player::PlayerAction::Theater => self.theater = !self.theater,
            }
            cx.notify();
            return;
        }
        match action {
            crate::player::PlayerAction::Settings => self.settings_open = true,
            crate::player::PlayerAction::Chat => self.chat_visible = !self.chat_visible,
            crate::player::PlayerAction::Overlay => {
                self.overlay_chat = !self.overlay_chat;
                self.chat_visible = true;
            }
            crate::player::PlayerAction::Theater => self.theater = !self.theater,
        }
        cx.notify();
    }
    fn close_player(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.theater = false;
        if let Some(multi) = self.multi.take() {
            for tile in multi.tiles {
                tile.view.update(cx, |player, cx| player.close(window, cx));
            }
        }
        if window.is_fullscreen() {
            window.toggle_fullscreen();
        }
        if let Some(playing) = self.playing.take() {
            playing
                .view
                .update(cx, |player, cx| player.close(window, cx));
            cx.notify();
        }
    }

    // ----- Followed channels ---------------------------------------------

    fn load_followed(&mut self, cx: &mut Context<Self>) {
        let Auth::SignedIn(current) = &self.auth else {
            return;
        };
        if self.loading {
            return;
        }
        self.loading = true;
        cx.notify();
        let current = current.clone();
        let epoch = current.epoch;
        let agent = self.agent.clone();
        self.followed_task = Some(cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { session::followed(&agent, &current) })
                .await;
            this.update(cx, |this, cx| this.followed_loaded(epoch, result, cx))
                .ok();
        }));
    }

    fn load_account_image(&mut self, cx: &mut Context<Self>) {
        let Auth::SignedIn(session) = &self.auth else {
            return;
        };
        if self.account_image.is_some() || self.account_image_task.is_some() {
            return;
        }
        let id = session.identity.user_id.clone();
        self.account_image_task = self.helix_task(
            cx,
            move |helix| helix.profile_image(&id),
            |this, result, cx| {
                this.account_image_task = None;
                if let Ok(Some(url)) = result {
                    this.account_image = Some(url);
                    this.queue_images(cx);
                }
            },
        );
    }

    fn followed_loaded(
        &mut self,
        epoch: u64,
        result: Result<Followed, Failure>,
        cx: &mut Context<Self>,
    ) {
        self.load_account_image(cx);
        let Auth::SignedIn(current) = &mut self.auth else {
            return;
        };
        if current.epoch != epoch {
            return;
        }
        self.loading = false;
        match result {
            Ok(followed) => {
                if let Some(token) = followed.renewed {
                    current.token = token;
                }
                self.channels = followed.channels;
                self.loaded = true;
                self.message = None;
                self.queue_images(cx);
            }
            Err(Failure::SignedOut) => {
                self.end_session(Some("Twitch ended the session. Sign in again."), cx);
                return;
            }
            Err(Failure::Other(error)) => self.message = Some(error.to_string().into()),
        }
        cx.notify();
    }

    // ----- Images -------------------------------------------------------

    fn queue_images(&mut self, cx: &mut Context<Self>) {
        let period = auth::now() / THUMBNAIL_PERIOD_SECONDS;
        // Thumbnails first: they are what Home shows.
        let thumbnails = self
            .channels
            .iter()
            .chain(&self.kick_followed)
            .filter_map(|channel| channel.stream.as_ref()?.thumbnail_url.clone())
            .map(|url| (url, period));
        let avatars = self
            .channels
            .iter()
            .chain(&self.kick_followed)
            .chain(&self.kick_channels)
            .filter_map(|channel| channel.profile_image_url.clone())
            .chain(self.account_image.clone())
            .map(|url| (url, 0));
        let mut wanted: Vec<(String, u64)> = thumbnails.chain(avatars).collect();
        wanted.extend(self.browse_images(period));

        let keep: HashSet<&str> = wanted.iter().map(|(url, _)| url.as_str()).collect();
        self.images.retain(|url, _| keep.contains(url.as_str()));

        let mut queue = self.image_queue.borrow_mut();
        for (url, version) in wanted {
            let entry = self.images.entry(url.clone()).or_insert(CachedImage {
                image: None,
                version: 0,
                pending: false,
            });
            // Missing images (including failed ones) retry on each refresh;
            // a thumbnail also re-fetches once a new period starts.
            let current = entry.image.is_some() && version <= entry.version;
            if entry.pending || current {
                continue;
            }
            entry.pending = true;
            let fetch_url = if version > 0 {
                // A new query string per period gets the current frame past caches.
                format!("{url}?t={version}")
            } else {
                url.clone()
            };
            queue.push_back(ImageJob {
                url,
                fetch_url,
                version,
            });
        }
        drop(queue);
        self.pump_images(cx);
    }

    fn pump_images(&mut self, cx: &mut Context<Self>) {
        while self.image_workers.get() < IMAGE_WORKERS && !self.image_queue.borrow().is_empty() {
            self.image_workers.set(self.image_workers.get() + 1);
            let queue = self.image_queue.clone();
            let workers = self.image_workers.clone();
            let agent = self.agent.clone();
            cx.spawn(async move |this, cx| {
                loop {
                    let Some(job) = queue.borrow_mut().pop_front() else {
                        break;
                    };
                    let agent = agent.clone();
                    let fetch_url = job.fetch_url.clone();
                    let result = cx
                        .background_executor()
                        .spawn(async move { images::fetch(&agent, &fetch_url) })
                        .await;
                    if this
                        .update(cx, |this, cx| this.image_loaded(job, result, cx))
                        .is_err()
                    {
                        break;
                    }
                }
                workers.set(workers.get() - 1);
            })
            .detach();
        }
    }

    fn image_loaded(
        &mut self,
        job: ImageJob,
        result: anyhow::Result<Arc<Image>>,
        cx: &mut Context<Self>,
    ) {
        let Some(entry) = self.images.get_mut(&job.url) else {
            return;
        };
        entry.pending = false;
        entry.version = entry.version.max(job.version);
        // A failed refresh keeps the previous frame.
        if let Ok(image) = result {
            entry.image = Some(image);
            cx.notify();
        }
    }

    fn image(&self, url: &str) -> Option<Arc<Image>> {
        self.images.get(url)?.image.clone()
    }

    // ----- Rendering ----------------------------------------------------

    fn title_bar(&self, window: &Window) -> impl IntoElement {
        let maximize_glyph = if window.is_maximized() {
            "\u{E923}"
        } else {
            "\u{E922}"
        };
        div()
            .h(px(30.))
            .flex_none()
            .flex()
            .items_center()
            .bg(theme::title_bar())
            .border_b_1()
            .border_color(theme::border())
            .child(
                div()
                    .flex_1()
                    .h_full()
                    .flex()
                    .items_center()
                    .gap_2()
                    .pl(px(19.))
                    // Keep the root's focus-on-click listener from preventing
                    // Windows' default non-client drag/double-click behavior.
                    .occlude()
                    .window_control_area(WindowControlArea::Drag)
                    .child(
                        div()
                            .text_size(px(12.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme::text_secondary())
                            .child("VioletWire"),
                    ),
            )
            .child(caption_button(
                "minimize",
                "\u{E921}",
                WindowControlArea::Min,
            ))
            .child(caption_button(
                "maximize",
                maximize_glyph,
                WindowControlArea::Max,
            ))
            .child(caption_button(
                "close",
                "\u{E8BB}",
                WindowControlArea::Close,
            ))
    }

    /// Electron's `top-multistream-group`: the Multistream toggle, and a
    /// chevron for saved line-ups when there are any.
    fn multistream_group(&self, cx: &Context<Self>) -> AnyElement {
        let active = self.multi.is_some();
        let presets = crate::preferences::get(cx).multi_stream_presets;
        let has_presets = !presets.is_empty();
        let names: std::collections::HashMap<String, String> = self
            .channels
            .iter()
            .map(|channel| (channel.login.clone(), channel.display_name.clone()))
            .collect();
        div()
            .relative()
            .flex_none()
            .flex()
            .items_center()
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                ui::button(
                    "multi-top",
                    "Multistream",
                    Some(Icon::Grid),
                    if active { ButtonStyle::Selected } else { ButtonStyle::Secondary },
                )
                .h(px(40.))
                .when(has_presets, |button| button.rounded_r(px(0.)))
                .tooltip(|_, cx| cx.new(|_| ui::Tooltip("Watch up to 4 streams at once".into())).into())
                .on_click(cx.listener(|this, _, window, cx| {
                    this.top_presets = false;
                    if this.multi.is_some() {
                        this.exit_multi(window, cx);
                    } else {
                        this.enter_multi(cx);
                    }
                    cx.notify();
                })),
            )
            .when(has_presets, |group| {
                group.child(
                    ui::icon_button("multi-top-presets", Icon::ChevronDown, "Open a saved line-up", self.top_presets || active)
                        .h(px(40.))
                        .w(px(30.))
                        .rounded_l(px(0.))
                        .border_l_1()
                        .border_color(theme::border())
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.top_presets = !this.top_presets;
                            this.account_menu = false;
                            this.search.open = false;
                            cx.notify();
                        })),
                )
            })
            .when(self.top_presets && has_presets, |group| {
                group.child(
                    gpui::deferred(
                        div()
                            .id("top-presets-menu")
                            .occlude()
                            .absolute()
                            .top(px(46.))
                            .right_0()
                            .w(px(280.))
                            .max_h(px(380.))
                            .overflow_y_scroll()
                            .p(px(6.))
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .rounded(px(10.))
                            .border_1()
                            .border_color(theme::button_border())
                            .bg(theme::popup())
                            .shadow_lg()
                            .children(presets.into_iter().enumerate().map(|(index, preset)| {
                                let lineup = preset
                                    .channels
                                    .iter()
                                    .map(|login| match crate::kick::slug(login) {
                                        Some(slug) => format!("{slug} (Kick)"),
                                        None => names.get(login).cloned().unwrap_or_else(|| login.clone()),
                                    })
                                    .collect::<Vec<_>>()
                                    .join(" · ");
                                let channels = preset.channels.clone();
                                div()
                                    .id(SharedString::from(format!("top-preset-{index}")))
                                    .px(px(10.))
                                    .py(px(7.))
                                    .flex()
                                    .flex_col()
                                    .gap(px(2.))
                                    .rounded(px(7.))
                                    .cursor_pointer()
                                    .hover(|style| style.bg(theme::surface_hover()))
                                    .child(
                                        div()
                                            .truncate()
                                            .text_size(px(13.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child(preset.name.clone()),
                                    )
                                    .child(div().truncate().text_size(px(11.)).text_color(theme::text_dim()).child(lineup))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.open_preset(channels.clone(), window, cx);
                                        cx.notify();
                                    }))
                            })),
                    )
                    .with_priority(1),
                )
            })
            .into_any_element()
    }

    fn navigation(&self, cx: &Context<Self>) -> impl IntoElement {
        let signed_in = matches!(self.auth, Auth::SignedIn(_));
        let login = match &self.auth {
            Auth::SignedIn(session) => session.identity.login.clone(),
            _ => String::new(),
        };
        let on_page = |section| self.playing.is_none() && self.section == section;
        let nav_style = |active: bool| {
            if active {
                ButtonStyle::Selected
            } else {
                ButtonStyle::Ghost
            }
        };
        div()
            .h(px(68.))
            .flex_none()
            .px_5()
            .gap_2()
            .flex()
            .items_center()
            .bg(theme::topbar())
            .border_b_1()
            .border_color(theme::border())
            .child(
                ui::button("home-nav", "Home", Some(Icon::Home), nav_style(on_page(Section::Home)))
                    .h(px(38.))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.show_section(Section::Home, window, cx)
                    })),
            )
            // Kick's directory needs no sign-in, so Browse is always there.
            .child(
                ui::button(
                    "browse-nav",
                    "Browse",
                    Some(Icon::Compass),
                    nav_style(on_page(Section::Browse)),
                )
                .h(px(38.))
                .on_click(cx.listener(|this, _, window, cx| {
                    this.show_section(Section::Browse, window, cx)
                })),
            )
            .child(div().flex_1().min_w(px(12.)))
            .child(
                div()
                    .relative()
                    // Prefers Electron's width and gives way in narrow windows.
                    .flex_basis(px(540.))
                    .flex_shrink()
                    .min_w(px(160.))
                    // Clicking the box must not close its own dropdown.
                    .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(self.channel_input.clone())
                    .when_some(self.search_dropdown(cx), |field, dropdown| {
                        field.child(
                            gpui::deferred(
                                div()
                                    .absolute()
                                    .top(px(44.))
                                    .left_0()
                                    .right_0()
                                    .child(dropdown),
                            )
                            .with_priority(1),
                        )
                    }),
            )
            .child(div().flex_1().min_w(px(12.)))
            .when(signed_in, |bar| bar.child(self.multistream_group(cx)))
            .when(signed_in, |bar| {
                let initial = login
                    .chars()
                    .next()
                    .map(|c| c.to_ascii_uppercase().to_string())
                    .unwrap_or_default();
                bar.child(
                    div()
                        .relative()
                        .flex_none()
                        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .child(
                            div()
                                .id("account")
                                .h(px(40.))
                                .pl(px(6.))
                                .pr(px(12.))
                                .flex()
                                .items_center()
                                .gap(px(9.))
                                .rounded(px(8.))
                                .border_1()
                                .border_color(theme::button_border())
                                .bg(theme::button())
                                .cursor_pointer()
                                .hover(|style| style.bg(theme::button_hover()))
                                .child(
                                    div()
                                        .relative()
                                        .size(px(28.))
                                        .flex_none()
                                        .rounded_full()
                                        .bg(theme::selected())
                                        .text_color(theme::accent_text())
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .map(|chip| {
                                            match self.account_image.as_deref().and_then(|url| self.image(url)) {
                                                Some(_) => chip.child(self.avatar(self.account_image.as_deref(), 28.)),
                                                None => chip.child(initial),
                                            }
                                        })
                                        .child(
                                            div()
                                                .absolute()
                                                .right(px(-1.))
                                                .bottom(px(-1.))
                                                .size(px(9.))
                                                .rounded_full()
                                                .border_2()
                                                .border_color(theme::button())
                                                .bg(rgb(0x22c55e)),
                                        ),
                                )
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(theme::text())
                                        .child(login.clone()),
                                )
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.account_menu = !this.account_menu;
                                    this.search.open = false;
                                    cx.notify();
                                })),
                        )
                        .when(self.account_menu, |chip| {
                            chip.child(
                                gpui::deferred(
                                    div()
                                        .absolute()
                                        .top(px(46.))
                                        .right_0()
                                        .w(px(220.))
                                        .p(px(6.))
                                        .rounded(px(10.))
                                        .border_1()
                                        .border_color(theme::button_border())
                                        .bg(theme::popup())
                                        .shadow_lg()
                                        .child(
                                            div()
                                                .px(px(10.))
                                                .py(px(8.))
                                                .text_size(px(12.))
                                                .text_color(theme::text_dim())
                                                .child(format!("Signed in as {login}")),
                                        )
                                        .child(
                                            div()
                                                .id("sign-out")
                                                .h(px(36.))
                                                .px(px(10.))
                                                .flex()
                                                .items_center()
                                                .gap(px(9.))
                                                .rounded(px(7.))
                                                .text_size(px(13.))
                                                .cursor_pointer()
                                                .hover(|style| style.bg(theme::selected()))
                                                .child(ui::icon(Icon::SignOut, 15.))
                                                .child("Sign out")
                                                .on_click(cx.listener(|this, _, window, cx| {
                                                    this.account_menu = false;
                                                    this.close_player(window, cx);
                                                    this.end_session(None, cx);
                                                })),
                                        ),
                                )
                                .with_priority(1),
                            )
                        }),
                )
            })
            .when(!signed_in, |bar| {
                bar.child(
                    ui::button("sign-in-top", "Sign in", Some(Icon::SignIn), ButtonStyle::Primary)
                        .h(px(38.))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.close_player(window, cx);
                            this.begin_sign_in(cx);
                        })),
                )
            })
            .child(
                ui::icon_button("top-settings", Icon::Settings, "Settings", self.settings_open)
                    .size(px(40.))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.settings_open = true;
                        this.account_menu = false;
                        window.focus(&this.focus);
                        cx.notify();
                    })),
            )
    }
    /// Followed channels as the sidebar lists them: live, then offline, each
    /// with favourites first and otherwise in Twitch's order. An offline
    /// favourite never outranks a live channel.
    /// The followed channels of the services the sidebar shows.
    fn followed_shown(&self, platform: browse::Platform) -> impl Iterator<Item = &FollowedChannel> {
        let twitch = if platform.twitch() { &self.channels[..] } else { &[] };
        let kick = if platform.kick() { &self.kick_followed[..] } else { &[] };
        twitch.iter().chain(kick)
    }

    fn sidebar_order(&self, favorites: &[String], platform: browse::Platform) -> Vec<&FollowedChannel> {
        // Live ones sort together across services by viewers, so the list
        // reads as one set of people who are on now (as Electron's does).
        let rank = |channel: &FollowedChannel| {
            (
                channel.stream.is_none(),
                !favorites.contains(&channel.login),
                std::cmp::Reverse(channel.stream.as_ref().map_or(0, |stream| stream.viewer_count)),
            )
        };
        let mut ordered: Vec<&FollowedChannel> = self.followed_shown(platform).collect();
        // Stable: within a rank the original order stays.
        ordered.sort_by_key(|channel| rank(channel));
        ordered
    }

    fn toggle_favorite(&mut self, login: &str, cx: &mut Context<Self>) {
        let login = login.to_owned();
        crate::preferences::update(cx, |prefs| {
            if let Some(at) = prefs.favorite_channels.iter().position(|seen| *seen == login) {
                prefs.favorite_channels.remove(at);
            } else {
                prefs.favorite_channels.push(login);
            }
        });
        self.channel_menu = None;
        cx.notify();
    }

    fn sidebar(&self, collapsed: bool, cx: &Context<Self>) -> impl IntoElement {
        let prefs = crate::preferences::get(cx);
        let favorites = prefs.favorite_channels;
        let platform = browse::Platform::from(prefs.platform_filter.as_str());
        let kick_signed_in = prefs.kick_account.is_some();
        let ordered = self.sidebar_order(&favorites, platform);
        let ring = platform == browse::Platform::Both;
        let live = ordered.iter().filter(|channel| channel.stream.is_some()).count();
        let total = ordered.len();
        div()
            .w(px(if collapsed { 68. } else { 244. }))
            .flex_none()
            .h_full()
            .flex()
            .flex_col()
            .bg(theme::sidebar())
            .border_r_1()
            .border_color(theme::border())
            .child(
                div()
                    .h(px(68.))
                    .flex_none()
                    .px_4()
                    .flex()
                    .items_center()
                    .gap_2p5()
                    .child(ui::brand(30.))
                    .when(!collapsed, |v| {
                        v.child(
                            div()
                                .font_weight(FontWeight::BOLD)
                                .text_size(px(19.))
                                .child("VioletWire"),
                        )
                    }),
            )
            .child(
                div()
                    .flex_none()
                    .px_4()
                    .pt_2()
                    .pb_2()
                    .flex()
                    .items_center()
                    .justify_between()
                    .text_xs()
                    .text_color(theme::text_dim())
                    .when(!collapsed, |v| {
                        v.child(
                            div()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child("FOLLOWED CHANNELS"),
                        )
                    })
                    .child(
                        ui::icon_button(
                            "collapse-sidebar",
                            if collapsed {
                                Icon::SidebarOpen
                            } else {
                                Icon::SidebarClose
                            },
                            if collapsed {
                                "Expand sidebar"
                            } else {
                                "Collapse sidebar"
                            },
                            false,
                        )
                        .w(px(24.))
                        .h(px(24.))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.sidebar_collapsed = !collapsed;
                            this.sidebar_force_expanded = collapsed;
                            crate::preferences::update(cx, |prefs| {
                                prefs.sidebar_collapsed = this.sidebar_collapsed
                            });
                            cx.notify();
                        })),
                    ),
            )
            .when(!collapsed, |v| v.child(self.followed_platforms(platform, cx)))
            .when(!collapsed && ordered.is_empty(), |v| {
                let (title, detail, kick_button) = match platform {
                    browse::Platform::Kick if !kick_signed_in => {
                        ("Not signed in to Kick", "Sign in to see the Kick channels you follow.", true)
                    }
                    _ if !matches!(self.auth, Auth::SignedIn(_)) && !kick_signed_in => {
                        ("Your channels will live here", "Sign in to see followed channels and who is live.", false)
                    }
                    _ => ("Nothing here yet", "Channels you follow show here.", false),
                };
                v.child(
                    div()
                        .mx_3()
                        .mt_2()
                        .p_3()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .rounded(px(8.))
                        .border_1()
                        .border_color(theme::border())
                        .child(div().text_size(px(12.)).font_weight(FontWeight::BOLD).child(title))
                        .child(div().text_size(px(11.)).text_color(theme::text_dim()).child(detail))
                        .when(kick_button, |card| {
                            card.child(
                                ui::button("sidebar-kick-sign-in", "Sign in to Kick", None, ButtonStyle::Secondary)
                                    .mt_1()
                                    .h(px(28.))
                                    .on_click(cx.listener(|this, _, _, cx| this.kick_sign_in(cx))),
                            )
                        }),
                )
            })
            .when(!collapsed && live > 0, |v| {
                v.child(
                    div()
                        .px_5()
                        .pt_2()
                        .pb_2()
                        .flex()
                        .justify_between()
                        .text_size(px(11.))
                        .font_weight(FontWeight::BOLD)
                        .text_color(theme::text_dim())
                        .child("LIVE")
                        .child(format!("{live}")),
                )
            })
            .child(
                div()
                    .id("followed")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px_1p5()
                    .pb_2()
                    .flex()
                    .flex_col()
                    .children(
                        ordered
                            .iter()
                            .enumerate()
                            .flat_map(|(index, channel)| {
                                let mut rows = Vec::new();
                                if !collapsed
                                    && channel.stream.is_none()
                                    && (index == 0 || ordered[index - 1].stream.is_some())
                                {
                                    rows.push(
                                        div()
                                            .px_3()
                                            .pt_4()
                                            .pb_2()
                                            .mt_1()
                                            .border_t_1()
                                            .border_color(theme::border())
                                            .text_size(px(11.))
                                            .font_weight(FontWeight::BOLD)
                                            .text_color(theme::text_dim())
                                            .flex()
                                            .justify_between()
                                            .child("OFFLINE")
                                            .child(format!("{}", total - live))
                                            .into_any_element(),
                                    );
                                }
                                rows.push(
                                    self.channel_row(
                                        channel,
                                        collapsed,
                                        favorites.contains(&channel.login),
                                        ring,
                                        cx,
                                    )
                                    .into_any_element(),
                                );
                                rows
                            }),
                    ),
            )
    }

    /// Electron's `followed-platforms`: which services the list shows.
    fn followed_platforms(&self, current: browse::Platform, cx: &Context<Self>) -> impl IntoElement {
        div()
            .mx(px(9.))
            .mb(px(8.))
            .p(px(3.))
            .flex()
            .gap(px(3.))
            .rounded(px(8.))
            .bg(rgb(0x17171b))
            .children([browse::Platform::Twitch, browse::Platform::Kick, browse::Platform::Both].into_iter().map(|option| {
                let active = option == current;
                div()
                    .id(SharedString::from(format!("followed-{}", option.as_str())))
                    .flex_1()
                    .h(px(26.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .gap(px(5.))
                    .rounded(px(6.))
                    .when(active, |button| button.bg(rgb(0x2f2938)))
                    .text_size(px(11.))
                    .font_weight(FontWeight::BOLD)
                    .text_color(if active { rgb(0xf4f4f5) } else { rgb(0x8a8a94) })
                    .cursor_pointer()
                    .hover(|style| style.text_color(rgb(0xe4e4e7)))
                    .children(browse::service_logos(option, 13.))
                    .child(match option {
                        browse::Platform::Twitch => "Twitch",
                        browse::Platform::Kick => "Kick",
                        browse::Platform::Both => "Both",
                    })
                    .on_click(cx.listener(move |_, _, _, cx| {
                        crate::preferences::update(cx, |prefs| prefs.platform_filter = option.as_str().into());
                        cx.notify();
                    }))
            }))
    }

    /// `ring`: mark the service with a coloured ring round the avatar, as
    /// Electron does while both services are listed.
    fn channel_row(
        &self,
        channel: &FollowedChannel,
        collapsed: bool,
        favorite: bool,
        ring: bool,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let kick = channel.login.starts_with(crate::kick::PREFIX);
        let login = channel.login.clone();
        let menu_login = channel.login.clone();
        let name = SharedString::from(channel.display_name.clone());
        let selected = self
            .playing
            .as_ref()
            .is_some_and(|playing| playing.login == channel.login);
        let subtitle: SharedString = match &channel.stream {
            Some(stream) if !stream.game_name.is_empty() => stream.game_name.clone().into(),
            Some(_) => "Live".into(),
            None => "Offline".into(),
        };
        let hint = match &channel.stream {
            Some(stream) => format!(
                "{}\n{}\n{} · {} viewers",
                channel.display_name,
                stream.title,
                stream.game_name,
                compact_count(stream.viewer_count)
            ),
            None => format!("{} · Offline", channel.display_name),
        };
        div()
            .id(SharedString::from(format!("channel-{}", channel.id)))
            .flex()
            .flex_none()
            .items_center()
            .gap_2p5()
            .px_2()
            .py_1p5()
            .h(px(56.))
            .rounded(px(8.))
            .cursor_pointer()
            .hover(|style| style.bg(theme::surface_hover()))
            .when(selected, |row| row.bg(theme::surface_hover()))
            .when(channel.stream.is_none(), |row| {
                row.text_color(theme::text_dim())
            })
            .child(
                div()
                    .relative()
                    .flex_none()
                    .size(px(36.))
                    .child(
                        div()
                            .size_full()
                            .when(ring, |v| {
                                v.rounded_full()
                                    .border_2()
                                    .border_color(rgb(if kick { ui::KICK_GREEN } else { ui::TWITCH_PURPLE }))
                                    .p(px(1.5))
                            })
                            .child(
                                div()
                                    .size_full()
                                    .when(channel.stream.is_none(), |v| v.opacity(0.45))
                                    .child(self.avatar(channel.profile_image_url.as_deref(), if ring { 29. } else { 36. })),
                            ),
                    )
                    .when(favorite, |v| {
                        v.child(
                            ui::icon(Icon::StarFilled, 11.)
                                .absolute()
                                .top(px(-3.))
                                .right(px(-3.))
                                .text_color(rgb(0xfacc15)),
                        )
                    })
                    .when(collapsed && channel.stream.is_some(), |v| {
                        v.child(
                            div()
                                .absolute()
                                .right_0()
                                .bottom_0()
                                .size(px(8.))
                                .rounded_full()
                                .bg(theme::live_dot()),
                        )
                    }),
            )
            .when(!collapsed, |v| {
                v.child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .truncate()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(channel.display_name.clone()),
                        )
                        .child(
                            div()
                                .truncate()
                                .text_xs()
                                .text_color(theme::text_dim())
                                .child(subtitle),
                        ),
                )
            })
            .when_some(
                channel.stream.as_ref().filter(|_| !collapsed),
                |row, stream| {
                    row.child(
                        div()
                            .flex_none()
                            .flex()
                            .items_center()
                            .gap_1()
                            .text_xs()
                            .text_color(theme::text_dim())
                            .child(div().size(px(6.)).rounded_full().bg(theme::live_dot()))
                            .child(compact_count(stream.viewer_count)),
                    )
                },
            )
            .when(channel.stream.is_some(), |row| {
                let hovered_login = login.clone();
                row.on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                    this.hover_preresolve(&hovered_login, *hovered, cx)
                }))
            })
            .on_click(
                cx.listener(move |this, _, window, cx| this.play(&login, name.clone(), window, cx)),
            )
            .on_mouse_down(
                gpui::MouseButton::Right,
                cx.listener(move |this, event: &gpui::MouseDownEvent, _, cx| {
                    this.channel_menu = Some((menu_login.clone(), event.position));
                    this.search.open = false;
                    this.account_menu = false;
                    cx.notify();
                }),
            )
            .when(self.channel_menu.is_none(), |row| {
                row.tooltip(move |_, cx| cx.new(|_| ui::Tooltip(hint.clone().into())).into())
            })
    }

    fn player_panel(
        &self,
        playing: &Playing,
        fullscreen: bool,
        compact: bool,
        cx: &Context<Self>,
    ) -> AnyElement {
        let login = playing.login.clone();
        let channel = self.channel_info(&playing.login);
        let stream = channel.and_then(|channel| channel.stream.as_ref());
        let tags = stream
            .map(|stream| crate::format::visible_tags(&stream.language, &stream.tags))
            .unwrap_or_default();
        let name: SharedString = channel
            .map(|channel| channel.display_name.clone().into())
            .unwrap_or_else(|| playing.name.clone());
        let title: SharedString = stream
            .map(|stream| stream.title.clone().into())
            .unwrap_or_else(|| name.clone());
        let title_hint = title.clone();
        let toolbar = div()
            .h(px(54.))
            .flex_none()
            .px_3()
            .flex()
            .items_center()
            .gap_2p5()
            .bg(theme::title_bar())
            .border_b_1()
            .border_color(theme::border())
            .child(
                ui::icon_button("back", Icon::Back, "Back to Home", false)
                    .on_click(cx.listener(|this, _, window, cx| this.close_player(window, cx))),
            )
            .when(!compact, |v| {
                v.child(self.avatar(
                    channel.and_then(|channel| channel.profile_image_url.as_deref()),
                    34.,
                ))
            })
            .when_some(stream.filter(|_| !compact), |v, stream| {
                v.child(
                    div()
                        .flex_none()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .mr(px(6.))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap_1()
                                .text_color(theme::live_dot())
                                .text_size(px(12.))
                                .child(ui::icon(Icon::Users, 13.))
                                .child(compact_count(stream.viewer_count)),
                        )
                        .when_some(uptime(&stream.started_at, auth::now()), |v, time| {
                            v.child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap_1()
                                    .text_color(theme::text_dim())
                                    .text_size(px(10.))
                                    .child(ui::icon(Icon::Clock, 11.))
                                    .child(time),
                            )
                        }),
                )
            })
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(3.))
                    .child(
                        div()
                            .id("stream-title")
                            .truncate()
                            .text_size(px(13.))
                            .font_weight(FontWeight::BOLD)
                            .child(title)
                            .tooltip(move |_, cx| {
                                cx.new(|_| ui::Tooltip(title_hint.clone())).into()
                            }),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .flex()
                            .items_center()
                            .gap_2()
                            .text_size(px(11.))
                            .child(
                                div()
                                    .truncate()
                                    .text_color(theme::text_dim())
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(name),
                            )
                            .when_some(
                                stream.filter(|stream| !compact && !stream.game_name.is_empty()),
                                |v, stream| {
                                    v.child(
                                        div()
                                            .truncate()
                                            .max_w(px(150.))
                                            .px_2()
                                            .py_0p5()
                                            .rounded_full()
                                            .border_1()
                                            .border_color(theme::selected_border())
                                            .bg(theme::selected())
                                            .text_color(theme::accent_text())
                                            .text_size(px(10.))
                                            .child(stream.game_name.clone()),
                                    )
                                },
                            )
                            .when(!compact, |row| {
                                row.children(tags.into_iter().map(|tag| {
                                    div()
                                        .flex_none()
                                        .px(px(6.))
                                        .py_0p5()
                                        .rounded(px(5.))
                                        .bg(theme::button())
                                        .text_color(theme::text_secondary())
                                        .text_size(px(10.))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .child(tag)
                                }))
                            }),
                    ),
            )
            .when(self.channels.iter().any(|followed| followed.login == login), |bar| {
                let favorite = crate::preferences::get(cx).favorite_channels.contains(&login);
                let star_login = login.clone();
                bar.child(
                    ui::icon_button(
                        "toolbar-favorite",
                        if favorite { Icon::StarFilled } else { Icon::Star },
                        if favorite { "Remove from favorites" } else { "Add to favorites" },
                        favorite,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| this.toggle_favorite(&star_login, cx))),
                )
            })
            .when_some(
                crate::kick::slug(&login)
                    .filter(|_| crate::preferences::get(cx).kick_account.is_some())
                    .map(str::to_owned),
                |bar, slug| {
                    let following = self.kick_followed.iter().any(|followed| followed.login == login);
                    bar.child(
                        ui::button(
                            "toolbar-kick-follow",
                            if compact { "" } else if following { "Following" } else { "Follow" },
                            Some(if following { Icon::StarFilled } else { Icon::Star }),
                            if following { ButtonStyle::Secondary } else { ButtonStyle::Primary },
                        )
                        .when(compact, |button| button.w(px(34.)).px_0())
                        .tooltip(|_, cx| {
                            cx.new(|_| ui::Tooltip("Opens the channel on Kick, signed in, to follow or unfollow there".into()))
                                .into()
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            // The followed list catches up once the page closes.
                            let root = cx.entity().downgrade();
                            crate::kick_web::open_page(this.hwnd, &slug, cx, move |cx| {
                                let _ = root.update(cx, |this, cx| this.start_kick(cx));
                            });
                        })),
                    )
                },
            )
            .when(matches!(self.auth, Auth::SignedIn(_)) && crate::kick::slug(&login).is_none(), |bar| {
                let login = login.clone();
                let creating = self.clip_task.is_some();
                bar.child(
                    ui::button(
                        "toolbar-clip",
                        if compact { "" } else if creating { "Clipping…" } else { "Clip" },
                        Some(Icon::Scissors),
                        if creating { ButtonStyle::Disabled } else { ButtonStyle::Ghost },
                    )
                    .when(compact, |button| button.w(px(34.)).px_0())
                    .tooltip(|_, cx| {
                        cx.new(|_| ui::Tooltip("Create a clip with Twitch's official API".into()))
                            .into()
                    })
                    .on_click(cx.listener(move |this, _, _, cx| this.create_clip(login.clone(), cx))),
                )
            })
            .child(
                ui::icon_button(
                    "toolbar-external",
                    Icon::External,
                    if crate::kick::slug(&login).is_some() { "Open on Kick" } else { "Open on Twitch" },
                    false,
                )
                    .on_click(cx.listener(move |_, _, _, cx| open_channel(&login, cx))),
            );
        let mut area = div()
            .relative()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .child(playing.view.clone());
        if !self.chat_visible {
            // Electron's edge restore: with chat hidden, an arrow appears when
            // the pointer nears the edge chat lives on.
            let left = crate::preferences::get(cx).chat_on_left;
            area = area.child(
                div()
                    .id("chat-edge")
                    .group("chat-edge")
                    .absolute()
                    .top_0()
                    .bottom(px(80.))
                    .w(px(72.))
                    .when(left, |edge| edge.left_0())
                    .when(!left, |edge| edge.right_0())
                    .child(
                        div()
                            .id("chat-edge-restore")
                            .absolute()
                            .top(px(12.))
                            .when(left, |button| button.left_0().rounded_r(px(8.)).border_r_1())
                            .when(!left, |button| button.right_0().rounded_l(px(8.)).border_l_1())
                            .w(px(34.))
                            .h(px(36.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .border_t_1()
                            .border_b_1()
                            .border_color(rgb(0x3a3a42))
                            .bg(rgba(0x18181bf2))
                            .shadow_lg()
                            .cursor_pointer()
                            .opacity(0.)
                            .group_hover("chat-edge", |style| style.opacity(1.))
                            .hover(|style| style.bg(rgb(0x28282f)))
                            .child(ui::icon(if left { Icon::Forward } else { Icon::Back }, 18.))
                            .tooltip(|_, cx| cx.new(|_| ui::Tooltip("Show stream chat · C".into())).into())
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.chat_visible = true;
                                cx.notify();
                            })),
                    ),
            );
        }
        if self.chat_visible && self.overlay_chat {
            area = area.child(
                div()
                    .absolute()
                    .right_3()
                    .top_3()
                    .bottom(px(64.))
                    .w(px(340.))
                    .rounded(px(11.))
                    .border_1()
                    .border_color(rgba(0xffffff1a))
                    .child(gpui::AnyView::from(playing.chat.clone())
                            // Re-laid out only when chat changes, not on every
                            // video frame the player draws.
                            .cached(gpui::StyleRefinement::default().size_full())),
            );
        }
        let player = div()
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .flex_col()
            .when(!fullscreen && !self.theater, |v| v.child(toolbar))
            .child(area);
        div()
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .bg(theme::surface())
            .when(crate::preferences::get(cx).chat_on_left, |v| v.flex_row_reverse())
            .child(player)
            .when(self.chat_visible && !self.overlay_chat, |v| {
                v.child(
                    div()
                        .w(px(f32::from(
                            crate::preferences::get(cx).chat_sidebar_width,
                        )))
                        .min_w(px(330.))
                        .h_full()
                        .flex_none()
                        .child(gpui::AnyView::from(playing.chat.clone())
                            // Re-laid out only when chat changes, not on every
                            // video frame the player draws.
                            .cached(gpui::StyleRefinement::default().size_full())),
                )
            })
            .into_any_element()
    }

    fn home(&self, width: f32, cx: &Context<Self>) -> impl IntoElement {
        let available = (width - 76.).max(200.);
        let columns = ((available + 16.) / 316.).floor().max(1.);
        let card_width = ((available - (columns - 1.) * 16.) / columns).floor();
        let platform = browse::Platform::from(crate::preferences::get(cx).platform_filter.as_str());
        let mut live: Vec<&FollowedChannel> =
            self.followed_shown(platform).filter(|channel| channel.stream.is_some()).collect();
        live.sort_by_key(|channel| std::cmp::Reverse(channel.stream.as_ref().map_or(0, |stream| stream.viewer_count)));
        let now = auth::now();
        let content: AnyElement = if !self.loaded {
            note(if self.loading {
                "Loading the channels you follow…"
            } else {
                "The channels you follow could not be loaded yet."
            })
            .into_any_element()
        } else if live.is_empty() {
            note("None of the channels you follow are live right now.").into_any_element()
        } else {
            div()
                .flex()
                .flex_wrap()
                .gap_x_4()
                .gap_y_7()
                .children(
                    live.iter()
                        .map(|channel| self.card(channel, now, card_width, cx)),
                )
                .into_any_element()
        };
        let subtitle = match (self.loaded, live.len()) {
            (false, _) => "Loading the channels you follow…".to_owned(),
            (true, 0) => "None of the channels you follow are live".to_owned(),
            (true, 1) => "1 followed channel is live".to_owned(),
            (true, count) => format!("{count} followed channels are live"),
        };
        div()
            .id("home")
            .flex_1()
            .min_w_0()
            .h_full()
            .overflow_y_scroll()
            .px(px(38.))
            .py(px(30.))
            .flex()
            .flex_col()
            .gap(px(24.))
            .child(
                div()
                    .flex()
                    .items_end()
                    .gap_3()
                    .child(Self::page_header("YOUR FOLLOWING", "Live channels", subtitle))
                    .when(self.loading, |row| {
                        row.child(
                            div()
                                .text_xs()
                                .text_color(theme::text_dim())
                                .child("Refreshing…"),
                        )
                    })
                    .child(
                        ui::button(
                            "refresh",
                            "Refresh",
                            Some(Icon::Refresh),
                            ButtonStyle::Secondary,
                        )
                        .on_click(cx.listener(|this, _, _, cx| this.load_followed(cx))),
                    ),
            )
            .when_some(self.message.clone(), |column, message| {
                column.child(banner(message))
            })
            .child(content)
    }

    fn card(
        &self,
        channel: &FollowedChannel,
        now: u64,
        width: f32,
        cx: &Context<Self>,
    ) -> AnyElement {
        let Some(stream) = channel.stream.as_ref() else {
            return div().into_any_element();
        };
        let login = channel.login.clone();
        let name = SharedString::from(channel.display_name.clone());
        let group = SharedString::from(format!("card-{}", channel.id));
        let thumbnail = stream
            .thumbnail_url
            .as_deref()
            .and_then(|url| self.image(url));
        let category: SharedString = if stream.game_name.is_empty() {
            "Live".into()
        } else {
            stream.game_name.clone().into()
        };
        let tags = crate::format::visible_tags(&stream.language, &stream.tags);
        div()
            .id(group.clone())
            .group(group.clone())
            .w(px(width))
            .flex()
            .flex_col()
            .gap_2p5()
            .cursor_pointer()
            .child(
                div()
                    .relative()
                    .w_full()
                    .h(px(width * 9. / 16.))
                    .rounded_lg()
                    .bg(rgb(0x000000))
                    .border_1()
                    .border_color(theme::border())
                    .group_hover(group, |style| style.border_color(theme::violet()))
                    .when_some(thumbnail, |frame, image| {
                        frame.child(
                            img(ImageSource::Image(image))
                                .size_full()
                                .rounded_lg()
                                .object_fit(ObjectFit::Cover),
                        )
                    })
                    .child(
                        pill("LIVE")
                            .bg(theme::live())
                            .font_weight(FontWeight::BOLD)
                            .absolute()
                            .top_2()
                            .left_2(),
                    )
                    .child(
                        pill(format!("{} viewers", compact_count(stream.viewer_count)))
                            .absolute()
                            .bottom_2()
                            .left_2(),
                    )
                    .when_some(uptime(&stream.started_at, now), |frame, time| {
                        frame.child(pill(time).absolute().bottom_2().right_2())
                    }),
            )
            .child(
                div()
                    .flex()
                    .gap_2p5()
                    .child(self.avatar(channel.profile_image_url.as_deref(), 36.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .truncate()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(SharedString::from(stream.title.clone())),
                            )
                            .child(
                                div()
                                    .truncate()
                                    .text_color(theme::text_dim())
                                    .child(channel.display_name.clone()),
                            )
                            .child(
                                div()
                                    .truncate()
                                    .text_xs()
                                    .text_color(theme::text_dim())
                                    .child(category),
                            )
                            .when(!tags.is_empty(), |text| {
                                text.child(
                                    div()
                                        .mt(px(6.))
                                        .flex()
                                        .flex_wrap()
                                        .gap(px(5.))
                                        .children(tags.into_iter().map(|tag| {
                                            div()
                                                .px(px(7.))
                                                .py(px(2.))
                                                .rounded(px(5.))
                                                .bg(theme::button())
                                                .text_size(px(11.))
                                                .font_weight(FontWeight::SEMIBOLD)
                                                .text_color(theme::text_secondary())
                                                .child(tag)
                                        })),
                                )
                            }),
                    ),
            )
            .when(channel.stream.is_some(), |row| {
                let hovered_login = login.clone();
                row.on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                    this.hover_preresolve(&hovered_login, *hovered, cx)
                }))
            })
            .on_click(
                cx.listener(move |this, _, window, cx| this.play(&login, name.clone(), window, cx)),
            )
            .into_any_element()
    }

    /// What is known about a channel: followed, or seen in Browse or search.
    fn channel_info(&self, login: &str) -> Option<&FollowedChannel> {
        self.channels
            .iter()
            .chain(&self.browse.streams)
            .chain(&self.search.full.channels)
            .chain(&self.search.quick.channels)
            .chain(&self.search.kick_quick)
            .chain(&self.search.kick_full)
            .chain(&self.kick_channels)
            .chain(&self.kick_followed)
            .find(|channel| channel.login == login)
    }

    fn avatar(&self, url: Option<&str>, size: f32) -> AnyElement {
        let size = px(size);
        match url.and_then(|url| self.image(url)) {
            // Clipped, so a picture that is not square stays in its circle.
            Some(image) => div()
                .size(size)
                .flex_none()
                .rounded_full()
                .overflow_hidden()
                .child(img(ImageSource::Image(image)).size_full().rounded_full().object_fit(ObjectFit::Cover))
                .into_any_element(),
            None => div()
                .size(size)
                .flex_none()
                .rounded_full()
                .bg(theme::surface_hover())
                .into_any_element(),
        }
    }

    fn welcome(&self, cx: &Context<Self>) -> impl IntoElement {
        let panel = div()
            .w(px(440.))
            .flex()
            .flex_col()
            .gap_4()
            .p_8()
            .rounded_xl()
            .bg(theme::surface())
            .border_1()
            .border_color(theme::border())
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(div().size(px(14.)).rounded_full().bg(theme::violet()))
                    .child(
                        div()
                            .text_2xl()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("VioletWire"),
                    ),
            );
        let panel = match &self.auth {
            Auth::Restoring => panel.child(note("Checking your saved sign-in…")),
            Auth::Unreachable => panel
                .child(note("Twitch could not be reached, so your saved sign-in could not be checked. It is still saved."))
                .child(
                    div()
                        .flex()
                        .gap_2()
                        .child(button("retry", "Try again", true).on_click(cx.listener(|this, _, _, cx| this.restore(cx))))
                        .child(
                            button("sign-in-again", "Sign in again", false)
                                .on_click(cx.listener(|this, _, _, cx| this.begin_sign_in(cx))),
                        ),
                ),
            Auth::SignedOut => panel
                .child(note(
                    "Sign in with Twitch to see the channels you follow. VioletWire uses Twitch's official \
                     device sign-in, so your password never touches the app.",
                ))
                .child(
                    button("sign-in", "Sign in with Twitch", true)
                        .on_click(cx.listener(|this, _, _, cx| this.begin_sign_in(cx))),
                ),
            Auth::Requesting => panel.child(note("Contacting Twitch…")),
            Auth::AwaitingApproval { user_code, verification_uri } => {
                let uri = verification_uri.clone();
                panel
                    .child(note(
                        "Approve VioletWire on the Twitch page that opened in your browser. \
                         If it asks for a code, enter:",
                    ))
                    .child(
                        div()
                            .py_3()
                            .flex()
                            .justify_center()
                            .rounded_lg()
                            .bg(theme::background())
                            .font_family("Consolas")
                            .text_3xl()
                            .font_weight(FontWeight::BOLD)
                            .text_color(theme::violet_hover())
                            .child(user_code.clone()),
                    )
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(
                                button("open-activate", "Open the Twitch page", true)
                                    .on_click(cx.listener(move |_, _, _, cx| open_activation(&uri, cx))),
                            )
                            .child(
                                button("cancel", "Cancel", false)
                                    .on_click(cx.listener(|this, _, _, cx| this.cancel_sign_in(cx))),
                            ),
                    )
                    .child(note("Waiting for approval…"))
            }
            Auth::SignedIn(_) => panel,
        };
        div().flex_1().flex().items_center().justify_center().child(
            panel.when_some(self.message.clone(), |panel, message| {
                panel.child(banner(message))
            }),
        )
    }
}

impl Render for Root {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let _timer = crate::render_stats::start("root");
        if self.hwnd.is_none()
            && let Ok(handle) = wry::raw_window_handle::HasWindowHandle::window_handle(window)
            && let wry::raw_window_handle::RawWindowHandle::Win32(handle) = handle.as_raw()
        {
            self.hwnd = Some(handle.hwnd.get());
            // A maximized window fills the monitor (see vendor/GPUI-PATCH.md).
            // Tell the shell it is not a fullscreen app, so an auto-hidden
            // taskbar still slides up over it.
            // SAFETY: sets a window property on this app's own window.
            unsafe {
                let _ = windows::Win32::UI::WindowsAndMessaging::SetPropW(
                    windows::Win32::Foundation::HWND(handle.hwnd.get() as _),
                    windows::core::w!("NonRudeHWND"),
                    Some(windows::Win32::Foundation::HANDLE(1 as _)),
                );
            }
        }
        // Probes use their own window sizes; never save those.
        if self.window_observer.is_none()
            && !std::env::args().any(|argument| argument.contains("probe"))
        {
            self.window_observer = Some(cx.observe_window_bounds(window, |_, window, cx| {
                remember_window(window, cx)
            }));
        }
        let fullscreen = window.is_fullscreen() || self.probe_fullscreen;
        if self.channel_subscription.is_none() {
            self.channel_subscription = Some(cx.subscribe_in(
                &self.channel_input,
                window,
                |this, _, _: &crate::input::Submitted, window, cx| this.submit_search(window, cx),
            ));
            self.input_observers = vec![
                cx.observe(&self.channel_input, |this, _, cx| this.search_changed(cx)),
                cx.observe(&self.category_input, |this, _, cx| this.category_query_changed(cx)),
            ];
        }
        if self.settings_open || self.shortcuts_open || window.focused(cx).is_none() {
            window.focus(&self.focus);
        }
        if let Some(playing) = &self.playing {
            let room = self
                .channels
                .iter()
                .find(|channel| channel.login == playing.login)
                .map(|channel| channel.id.as_str());
            let session = if let Auth::SignedIn(s) = &self.auth {
                Some(s.clone())
            } else {
                None
            };
            playing.chat.update(cx, |chat, cx| {
                chat.set_session(session, cx);
                // Followed-channel metadata already contains the room ID;
                // provider loading need not wait for the IRC join round trip.
                if let Some(room) = room {
                    chat.set_room(room, cx);
                }
                chat.set_overlay(self.overlay_chat, cx);
                chat.set_preferences(crate::preferences::get(cx), cx);
            });
            playing.view.update(cx, |player, cx| {
                player.set_presentation(self.chat_visible, self.overlay_chat, self.theater, cx)
            });
            let controls_delay = crate::preferences::get(cx).controls_hide_delay;
            playing
                .view
                .update(cx, |player, _| player.set_controls_delay(controls_delay));
        }
        // Debug aid: `VIOLETWIRE_PROBE_MULTI=a,b,c` opens multistream with those
        // channels once the followed list has loaded.
        static PROBE_MULTI: std::sync::Once = std::sync::Once::new();
        if self.loaded
            && let Ok(channels) = std::env::var("VIOLETWIRE_PROBE_MULTI")
        {
            PROBE_MULTI.call_once(|| {
                self.enter_multi(cx);
                for login in channels.split(',').filter(|login| crate::format::is_channel(login)) {
                    self.add_tile(login, login.to_owned().into(), cx);
                }
                self.activate_tile(0, cx);
            });
        }
        // Debug aid: `VIOLETWIRE_PROBE_CHAT_SETTINGS=1` opens Settings > Chat.
        if std::env::var_os("VIOLETWIRE_PROBE_CHAT_SETTINGS").is_some() && self.loaded {
            static OPENED: std::sync::Once = std::sync::Once::new();
            OPENED.call_once(|| {
                self.settings_open = true;
                self.settings.update(cx, |settings, cx| settings.probe_section(crate::settings::Section::Chat, cx));
                self.load_chat_colors(cx);
            });
        }
        // Debug aid: `VIOLETWIRE_PROBE_PREVIEW=url` previews a link in chat.
        if let Ok(url) = std::env::var("VIOLETWIRE_PROBE_PREVIEW")
            && let Some(playing) = self.current()
        {
            static PREVIEWED: std::sync::Once = std::sync::Once::new();
            let chat = playing.chat.clone();
            PREVIEWED.call_once(|| chat.update(cx, |chat, cx| chat.probe_preview(&url, cx)));
        }
        // Debug aid: `VIOLETWIRE_PROBE_SEARCH=text` types into the top search box.
        if let Ok(text) = std::env::var("VIOLETWIRE_PROBE_SEARCH") {
            static TYPED: std::sync::Once = std::sync::Once::new();
            if self.loaded {
                TYPED.call_once(|| {
                    self.channel_input.update(cx, |input, cx| {
                        input.clear(cx);
                        input.append(&text, cx);
                    });
                    self.search_changed(cx);
                    if std::env::var_os("VIOLETWIRE_PROBE_SEARCH_PAGE").is_some() {
                        self.submit_search(window, cx);
                    }
                });
            }
        }
        // Debug aid: `VIOLETWIRE_PROBE_KICK_BROWSE=1` opens Kick's Browse, then
        // its first category, and logs what loads.
        if std::env::var_os("VIOLETWIRE_PROBE_KICK_BROWSE").is_some() {
            static OPENED: std::sync::Once = std::sync::Once::new();
            static PICKED: std::sync::Once = std::sync::Once::new();
            static LOGGED: std::sync::Once = std::sync::Once::new();
            OPENED.call_once(|| {
                self.show_section(Section::Browse, window, cx);
                self.set_browse_kick(true, cx);
            });
            if self.browse.kick && self.browse.selected.is_none() && !self.browse.categories.is_empty() {
                let first = self.browse.categories[0].clone();
                PICKED.call_once(|| {
                    eprintln!("[probe] kick categories={} first={}", self.browse.categories.len(), first.name);
                    self.open_category(first, window, cx);
                });
            }
            if self.browse.selected.is_some() && !self.browse.streams_loading && (self.browse.error.is_some() || !self.browse.streams.is_empty()) {
                LOGGED.call_once(|| {
                    eprintln!(
                        "[probe] kick streams={} more={} error={:?}",
                        self.browse.streams.len(),
                        self.browse.streams_cursor.is_some(),
                        self.browse.error
                    );
                });
            }
        }
        self.sync_tiles(cx);
        let account = match &self.auth {
            Auth::SignedIn(session) => Some(session.identity.login.clone()),
            _ => None,
        };
        self.settings.update(cx, |settings, cx| settings.set_account(account, cx));
        let signed_in = matches!(self.auth, Auth::SignedIn(_));
        let sidebar_collapsed = self.sidebar_collapsed
            || (!self.sidebar_force_expanded && window.viewport_size().width < px(1150.));
        let sidebar_width = if fullscreen || self.theater {
            0.
        } else if sidebar_collapsed {
            68.
        } else {
            244.
        };
        let chat_width = if self.chat_visible && !self.overlay_chat {
            f32::from(crate::preferences::get(cx).chat_sidebar_width)
        } else {
            0.
        };
        let compact = f32::from(window.viewport_size().width) - sidebar_width - chat_width < 480.;
        let main = match &self.playing {
            _ if self.multi.is_some() => self.multi_panel(fullscreen, window, cx),
            Some(playing) => self
                .player_panel(playing, fullscreen, compact, cx)
                .into_any_element(),
            // Signed out, Browse (Kick's directory) and Search still work.
            None if signed_in || self.section != Section::Home => {
                let width = f32::from(window.viewport_size().width) - sidebar_width;
                match self.section {
                    Section::Home => self.home(width, cx).into_any_element(),
                    Section::Browse => self.browse_page(width, cx),
                    Section::Search => self.search_page(width, cx),
                }
            }
            None => self.welcome(cx).into_any_element(),
        };
        let body = div()
            .flex_1()
            .min_h_0()
            .flex()
            .when(!fullscreen && !self.theater, |body| {
                body.child(self.sidebar(
                    self.sidebar_collapsed
                        || (!self.sidebar_force_expanded
                            && window.viewport_size().width < px(1150.)),
                    cx,
                ))
            })
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .flex_col()
                    .when(!fullscreen && !self.theater, |v| {
                        v.child(self.navigation(cx))
                    })
                    .child(main),
            );
        div()
            .size_full()
            .relative()
            .track_focus(&self.focus)
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    if this.search.open || this.account_menu || this.top_presets || this.channel_menu.is_some() {
                        this.search.open = false;
                        this.account_menu = false;
                        this.top_presets = false;
                        this.channel_menu = None;
                        cx.notify();
                    }
                }),
            )
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                let key = event.keystroke.key.as_str();
                if key == "escape"
                    && let Some(playing) = this.current()
                    && playing.chat.read(cx).has_card()
                {
                    playing.chat.update(cx, |chat, cx| chat.close_card(cx));
                    cx.stop_propagation();
                    return;
                }
                if key == "escape"
                    && (this.search.open || this.account_menu || this.top_presets || this.channel_menu.is_some())
                {
                    this.search.open = false;
                    this.account_menu = false;
                    this.top_presets = false;
                    this.channel_menu = None;
                    cx.notify();
                    cx.stop_propagation();
                    return;
                }
                if this.settings_open || this.shortcuts_open {
                    if key == "escape" {
                        this.settings_open = false;
                        this.shortcuts_open = false;
                        cx.notify();
                        cx.stop_propagation();
                    }
                    return;
                }
                let modifiers = event.keystroke.modifiers;
                let typing = this.current().is_some_and(|playing| {
                    playing.chat.read(cx).is_editing(window, cx)
                }) || [&this.channel_input, &this.category_input].into_iter().any(|input| {
                    gpui::Focusable::focus_handle(input.read(cx), cx).is_focused(window)
                });
                // "?" lists every shortcut, from anywhere outside a text box.
                if !typing
                    && !modifiers.control
                    && !modifiers.alt
                    && !modifiers.platform
                    && (key == "?" || event.keystroke.key_char.as_deref() == Some("?"))
                {
                    this.shortcuts_open = true;
                    cx.notify();
                    cx.stop_propagation();
                    return;
                }
                if key == "f11" || (key == "escape" && window.is_fullscreen()) {
                    window.toggle_fullscreen();
                    cx.notify();
                    cx.stop_propagation();
                    return;
                }
                let Some(playing) = this.current() else { return };
                if modifiers.control || modifiers.alt || modifiers.platform || typing {
                    return;
                }
                match key {
                    "f" => {
                        window.toggle_fullscreen();
                        cx.notify();
                    }
                    "t" => {
                        this.theater = !this.theater;
                        cx.notify();
                    }
                    "c" => {
                        match &mut this.multi {
                            Some(multi) => multi.chat_visible = !multi.chat_visible,
                            None => this.chat_visible = !this.chat_visible,
                        }
                        cx.notify();
                    }
                    "space" => playing.view.update(cx, |p, cx| p.toggle_pause(cx)),
                    "m" => playing.view.update(cx, |p, cx| p.toggle_mute(cx)),
                    "g" => playing.view.update(cx, |p, cx| p.go_live(cx)),
                    "up" => playing.view.update(cx, |p, cx| p.change_volume(0.05, cx)),
                    "down" => playing.view.update(cx, |p, cx| p.change_volume(-0.05, cx)),
                    "o" if this.multi.is_none() => {
                        this.overlay_chat = !this.overlay_chat;
                        this.chat_visible = true;
                        cx.notify();
                    }
                    // Esc leaves fullscreen (above), then theater mode.
                    "escape" if this.theater => {
                        this.theater = false;
                        cx.notify();
                    }
                    _ => {}
                }
            }))
            .flex()
            .flex_col()
            .bg(theme::background())
            .text_color(theme::text())
            .font_family(theme::UI_FONT)
            .text_size(px(14.))
            .when(!fullscreen, |v| v.child(self.title_bar(window)))
            .child(body)
            .when_some(self.channel_menu.clone(), |root, (login, at)| {
                let favorite = crate::preferences::get(cx).favorite_channels.contains(&login);
                root.child(
                    gpui::deferred(
                        div()
                            .absolute()
                            .left(at.x)
                            .top(at.y)
                            .min_w(px(196.))
                            .p(px(4.))
                            .rounded(px(9.))
                            .border_1()
                            .border_color(theme::button_border())
                            .bg(theme::popup())
                            .shadow_lg()
                            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .child(
                                div()
                                    .id("menu-favorite")
                                    .h(px(34.))
                                    .px(px(10.))
                                    .flex()
                                    .items_center()
                                    .gap(px(9.))
                                    .rounded(px(6.))
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .cursor_pointer()
                                    .hover(|style| style.bg(rgb(0x2a2a31)))
                                    .child(ui::icon(if favorite { Icon::Star } else { Icon::StarFilled }, 15.))
                                    .child(if favorite { "Remove from favorites" } else { "Add to favorites" })
                                    .on_click(cx.listener(move |this, _, _, cx| this.toggle_favorite(&login, cx))),
                            ),
                    )
                    .with_priority(2),
                )
            })
            .when_some(self.notice.clone(), |root, notice| {
                root.child(
                    div()
                        .absolute()
                        .left_0()
                        .right_0()
                        .bottom(px(28.))
                        .flex()
                        .justify_center()
                        .child(
                            div()
                                .max_w(px(560.))
                                .px_4()
                                .py(px(10.))
                                .rounded(px(9.))
                                .border_1()
                                .border_color(theme::button_border())
                                .bg(theme::popup())
                                .shadow_lg()
                                .text_size(px(13.))
                                .text_color(theme::text())
                                .child(notice),
                        ),
                )
            })
            .when(self.shortcuts_open, |v| {
                v.child(
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(
                            div()
                                .id("shortcuts-backdrop")
                                .absolute()
                                .inset_0()
                                .bg(rgba(0x00000099))
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.shortcuts_open = false;
                                    cx.notify();
                                })),
                        )
                        .child(self.shortcuts_dialog(window, cx)),
                )
            })
            .when(self.settings_open, |v| {
                v.child(
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(
                            div()
                                .id("settings-backdrop")
                                .absolute()
                                .inset_0()
                                .bg(rgba(0x00000099))
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.settings_open = false;
                                    cx.notify();
                                })),
                        )
                        .child(self.settings.clone()),
                )
            })
    }
}

/// One shortcut: the keys (pressed together unless `either`) and what they do.
struct Shortcut {
    keys: &'static [&'static str],
    either: bool,
    action: &'static str,
}

const fn keys(keys: &'static [&'static str], action: &'static str) -> Shortcut {
    Shortcut { keys, either: false, action }
}

const fn either(keys: &'static [&'static str], action: &'static str) -> Shortcut {
    Shortcut { keys, either: true, action }
}

/// Every shortcut the app has. Each one is backed by a handler: Root's key
/// handler, the player's mouse handlers or the chat composer; keep them in step.
const SHORTCUTS: &[(&str, Option<&str>, &[Shortcut])] = &[
    (
        "WATCHING A STREAM",
        Some("While you are not typing in chat or a search box."),
        &[
            keys(&["Space"], "Pause, or resume at live"),
            either(&["M", "Middle-click"], "Mute or unmute"),
            either(&["↑", "↓"], "Volume up or down"),
            keys(&["G"], "Jump to live"),
            either(&["F", "Double-click"], "Fullscreen"),
            keys(&["T"], "Theater mode"),
            keys(&["C"], "Show or hide chat"),
            keys(&["O"], "Chat over the video"),
            keys(&["Esc"], "Leave fullscreen, then theater mode"),
        ],
    ),
    (
        "CHAT",
        None,
        &[
            keys(&["Enter"], "Send, or take the highlighted suggestion"),
            keys(&["Tab"], "Complete an emote or @name"),
            either(&["↑", "↓"], "Move through suggestions"),
            keys(&["Esc"], "Close suggestions"),
        ],
    ),
    (
        "SIDEBAR",
        None,
        &[keys(&["Right-click"], "Add or remove a favorite")],
    ),
    (
        "WINDOW",
        None,
        &[
            keys(&["F11"], "Fullscreen"),
            keys(&["?"], "This list"),
        ],
    ),
];

fn key_chip(label: &'static str) -> impl IntoElement {
    div()
        .flex_none()
        .h(px(24.))
        .min_w(px(24.))
        .px(px(7.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .border_1()
        .border_color(theme::button_border())
        .bg(theme::surface())
        .text_size(px(12.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(theme::text())
        .child(label)
}

impl Root {
    fn shortcuts_dialog(&self, window: &Window, cx: &Context<Self>) -> impl IntoElement {
        let groups = SHORTCUTS.iter().map(|(title, note, shortcuts)| {
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(
                    div()
                        .pt_2()
                        .text_size(px(11.))
                        .font_weight(FontWeight::BOLD)
                        .text_color(theme::text_dim())
                        .child(*title),
                )
                .when_some(*note, |group, note| {
                    group.child(
                        div()
                            .text_size(px(12.))
                            .text_color(theme::text_dim())
                            .child(note),
                    )
                })
                .children(shortcuts.iter().map(|shortcut| {
                    let separator = if shortcut.either { "or" } else { "+" };
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap_4()
                        .py(px(3.))
                        .child(
                            div()
                                .text_size(px(13.))
                                .text_color(theme::text())
                                .child(shortcut.action),
                        )
                        .child(div().flex_none().flex().items_center().gap(px(6.)).children(
                            shortcut.keys.iter().enumerate().flat_map(|(index, key)| {
                                let mut parts = Vec::new();
                                if index > 0 {
                                    parts.push(
                                        div()
                                            .text_size(px(11.))
                                            .text_color(theme::text_dim())
                                            .child(separator)
                                            .into_any_element(),
                                    );
                                }
                                parts.push(key_chip(key).into_any_element());
                                parts
                            }),
                        ))
                }))
        });
        div()
            .id("shortcuts")
            .occlude()
            .w(px(480.))
            .max_w(gpui::relative(0.94))
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
                    .pb_2()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_3()
                            .child(ui::icon(Icon::Keyboard, 20.).text_color(theme::violet_hover()))
                            .child(
                                div()
                                    .text_size(px(18.))
                                    .font_weight(FontWeight::BOLD)
                                    .child("Keyboard shortcuts"),
                            ),
                    )
                    .child(
                        ui::icon_button("shortcuts-close", Icon::Close, "Close", false).on_click(
                            cx.listener(|this, _, _, cx| {
                                this.shortcuts_open = false;
                                cx.notify();
                            }),
                        ),
                    ),
            )
            .child(
                div()
                    .id("shortcuts-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px_5()
                    .pb_5()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .children(groups),
            )
    }
}

/// Electron's window-state persistence: the normal bounds, whether the window
/// was maximized, and on which monitor. Fullscreen is not remembered.
fn remember_window(window: &Window, cx: &mut gpui::App) {
    let (bounds, maximized) = match window.window_bounds() {
        gpui::WindowBounds::Windowed(bounds) => (bounds, false),
        gpui::WindowBounds::Maximized(bounds) => (bounds, true),
        gpui::WindowBounds::Fullscreen(_) => return,
    };
    let display = window
        .display(cx)
        .and_then(|display| display.uuid().ok())
        .map(|uuid| uuid.to_string());
    crate::preferences::update(cx, |preferences| {
        preferences.window = Some(crate::preferences::WindowPlacement {
            x: f32::from(bounds.origin.x),
            y: f32::from(bounds.origin.y),
            width: f32::from(bounds.size.width),
            height: f32::from(bounds.size.height),
            maximized,
            display,
        });
    });
}

fn caption_button(
    id: &'static str,
    glyph: &'static str,
    area: WindowControlArea,
) -> impl IntoElement {
    let close = area == WindowControlArea::Close;
    div()
        .id(id)
        .flex_none()
        .w(px(46.))
        .h_full()
        .flex()
        .items_center()
        .justify_center()
        .font_family(theme::ICON_FONT)
        .text_size(px(10.))
        .text_color(theme::text())
        .occlude()
        .window_control_area(area)
        .hover(move |style| {
            if close {
                style.bg(theme::close_hover()).text_color(gpui::white())
            } else {
                style.bg(theme::surface_hover())
            }
        })
        .child(glyph)
}

fn button(id: &'static str, label: &'static str, primary: bool) -> Stateful<Div> {
    ui::button(
        id,
        label,
        None,
        if primary {
            ButtonStyle::Primary
        } else {
            ButtonStyle::Secondary
        },
    )
}

fn pill(text: impl Into<SharedString>) -> Div {
    div()
        .px_1p5()
        .py_0p5()
        .rounded_sm()
        .bg(rgba(0x000000c0))
        .text_xs()
        .text_color(gpui::white())
        .child(text.into())
}

fn note(text: &'static str) -> Div {
    div().text_color(theme::text_dim()).child(text)
}

fn banner(message: SharedString) -> Div {
    div()
        .px_3()
        .py_2()
        .rounded_md()
        .bg(rgba(0xeb04001f))
        .border_1()
        .border_color(rgba(0xeb040066))
        .text_color(rgb(0xfca5a5))
        .child(message)
}

fn is_hex_color(text: &str) -> bool {
    text.len() == 7 && text.starts_with('#') && text[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn open_channel(login: &str, cx: &mut App) {
    if let Some(slug) = crate::kick::slug(login) {
        cx.open_url(&format!("https://kick.com/{slug}"));
    } else if is_login(login) {
        cx.open_url(&format!("https://www.twitch.tv/{login}"));
    }
}

fn open_activation(url: &str, cx: &mut App) {
    if auth::is_twitch_activation_url(url) {
        cx.open_url(url);
    }
}

/// The signed-in Kick account's followed channels, live ones with their
/// thumbnail. `None` when Kick no longer accepts the account.
async fn load_kick_followed(cx: &mut gpui::AsyncApp) -> anyhow::Result<Option<Vec<FollowedChannel>>> {
    let mut channels: Vec<FollowedChannel> = Vec::new();
    let mut cursor: Option<String> = None;
    // Bounded, so a runaway cursor cannot loop forever.
    for _ in 0..10 {
        let path = match &cursor {
            None => "/api/v2/channels/followed".to_owned(),
            Some(cursor) => format!("/api/v2/channels/followed?cursor={}", crate::playback::kick::encode(cursor)),
        };
        let (status, page) = crate::kick_web::request(cx, "GET", &path, None).await?;
        match status {
            200 => {}
            401 => return Ok(None),
            status => anyhow::bail!("Kick answered {status}."),
        }
        let entries = if page.is_array() { &page } else { &page["channels"] };
        channels.extend(entries.as_array().into_iter().flatten().filter_map(crate::kick::followed_entry));
        cursor = match &page["next_cursor"] {
            serde_json::Value::String(next) if !next.is_empty() && next.len() < 200 => Some(next.clone()),
            serde_json::Value::Number(next) if next.as_u64().is_some_and(|n| n > 0) => Some(next.to_string()),
            _ => None,
        };
        if cursor.is_none() {
            break;
        }
    }
    // The followed list has no thumbnails; the livestream route does.
    for channel in &mut channels {
        let Some(slug) = crate::kick::slug(&channel.login).map(str::to_owned) else { continue };
        let Some(stream) = channel.stream.as_mut() else { continue };
        if let Ok((200, live)) =
            crate::kick_web::request(cx, "GET", &format!("/api/v2/channels/{slug}/livestream"), None).await
        {
            stream.thumbnail_url = live["data"]["thumbnail"]["src"]
                .as_str()
                .filter(|url| crate::kick::is_image_url(url))
                .map(str::to_owned);
        }
    }
    Ok(Some(channels))
}
