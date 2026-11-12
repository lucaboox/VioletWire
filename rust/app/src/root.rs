//! The main window: a custom title bar, the followed-channels sidebar and the
//! Home grid of live channels.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::anyhow;
use gpui::{
    AnyElement, App, Context, Div, FontWeight, Image, ImageSource, ObjectFit, Render,
    SharedString, Stateful, Task, Window, WindowControlArea, div, img, prelude::*, px, rgb, rgba,
};

use crate::format::{compact_count, is_login, uptime};
use crate::session::{self, Failure, Followed, Session};
use crate::twitch::auth::{self, Poll};
use crate::twitch::helix::FollowedChannel;
use crate::twitch::token_store;
use crate::{http, images, theme};

/// How often the followed list (and its live state) refreshes.
const REFRESH_EVERY: Duration = Duration::from_secs(120);
/// Concurrent image downloads.
const IMAGE_WORKERS: usize = 6;
/// Twitch regenerates live thumbnails about every five minutes.
const THUMBNAIL_PERIOD_SECONDS: u64 = 300;
const CARD_WIDTH: f32 = 320.0;

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
    // A held task is cancelled when it is replaced or dropped.
    auth_task: Option<Task<()>>,
    followed_task: Option<Task<()>>,
    refresh_task: Option<Task<()>>,
}

impl Root {
    pub fn new(cx: &mut Context<Self>) -> Self {
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
            auth_task: None,
            followed_task: None,
            refresh_task: None,
        };
        root.restore(cx);
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
                    this.update(cx, |this, cx| this.sign_in_failed(error, cx)).ok();
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
                    this.update(cx, |this, cx| this.sign_in_failed(expired, cx)).ok();
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
                            Poll::Approved(token) => Step::Done(session::begin(&agent, token, epoch)?),
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
                        this.update(cx, |this, cx| this.sign_in_failed(error, cx)).ok();
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
            this.update(cx, |this, cx| this.followed_loaded(epoch, result, cx)).ok();
        }));
    }

    fn followed_loaded(&mut self, epoch: u64, result: Result<Followed, Failure>, cx: &mut Context<Self>) {
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
            .filter_map(|channel| channel.stream.as_ref()?.thumbnail_url.clone())
            .map(|url| (url, period));
        let avatars = self
            .channels
            .iter()
            .filter_map(|channel| channel.profile_image_url.clone())
            .map(|url| (url, 0));
        let wanted: Vec<(String, u64)> = thumbnails.chain(avatars).collect();

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
            queue.push_back(ImageJob { url, fetch_url, version });
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
                    if this.update(cx, |this, cx| this.image_loaded(job, result, cx)).is_err() {
                        break;
                    }
                }
                workers.set(workers.get() - 1);
            })
            .detach();
        }
    }

    fn image_loaded(&mut self, job: ImageJob, result: anyhow::Result<Arc<Image>>, cx: &mut Context<Self>) {
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
        let maximize_glyph = if window.is_maximized() { "\u{E923}" } else { "\u{E922}" };
        div()
            .h(px(32.))
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
                    .pl_3()
                    .window_control_area(WindowControlArea::Drag)
                    .child(div().size(px(10.)).rounded_full().bg(theme::violet()))
                    .child(div().text_xs().text_color(theme::text_dim()).child("VioletWire")),
            )
            .child(caption_button("minimize", "\u{E921}", WindowControlArea::Min))
            .child(caption_button("maximize", maximize_glyph, WindowControlArea::Max))
            .child(caption_button("close", "\u{E8BB}", WindowControlArea::Close))
    }

    fn sidebar(&self, cx: &Context<Self>) -> impl IntoElement {
        let live = self.channels.iter().filter(|channel| channel.stream.is_some()).count();
        let login = match &self.auth {
            Auth::SignedIn(session) => session.identity.login.clone(),
            _ => String::new(),
        };
        div()
            .w(px(248.))
            .flex_none()
            .h_full()
            .flex()
            .flex_col()
            .bg(theme::title_bar())
            .border_r_1()
            .border_color(theme::border())
            .child(
                div()
                    .flex_none()
                    .px_3()
                    .pt_3()
                    .pb_2()
                    .flex()
                    .items_center()
                    .justify_between()
                    .text_xs()
                    .text_color(theme::text_dim())
                    .child(div().font_weight(FontWeight::SEMIBOLD).child("FOLLOWED CHANNELS"))
                    .when(self.loaded, |row| row.child(format!("{live} live"))),
            )
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
                    .children(self.channels.iter().map(|channel| self.channel_row(channel, cx))),
            )
            .child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .px_3()
                    .py_2()
                    .border_t_1()
                    .border_color(theme::border())
                    .child(div().min_w_0().truncate().text_xs().text_color(theme::text_dim()).child(login))
                    .child(
                        button("sign-out", "Sign out", false)
                            .on_click(cx.listener(|this, _, _, cx| this.end_session(None, cx))),
                    ),
            )
    }

    fn channel_row(&self, channel: &FollowedChannel, cx: &Context<Self>) -> impl IntoElement {
        let login = channel.login.clone();
        let subtitle: SharedString = match &channel.stream {
            Some(stream) if !stream.game_name.is_empty() => stream.game_name.clone().into(),
            Some(_) => "Live".into(),
            None => "Offline".into(),
        };
        div()
            .id(SharedString::from(format!("channel-{}", channel.id)))
            .flex()
            .flex_none()
            .items_center()
            .gap_2p5()
            .px_2()
            .py_1p5()
            .rounded_md()
            .cursor_pointer()
            .hover(|style| style.bg(theme::surface_hover()))
            .when(channel.stream.is_none(), |row| row.opacity(0.5))
            .child(self.avatar(channel.profile_image_url.as_deref(), 30.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(div().truncate().font_weight(FontWeight::MEDIUM).child(channel.display_name.clone()))
                    .child(div().truncate().text_xs().text_color(theme::text_dim()).child(subtitle)),
            )
            .when_some(channel.stream.as_ref(), |row, stream| {
                row.child(
                    div()
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap_1()
                        .text_xs()
                        .text_color(theme::text_dim())
                        .child(div().size(px(7.)).rounded_full().bg(theme::live()))
                        .child(compact_count(stream.viewer_count)),
                )
            })
            .on_click(cx.listener(move |_, _, _, cx| open_channel(&login, cx)))
    }

    fn home(&self, cx: &Context<Self>) -> impl IntoElement {
        let live: Vec<&FollowedChannel> = self.channels.iter().filter(|channel| channel.stream.is_some()).collect();
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
                .gap_5()
                .children(live.iter().map(|channel| self.card(channel, now, cx)))
                .into_any_element()
        };
        div()
            .id("home")
            .flex_1()
            .min_w_0()
            .h_full()
            .overflow_y_scroll()
            .p_6()
            .flex()
            .flex_col()
            .gap_4()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(div().text_xl().font_weight(FontWeight::SEMIBOLD).child("Live now"))
                    .when(self.loaded, |row| {
                        row.child(div().text_color(theme::text_dim()).child(format!("{} channels", live.len())))
                    })
                    .child(div().flex_1())
                    .when(self.loading, |row| {
                        row.child(div().text_xs().text_color(theme::text_dim()).child("Refreshing…"))
                    })
                    .child(button("refresh", "Refresh", false).on_click(cx.listener(|this, _, _, cx| this.load_followed(cx)))),
            )
            .when_some(self.message.clone(), |column, message| column.child(banner(message)))
            .child(content)
    }

    fn card(&self, channel: &FollowedChannel, now: u64, cx: &Context<Self>) -> AnyElement {
        let Some(stream) = channel.stream.as_ref() else {
            return div().into_any_element();
        };
        let login = channel.login.clone();
        let group = SharedString::from(format!("card-{}", channel.id));
        let thumbnail = stream.thumbnail_url.as_deref().and_then(|url| self.image(url));
        let category: SharedString = if stream.game_name.is_empty() {
            "Live".into()
        } else {
            stream.game_name.clone().into()
        };
        div()
            .id(group.clone())
            .group(group.clone())
            .w(px(CARD_WIDTH))
            .flex()
            .flex_col()
            .gap_2p5()
            .cursor_pointer()
            .child(
                div()
                    .relative()
                    .w_full()
                    .h(px(CARD_WIDTH * 9. / 16.))
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
                            .child(div().truncate().text_color(theme::text_dim()).child(channel.display_name.clone()))
                            .child(div().truncate().text_xs().text_color(theme::text_dim()).child(category)),
                    ),
            )
            .on_click(cx.listener(move |_, _, _, cx| open_channel(&login, cx)))
            .into_any_element()
    }

    fn avatar(&self, url: Option<&str>, size: f32) -> AnyElement {
        let size = px(size);
        match url.and_then(|url| self.image(url)) {
            Some(image) => img(ImageSource::Image(image))
                .size(size)
                .flex_none()
                .rounded_full()
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
                    .child(div().text_2xl().font_weight(FontWeight::SEMIBOLD).child("VioletWire")),
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
        div()
            .flex_1()
            .flex()
            .items_center()
            .justify_center()
            .child(panel.when_some(self.message.clone(), |panel, message| panel.child(banner(message))))
    }
}

