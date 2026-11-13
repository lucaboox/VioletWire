use super::{
    assets::{self, Assets},
    connection::Connection,
    model::{self, Event, Message, Part},
};
use crate::player::PlayerAction;
use crate::ui::{self, ButtonStyle, Icon};
use crate::{
    input::{Submitted, TextInput},
    session::Session,
    theme,
};
use gpui::{
    AnyElement, Context, Entity, FontWeight, ImageSource, ListAlignment, ListOffset, ListState,
    ObjectFit, Render, RenderImage, SharedString, Subscription, Task, Window, div, img, list,
    prelude::*, px, rgb, rgba,
};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};

const MAX_MESSAGES: usize = 500;
const MAX_IMAGES: usize = 160;
const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
type EmoteEntries = Arc<Vec<(String, String)>>;
type PickerCache = (String, &'static str, EmoteEntries);
pub struct Chat {
    agent: ureq::Agent,
    overlay: bool,
    hovered: bool,
    preferences: crate::preferences::Preferences,
    connection: Connection,
    messages: VecDeque<Message>,
    ids: HashSet<String>,
    room: String,
    session: Option<Session>,
    assets: Assets,
    // A displayed emote keeps its geometry across loading, eviction and retry.
    emote_ratios: HashMap<String, HashMap<String, f32>>,
    images: HashMap<String, Option<Arc<RenderImage>>>,
    failed_images: HashMap<String, Instant>,
    pending_images: HashMap<String, u64>,
    next_image: u64,
    image_bytes: usize,
    order: VecDeque<String>,
    image_queue: VecDeque<(String, u64)>,
    workers: usize,
    state: &'static str,
    paused: bool,
    unseen: usize,
    list: ListState,
    input: Entity<TextInput>,
    picker_input: Entity<TextInput>,
    picker: bool,
    picker_provider: &'static str,
    picker_cache: Option<PickerCache>,
    notice: Option<SharedString>,
    last_send: Option<Instant>,
    sending: bool,
    replying: Option<model::Reply>,
    menu: Option<(Message, gpui::Point<gpui::Pixels>)>,
    _poll: Option<Task<()>>,
    _metadata: Option<Task<()>>,
    _send: Option<Task<()>>,
    _history: Option<Task<()>>,
    history_loaded: usize,
    _subscriptions: Vec<Subscription>,
}
impl gpui::EventEmitter<PlayerAction> for Chat {}
impl Chat {
    pub fn set_overlay(&mut self, overlay: bool, cx: &mut Context<Self>) {
        if self.overlay != overlay {
            self.overlay = overlay;
            cx.notify();
        }
    }
    /// Electron's mention alert: someone else's live message that mentions
    /// or replies to the signed-in viewer. History never arrives here.
    fn alerts_for(&self, message: &model::Message) -> bool {
        let Some(session) = &self.session else {
            return false;
        };
        let login = &session.identity.login;
        self.preferences.mention_sound_enabled
            && message.system.is_none()
            && !message.deleted
            && !message.login.eq_ignore_ascii_case(login)
            && (model::mentioned(&message.text, login)
                || message
                    .reply
                    .as_ref()
                    .is_some_and(|reply| reply.name.eq_ignore_ascii_case(login)))
    }

    pub fn set_preferences(
        &mut self,
        settings: crate::preferences::Preferences,
        cx: &mut Context<Self>,
    ) {
        let changed = self.preferences.chat_font_size != settings.chat_font_size
            || self.preferences.chat_emote_size != settings.chat_emote_size
            || self.preferences.chat_timestamps != settings.chat_timestamps
            || self.preferences.chat_overlay_opacity != settings.chat_overlay_opacity
            || self.preferences.chat_deleted_message_style != settings.chat_deleted_message_style
            || self.preferences.chat_on_left != settings.chat_on_left;
        self.preferences = settings;
        if changed {
            self.invalidate_messages();
            cx.notify();
        }
    }
    pub fn probe_layout(&mut self, picker: bool, extras: bool, cx: &mut Context<Self>) {
        if extras
            && self.replying.is_none()
            && let Some(message) = self.messages.back()
        {
            self.replying = Some(model::Reply {
                id: message.id.clone(),
                name: message.name.clone(),
                text: message.text.clone(),
            });
            self.menu = Some((message.clone(), gpui::point(px(40.), px(160.))));
            cx.notify();
        }
        if self.picker != picker {
            self.picker = picker;
            cx.notify();
        }
    }

    pub fn probe_succeeded(&self) -> bool {
        self.state == "Connected"
            && !self.assets.emotes.is_empty()
            && self.list.viewport_bounds().size.height > px(100.)
    }
    pub fn diagnostics(&self) -> String {
        format!(
            "chat={} messages={} history={} emotes={} images_loaded={} animated_images={} image_bytes={} list_height={:.0}",
            self.state,
            self.messages.len(),
            self.history_loaded,
            self.assets.emotes.len(),
            self.images.values().filter(|image| image.is_some()).count(),
            self.images
                .values()
                .flatten()
                .filter(|image| image.frame_count() > 1)
                .count(),
            self.image_bytes,
            f32::from(self.list.viewport_bounds().size.height)
        )
    }
    pub fn is_editing(&self, window: &Window, cx: &gpui::App) -> bool {
        use gpui::Focusable;
        self.input.read(cx).focus_handle(cx).is_focused(window)
            || self
                .picker_input
                .read(cx)
                .focus_handle(cx)
                .is_focused(window)
    }
    pub fn new(login: &str, session: Option<Session>, cx: &mut Context<Self>) -> Self {
        let input = cx.new(TextInput::composer);
        let picker_input = cx.new(|cx| TextInput::new("Search emotes", cx));
        let submitted = cx.subscribe(&input, |this, _, _: &Submitted, cx| this.send(cx));
        let input_changed = cx.observe(&input, |_, _, cx| cx.notify());
        let picker_changed = cx.observe(&picker_input, |_, _, cx| cx.notify());
        let release = cx.on_release(|this, cx| {
            for image in this.images.drain().filter_map(|(_, image)| image) {
                cx.defer(move |cx| cx.drop_image(image, None));
            }
        });
        let mut this = Self {
            agent: crate::http::agent(),
            overlay: false,
            hovered: false,
            preferences: crate::preferences::get(cx),
            connection: Connection::new(login),
            messages: VecDeque::new(),
            ids: HashSet::new(),
            room: String::new(),
            session,
            assets: Assets::default(),
            emote_ratios: HashMap::new(),
            images: HashMap::new(),
            failed_images: HashMap::new(),
            pending_images: HashMap::new(),
            next_image: 0,
            image_bytes: 0,
            order: VecDeque::new(),
            image_queue: VecDeque::new(),
            workers: 0,
            state: "Connecting",
            paused: false,
            unseen: 0,
            list: ListState::new(0, ListAlignment::Bottom, px(150.)),
            input,
            picker_input,
            picker: false,
            picker_provider: "All",
            picker_cache: None,
            notice: None,
            last_send: None,
            sending: false,
            replying: None,
            menu: None,
            _poll: None,
            _metadata: None,
            _send: None,
            _history: None,
            history_loaded: 0,
            _subscriptions: vec![submitted, picker_changed, input_changed, release],
        };
        let view = cx.entity().downgrade();
        this.list.set_scroll_handler(move |event, _, cx| {
            let _ = view.update(cx, |this, cx| {
                this.paused = event.is_scrolled;
                if !this.paused {
                    this.unseen = 0;
                }
                cx.notify();
            });
        });
        this._poll = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(100))
                    .await;
                if this.update(cx, |this, cx| this.poll(cx)).is_err() {
                    break;
                }
            }
        }));
        let limit = usize::from(this.preferences.chat_history_limit);
        if limit > 0 {
            let channel = login.to_owned();
            let agent = this.agent.clone();
            this._history = Some(cx.spawn(async move |this, cx| {
                let history = cx
                    .background_executor()
                    .spawn(async move { super::history::load(&agent, &channel, limit) })
                    .await;
                let _ = this.update(cx, |this, cx| {
                    if history.is_empty() {
                        return;
                    }
                    let offset = this.paused.then(|| this.list.logical_scroll_top());
                    let anchor = offset
                        .as_ref()
                        .and_then(|offset| this.messages.get(offset.item_ix))
                        .map(|message| message.id.clone());
                    let mut history: Vec<_> = history
                        .into_iter()
                        .filter(|message| {
                            message.id.is_empty() || this.ids.insert(message.id.clone())
                        })
                        .collect();
                    this.history_loaded = history.len();
                    history.extend(this.messages.drain(..));
                    history.sort_by_key(|message| message.sent_at.unwrap_or(0));
                    if history.len() > MAX_MESSAGES {
                        history.drain(..history.len() - MAX_MESSAGES);
                    }
                    this.messages = history.into();
                    this.ids = this
                        .messages
                        .iter()
                        .filter(|message| !message.id.is_empty())
                        .map(|message| message.id.clone())
                        .collect();
                    this.emote_ratios.retain(|id, _| this.ids.contains(id));
                    this.list.reset(this.messages.len());
                    if let (Some(offset), Some(anchor)) = (offset, anchor)
                        && let Some(item_ix) = this
                            .messages
                            .iter()
                            .position(|message| message.id == anchor)
                    {
                        this.list.scroll_to(ListOffset { item_ix, ..offset });
                    }
                    cx.notify();
                });
            }));
        }
        this
    }
    pub fn set_session(&mut self, session: Option<Session>, cx: &mut Context<Self>) {
        let old = self.session.as_ref().map(|s| s.token.access_token.as_str());
        let new = session.as_ref().map(|s| s.token.access_token.as_str());
        if old == new {
            return;
        }
        self.session = session;
        self.notice = None;
        self.reload_assets(cx);
        cx.notify();
    }
    pub fn set_room(&mut self, room: &str, cx: &mut Context<Self>) {
        if room != self.room
            && !room.is_empty()
            && room.len() <= 20
            && room.bytes().all(|b| b.is_ascii_digit())
        {
            self.room = room.to_owned();
            self.reload_assets(cx);
        }
    }
    fn poll(&mut self, cx: &mut Context<Self>) {
        let events: Vec<_> = self.connection.events.try_iter().take(250).collect();
        if events.is_empty() {
            return;
        }
        let mut invalidate = false;
        for event in events {
            match event {
                Event::State(state) => self.state = state,
                Event::Room(room) => {
                    self.set_room(&room, cx);
                }
                Event::Message(message) => {
                    if !message.id.is_empty() && !self.ids.insert(message.id.clone()) {
                        continue;
                    }
                    if self.alerts_for(&message) {
                        crate::sound::play_mention(
                            &self.preferences.mention_sound_id,
                            self.preferences.mention_sound_volume,
                        );
                    }
                    self.messages.push_back(message);
                    let n = self.messages.len();
                    self.list.splice(n - 1..n - 1, 1);
                    if self.paused {
                        self.unseen = (self.unseen + 1).min(999);
                    }
                    while self.messages.len() > MAX_MESSAGES {
                        if let Some(old) = self.messages.pop_front() {
                            self.ids.remove(&old.id);
                            self.emote_ratios.remove(&old.id);
                        }
                        self.list.splice(0..1, 0);
                    }
                }
                Event::Delete(id) => {
                    // A history response racing live moderation must never
                    // reintroduce a message the moderator has just removed.
                    self._history = None;
                    for message in &mut self.messages {
                        if message.id == id {
                            message.deleted = true;
                            invalidate = true;
                        }
                    }
                }
                Event::ClearUser(login) => {
                    self._history = None;
                    for message in &mut self.messages {
                        if message.login == login {
                            message.deleted = true;
                            invalidate = true;
                        }
                    }
                }
                Event::Clear => {
                    self._history = None;
                    self.messages.clear();
                    self.ids.clear();
                    self.emote_ratios.clear();
                    self.list.reset(0);
                }
            }
        }
        if invalidate {
            self.invalidate_messages();
        }
        if !self.paused {
            self.list.scroll_to(ListOffset {
                item_ix: self.messages.len(),
                offset_in_item: px(0.),
            });
        }
        cx.notify();
    }
    fn reload_assets(&mut self, cx: &mut Context<Self>) {
        if self.room.is_empty() {
            return;
        }
        let room = self.room.clone();
        let session = self.session.clone();
        self._metadata = Some(cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { assets::load(&room, session.as_ref()) })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.assets = result;
                this.picker_cache = None;
                this.invalidate_messages();
                cx.notify();
            });
        }));
    }
    fn evict_image(&mut self, cx: &mut Context<Self>) {
        let Some(key) = self.order.pop_front() else {
            return;
        };
        self.failed_images.remove(&key);
        self.pending_images.remove(&key);
        if let Some(Some(image)) = self.images.remove(&key) {
            self.image_bytes = self
                .image_bytes
                .saturating_sub(crate::images::decoded_bytes(&image));
            // Eviction can happen during layout while this window is borrowed.
            // Defer atlas removal until it is back in App.windows.
            cx.defer(move |cx| cx.drop_image(image, None));
        }
    }
    fn image(
        &mut self,
        url: &str,
        animated: bool,
        cx: &mut Context<Self>,
    ) -> Option<Arc<RenderImage>> {
        let key = if animated {
            url.to_owned()
        } else {
            format!("still:{url}")
        };
        if self
            .failed_images
            .get(&key)
            .is_some_and(|at| at.elapsed() > Duration::from_secs(30))
        {
            self.failed_images.remove(&key);
            self.images.remove(&key);
            self.order.retain(|cached| cached != &key);
        }
        if let Some(image) = self.images.get(&key) {
            return image.clone();
        }
        if !assets::image_url(url) {
            return None;
        }
        if self.image_queue.len() >= MAX_IMAGES {
            return None;
        }
        while self.images.len() >= MAX_IMAGES {
            self.evict_image(cx);
        }
        self.images.insert(key.clone(), None);
        self.order.push_back(key.clone());
        self.next_image = self.next_image.wrapping_add(1);
        self.pending_images.insert(key.clone(), self.next_image);
        self.image_queue.push_back((key, self.next_image));
        self.pump(cx);
        None
    }
    fn pump(&mut self, cx: &mut Context<Self>) {
        while self.workers < 4 {
            let Some((url, generation)) = self.image_queue.pop_front() else {
                break;
            };
            if self.pending_images.get(&url) != Some(&generation) || !self.images.contains_key(&url)
            {
                continue;
            }
            self.workers += 1;
            let agent = self.agent.clone();
            cx.spawn(async move |this, cx| {
                let address = url.clone();
                let (address, animated) = match address.strip_prefix("still:") {
                    Some(address) => (address.to_owned(), false),
                    None => (address, true),
                };
                let result = cx
                    .background_executor()
                    .spawn(async move { crate::images::fetch_chat(&agent, &address, animated) })
                    .await;
                let _ = this.update(cx, |this, cx| {
                    this.workers = this.workers.saturating_sub(1);
                    if this.pending_images.get(&url) == Some(&generation)
                        && this.images.contains_key(&url)
                    {
                        this.pending_images.remove(&url);
                        let image = result.ok();
                        if image.is_none() {
                            this.failed_images.insert(url.clone(), Instant::now());
                        }
                        let size = image
                            .as_ref()
                            .map_or(0, |image| crate::images::decoded_bytes(image));
                        while this.image_bytes + size > MAX_IMAGE_BYTES && !this.order.is_empty() {
                            this.evict_image(cx);
                        }
                        if this.images.contains_key(&url) {
                            this.image_bytes += size;
                            this.images.insert(url, image);
                        }
                    }
                    cx.notify();
                    this.pump(cx);
                });
            })
            .detach();
        }
    }
    fn send(&mut self, cx: &mut Context<Self>) {
        if self.sending {
            return;
        }
        let Some(session) = self.session.clone() else {
            self.notice = Some("Sign in with Twitch to chat.".into());
            cx.notify();
            return;
        };
        if self
            .last_send
            .is_some_and(|time| time.elapsed() < Duration::from_secs(2))
        {
            self.notice = Some("Please wait a moment before sending again.".into());
            cx.notify();
            return;
        }
        let text = self.input.read(cx).content.to_string();
        if text.trim().is_empty() {
            return;
        }
        let room = self.room.clone();
        self.sending = true;
        let reply = self.replying.as_ref().map(|reply| reply.id.clone());
        self.last_send = Some(Instant::now());
        self.notice = None;
        self._send = Some(cx.spawn(async move |this, cx| {
            let sent = text.clone();
            let sent_reply = reply.clone();
            let result = cx
                .background_executor()
                .spawn(async move { assets::send(&room, &sent, sent_reply.as_deref(), &session) })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.sending = false;
                match result {
                    Ok(()) => {
                        if this.input.read(cx).content.as_ref() == text
                            && this.replying.as_ref().map(|reply| reply.id.as_str())
                                == reply.as_deref()
                        {
                            this.input.update(cx, |input, cx| input.clear(cx));
                            this.replying = None;
                        }
                    }
                    Err(error) => {
                        this.notice = Some(crate::http::short_message(&error.to_string()).into())
                    }
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
    fn invalidate_messages(&mut self) {
        let offset = self.paused.then(|| self.list.logical_scroll_top());
        // Keep the list's scroll state; reset also discards the anchor and
        // drops scroll events until the next paint.
        self.list
            .splice(0..self.messages.len(), self.messages.len());
        if let Some(offset) = offset {
            self.list.scroll_to(offset);
        } else {
            self.list.scroll_to(ListOffset {
                item_ix: self.messages.len(),
                offset_in_item: px(0.),
            });
        }
    }
    fn row(&mut self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let Some(message) = self.messages.get(index).cloned() else {
            return div().into_any_element();
        };
        let row_id = if model::asset_id(&message.id) {
            message.id.clone()
        } else {
            format!("row-{index}")
        };
        let mut flow = super::flow::MessageFlow::new(self.preferences.chat_font_size);
        if self.preferences.chat_timestamps
            && let Some(time) = message.sent_at.and_then(model::local_time)
        {
            flow.image(
                div()
                    .w(px(38.))
                    .h(px(21.))
                    .flex()
                    .items_center()
                    .text_size(px(11.))
                    .text_color(theme::text_dim())
                    .child(time)
                    .into_any_element(),
                38.,
                21.,
            );
        }
        for badge in &message.badges {
            if let Some(url) = self.assets.badges.get(badge).cloned() {
                let image = self.image(&url, false, cx);
                let label = badge.clone();
                flow.image(
                    div()
                        .id(SharedString::from(format!("badge-{badge}")))
                        .w(px(21.))
                        .h(px(18.))
                        .pr(px(3.))
                        .when_some(image, |v, image| {
                            v.child(img(ImageSource::Render(image)).size(px(18.)))
                        })
                        .tooltip(move |_, cx| cx.new(|_| ui::Tooltip(label.clone().into())).into())
                        .into_any_element(),
                    21.,
                    18.,
                );
            }
        }
        if message.system.is_none() || !message.text.is_empty() {
            flow.text(
                &format!("{}{} ", message.name, if message.action { "" } else { ":" }),
                rgb(message.color),
                true,
            );
        }
        if message.deleted && self.preferences.chat_deleted_message_style != "dimmed" {
            flow.text("[Message deleted]", theme::text_dim(), false);
        } else {
            for (part_index, part) in model::parts(&message, &self.assets.providers)
                .into_iter()
                .enumerate()
            {
                match part {
                    Part::Text(text) => flow.text(
                        &text,
                        if message.action {
                            rgb(message.color)
                        } else {
                            theme::text_secondary()
                        },
                        false,
                    ),
                    Part::Emote { name, url } => {
                        let image = self.image(&url, true, cx);
                        let height = f32::from(self.preferences.chat_emote_size);
                        let ratio =
                            self.assets
                                .aspect_ratios
                                .get(&url)
                                .copied()
                                .unwrap_or_else(|| {
                                    image.as_ref().map_or(1., |image| {
                                        let size = image.size(0);
                                        size.width.0 as f32 / size.height.0.max(1) as f32
                                    })
                                });
                        // Freeze each displayed message's geometry, rather than
                        // freezing an unknown image's square fallback forever.
                        // Later messages can use its decoded natural aspect ratio.
                        let ratios = self.emote_ratios.entry(row_id.clone()).or_default();
                        let ratio = if ratios.len() < 32 || ratios.contains_key(&url) {
                            *ratios.entry(url).or_insert(ratio)
                        } else {
                            1.
                        };
                        let width = (ratio * height).clamp(10., height * 6.);
                        let label = name.clone();
                        let layered = self.assets.zero_width.contains(&name);
                        flow.image_layer(
                            div()
                                .id(SharedString::from(format!("emote-{part_index}")))
                                .w(px(width + 2.))
                                .h(px(height))
                                .px(px(1.))
                                .when_some(image.clone(), |v, image| {
                                    v.child(
                                        img(ImageSource::Render(image))
                                            .w(px(width))
                                            .h(px(height))
                                            .object_fit(ObjectFit::Contain),
                                    )
                                })
                                .when(image.is_none(), |v| {
                                    v.text_size(px(10.)).truncate().child(name)
                                })
                                .tooltip(move |_, cx| {
                                    cx.new(|_| ui::Tooltip(label.clone().into())).into()
                                })
                                .into_any_element(),
                            width + 2.,
                            height,
                            layered,
                        );
                    }
                }
            }
        }
        let mentioned = self
            .session
            .as_ref()
            .is_some_and(|session| model::mentioned(&message.text, &session.identity.login));
        let reply_message = message.clone();
        let menu_message = message.clone();
        div()
            .id(SharedString::from(row_id))
            .group("chat-message")
            .relative()
            .px(px(11.))
            .py(px(3.))
            .rounded(px(4.))
            .text_color(theme::text_secondary())
            // "Dimmed" keeps a deleted message's text, faded.
            .when(
                message.deleted && self.preferences.chat_deleted_message_style == "dimmed",
                |v| v.opacity(0.4),
            )
            .when(mentioned, |v| {
                v.bg(rgba(0x9147ff29))
                    .border_l_2()
                    .border_color(theme::violet())
            })
            .when(message.first_message, |v| {
                v.bg(rgba(0x7c3aed1f))
                    .border_l_2()
                    .border_color(theme::violet())
            })
            .hover(|s| s.bg(rgba(0xffffff0d)))
            .when(message.first_message, |v| {
                v.child(
                    div()
                        .pb_1()
                        .text_size(px(10.))
                        .font_weight(FontWeight::BOLD)
                        .text_color(theme::accent_text())
                        .child("FIRST TIME CHATTER"),
                )
            })
            .when_some(message.system.as_ref(), |v, notice| {
                v.child(
                    div()
                        .py_1()
                        .text_size(px(12.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme::accent_text())
                        .child(notice.clone()),
                )
            })
            .when_some(message.reply.as_ref(), |v, reply| {
                let id = reply.id.clone();
                v.child(
                    div()
                        .id("reply-parent")
                        .mb_1()
                        .pl_2()
                        .border_l_2()
                        .border_color(theme::selected_border())
                        .text_size(px(11.))
                        .text_color(theme::text_dim())
                        .cursor_pointer()
                        .truncate()
                        .child(format!("Replying to @{}: {}", reply.name, reply.text))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(index) =
                                this.messages.iter().position(|message| message.id == id)
                            {
                                this.paused = true;
                                this.list.scroll_to_reveal_item(index);
                                cx.notify();
                            }
                        })),
                )
            })
            .child(flow)
            .when(
                !message.deleted && !message.id.is_empty() && message.system.is_none(),
                |v| {
                    v.child(
                        ui::icon_button("reply", Icon::Reply, "Reply to message", false)
                            .absolute()
                            .right_1()
                            .top_1()
                            .w(px(25.))
                            .h(px(25.))
                            .bg(theme::button())
                            .border_color(theme::button_border())
                            .invisible()
                            .group_hover("chat-message", |s| s.visible())
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.start_reply(&reply_message, window, cx)
                            })),
                    )
                },
            )
            .on_mouse_down(
                gpui::MouseButton::Right,
                cx.listener(move |this, event: &gpui::MouseDownEvent, _, cx| {
                    let origin = this.list.viewport_bounds().origin;
                    this.menu = Some((
                        menu_message.clone(),
                        gpui::point(
                            (event.position.x - origin.x).max(px(0.)),
                            (event.position.y - origin.y + px(if this.overlay { 0. } else { 54. }))
                                .max(px(0.)),
                        ),
                    ));
                    cx.notify();
                    cx.stop_propagation();
                }),
            )
            .into_any_element()
    }
    fn start_reply(&mut self, message: &Message, window: &mut Window, cx: &mut Context<Self>) {
        if message.deleted || !model::asset_id(&message.id) {
            return;
        }
        self.replying = Some(model::Reply {
            id: message.id.clone(),
            name: message.name.clone(),
            text: message.text.clone(),
        });
        self.menu = None;
        self.input.update(cx, |input, cx| {
            window.focus(&gpui::Focusable::focus_handle(input, cx))
        });
        cx.notify();
    }
    fn context_menu(
        &mut self,
        message: Message,
        position: gpui::Point<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let viewport = self.list.viewport_bounds().size;
        let left = position.x.min(viewport.width - px(202.)).max(px(8.));
        let top = position
            .y
            .min(viewport.height + px(if self.overlay { -20. } else { 30. }))
            .max(px(8.));
        let copy = format!("{}: {}", message.name, message.text);
        let login = message.login.clone();
        let reply = message.clone();
        div()
            .id("message-menu")
            .absolute()
            .left(left)
            .top(top)
            .w(px(194.))
            .p_1()
            .occlude()
            .rounded(px(9.))
            .border_1()
            .border_color(theme::button_border())
            .bg(theme::popup())
            .shadow_xl()
            .flex()
            .flex_col()
            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                this.menu = None;
                cx.notify();
            }))
            .child(
                ui::button(
                    "copy-message",
                    "Copy message",
                    Some(Icon::Copy),
                    ButtonStyle::Ghost,
                )
                .w_full()
                .justify_start()
                .on_click(cx.listener(move |this, _, _, cx| {
                    cx.write_to_clipboard(gpui::ClipboardItem::new_string(copy.clone()));
                    this.menu = None;
                    cx.notify();
                })),
            )
            .when(!message.deleted && message.system.is_none(), |v| {
                v.child(
                    ui::button(
                        "reply-message",
                        "Reply",
                        Some(Icon::Reply),
                        ButtonStyle::Ghost,
                    )
                    .w_full()
                    .justify_start()
                    .on_click(
                        cx.listener(move |this, _, window, cx| {
                            this.start_reply(&reply, window, cx)
                        }),
                    ),
                )
            })
            .child(
                ui::button(
                    "open-profile",
                    "Open profile",
                    Some(Icon::External),
                    ButtonStyle::Ghost,
                )
                .w_full()
                .justify_start()
                .on_click(cx.listener(move |this, _, _, cx| {
                    if crate::format::is_login(&login) {
                        cx.open_url(&format!("https://www.twitch.tv/{login}"));
                    }
                    this.menu = None;
                    cx.notify();
                })),
            )
            .into_any_element()
    }
    fn toggle_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.picker = !self.picker;
        let input = if self.picker {
            self.picker_input.clone()
        } else {
            self.input.clone()
        };
        input.update(cx, |input, cx| {
            window.focus(&gpui::Focusable::focus_handle(input, cx))
        });
        cx.notify();
    }
    fn picker(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let query = self.picker_input.read(cx).content.to_ascii_lowercase();
        let entries = if let Some((cached_query, provider, entries)) = &self.picker_cache
            && cached_query == &query
            && *provider == self.picker_provider
        {
            entries.clone()
        } else {
            let mut entries: Vec<_> = self
                .assets
                .emotes
                .iter()
                .filter(|(_, url)| match self.picker_provider {
                    "Twitch" => url.contains("static-cdn.jtvnw.net/"),
                    "7TV" => url.contains("cdn.7tv.app/"),
                    "BTTV" => url.contains("cdn.betterttv.net/"),
                    "FFZ" => url.contains("cdn.frankerfacez.com/"),
                    _ => true,
                })
                .filter(|(name, _)| name.to_ascii_lowercase().contains(&query))
                .map(|(name, url)| (name.clone(), url.clone()))
                .collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            let entries = Arc::new(entries);
            self.picker_cache = Some((query.clone(), self.picker_provider, entries.clone()));
            entries
        };
        let count = entries.len();
        let columns = ((f32::from(self.list.viewport_bounds().size.width) - 40.) / 42.)
            .floor()
            .clamp(1., 12.) as usize;
        let grid = gpui::uniform_list(
            SharedString::from(format!("emote-grid-{}-{}", self.picker_provider, query)),
            count.div_ceil(columns),
            cx.processor(move |this, range: std::ops::Range<usize>, _, cx| {
                range
                    .map(|row| {
                        let mut line = div()
                            .id(row)
                            .h(px(44.))
                            .px_2()
                            .flex()
                            .items_center()
                            .gap_1();
                        for index in row * columns..((row + 1) * columns).min(entries.len()) {
                            let (name, url) = &entries[index];
                            let image = this.image(url, false, cx);
                            let label = name.clone();
                            let insert = name.clone();
                            line = line.child(
                                div()
                                    .id(index)
                                    .size(px(38.))
                                    .p(px(3.))
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .hover(|s| s.bg(theme::surface_hover()))
                                    .when_some(image, |v, image| {
                                        v.child(
                                            img(ImageSource::Render(image))
                                                .size_full()
                                                .object_fit(ObjectFit::Contain),
                                        )
                                    })
                                    .tooltip(move |_, cx| {
                                        cx.new(|_| ui::Tooltip(label.clone().into())).into()
                                    })
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.input.update(cx, |input, cx| {
                                            input.append(&format!("{insert} "), cx);
                                            window.focus(&gpui::Focusable::focus_handle(input, cx));
                                        });
                                        this.picker = false;
                                        cx.notify();
                                    })),
                            );
                        }
                        line
                    })
                    .collect::<Vec<_>>()
            }),
        )
        .flex_1()
        .min_h_0();
        div()
            .absolute()
            .occlude()
            .bottom(px(if self.replying.is_some() { 158. } else { 100. }))
            .left_2()
            .right_2()
            .h(px(
                (f32::from(self.list.viewport_bounds().bottom()) - 38.).clamp(160., 420.)
            ))
            .flex()
            .flex_col()
            .bg(theme::popup())
            .border_1()
            .border_color(rgb(0x414149))
            .rounded(px(12.))
            .shadow_xl()
            .overflow_hidden()
            .child(
                div()
                    .h(px(42.))
                    .flex_none()
                    .px_3()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_size(px(13.))
                            .child("Emotes"),
                    )
                    .child(
                        ui::icon_button("close-picker", Icon::Close, "Close emote picker", false)
                            .on_click(
                                cx.listener(|this, _, window, cx| this.toggle_picker(window, cx)),
                            ),
                    ),
            )
            .child(
                div().flex_none().px_2().pb_2().flex().gap_1().children(
                    [
                        ("all-emotes", "All"),
                        ("twitch-emotes", "Twitch"),
                        ("seven-emotes", "7TV"),
                        ("bttv-emotes", "BTTV"),
                        ("ffz-emotes", "FFZ"),
                    ]
                    .into_iter()
                    .map(|(id, provider)| {
                        ui::button(
                            id,
                            provider,
                            None,
                            if self.picker_provider == provider {
                                ButtonStyle::Selected
                            } else {
                                ButtonStyle::Ghost
                            },
                        )
                        .h(px(27.))
                        .px_2()
                        .text_size(px(11.))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.picker_provider = provider;
                            cx.notify();
                        }))
                    }),
                ),
            )
            .child(grid)
            .when(count == 0, |v| {
                v.child(
                    div()
                        .flex_1()
                        .p_4()
                        .text_size(px(12.))
                        .text_color(theme::text_dim())
                        .child("No matching emotes"),
                )
            })
            .child(
                div()
                    .p_2()
                    .border_t_1()
                    .border_color(theme::border())
                    .child(self.picker_input.clone()),
            )
            .child(
                div()
                    .px_3()
                    .pb_2()
                    .text_size(px(10.))
                    .text_color(theme::text_dim())
                    .child(format!("{count} emotes · Click to insert")),
            )
            .into_any_element()
    }
}
impl Render for Chat {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let view = cx.entity().downgrade();
        let list = list(self.list.clone(), move |index, _, cx| {
            view.update(cx, |this, cx| this.row(index, cx))
                .unwrap_or_else(|_| div().into_any_element())
        })
        .flex_1()
        .min_h_0();
        let picker = self.picker.then(|| self.picker(cx));
        let menu = self
            .menu
            .clone()
            .map(|(message, position)| self.context_menu(message, position, cx));
        let show_composer = !self.overlay
            || self.hovered
            || self.picker
            || self.replying.is_some()
            || self.is_editing(window, cx);
        let can_send = self.session.is_some()
            && !self.sending
            && !self.input.read(cx).content.trim().is_empty();
        div()
            .id("stream-chat")
            .relative()
            .occlude()
            .w_full()
            .h_full()
            .flex()
            .flex_col()
            .bg(if self.overlay {
                theme::overlay(self.preferences.chat_overlay_opacity)
            } else {
                theme::surface()
            })
            .when(!self.overlay && !self.preferences.chat_on_left, |v| v.border_l_1())
            .when(!self.overlay && self.preferences.chat_on_left, |v| v.border_r_1())
            .when(self.overlay, |v| v.rounded(px(11.)))
            .border_color(theme::border())
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                this.hovered = *hovered;
                cx.notify();
            }))
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape"
                    && (this.picker || this.menu.is_some() || this.replying.is_some())
                {
                    if this.picker {
                        this.toggle_picker(window, cx);
                    } else if this.menu.is_some() {
                        this.menu = None;
                    } else {
                        this.replying = None;
                    }
                    cx.notify();
                    cx.stop_propagation();
                }
            }))
            .when(!self.overlay, |v| {
                v.child(
                    div()
                        .h(px(54.))
                        .flex_none()
                        .px_2()
                        .flex()
                        .items_center()
                        .justify_between()
                        .border_b_1()
                        .border_color(theme::border())
                        .bg(theme::chat_header())
                        .child(
                            ui::icon_button(
                                "collapse-chat",
                                Icon::ChatClose,
                                "Hide chat · C",
                                false,
                            )
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(PlayerAction::Chat))),
                        )
                        .child(
                            div()
                                .flex_1()
                                .flex()
                                .justify_center()
                                .font_weight(FontWeight::BOLD)
                                .text_size(px(14.))
                                .child("Stream Chat"),
                        )
                        .child(
                            div()
                                .id("chat-status")
                                .flex_none()
                                .w(px(20.))
                                .flex()
                                .justify_center()
                                .child(div().size(px(6.)).rounded_full().bg(
                                    if self.state == "Connected" {
                                        rgb(0x22c55e)
                                    } else {
                                        theme::text_dim()
                                    },
                                ))
                                .tooltip({
                                    let state = self.state;
                                    move |_, cx| cx.new(|_| ui::Tooltip(state.into())).into()
                                }),
                        )
                        .child(
                            ui::icon_button(
                                "chat-overlay",
                                Icon::Overlay,
                                "Overlay chat · O",
                                false,
                            )
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(PlayerAction::Overlay))),
                        ),
                )
            })
            .child(div().flex_1().min_h_0().flex().flex_col().child(list))
            .when(self.paused, |v| {
                v.child(
                    ui::button(
                        "jump-live",
                        format!("Jump to live · {} new", self.unseen),
                        Some(Icon::Down),
                        ButtonStyle::Selected,
                    )
                    .mx_3()
                    .my_1()
                    .rounded_full()
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.paused = false;
                        this.unseen = 0;
                        this.list.scroll_to(ListOffset {
                            item_ix: this.messages.len(),
                            offset_in_item: px(0.),
                        });
                        cx.notify();
                    })),
                )
            })
            .when(show_composer, |v| {
                v.child(
                    div()
                        .flex_none()
                        .p(px(10.))
                        .flex()
                        .flex_col()
                        .gap_2()
                        .bg(if self.overlay {
                            rgba(0x0e0e10ec)
                        } else {
                            theme::surface()
                        })
                        .when_some(self.notice.clone(), |v, n| {
                            v.child(div().text_xs().text_color(rgb(0xf8a5ad)).child(n))
                        })
                        .when_some(self.replying.as_ref(), |v, reply| {
                            v.child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap_1()
                                    .pl_2()
                                    .py_1()
                                    .border_l_2()
                                    .border_color(theme::violet())
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .justify_between()
                                            .gap_2()
                                            .text_size(px(11.))
                                            .text_color(theme::accent_text())
                                            .child(
                                                div()
                                                    .truncate()
                                                    .child(format!("Replying to @{}", reply.name)),
                                            )
                                            .child(
                                                ui::icon_button(
                                                    "cancel-reply",
                                                    Icon::Close,
                                                    "Cancel reply · Escape",
                                                    false,
                                                )
                                                .w(px(20.))
                                                .h(px(20.))
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.replying = None;
                                                    cx.notify();
                                                })),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .truncate()
                                            .text_size(px(11.))
                                            .text_color(theme::text_dim())
                                            .child(reply.text.clone()),
                                    ),
                            )
                        })
                        .child(
                            div().relative().child(self.input.clone()).child(
                                ui::icon_button(
                                    "emotes",
                                    Icon::Emotes,
                                    "Choose an emote",
                                    self.picker,
                                )
                                .absolute()
                                .right(px(5.))
                                .top(px(5.))
                                .w(px(32.))
                                .h(px(32.))
                                .on_click(
                                    cx.listener(|this, _, window, cx| {
                                        this.toggle_picker(window, cx)
                                    }),
                                ),
                            ),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .justify_between()
                                .gap_2()
                                .child(
                                    ui::icon_button(
                                        "chat-settings",
                                        Icon::Settings,
                                        "Chat settings",
                                        false,
                                    )
                                    .w(px(26.))
                                    .h(px(26.))
                                    .on_click(
                                        cx.listener(|_, _, _, cx| cx.emit(PlayerAction::Settings)),
                                    ),
                                )
                                .child(
                                    div()
                                        .min_w_0()
                                        .flex_1()
                                        .truncate()
                                        .text_size(px(10.))
                                        .text_color(theme::text_dim())
                                        .child(
                                            self.session
                                                .as_ref()
                                                .map(|s| {
                                                    format!("Chatting as {}", s.identity.login)
                                                })
                                                .unwrap_or_else(|| {
                                                    "Sign in with Twitch to chat".into()
                                                }),
                                        ),
                                )
                                .child(
                                    ui::button(
                                        "send",
                                        if self.sending { "Sending…" } else { "Chat" },
                                        None,
                                        if can_send {
                                            ButtonStyle::Primary
                                        } else {
                                            ButtonStyle::Disabled
                                        },
                                    )
                                    .h(px(29.))
                                    .px_2p5()
                                    .text_size(px(11.))
                                    .rounded(px(6.))
                                    .when(!can_send, |v| v.opacity(0.72).cursor_default())
                                    .on_click(cx.listener(
                                        move |this, _, _, cx| {
                                            if can_send {
                                                this.send(cx)
                                            }
                                        },
                                    )),
                                ),
                        ),
                )
            })
            .when_some(picker, |v, picker| v.child(picker))
            .when_some(menu, |v, menu| v.child(menu))
    }
}
