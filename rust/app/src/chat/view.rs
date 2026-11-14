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
const MAX_IMAGES: usize = 400;
const MAX_IMAGE_BYTES: usize = 96 * 1024 * 1024;
/// What a section shows on the picker's side rail (Electron's `vw-emote-rail`).
#[derive(Clone)]
enum RailMark {
    Avatar(String),
    Glyph(&'static str),
    Letter(String),
    Global,
    Effects,
    Favorites,
}

struct LinkHover {
    url: String,
    at: gpui::Point<gpui::Pixels>,
    preview: Option<super::preview::Preview>,
    _task: Task<()>,
}

#[derive(Clone)]
struct Pinned {
    message: Message,
    by: Option<String>,
    /// When the pin ends, in Unix seconds.
    ends: Option<u64>,
}

/// A Helix `chat/pins` entry as a message: its fragments give the emotes.
fn twitch_pin(pin: &serde_json::Value) -> Option<Pinned> {
    let id = pin["message_id"].as_str().filter(|id| model::asset_id(id))?.to_owned();
    let clean = |value: &serde_json::Value, limit: usize| -> String {
        value.as_str().unwrap_or_default().chars().filter(|c| !c.is_control()).take(limit).collect()
    };
    let mut text = String::new();
    let mut emotes = Vec::new();
    for fragment in pin["message"]["fragments"].as_array().into_iter().flatten() {
        let part = clean(&fragment["text"], 500);
        let start = text.len();
        text.push_str(&part);
        if fragment["type"] == "emote"
            && let Some(emote) = fragment["emote"]["id"].as_str().filter(|id| model::asset_id(id))
        {
            emotes.push(model::EmoteRange { start, end: text.len(), id: emote.to_owned() });
        }
    }
    if text.is_empty() {
        text = clean(&pin["message"]["text"], 500);
    }
    let login = clean(&pin["sender_user_login"], 25).to_ascii_lowercase();
    let name = Some(clean(&pin["sender_user_name"], 40)).filter(|name| !name.is_empty()).unwrap_or_else(|| login.clone());
    let ends = pin["ends_at"].as_str().and_then(crate::format::unix_from_rfc3339);
    Some(Pinned {
        message: Message {
            first_message: false,
            sent_at: None,
            reply: None,
            system: None,
            id,
            login,
            user_id: model::digits(pin["sender_user_id"].as_str()),
            name,
            color: 0xf1e8ff,
            text,
            emotes,
            badges: Vec::new(),
            action: false,
            deleted: false,
        },
        by: Some(clean(&pin["pinned_by_user_name"], 40)).filter(|name| !name.is_empty()),
        ends,
    })
}

/// A titled group of emotes in the picker (Electron's picker sections). An
/// emoji entry's "url" is `emoji:` followed by its name.
struct PickerSection {
    label: String,
    avatar: Option<String>,
    mark: RailMark,
    /// Effect emotes change a neighbour; picking one keeps the picker open.
    effects: bool,
    emotes: Vec<(String, String)>,
}

/// Electron's emoji groups (emojibase), in its order.
const EMOJI_GROUPS: [(u8, &str, &str); 9] = [
    (0, "Smileys & emotion", "😀"),
    (1, "People & body", "👋"),
    (3, "Animals & nature", "🐱"),
    (4, "Food & drink", "🍎"),
    (5, "Travel & places", "🏠"),
    (6, "Activities", "⚽"),
    (7, "Objects", "📝"),
    (8, "Symbols", "⛔"),
    (9, "Flags", "🏁"),
];

/// Unicode emoji Windows 10's emoji font can draw (up to Emoji 12.1), from
/// emojibase's data (MIT), as Electron's picker used: group, emoji, name,
/// shortcodes.
fn emoji() -> &'static [(u8, &'static str, &'static str, &'static str)] {
    static EMOJI: std::sync::OnceLock<Vec<(u8, &'static str, &'static str, &'static str)>> =
        std::sync::OnceLock::new();
    EMOJI.get_or_init(|| {
        include_str!("../../assets/emoji.tsv")
            .lines()
            .filter_map(|line| {
                let mut fields = line.split('\t');
                Some((fields.next()?.parse().ok()?, fields.next()?, fields.next()?, fields.next().unwrap_or("")))
            })
            .collect()
    })
}
type PickerCache = (String, &'static str, Arc<Vec<PickerSection>>);

/// One uniform-height row of the picker: a section title or a line of emotes.
enum PickerRow {
    Header(usize),
    Emotes(usize, std::ops::Range<usize>),
}
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
    /// When each cached image was last drawn: eviction takes the least
    /// recently used, so badges and emotes on screen are never dropped and
    /// fetched again (which looked like chat refreshing them).
    last_used: HashMap<String, u64>,
    use_tick: u64,
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
    picker_scroll: gpui::UniformListScrollHandle,
    notice: Option<SharedString>,
    last_send: Option<Instant>,
    sending: bool,
    replying: Option<model::Reply>,
    menu: Option<(Message, gpui::Point<gpui::Pixels>)>,
    /// This chat's channel login, for the user card's lookups.
    channel: String,
    /// A Kick channel's chat: read-only, Kick badges, no Twitch user cards.
    kick: bool,
    /// Electron's chat user card, open for one chatter.
    card: Option<Card>,
    _card: Option<Task<()>>,
    _poll: Option<Task<()>>,
    _metadata: Option<Task<()>>,
    _send: Option<Task<()>>,
    _history: Option<Task<()>>,
    /// The channel's pinned message, and the pin the viewer hid.
    pinned: Option<Pinned>,
    pinned_hidden: Option<String>,
    _pins: Option<Task<()>>,
    /// The chat link under the pointer and its preview, once found.
    link_hover: Option<LinkHover>,
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
    fn blocked(&self, login: &str) -> bool {
        self.preferences
            .blocked_chat_users
            .iter()
            .any(|blocked| blocked.eq_ignore_ascii_case(login))
    }

    /// Removes messages from chatters just blocked.
    fn drop_blocked(&mut self) {
        let before = self.messages.len();
        let blocked = self.preferences.blocked_chat_users.clone();
        self.messages
            .retain(|message| !blocked.iter().any(|login| login.eq_ignore_ascii_case(&message.login)));
        if self.messages.len() != before {
            self.ids = self
                .messages
                .iter()
                .filter(|message| !message.id.is_empty())
                .map(|message| message.id.clone())
                .collect();
            self.list.reset(self.messages.len());
        }
    }

    fn on_link_hover(&self, cx: &Context<Self>) -> super::flow::OnLinkHover {
        let view = cx.entity().downgrade();
        std::rc::Rc::new(move |link, window, cx| {
            let modifiers = window.modifiers();
            let _ = view.update(cx, |chat, cx| chat.hover_link(link.map(|(url, at)| (url.to_owned(), at)), modifiers, cx));
        })
    }

    /// Starts (or drops) the preview for the link under the pointer, after a
    /// short pause so passing over links fetches nothing.
    fn hover_link(&mut self, link: Option<(String, gpui::Point<gpui::Pixels>)>, modifiers: gpui::Modifiers, cx: &mut Context<Self>) {
        let Some((url, at)) = link else {
            if self.link_hover.take().is_some() {
                cx.notify();
            }
            return;
        };
        if self.link_hover.as_ref().is_some_and(|hover| hover.url == url) {
            return;
        }
        let prefs = crate::preferences::get(cx);
        let generic = prefs.generic_link_previews
            && match prefs.generic_link_preview_activation.as_str() {
                "hover" => true,
                "alt" => modifiers.alt,
                _ => modifiers.control,
            };
        let session = self.session.clone();
        let wanted = url.clone();
        let task = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(300)).await;
            let found = cx
                .background_executor()
                .spawn(async move { super::preview::resolve(&wanted, session.as_ref(), generic) })
                .await;
            let _ = this.update(cx, |this, cx| {
                if let Some(hover) = &mut this.link_hover
                    && hover.preview.is_none()
                {
                    hover.preview = found;
                    cx.notify();
                }
            });
        });
        self.link_hover = Some(LinkHover { url, at, preview: None, _task: task });
        cx.notify();
    }

    /// Electron's link preview tooltip: picture, title and details.
    fn link_preview(&self) -> Option<AnyElement> {
        let hover = self.link_hover.as_ref()?;
        let preview = hover.preview.clone()?;
        let panel = div()
            .w(px(320.))
            .flex()
            .flex_col()
            .rounded(px(10.))
            .overflow_hidden()
            .border_1()
            .border_color(theme::button_border())
            .bg(theme::popup())
            .shadow_xl()
            .when_some(preview.image.clone(), |panel, image| {
                panel.child(
                    div()
                        .w_full()
                        .h(px(170.))
                        .bg(rgb(0x0e0e10))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(img(ImageSource::Render(image)).max_w_full().max_h_full().object_fit(ObjectFit::Contain)),
                )
            })
            .child(
                div()
                    .p(px(10.))
                    .flex()
                    .flex_col()
                    .gap(px(3.))
                    .child(
                        div()
                            .text_size(px(10.))
                            .font_weight(FontWeight::BOLD)
                            .text_color(theme::violet_hover())
                            .child(preview.kind.to_uppercase()),
                    )
                    .child(div().text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).child(preview.title.clone()))
                    .when_some(preview.detail.clone(), |v, detail| {
                        v.child(div().text_size(px(11.)).text_color(theme::text_dim()).child(detail))
                    }),
            );
        Some(
            gpui::deferred(
                gpui::anchored()
                    .position(hover.at + gpui::point(px(0.), px(18.)))
                    .anchor(if self.preferences.chat_on_left { gpui::Corner::TopLeft } else { gpui::Corner::TopRight })
                    .snap_to_window_with_margin(px(8.))
                    .child(panel),
            )
            .with_priority(4)
            .into_any_element(),
        )
    }

    fn on_user(&self, cx: &Context<Self>) -> super::flow::OnUser {
        let view = cx.entity().downgrade();
        std::rc::Rc::new(move |login, at, _, cx| {
            let _ = view.update(cx, |chat, cx| chat.open_card(login, at, cx));
        })
    }

    /// Debug aid: shows the preview for `url` as if it were hovered.
    pub fn probe_preview(&mut self, url: &str, cx: &mut Context<Self>) {
        self.hover_link(Some((url.to_owned(), gpui::point(px(1880.), px(300.)))), gpui::Modifiers::default(), cx);
    }

    pub fn probe_card(&mut self, cx: &mut Context<Self>) {
        if self.card.is_none()
            && let Some(login) = self.messages.back().map(|message| message.login.clone())
        {
            self.open_card(&login, gpui::point(px(1180.), px(260.)), cx);
        }
    }

    /// A Twitch badge by its `set/version` key; a Kick badge is its own
    /// image address.
    fn badge_url(&self, badge: &str) -> Option<String> {
        self.assets
            .badges
            .get(badge)
            .cloned()
            .or_else(|| (self.kick && assets::image_url(badge)).then(|| badge.to_owned()))
    }

    /// A Kick badge's tooltip, from its glyph name or image address.
    fn badge_title(badge: &str) -> String {
        let name = if let Some(kind) = badge.strip_prefix("kick-badge:") {
            kind
        } else if badge.contains("/channel_subscriber_badges/") || badge.starts_with("https://files.kick.com/") {
            "subscriber"
        } else {
            let file = badge.rsplit('/').next().unwrap_or(badge);
            let file = file.split(['.', '?']).next().unwrap_or(file);
            // Kick's own badge files end in `_<uuid>`.
            file.split_once('_').filter(|(_, rest)| rest.len() >= 32).map_or(file, |(name, _)| name)
        };
        let words = name.replace('_', " ");
        let mut chars = words.chars();
        chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
    }

    pub fn has_card(&self) -> bool {
        self.card.is_some()
    }

    pub fn close_card(&mut self, cx: &mut Context<Self>) {
        self.card = None;
        self._card = None;
        cx.notify();
    }

    fn open_card(&mut self, login: &str, at: gpui::Point<gpui::Pixels>, cx: &mut Context<Self>) {
        if self.kick || !crate::format::is_login(login) {
            return;
        }
        let login = login.to_ascii_lowercase();
        let latest = self.messages.iter().rev().find(|message| message.login == login);
        self.card = Some(Card {
            login: login.clone(),
            name: latest.map_or_else(|| login.clone(), |message| message.name.clone()),
            color: latest.map_or(0xa78bfa, |message| message.color),
            badges: latest.map(|message| message.badges.clone()).unwrap_or_default(),
            at,
            profile: None,
        });
        self.menu = None;
        let agent = self.agent.clone();
        let session = self.session.clone();
        let channel = self.channel.clone();
        self._card = Some(cx.spawn(async move |this, cx| {
            let wanted = login.clone();
            let result = cx
                .background_executor()
                .spawn(async move { super::profile::load(&agent, session.as_ref(), &channel, &login) })
                .await
                .map_err(|error| SharedString::from(error.to_string()));
            let _ = this.update(cx, |this, cx| {
                if let Some(card) = &mut this.card
                    && card.login == wanted
                {
                    card.profile = Some(result);
                    cx.notify();
                }
            });
        }));
        cx.notify();
    }

    fn toggle_block(&mut self, login: &str, cx: &mut Context<Self>) {
        let login = login.to_ascii_lowercase();
        crate::preferences::update(cx, |preferences| {
            if let Some(at) = preferences.blocked_chat_users.iter().position(|blocked| *blocked == login) {
                preferences.blocked_chat_users.remove(at);
            } else {
                preferences.blocked_chat_users.push(login);
            }
        });
        self.set_preferences(crate::preferences::get(cx), cx);
    }

    /// Electron's `ChatUserCard`: profile, badges, account age, follow and
    /// subscription details, a local Block, and their messages here.
    fn user_card(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let card = self.card.clone()?;
        let blocked = self.blocked(&card.login);
        let mut messages: Vec<Message> = self
            .messages
            .iter()
            .rev()
            .filter(|message| message.login == card.login)
            .take(40)
            .cloned()
            .collect();
        messages.reverse();
        let count = messages.len();
        let rows: Vec<AnyElement> = messages
            .into_iter()
            .map(|message| self.card_message(message, cx))
            .collect();
        let profile = card.profile.as_ref().and_then(|profile| profile.as_ref().ok());
        let error = card.profile.as_ref().and_then(|profile| profile.as_ref().err()).cloned();
        let avatar = profile
            .and_then(|profile| profile.image.clone())
            .map(|url| url.replace("300x300", "70x70"))
            .and_then(|url| self.image(&url, false, cx));
        let badges: Vec<AnyElement> = card
            .badges
            .iter()
            .filter_map(|badge| {
                let url = self.badge_url(badge)?;
                let image = self.image(&url, false, cx)?;
                Some(img(ImageSource::Render(image)).size(px(20.)).into_any_element())
            })
            .collect();
        let loading = if error.is_some() { "Unavailable" } else { "Loading…" };
        let row = |label: &'static str, value: String| {
            div()
                .flex()
                .justify_between()
                .gap_3()
                .text_size(px(12.))
                .child(div().text_color(theme::text_dim()).child(label))
                .child(div().text_color(theme::text()).child(value))
        };
        let created = profile.map_or(loading.to_owned(), |profile| {
            profile.created.clone().unwrap_or_else(|| "Unknown".into())
        });
        let following = profile.map_or(loading.to_owned(), |profile| {
            profile.following.clone().unwrap_or_else(|| "Unavailable".into())
        });
        let subscription = profile.map_or(loading.to_owned(), |profile| {
            profile.subscription.clone().unwrap_or_else(|| "Unavailable".into())
        });
        let description = profile.map(|profile| profile.description.clone()).filter(|text| !text.is_empty());
        let display = profile
            .map(|profile| profile.display_name.clone())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| card.name.clone());
        let initial: String = display.chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_default();
        let login = card.login.clone();
        let block_login = card.login.clone();
        let panel = div()
            .id("user-card")
            .occlude()
            .w(px(320.))
            .max_h(px(560.))
            .p(px(14.))
            .flex()
            .flex_col()
            .gap(px(10.))
            .rounded(px(12.))
            .border_1()
            .border_color(theme::button_border())
            .bg(theme::popup())
            .shadow_xl()
            .text_color(theme::text())
            .on_mouse_down_out(cx.listener(|this, _, _, cx| this.close_card(cx)))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .child(match avatar {
                        Some(image) => img(ImageSource::Render(image))
                            .size(px(44.))
                            .flex_none()
                            .rounded_full()
                            .into_any_element(),
                        None => div()
                            .size(px(44.))
                            .flex_none()
                            .rounded_full()
                            .bg(theme::selected())
                            .flex()
                            .items_center()
                            .justify_center()
                            .font_weight(FontWeight::BOLD)
                            .child(initial)
                            .into_any_element(),
                    })
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .truncate()
                                    .text_size(px(15.))
                                    .font_weight(FontWeight::BOLD)
                                    .text_color(rgb(card.color))
                                    .child(display),
                            )
                            .child(
                                div()
                                    .text_size(px(11.))
                                    .text_color(theme::text_dim())
                                    .child(format!("@{}", card.login)),
                            ),
                    )
                    .child(
                        ui::icon_button("card-profile", Icon::External, "Open Twitch profile", false)
                            .on_click(move |_, _, cx| cx.open_url(&format!("https://www.twitch.tv/{login}"))),
                    )
                    .child(
                        ui::icon_button("card-close", Icon::Close, "Close", false)
                            .on_click(cx.listener(|this, _, _, cx| this.close_card(cx))),
                    ),
            )
            .when_some(description, |v, text| {
                v.child(div().text_size(px(12.)).text_color(theme::text_secondary()).child(text))
            })
            .when(!badges.is_empty(), |v| v.child(div().flex().flex_wrap().gap(px(4.)).children(badges)))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .p(px(10.))
                    .rounded(px(8.))
                    .bg(theme::surface())
                    .child(row("Account created", created))
                    .child(row("Following since", following))
                    .child(row("Subscription", subscription)),
            )
            .when_some(error, |v, error| {
                v.child(div().text_size(px(11.)).text_color(theme::live()).child(error))
            })
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        ui::button(
                            "card-block",
                            if blocked { "Unblock" } else { "Block" },
                            None,
                            ButtonStyle::Secondary,
                        )
                        .px_3()
                        .h(px(28.))
                        .on_click(cx.listener(move |this, _, _, cx| this.toggle_block(&block_login, cx))),
                    )
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(theme::text_dim())
                            .child("Hides their messages in VioletWire only."),
                    ),
            )
            .child(
                div()
                    .flex()
                    .justify_between()
                    .text_size(px(11.))
                    .font_weight(FontWeight::BOLD)
                    .text_color(theme::text_dim())
                    .child("MESSAGES IN CURRENT CHAT")
                    .child(count.to_string()),
            )
            .child(
                div()
                    .id("card-messages")
                    .max_h(px(220.))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .when(rows.is_empty(), |v| {
                        v.child(div().text_size(px(12.)).text_color(theme::text_dim()).child("No retained messages."))
                    })
                    .children(rows),
            );
        Some(
            gpui::deferred(
                gpui::anchored()
                    .position(card.at)
                    .anchor(if self.preferences.chat_on_left {
                        gpui::Corner::TopLeft
                    } else {
                        gpui::Corner::TopRight
                    })
                    .snap_to_window_with_margin(px(8.))
                    .child(panel),
            )
            .with_priority(3)
            .into_any_element(),
        )
    }

    fn card_message(&mut self, message: Message, cx: &mut Context<Self>) -> AnyElement {
        let row_id = format!("card-{}", message.id);
        let mut flow = super::flow::MessageFlow::new(self.preferences.chat_font_size.saturating_sub(1));
        if let Some(time) = message.sent_at.and_then(model::local_time) {
            flow.text(&format!("{time} "), theme::text_dim(), false);
        }
        if message.deleted && self.preferences.chat_deleted_message_style != "dimmed" {
            flow.text("[Message deleted]", theme::text_dim(), false);
        } else {
            for (part_index, part) in model::parts(&message, &self.assets.providers).into_iter().enumerate() {
                match part {
                    Part::Text(text) => flow.text(&text, theme::text_secondary(), false),
                    Part::Mention(text) => flow.text(&text, theme::text(), true),
                    Part::Emote(emote) => self.emote_into(&mut flow, &row_id, part_index, emote, cx),
                }
            }
        }
        div()
            .id(SharedString::from(row_id))
            .child(flow)
            .into_any_element()
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
        let newly_blocked = settings
            .blocked_chat_users
            .iter()
            .any(|login| !self.preferences.blocked_chat_users.contains(login));
        let changed = self.preferences.chat_font_size != settings.chat_font_size
            || self.preferences.chat_emote_size != settings.chat_emote_size
            || self.preferences.chat_timestamps != settings.chat_timestamps
            || self.preferences.chat_overlay_opacity != settings.chat_overlay_opacity
            || self.preferences.chat_deleted_message_style != settings.chat_deleted_message_style
            || self.preferences.chat_on_left != settings.chat_on_left;
        self.preferences = settings;
        if newly_blocked {
            self.drop_blocked();
        }
        if changed || newly_blocked {
            self.invalidate_messages();
            cx.notify();
        }
    }
    pub fn probe_layout(&mut self, picker: bool, extras: bool, cx: &mut Context<Self>) {
        // `VIOLETWIRE_PROBE_PICKER=Emoji` (or a provider) picks the tab shown.
        if let Ok(tab) = std::env::var("VIOLETWIRE_PROBE_PICKER")
            && let Some(tab) = ["Favorites", "7TV", "Twitch", "FFZ", "BTTV", "Emoji"]
                .into_iter()
                .find(|known| *known == tab)
        {
            self.picker_provider = tab;
        }
        if extras
            && self.replying.is_none()
            && let Some(message) = self.messages.back()
        {
            self.replying = Some(model::Reply {
                id: message.id.clone(),
                name: message.name.clone(),
                login: message.login.clone(),
                user_id: message.user_id.clone(),
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
            connection: Connection::new(login, usize::from(crate::preferences::get(cx).chat_history_limit)),
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
            last_used: HashMap::new(),
            use_tick: 0,
            image_queue: VecDeque::new(),
            workers: 0,
            state: "Connecting",
            paused: false,
            unseen: 0,
            list: ListState::new(0, ListAlignment::Bottom, px(150.)),
            input,
            picker_input,
            picker: false,
            picker_provider: "7TV",
            picker_cache: None,
            picker_scroll: gpui::UniformListScrollHandle::new(),
            notice: None,
            last_send: None,
            sending: false,
            replying: None,
            menu: None,
            channel: crate::kick::slug(login).map_or_else(|| login.to_ascii_lowercase(), str::to_owned),
            kick: crate::kick::slug(login).is_some(),
            card: None,
            _card: None,
            _poll: None,
            _metadata: None,
            _send: None,
            _history: None,
            pinned: None,
            pinned_hidden: None,
            _pins: None,
            link_hover: None,
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
        if limit > 0 && !this.kick {
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
                    let blocked = this.preferences.blocked_chat_users.clone();
                    let mut history: Vec<_> = history
                        .into_iter()
                        .filter(|message| {
                            !blocked.iter().any(|login| login.eq_ignore_ascii_case(&message.login))
                        })
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
        // A Twitch room ID, or Kick's `kick:<user id>:<slug>`.
        let valid = match room.strip_prefix("kick:") {
            Some(rest) => rest.split_once(':').is_some_and(|(id, slug)| {
                !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit()) && crate::kick::is_slug(slug)
            }),
            None => !room.is_empty() && room.len() <= 20 && room.bytes().all(|b| b.is_ascii_digit()),
        };
        if room != self.room && valid {
            self.room = room.to_owned();
            self.reload_assets(cx);
            self.watch_pins(cx);
        }
    }

    /// Checks the channel's pinned message every 30 s, as Electron does.
    /// Twitch only shows pins to the channel's moderators through its API, so
    /// for everyone else that check backs off.
    fn watch_pins(&mut self, cx: &mut Context<Self>) {
        let kick = self.kick;
        let slug = self.channel.clone();
        let room = self.room.clone();
        self._pins = Some(cx.spawn(async move |this, cx| {
            loop {
                let session = this.update(cx, |this, _| this.session.clone()).ok().flatten();
                let (slug, room, agent) = (slug.clone(), room.clone(), crate::http::agent());
                let found: Option<Option<Pinned>> = cx
                    .background_executor()
                    .spawn(async move {
                        if kick {
                            return super::kick::pinned(&slug)
                                .ok()
                                .map(|pin| pin.map(|(message, by, ends)| Pinned { message, by, ends }));
                        }
                        let session = session?;
                        let value = assets::helix_json(
                            &agent,
                            "https://api.twitch.tv/helix/chat/pins",
                            &session,
                            &[("broadcaster_id", room.as_str()), ("moderator_id", session.identity.user_id.as_str())],
                        )?;
                        Some(twitch_pin(&value["data"][0]))
                    })
                    .await;
                if std::env::var_os("VIOLETWIRE_PIN_LOG").is_some() {
                    eprintln!("[pin] kick={kick} found={:?}", found.as_ref().map(|pin| pin.as_ref().map(|pin| (pin.message.id.clone(), pin.ends))));
                }
                let wait = if found.is_some() { 30 } else { 300 };
                if this
                    .update(cx, |this, cx| {
                        let now = crate::twitch::auth::now();
                        let pin = found.flatten().filter(|pin| pin.ends.is_none_or(|ends| ends > now));
                        if pin.as_ref().map(|pin| &pin.message.id) != this.pinned.as_ref().map(|pin| &pin.message.id) {
                            this.pinned = pin;
                            cx.notify();
                        }
                    })
                    .is_err()
                {
                    break;
                }
                cx.background_executor().timer(Duration::from_secs(wait)).await;
            }
        }));
    }

    /// Electron's `PinnedChatMessage` banner above the messages.
    fn pinned_banner(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let pin = self.pinned.clone()?;
        if self.pinned_hidden.as_deref() == Some(pin.message.id.as_str()) {
            return None;
        }
        let mut message = pin.message.clone();
        message.sent_at = None;
        let name = message.name.clone();
        let body = self.card_message(message, cx);
        Some(
            div()
                .flex_none()
                .px(px(11.))
                .pt(px(9.))
                .pb(px(10.))
                .border_b_1()
                .border_color(rgb(0x323039))
                .bg(rgb(0x221d29))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap_2()
                        .mb(px(5.))
                        .child(
                            div()
                                .min_w_0()
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .text_size(px(11.))
                                .font_weight(FontWeight::BOLD)
                                .text_color(rgb(0xbf94ff))
                                .child(ui::icon(Icon::Pin, 13.).text_color(rgb(0xbf94ff)))
                                .child(div().truncate().child(match &pin.by {
                                    Some(by) => format!("Pinned by {by}"),
                                    None => "Pinned message".to_owned(),
                                })),
                        )
                        .child(
                            ui::icon_button("hide-pin", Icon::Close, "Hide pinned message", false)
                                .w(px(24.))
                                .h(px(24.))
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.pinned_hidden = this.pinned.as_ref().map(|pin| pin.message.id.clone());
                                    cx.notify();
                                })),
                        ),
                )
                .child(
                    div()
                        .max_h(px(80.))
                        .overflow_hidden()
                        .flex()
                        .gap_1()
                        .child(div().flex_none().font_weight(FontWeight::BOLD).text_color(rgb(0xf1e8ff)).child(format!("{name}:")))
                        .child(div().flex_1().min_w_0().child(body)),
                )
                .into_any_element(),
        )
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
                    if self.blocked(&message.login) {
                        continue;
                    }
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
            // The saved lists first, so emotes show at once, then the network.
            for offline in [true, false] {
            let (room, session) = (room.clone(), session.clone());
            let result = cx
                .background_executor()
                .spawn(async move { assets::load(&room, session.as_ref(), offline) })
                .await;
            if offline && result.emotes.is_empty() && result.badges.is_empty() {
                continue;
            }
            let _ = this.update(cx, |this, cx| {
                // A reload (token renewal, say) where one source failed keeps
                // what that source gave before, rather than blanking it.
                let mut result = result;
                if result.badges.is_empty() {
                    result.badges = std::mem::take(&mut this.assets.badges);
                }
                if result.providers.is_empty() {
                    result.providers = std::mem::take(&mut this.assets.providers);
                }
                if result.emotes.len() < this.assets.emotes.len() / 2 {
                    result.emotes = std::mem::take(&mut this.assets.emotes);
                }
                if result.twitch.is_empty() {
                    result.twitch = std::mem::take(&mut this.assets.twitch);
                    result.owners = std::mem::take(&mut this.assets.owners);
                }
                this.assets = result;
                this.picker_cache = None;
                this.invalidate_messages();
                cx.notify();
            });
            }
        }));
    }
    fn evict_image(&mut self, cx: &mut Context<Self>) {
        let Some(oldest) = self
            .order
            .iter()
            .enumerate()
            .min_by_key(|(_, key)| self.last_used.get(*key).copied().unwrap_or(0))
            .map(|(index, _)| index)
        else {
            return;
        };
        let Some(key) = self.order.remove(oldest) else {
            return;
        };
        self.last_used.remove(&key);
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
    /// One emote, sized and decorated as Electron's `ChatEmote` does: small
    /// third-party emotes keep their size (height scales with the 1x height
    /// over 28 px for BetterTTV, 32 px otherwise), modifiers flip, rotate,
    /// widen or fade it, and zero-width emotes stack on the one before.
    fn emote_into(
        &mut self,
        flow: &mut super::flow::MessageFlow,
        row_id: &str,
        part_index: usize,
        emote: model::EmotePart,
        cx: &mut Context<Self>,
    ) {
        use model::effect;
        let base = self.image(&emote.url, true, cx);
        let full = f32::from(self.preferences.chat_emote_size);
        let (height, mut ratio) = match emote.logical {
            Some((width, height)) => {
                let natural = if emote.provider == assets::Provider::Bttv { 28. } else { 32. };
                (full * (height / natural).min(1.), width / height.max(1.))
            }
            None => (
                full,
                base.as_ref().map_or(1., |image| {
                    let size = image.size(0);
                    size.width.0 as f32 / size.height.0.max(1) as f32
                }),
            ),
        };
        let rotate = if emote.effects & effect::ROTATE_LEFT != 0 {
            -1
        } else if emote.effects & effect::ROTATE_RIGHT != 0 {
            1
        } else {
            0
        };
        if rotate != 0 {
            ratio = 1. / ratio.max(0.01);
        }
        if emote.effects & effect::WIDE != 0 {
            ratio *= 2.;
        }
        let flip_x = emote.effects & effect::FLIP_X != 0;
        let flip_y = emote.effects & effect::FLIP_Y != 0;
        let image = base.and_then(|image| {
            if !flip_x && !flip_y && rotate == 0 {
                return Some(image);
            }
            let key = format!("{}#{}{}{}", emote.url, u8::from(flip_x), u8::from(flip_y), rotate);
            self.use_tick += 1;
            self.last_used.insert(key.clone(), self.use_tick);
            if let Some(Some(done)) = self.images.get(&key) {
                return Some(done.clone());
            }
            let done = crate::images::transformed(&image, flip_x, flip_y, rotate)?;
            self.images.insert(key.clone(), Some(done.clone()));
            self.order.push_back(key);
            Some(done)
        });
        // Freeze each displayed message's geometry, rather than freezing an
        // unknown image's square fallback forever.
        let ratios = self.emote_ratios.entry(row_id.to_owned()).or_default();
        let ratio = if ratios.len() < 32 || ratios.contains_key(&emote.url) {
            *ratios.entry(emote.url.clone()).or_insert(ratio)
        } else {
            1.
        };
        let width = (ratio * height).clamp(8., full * 6.);
        let gap = if emote.effects & effect::ZERO_SPACE != 0 { 0. } else { 1. };
        let cursed = emote.effects & effect::CURSED != 0;
        let tooltip = EmoteTooltip {
            image: image.clone(),
            name: emote.name.clone().into(),
            provider: emote.provider.label(),
            height: (height * 2.2).min(150.),
            ratio,
        };
        let element_id = SharedString::from(format!("emote-{part_index}"));
        flow.image_layer(
            div()
                .id(element_id.clone())
                .w(px(width + gap * 2.))
                .h(px(height))
                .px(px(gap))
                .when_some(image, |v, image| {
                    v.child(
                        // The id keeps GPUI's frame clock, so GIF and WebP
                        // emotes animate.
                        img(ImageSource::Render(image))
                            .id(SharedString::from(format!("{element_id}-image")))
                            .w(px(width))
                            .h(px(height))
                            .object_fit(if emote.effects & effect::WIDE != 0 {
                                ObjectFit::Fill
                            } else {
                                ObjectFit::Contain
                            })
                            .when(cursed, |image| image.grayscale(true).opacity(0.85)),
                    )
                })
                .when(self.images.get(&emote.url).is_some_and(Option::is_none) && self.failed_images.contains_key(&emote.url), |v| {
                    v.text_size(px(10.)).truncate().child(emote.name.clone())
                })
                .tooltip(move |_, cx| cx.new(|_| tooltip.clone()).into())
                .into_any_element(),
            width + gap * 2.,
            height,
            emote.overlay,
        );
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
        self.use_tick += 1;
        self.last_used.insert(key.clone(), self.use_tick);
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
        // Eight at a time: the picker asks for a screenful at once.
        while self.workers < 8 {
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
        if self.kick {
            self.send_kick(cx);
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
    /// Kick's composer text: its emotes go as `[emote:ID:NAME]` codes.
    fn kick_content(&self, text: &str) -> String {
        let ids: HashMap<&str, &str> = self
            .assets
            .twitch
            .iter()
            .filter_map(|emote| Some((emote.name.as_str(), assets::kick_emote_id(&emote.url)?)))
            .collect();
        text.split(' ')
            .map(|word| match ids.get(word) {
                Some(id) => format!("[emote:{id}:{word}]"),
                None => word.to_owned(),
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// Sends as the signed-in Kick account, from Kick's own page (see
    /// `kick_web`), as Electron's `KickService.sendMessage` does.
    fn send_kick(&mut self, cx: &mut Context<Self>) {
        if crate::preferences::get(cx).kick_account.is_none() {
            self.notice = Some("Sign in to Kick in Settings to chat here.".into());
            cx.notify();
            return;
        }
        if self.last_send.is_some_and(|time| time.elapsed() < Duration::from_secs(1)) {
            self.notice = Some("Please wait a moment before sending again.".into());
            cx.notify();
            return;
        }
        let text = self.input.read(cx).content.to_string();
        if text.trim().is_empty() {
            return;
        }
        if text.chars().count() > 500 {
            self.notice = Some("Kick messages can be up to 500 characters.".into());
            cx.notify();
            return;
        }
        let content = self.kick_content(text.trim());
        let reply = self.replying.clone();
        let reply_id = reply.as_ref().map(|reply| reply.id.clone());
        let slug = self.channel.clone();
        self.sending = true;
        self.last_send = Some(Instant::now());
        self.notice = None;
        self._send = Some(cx.spawn(async move |this, cx| {
            let channel = cx.background_executor().spawn(async move { crate::kick::channel(&slug) }).await;
            let result = match channel {
                Err(error) => Err(error),
                Ok(channel) => {
                    let sent_at = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_or(0, |elapsed| elapsed.as_millis());
                    let mut body = serde_json::json!({
                        "content": content,
                        "type": "message",
                        "message_ref": sent_at.to_string(),
                    });
                    if let Some(reply) = &reply {
                        body["type"] = "reply".into();
                        body["metadata"] = serde_json::json!({
                            "original_message": {"id": reply.id, "content": reply.text},
                            "original_sender": {
                                "id": reply.user_id.parse::<u64>().ok(),
                                "username": reply.name,
                            },
                        });
                    }
                    let path = format!("/api/v2/messages/send/{}", channel.chatroom_id);
                    match crate::kick_web::request(cx, "POST", &path, Some(&body)).await {
                        Ok((200..=299, _)) => Ok(()),
                        Ok((401 | 403, _)) => Err(anyhow::anyhow!("Kick refused the message. Sign in to Kick again in Settings.")),
                        Ok((419, _)) => Err(anyhow::anyhow!("Kick rejected the session. Sign in again.")),
                        Ok((status, answer)) => {
                            let detail = [&answer["message"], &answer["error"], &answer["data"]["message"], &answer["status"]["message"]]
                                .into_iter()
                                .find_map(|value| value.as_str().filter(|text| !text.is_empty()))
                                .map(crate::http::short_message);
                            Err(anyhow::anyhow!(detail.unwrap_or_else(|| if status == 429 {
                                "You are sending messages too quickly.".to_owned()
                            } else {
                                "Kick would not accept the message.".to_owned()
                            })))
                        }
                        Err(error) => Err(error),
                    }
                }
            };
            let _ = this.update(cx, |this, cx| {
                this.sending = false;
                match result {
                    Ok(()) => {
                        if this.input.read(cx).content.as_ref() == text
                            && this.replying.as_ref().map(|reply| reply.id.as_str()) == reply_id.as_deref()
                        {
                            this.input.update(cx, |input, cx| input.clear(cx));
                            this.replying = None;
                        }
                    }
                    Err(error) => this.notice = Some(crate::http::short_message(&error.to_string()).into()),
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
        flow.on_link_hover = Some(self.on_link_hover(cx));
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
            if let Some(url) = self.badge_url(badge) {
                let image = self.image(&url, false, cx);
                let label = if self.kick { Self::badge_title(badge) } else { badge.clone() };
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
            flow.user(
                &message.name,
                if message.action { " " } else { ": " },
                rgb(message.color),
                &message.login,
                self.on_user(cx),
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
                    Part::Mention(text) => flow.text(&text, theme::text(), true),
                    Part::Emote(emote) => {
                        self.emote_into(&mut flow, &row_id, part_index, emote, cx);
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
            login: message.login.clone(),
            user_id: message.user_id.clone(),
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
    /// The picker's sections for the current tab, as Electron groups them:
    /// a provider's channel set, its global set and its effects; Twitch
    /// emotes by the channel they belong to; or the starred favorites.
    /// Emotes typed in the composer show as images there, as in Electron,
    /// rather than only once the message is sent.
    fn sync_composer_emotes(&mut self, cx: &mut Context<Self>) {
        let content = self.input.read(cx).content.clone();
        let mut emotes = crate::input::InlineEmotes::new();
        for word in content.split_whitespace().take(100) {
            if emotes.contains_key(word) {
                continue;
            }
            let Some(url) = self.assets.emotes.get(word).cloned() else { continue };
            if let Some(image) = self.image(&url, false, cx) {
                let size = image.size(0);
                let ratio = size.width.0 as f32 / size.height.0.max(1) as f32;
                emotes.insert(word.to_owned(), (image, ratio.clamp(0.25, 4.)));
            }
        }
        self.input.update(cx, |input, cx| input.set_emotes(emotes, cx));
    }

    fn toggle_favorite_emote(&mut self, name: &str, cx: &mut Context<Self>) {
        let name = name.to_owned();
        crate::preferences::update(cx, |preferences| {
            if let Some(at) = preferences.emote_favorites.iter().position(|kept| *kept == name) {
                preferences.emote_favorites.remove(at);
            } else {
                preferences.emote_favorites.push(name);
            }
        });
        self.preferences = crate::preferences::get(cx);
        self.picker_cache = None;
        cx.notify();
    }

    fn picker_sections(&self, query: &str) -> Vec<PickerSection> {
        let matches = |name: &str| query.is_empty() || name.to_ascii_lowercase().contains(query);
        let sorted = |mut emotes: Vec<(String, String)>| {
            emotes.sort_by_key(|(name, _)| name.to_ascii_lowercase());
            emotes
        };
        let mut sections = Vec::new();
        match self.picker_provider {
            "Favorites" => {
                let emotes: Vec<(String, String)> = self
                    .preferences
                    .emote_favorites
                    .iter()
                    .filter(|name| matches(name))
                    .filter_map(|name| Some((name.clone(), self.assets.emotes.get(name)?.clone())))
                    .collect();
                sections.push(PickerSection {
                    label: "Favorites".into(),
                    avatar: None,
                    mark: RailMark::Favorites,
                    effects: false,
                    emotes,
                });
            }
            "Emoji" => {
                for (group, label, glyph) in EMOJI_GROUPS {
                    let emotes: Vec<(String, String)> = emoji()
                        .iter()
                        .filter(|(kind, _, name, codes)| {
                            *kind == group && (query.is_empty() || name.contains(query) || codes.contains(query))
                        })
                        .map(|(_, character, name, _)| ((*character).to_owned(), format!("emoji:{name}")))
                        .collect();
                    sections.push(PickerSection {
                        label: label.into(),
                        avatar: None,
                        mark: RailMark::Glyph(glyph),
                        effects: false,
                        emotes,
                    });
                }
            }
            "Twitch" => {
                let mut groups: HashMap<&str, Vec<(String, String)>> = HashMap::new();
                for emote in &self.assets.twitch {
                    if matches(&emote.name) {
                        groups.entry(emote.owner.as_str()).or_default().push((emote.name.clone(), emote.url.clone()));
                    }
                }
                let mut owners: Vec<&str> = groups.keys().copied().collect();
                // This channel first, other channels by name, Twitch's own last.
                owners.sort_by_key(|owner| {
                    (
                        owner.is_empty(),
                        *owner != self.room,
                        self.assets.owners.get(*owner).map(|(name, _)| name.to_ascii_lowercase()),
                    )
                });
                for owner in owners {
                    let (label, avatar) = if owner.is_empty() {
                        ("Global emotes".to_owned(), None)
                    } else {
                        self.assets
                            .owners
                            .get(owner)
                            .cloned()
                            .unwrap_or_else(|| ("Channel emotes".to_owned(), None))
                    };
                    let emotes = sorted(groups.remove(owner).unwrap_or_default());
                    let mark = match (&avatar, owner.is_empty()) {
                        (_, true) => RailMark::Global,
                        (Some(url), false) => RailMark::Avatar(url.clone()),
                        (None, false) => RailMark::Letter(label.chars().next().map(String::from).unwrap_or_default()),
                    };
                    sections.push(PickerSection { label, avatar, mark, effects: false, emotes });
                }
            }
            provider => {
                let wanted = match provider {
                    "FFZ" => assets::Provider::Ffz,
                    "BTTV" => assets::Provider::Bttv,
                    _ => assets::Provider::SevenTv,
                };
                let (mut channel, mut global, mut effects) = (Vec::new(), Vec::new(), Vec::new());
                for (name, emote) in &self.assets.providers {
                    if emote.provider != wanted || !matches(name) {
                        continue;
                    }
                    let entry = (name.clone(), emote.url.clone());
                    if emote.modifier {
                        effects.push(entry);
                    } else if emote.channel {
                        channel.push(entry);
                    } else {
                        global.push(entry);
                    }
                }
                let channel_avatar = self.assets.owners.get(&self.room).and_then(|(_, image)| image.clone());
                sections.push(PickerSection {
                    label: self.channel.clone(),
                    avatar: channel_avatar.clone(),
                    mark: match channel_avatar {
                        Some(url) => RailMark::Avatar(url),
                        None => RailMark::Letter(self.channel.chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_default()),
                    },
                    effects: false,
                    emotes: sorted(channel),
                });
                sections.push(PickerSection {
                    label: "Global emotes".into(),
                    avatar: None,
                    mark: RailMark::Global,
                    effects: false,
                    emotes: sorted(global),
                });
                sections.push(PickerSection {
                    label: "Effects".into(),
                    avatar: None,
                    mark: RailMark::Effects,
                    effects: true,
                    emotes: sorted(effects),
                });
            }
        }
        sections.retain(|section| !section.emotes.is_empty());
        sections
    }

    fn picker(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let query = self.picker_input.read(cx).content.to_ascii_lowercase();
        let sections = if let Some((cached_query, provider, sections)) = &self.picker_cache
            && cached_query == &query
            && *provider == self.picker_provider
        {
            sections.clone()
        } else {
            let sections = Arc::new(self.picker_sections(&query));
            self.picker_cache = Some((query.clone(), self.picker_provider, sections.clone()));
            sections
        };
        let count: usize = sections.iter().map(|section| section.emotes.len()).sum();
        // The side rail takes 44 px when it shows.
        let rail_width = if query.is_empty() && sections.len() > 1 { 44. } else { 0. };
        let columns = ((f32::from(self.list.viewport_bounds().size.width) - 40. - rail_width) / 42.)
            .floor()
            .clamp(1., 12.) as usize;
        let mut rows = Vec::new();
        for (index, section) in sections.iter().enumerate() {
            rows.push(PickerRow::Header(index));
            let mut start = 0;
            while start < section.emotes.len() {
                let end = (start + columns).min(section.emotes.len());
                rows.push(PickerRow::Emotes(index, start..end));
                start = end;
            }
        }
        // Each section's header row, for the side rail's jumps.
        let section_rows: Vec<usize> = rows
            .iter()
            .enumerate()
            .filter_map(|(row, kind)| matches!(kind, PickerRow::Header(_)).then_some(row))
            .collect();
        let rows = Arc::new(rows);
        let favorites: HashSet<String> = self.preferences.emote_favorites.iter().cloned().collect();
        let rail_sections = sections.clone();
        let grid = gpui::uniform_list(
            SharedString::from(format!("emote-grid-{}-{}", self.picker_provider, query)),
            rows.len(),
            cx.processor(move |this, range: std::ops::Range<usize>, _, cx| {
                range
                    .filter_map(|row| Some((row, rows.get(row)?)))
                    .map(|(row, kind)| match kind {
                        PickerRow::Header(index) => {
                            let section = &sections[*index];
                            let avatar = section
                                .avatar
                                .as_deref()
                                .and_then(|url| this.image(url, false, cx));
                            div()
                                .id(row)
                                .h(px(44.))
                                .px_3()
                                .pt(px(14.))
                                .flex()
                                .items_center()
                                .gap(px(7.))
                                .when_some(avatar, |v, image| {
                                    v.child(img(ImageSource::Render(image)).size(px(18.)).rounded_full())
                                })
                                .child(
                                    div()
                                        .text_size(px(11.))
                                        .font_weight(FontWeight::BOLD)
                                        .text_color(theme::text_dim())
                                        .child(section.label.to_uppercase()),
                                )
                                .child(
                                    div()
                                        .text_size(px(10.))
                                        .text_color(theme::text_dim())
                                        .child(section.emotes.len().to_string()),
                                )
                                .into_any_element()
                        }
                        PickerRow::Emotes(index, span) => {
                            let mut line = div().id(row).h(px(44.)).px_2().flex().items_center().gap_1();
                            let keep_open = sections[*index].effects;
                            for (name, url) in &sections[*index].emotes[span.clone()] {
                                let emoji_name = url.strip_prefix("emoji:").map(str::to_owned);
                                let image = if emoji_name.is_some() { None } else { this.image(url, false, cx) };
                                let label = name.clone();
                                let insert = name.clone();
                                let starred = favorites.contains(name);
                                line = line.child(
                                    div()
                                        .id(SharedString::from(format!("pick-{name}")))
                                        .relative()
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
                                        .when(emoji_name.is_some(), |v| {
                                            v.flex()
                                                .items_center()
                                                .justify_center()
                                                .text_size(px(24.))
                                                .font_family("Segoe UI Emoji")
                                                .child(name.clone())
                                        })
                                        .when(starred, |v| {
                                            v.child(
                                                ui::icon(Icon::StarFilled, 10.)
                                                    .absolute()
                                                    .top(px(1.))
                                                    .right(px(1.))
                                                    .text_color(rgb(0xfacc15)),
                                            )
                                        })
                                        .tooltip(move |_, cx| {
                                            let label = emoji_name.clone().unwrap_or_else(|| label.clone());
                                            cx.new(|_| {
                                                ui::Tooltip(
                                                    format!("{label} · Ctrl+click keeps the picker open · Alt+click to favorite").into(),
                                                )
                                            })
                                            .into()
                                        })
                                        .on_click(cx.listener(move |this, event: &gpui::ClickEvent, window, cx| {
                                            if event.modifiers().alt {
                                                this.toggle_favorite_emote(&insert, cx);
                                                return;
                                            }
                                            this.input.update(cx, |input, cx| {
                                                input.append(&format!("{insert} "), cx);
                                                window.focus(&gpui::Focusable::focus_handle(input, cx));
                                            });
                                            // Electron: Ctrl+click inserts and keeps the picker
                                            // open; so does an effect, which needs an emote next.
                                            if !event.modifiers().control && !keep_open {
                                                this.picker = false;
                                            }
                                            cx.notify();
                                        })),
                                );
                            }
                            line.into_any_element()
                        }
                    })
                    .collect::<Vec<_>>()
            }),
        )
        .track_scroll(self.picker_scroll.clone())
        .flex_1()
        .min_h_0();
        let sections = rail_sections;
        let rail = (query.is_empty() && sections.len() > 1).then(|| {
            div()
                .id("emote-rail")
                .w(px(44.))
                .flex_none()
                .h_full()
                .overflow_y_scroll()
                .py_1()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(4.))
                .border_l_1()
                .border_color(theme::border())
                .children(sections.iter().zip(section_rows).enumerate().map(|(index, (section, row))| {
                    let label = section.label.clone();
                    let mark = match &section.mark {
                        RailMark::Avatar(url) => match self.image(url, false, cx) {
                            Some(image) => img(ImageSource::Render(image)).size(px(24.)).rounded_full().into_any_element(),
                            None => div().size(px(24.)).rounded_full().bg(theme::surface_hover()).into_any_element(),
                        },
                        RailMark::Glyph(glyph) => div()
                            .text_size(px(18.))
                            .font_family("Segoe UI Emoji")
                            .child(*glyph)
                            .into_any_element(),
                        RailMark::Letter(letter) => div()
                            .size(px(24.))
                            .rounded_full()
                            .bg(theme::selected())
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(px(12.))
                            .font_weight(FontWeight::BOLD)
                            .child(letter.clone())
                            .into_any_element(),
                        RailMark::Global => ui::icon(Icon::Globe, 18.).into_any_element(),
                        RailMark::Effects => ui::icon(Icon::Sparkles, 18.).into_any_element(),
                        RailMark::Favorites => ui::icon(Icon::StarFilled, 18.).text_color(rgb(0xfacc15)).into_any_element(),
                    };
                    let scroll = self.picker_scroll.clone();
                    div()
                        .id(index)
                        .size(px(34.))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(7.))
                        .cursor_pointer()
                        .hover(|style| style.bg(theme::surface_hover()))
                        .child(mark)
                        .tooltip(move |_, cx| cx.new(|_| ui::Tooltip(label.clone().into())).into())
                        .on_click(move |_, _, _| scroll.scroll_to_item(row, gpui::ScrollStrategy::Top))
                }))
        });
        let grid = div()
            .flex_1()
            .min_h_0()
            .flex()
            .child(div().flex_1().min_w_0().h_full().flex().flex_col().child(grid))
            .when_some(rail, |row, rail| row.child(rail));
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
                        ("favorite-emotes", "Favorites"),
                        ("seven-emotes", "7TV"),
                        ("twitch-emotes", "Twitch"),
                        ("ffz-emotes", "FFZ"),
                        ("bttv-emotes", "BTTV"),
                        ("emoji-tab", "Emoji"),
                    ]
                    .into_iter()
                    .map(|(id, provider)| {
                        ui::button(
                            id,
                            if self.kick && provider == "Twitch" { "Kick" } else { provider },
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
                            this.picker_scroll.scroll_to_item(0, gpui::ScrollStrategy::Top);
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
                    .child(format!("{count} emotes · Click to insert · Alt+click to favorite")),
            )
            .into_any_element()
    }
}
impl Render for Chat {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let _timer = crate::render_stats::start("chat");
        let view = cx.entity().downgrade();
        let list = list(self.list.clone(), move |index, _, cx| {
            view.update(cx, |this, cx| this.row(index, cx))
                .unwrap_or_else(|_| div().into_any_element())
        })
        .flex_1()
        .min_h_0();
        self.sync_composer_emotes(cx);
        let picker = self.picker.then(|| self.picker(cx));
        let card = self.user_card(cx);
        let pinned = self.pinned_banner(cx);
        let link_preview = self.link_preview();
        let pin_hidden = self.pinned.as_ref().is_some_and(|pin| self.pinned_hidden.as_deref() == Some(pin.message.id.as_str()));
        let menu = self
            .menu
            .clone()
            .map(|(message, position)| self.context_menu(message, position, cx));
        let show_composer = !self.overlay
            || self.hovered
            || self.picker
            || self.replying.is_some()
            || self.is_editing(window, cx);
        let can_send = (if self.kick {
            crate::preferences::get(cx).kick_account.is_some()
        } else {
            self.session.is_some()
        })
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
                // Leaving chat ends any link preview.
                if !*hovered {
                    this.link_hover = None;
                }
                cx.notify();
            }))
            .when_some(card, |v, card| v.child(card))
            .when_some(link_preview, |v, preview| v.child(preview))
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape" && this.card.is_some() {
                    this.close_card(cx);
                    cx.stop_propagation();
                    return;
                }
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
                        // Balances the collapse button so the title stays centred.
                        .child(div().w(px(34.)).flex_none()),
                )
            })
            .children(pinned)
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
                                .when(pin_hidden, |row| {
                                    row.child(
                                        ui::icon_button("show-pin", Icon::Pin, "Show pinned message", false)
                                            .w(px(26.))
                                            .h(px(26.))
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.pinned_hidden = None;
                                                cx.notify();
                                            })),
                                    )
                                })
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
                                            (if self.kick {
                                                crate::preferences::get(cx)
                                                    .kick_account
                                                    .map(|account| format!("Chatting on Kick as {}", account.username))
                                            } else {
                                                self.session.as_ref().map(|s| format!("Chatting as {}", s.identity.login))
                                            })
                                                .unwrap_or_else(|| {
                                                    if self.kick {
                                                        "Sign in to Kick in Settings to chat".into()
                                                    } else {
                                                        "Sign in with Twitch to chat".into()
                                                    }
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

/// Electron's emote preview: the emote at about 2.2x, its name and provider.
#[derive(Clone)]
struct EmoteTooltip {
    image: Option<Arc<RenderImage>>,
    name: SharedString,
    provider: &'static str,
    height: f32,
    ratio: f32,
}

impl Render for EmoteTooltip {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let width = (self.height * self.ratio).min(320.);
        div()
            .p(px(8.))
            .flex()
            .flex_col()
            .items_center()
            .gap(px(4.))
            .rounded(px(8.))
            .border_1()
            .border_color(theme::button_border())
            .bg(theme::popup())
            .shadow_lg()
            .when_some(self.image.clone(), |v, image| {
                v.child(
                    img(ImageSource::Render(image))
                        .id("emote-tooltip-image")
                        .w(px(width))
                        .h(px(self.height))
                        .object_fit(ObjectFit::Contain),
                )
            })
            .child(
                div()
                    .text_size(px(13.))
                    .font_weight(FontWeight::BOLD)
                    .text_color(theme::text())
                    .child(self.name.clone()),
            )
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(theme::text_dim())
                    .child(self.provider),
            )
    }
}

#[derive(Clone)]
struct Card {
    login: String,
    name: String,
    color: u32,
    badges: Vec<String>,
    at: gpui::Point<gpui::Pixels>,
    profile: Option<Result<super::profile::Profile, SharedString>>,
}