impl Render for Root {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let body = match &self.auth {
            Auth::SignedIn(_) => div()
                .flex_1()
                .min_h_0()
                .flex()
                .child(self.sidebar(cx))
                .child(self.home(cx))
                .into_any_element(),
            _ => self.welcome(cx).into_any_element(),
        };
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(theme::background())
            .text_color(theme::text())
            .font_family(theme::UI_FONT)
            .text_sm()
            .child(self.title_bar(window))
            .child(body)
    }
}

fn caption_button(id: &'static str, glyph: &'static str, area: WindowControlArea) -> impl IntoElement {
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
    let (background, hover, text) = if primary {
        (theme::violet(), theme::violet_hover(), rgb(0xffffff))
    } else {
        (theme::surface_hover(), theme::border(), theme::text())
    };
    div()
        .id(id)
        .flex_none()
        .flex()
        .justify_center()
        .px_3()
        .py_1p5()
        .rounded_md()
        .cursor_pointer()
        .bg(background)
        .hover(move |style| style.bg(hover))
        .text_color(text)
        .font_weight(FontWeight::SEMIBOLD)
        .child(label)
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

/// Until playback lands in the Rust build, a channel opens on twitch.tv.
fn open_channel(login: &str, cx: &mut App) {
    if is_login(login) {
        cx.open_url(&format!("https://www.twitch.tv/{login}"));
    }
}

fn open_activation(url: &str, cx: &mut App) {
    if auth::is_twitch_activation_url(url) {
        cx.open_url(url);
    }
}
