//! Native visual settings using the same controls and grouping as Electron.
use crate::{
    preferences::{self, Preferences},
    theme,
    ui::{self, ButtonStyle, Icon},
};
use gpui::{Context, Entity, Render, Subscription, Window, div, prelude::*, px, rgb, rgba};
#[derive(Clone)]
pub enum Event {
    Closed,
    /// Open the keyboard shortcuts list (and close settings).
    Shortcuts,
    /// Sign in on twitch.tv for ad-free playback.
    LinkPlayback,
    UnlinkPlayback,
    KickSignIn,
    KickSignOut,
    /// Look up the Twitch and Kick name colours (the Chat section opened).
    LoadChatColors,
    /// Set a name colour: Twitch's colour name and its hex value.
    SetChatColor { kick: bool, name: &'static str, hex: &'static str },
    CheckForUpdates,
    InstallUpdate,
    /// Open the version history (and close settings).
    Changelog,
}

/// What Settings > About says about updates.
#[derive(Clone, Default)]
pub enum UpdateState {
    #[default]
    Idle,
    Checking,
    UpToDate,
    Available(String),
    Installing(String),
    Failed(String),
}

/// Electron's `TWITCH_CHAT_COLORS`: Twitch's named chat colours, which Kick
/// is offered too.
pub const CHAT_COLORS: [(&str, &str, &str); 15] = [
    ("Blue", "blue", "#0000FF"),
    ("Blue violet", "blue_violet", "#8A2BE2"),
    ("Cadet blue", "cadet_blue", "#5F9EA0"),
    ("Chocolate", "chocolate", "#D2691E"),
    ("Coral", "coral", "#FF7F50"),
    ("Dodger blue", "dodger_blue", "#1E90FF"),
    ("Firebrick", "firebrick", "#B22222"),
    ("Golden rod", "golden_rod", "#DAA520"),
    ("Green", "green", "#008000"),
    ("Hot pink", "hot_pink", "#FF69B4"),
    ("Orange red", "orange_red", "#FF4500"),
    ("Red", "red", "#FF0000"),
    ("Sea green", "sea_green", "#2E8B57"),
    ("Spring green", "spring_green", "#00FF7F"),
    ("Yellow green", "yellow_green", "#9ACD32"),
];

/// A service's name colour as the Chat section shows it.
#[derive(Clone, Default)]
pub struct ChatColor {
    pub color: Option<String>,
    pub note: Option<String>,
    pub busy: bool,
}
/// Electron's settings sections, in its order.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub enum Section {
    #[default]
    Account,
    Playback,
    Chat,
    Emotes,
    Appearance,
    About,
}

const SECTIONS: [(Section, &str, Icon); 5] = [
    (Section::Account, "Account", Icon::Users),
    (Section::Playback, "Playback", Icon::Monitor),
    (Section::Chat, "Chat", Icon::Chat),
    (Section::Emotes, "Emotes", Icon::Emotes),
    (Section::Appearance, "Appearance", Icon::Star),
];

/// Electron's settings search index: what each card is called, says, and
/// might be searched for.
const INDEX: &[(Section, &str, &str, &str)] = &[
    (Section::Account, "Twitch API account", "Sign in, refresh OAuth permissions, or sign out.", "login oauth authorization scopes"),
    (Section::Account, "Kick account", "Connect or remove the Kick account used for follows and chat.", "login sign in following"),
    (Section::Account, "Twitch website session", "Link playback access for Source and higher stream qualities.", "1440p source quality authentication ads"),
    (Section::Playback, "Low latency", "Play closer to live, or steadier when a stream hiccups.", "buffer hls prefetch reliable fast latency balanced"),
    (Section::Playback, "Controls auto-hide delay", "Change how quickly player controls disappear.", "cursor timeout seconds"),
    (Section::Playback, "Volume normalizer", "Even out loud and quiet moments.", "audio compression compressor loudness"),
    (Section::Playback, "FPS in the corner", "Show the video's frame rate over the player.", "frames overlay performance"),
    (Section::Playback, "Keyboard shortcuts", "See every shortcut, or press ? anywhere outside a text box.", "keys hotkeys keybinds fullscreen theater mute space"),
    (Section::Chat, "Username color", "Change the color of your username in chat.", "prime turbo custom color"),
    (Section::Chat, "Chat timestamps", "Show the sent time beside chat messages.", "time messages"),
    (Section::Chat, "Blocked chatters", "Hide a viewer's messages everywhere chat appears.", "block ignore mute hide user unblock blocklist"),
    (Section::Chat, "Subscriber GIFs", "Draw the GIFs higher-tier subscribers send in chat.", "gif giphy animated tier 2 3 subscriber"),
    (Section::Chat, "Mention sound", "Configure mention alerts, sound, and volume.", "ping notification audio test"),
    (Section::Chat, "Deleted messages", "Choose whether removed messages are dimmed or replaced.", "moderation timeout ban placeholder"),
    (Section::Chat, "Emote autocomplete", "Match emote names by prefix, or anywhere in the name.", "tab complete suggestion starts with contains substring"),
    (Section::Chat, "Tab while naming someone", "Fill in the highlighted @name, or move through the names.", "mention tab cycle complete"),
    (Section::Chat, "Chat layout", "Move chat to the left or adjust overlay opacity.", "position side overlay transparency"),
    (Section::Chat, "Chat sizing and history", "Adjust message font, chat width, and loaded history.", "text messages count width"),
    (Section::Chat, "Generic link previews", "Preview metadata from public websites on hover.", "embed open graph privacy ip ctrl alt tooltip"),
    (Section::Emotes, "Third-party emotes", "Review 7TV, FrankerFaceZ, and BetterTTV providers.", "7tv ffz bttv cache channel global size"),
    (Section::Appearance, "OLED mode", "Use true-black backgrounds throughout VioletWire.", "theme black dark appearance"),
    (Section::About, "Updates and version history", "Check for updates or read the VioletWire changelog.", "release version latest install changelog"),
    (Section::About, "Project and support links", "Open the website, GitHub, Ko-fi, sponsors, or issue tracker.", "lucaboox donate bugs help source"),
    (Section::About, "Dependencies and licenses", "Review core dependencies and third-party notices.", "rust gpui streamlink credits licenses"),
];

fn section_name(section: Section) -> &'static str {
    match section {
        Section::Account => "Account",
        Section::Playback => "Playback",
        Section::Chat => "Chat",
        Section::Emotes => "Emotes",
        Section::Appearance => "Appearance",
        Section::About => "About",
    }
}

#[derive(Default)]
pub struct Settings {
    /// Electron's "Search settings" box, made on first draw.
    search: Option<gpui::Entity<crate::input::TextInput>>,
    section: Section,
    /// The signed-in Twitch login, shown under Account.
    account: Option<String>,
    twitch_color: ChatColor,
    kick_color: ChatColor,
    update: UpdateState,
}

impl Settings {
    pub fn probe_section(&mut self, section: Section, cx: &mut Context<Self>) {
        self.section = section;
        cx.notify();
    }

    pub fn probe_search(&mut self, text: &str, cx: &mut Context<Self>) {
        let input = cx.new(|cx| crate::input::TextInput::new("Search settings", cx));
        input.update(cx, |input, cx| input.append(text, cx));
        cx.observe(&input, |_, _, cx| cx.notify()).detach();
        self.search = Some(input);
        cx.notify();
    }

    /// Electron opens Settings with an empty search each time.
    pub fn clear_search(&mut self, cx: &mut Context<Self>) {
        if let Some(search) = &self.search {
            search.update(cx, |input, cx| input.clear(cx));
        }
    }

    pub fn set_update(&mut self, update: UpdateState, cx: &mut Context<Self>) {
        self.update = update;
        cx.notify();
    }

    /// Electron's update card: this version, and a newer one when released.
    fn update_card(&self, cx: &Context<Self>) -> impl IntoElement {
        let (description, button): (String, Option<(&'static str, Event)>) = match &self.update {
            UpdateState::Idle => (
                format!("Version {}. VioletWire checks GitHub releases for updates.", crate::updates::current()),
                Some(("Check now", Event::CheckForUpdates)),
            ),
            UpdateState::Checking => ("Checking for updates…".into(), None),
            UpdateState::UpToDate => (
                format!("Version {} is the newest.", crate::updates::current()),
                Some(("Check again", Event::CheckForUpdates)),
            ),
            UpdateState::Available(version) => (
                format!("Version {version} is available (you have {}).", crate::updates::current()),
                Some(("Install and restart", Event::InstallUpdate)),
            ),
            UpdateState::Installing(version) => (format!("Downloading and checking {version}…"), None),
            UpdateState::Failed(error) => (error.clone(), Some(("Try again", Event::CheckForUpdates))),
        };
        card(
            "Updates and version history",
            description,
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(
                    ui::button("show-changelog", "Changelog", Some(Icon::Changelog), ButtonStyle::Secondary)
                        .px_3()
                        .h(px(30.))
                        .on_click(cx.listener(|_, _, _, cx| cx.emit(Event::Changelog))),
                )
                .children(button.map(|(label, event)| {
                    ui::button("update-action", label, None, ButtonStyle::Primary)
                        .px_3()
                        .h(px(30.))
                        .on_click(cx.listener(move |_, _, _, cx| cx.emit(event.clone())))
                })),
        )
    }

    pub fn set_chat_color(&mut self, kick: bool, color: ChatColor, cx: &mut Context<Self>) {
        if kick {
            self.kick_color = color;
        } else {
            self.twitch_color = color;
        }
        cx.notify();
    }

    /// Electron's `TwitchChatColorControls`: the current colour and the
    /// named ones to pick from.
    fn color_card(&self, kick: bool, cx: &Context<Self>) -> impl IntoElement {
        let state = if kick { &self.kick_color } else { &self.twitch_color };
        let current = state.color.clone().unwrap_or_default().to_ascii_uppercase();
        let swatches = div().flex().flex_wrap().gap(px(5.)).max_w(px(330.)).children(CHAT_COLORS.iter().map(|(label, name, hex)| {
            let active = current == *hex;
            let value = u32::from_str_radix(&hex[1..], 16).unwrap_or(0);
            div()
                .id(gpui::SharedString::from(format!("color-{}-{name}", if kick { "kick" } else { "twitch" })))
                .size(px(20.))
                .rounded(px(5.))
                .bg(rgb(value))
                .border_2()
                .border_color(if active { gpui::white() } else { gpui::transparent_black() })
                .cursor_pointer()
                .tooltip(move |_, cx| cx.new(|_| ui::Tooltip((*label).into())).into())
                .on_click(cx.listener(move |_, _, _, cx| cx.emit(Event::SetChatColor { kick, name, hex })))
        }));
        let description = match (&state.note, &state.color, state.busy) {
            (Some(note), _, _) => note.clone(),
            (None, _, true) => "Working…".to_owned(),
            (None, Some(color), false) if !color.is_empty() => format!("Your name shows in {color}."),
            _ => "Pick the colour your name shows in chat.".to_owned(),
        };
        card(
            if kick { "Username color · Kick" } else { "Username color · Twitch" },
            description,
            swatches,
        )
    }

    pub fn set_account(&mut self, account: Option<String>, cx: &mut Context<Self>) {
        if self.account != account {
            self.account = account;
            cx.notify();
        }
    }
}
impl gpui::EventEmitter<Event> for Settings {}
pub fn subscribe<T: 'static>(
    view: &Entity<Settings>,
    cx: &mut Context<T>,
    handle: impl Fn(&mut T, &Event, &mut Context<T>) + 'static,
) -> Subscription {
    cx.subscribe(view, move |this, _, event: &Event, cx| handle(this, event, cx))
}
fn card(
    title: &'static str,
    description: impl Into<gpui::SharedString>,
    control: impl IntoElement,
) -> impl IntoElement {
    div()
        .flex_none()
        .p_3()
        .rounded(px(10.))
        .border_1()
        .border_color(theme::border())
        .bg(theme::surface())
        .flex()
        .items_center()
        .gap_4()
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap_1()
                .child(
                    div()
                        .text_size(px(13.))
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .child(title.to_owned()),
                )
                .child(
                    div()
                        .text_size(px(11.))
                        .text_color(theme::text_dim())
                        .child(description.into()),
                ),
        )
        .child(control)
}
fn toggle(id: &'static str, on: bool) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .w(px(38.))
        .h(px(22.))
        .flex_none()
        .rounded_full()
        .p(px(3.))
        .flex()
        .items_center()
        .when(on, |v| v.justify_end())
        .bg(if on {
            theme::primary()
        } else {
            theme::button_border()
        })
        .cursor_pointer()
        .child(div().size(px(16.)).rounded_full().bg(gpui::white()))
}
impl Render for Settings {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let settings = preferences::get(cx);
        let viewport = window.viewport_size();
        let search = self
            .search
            .get_or_insert_with(|| {
                let input = cx.new(|cx| crate::input::TextInput::new("Search settings", cx));
                cx.observe(&input, |_, _, cx| cx.notify()).detach();
                input
            })
            .clone();
        let query = search.read(cx).content.trim().to_lowercase();
        let content = if !query.is_empty() {
            self.search_results(&query, &search, cx).into_any_element()
        } else {
            match self.section {
            Section::Account => self.account_section(cx).into_any_element(),
            Section::Playback => playback_section(&settings, cx).into_any_element(),
            Section::Chat => div()
                .flex()
                .flex_col()
                .gap_3()
                .child(chat_section(&settings, cx))
                .when(self.account.is_some(), |v| v.child(self.color_card(false, cx)))
                .when(settings.kick_account.is_some(), |v| v.child(self.color_card(true, cx)))
                .into_any_element(),
            Section::Emotes => emotes_section(&settings, cx).into_any_element(),
            Section::Appearance => appearance_section(&settings, cx).into_any_element(),
            Section::About => div()
                .flex()
                .flex_col()
                .gap_3()
                .child(about_section())
                .child(self.update_card(cx))
                .child(links_card(cx))
                .child(dependencies_card(cx))
                .into_any_element(),
            }
        };
        let searching = !query.is_empty();
        let nav_button = |section: Section, label: &'static str, icon: Icon, id: &'static str, cx: &mut Context<Self>| {
            let active = self.section == section && !searching;
            let search = search.clone();
            div()
                .id(id)
                .h(px(40.))
                .px(px(12.))
                .flex()
                .items_center()
                .gap(px(11.))
                .rounded(px(9.))
                .border_1()
                .border_color(if active { rgba(0x6d4b913d) } else { rgba(0x00000000) })
                .when(active, |v| v.bg(rgb(0x2a1d35)))
                .text_size(px(12.))
                .font_weight(gpui::FontWeight::BOLD)
                .text_color(if active { rgb(0xf4eefe) } else { rgb(0x9b9ba6) })
                .cursor_pointer()
                .hover(|style| style.bg(rgba(0xffffff0b)).text_color(rgb(0xededf0)))
                .child(ui::icon(icon, 17.).when(active, |icon| icon.text_color(rgb(0xb794f6))))
                .child(label)
                .on_click(cx.listener(move |this, _, _, cx| {
                    if section == Section::Chat && this.section != Section::Chat {
                        cx.emit(Event::LoadChatColors);
                    }
                    this.section = section;
                    search.update(cx, |input, cx| input.clear(cx));
                    cx.notify();
                }))
        };
        div()
            .occlude()
            .w((viewport.width - px(48.)).min(px(980.)).max(px(320.)))
            .h((viewport.height - px(48.)).min(px(780.)).max(px(240.)))
            .rounded(px(16.))
            .border_1()
            .border_color(rgb(0x44364f))
            .bg(theme::background())
            .shadow_xl()
            .flex()
            .flex_col()
            .overflow_hidden()
            .child(
                div()
                    .flex_none()
                    .px(px(24.))
                    .pt(px(22.))
                    .pb(px(18.))
                    .flex()
                    .items_center()
                    .justify_between()
                    .border_b_1()
                    .border_color(rgb(0x2e2a33))
                    // Clipping is rectangular, so the header rounds its own
                    // top corners to sit inside the dialog's.
                    .rounded_t(px(15.))
                    .bg(gpui::linear_gradient(
                        100.,
                        gpui::linear_color_stop(rgb(0x23152e), 0.),
                        gpui::linear_color_stop(rgb(0x131217), 0.65),
                    ))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .text_size(px(9.))
                                    .font_weight(gpui::FontWeight::EXTRA_BOLD)
                                    .text_color(rgb(0xa78bfa))
                                    .child("VIOLETWIRE"),
                            )
                            .child(
                                div()
                                    .mt(px(3.))
                                    .text_size(px(26.))
                                    .font_weight(gpui::FontWeight::BOLD)
                                    .child("Settings"),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_3()
                            .child(div().w(px(280.)).child(search.clone()))
                            .child(
                                ui::icon_button("close-settings", Icon::Close, "Close settings · Escape", false)
                                    .on_click(cx.listener(|_, _, _, cx| cx.emit(Event::Closed))),
                            ),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .child(
                        div()
                            .w(px(190.))
                            .flex_none()
                            .h_full()
                            .px(px(11.))
                            .py(px(16.))
                            .flex()
                            .flex_col()
                            .gap(px(4.))
                            .border_r_1()
                            .border_color(rgb(0x29272e))
                            .rounded_bl(px(15.))
                            .bg(rgba(0x0d0d10c7))
                            .children(SECTIONS.iter().map(|(section, label, icon)| {
                                let id = match section {
                                    Section::Account => "nav-account",
                                    Section::Playback => "nav-playback",
                                    Section::Chat => "nav-chat",
                                    Section::Emotes => "nav-emotes",
                                    _ => "nav-appearance",
                                };
                                nav_button(*section, label, *icon, id, cx)
                            }))
                            .child(div().flex_1())
                            .child(
                                div()
                                    .pt(px(12.))
                                    .border_t_1()
                                    .border_color(rgb(0x29272e))
                                    .child(nav_button(Section::About, "About", Icon::Info, "nav-about", cx)),
                            ),
                    )
                    .child(
                        div()
                            .id("settings-content")
                            .flex_1()
                            .min_w_0()
                            .h_full()
                            .overflow_y_scroll()
                            .px(px(28.))
                            .pt(px(24.))
                            .pb(px(30.))
                            .child(content),
                    ),
            )
    }
}

impl Settings {
    /// Electron's settings search results: each matching card, and its
    /// section, which a click opens.
    fn search_results(
        &self,
        query: &str,
        search: &gpui::Entity<crate::input::TextInput>,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let results: Vec<_> = INDEX
            .iter()
            .filter(|(section, title, description, keywords)| {
                [*title, *description, *keywords, section_name(*section)]
                    .iter()
                    .any(|text| text.to_lowercase().contains(query))
            })
            .collect();
        let summary = match results.len() {
            1 => "1 matching setting".to_owned(),
            count => format!("{count} matching settings"),
        };
        section("SEARCH", "Settings results", "").child(div().text_size(px(12.)).text_color(theme::text_dim()).child(summary)).children(
            results.into_iter().enumerate().map(|(index, (target, title, description, _))| {
                let (target, search) = (*target, search.clone());
                div()
                    .id(("settings-result", index))
                    .px(px(16.))
                    .py(px(12.))
                    .flex()
                    .items_center()
                    .gap_3()
                    .rounded(px(10.))
                    .border_1()
                    .border_color(theme::border())
                    .bg(theme::surface())
                    .cursor_pointer()
                    .hover(|style| style.border_color(rgb(0x6d4b91)))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(3.))
                            .child(div().text_size(px(13.)).font_weight(gpui::FontWeight::BOLD).child(*title))
                            .child(div().text_size(px(12.)).text_color(theme::text_dim()).child(*description)),
                    )
                    .child(div().text_size(px(11.)).text_color(rgb(0xb794f6)).child(section_name(target)))
                    .child(ui::icon(Icon::ChevronRight, 16.))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if target == Section::Chat {
                            cx.emit(Event::LoadChatColors);
                        }
                        this.section = target;
                        search.update(cx, |input, cx| input.clear(cx));
                        cx.notify();
                    }))
            }),
        )
    }
}

/// Electron's project and support links, opened in the default browser.
fn links_card(cx: &Context<Settings>) -> impl IntoElement {
    const LINKS: [(&str, &str, &str); 6] = [
        ("VioletWire website", "violetwire.lucaboox.win", "https://violetwire.lucaboox.win"),
        ("Source code", "github.com/lucaboox/VioletWire", "https://github.com/lucaboox/VioletWire"),
        ("lucaboox on GitHub", "Projects and profile", "https://github.com/lucaboox"),
        ("Help and bug reports", "VioletWire Issues", "https://github.com/lucaboox/VioletWire/issues"),
        ("Support on Ko-fi", "ko-fi.com/W7W3D7V7U", "https://ko-fi.com/W7W3D7V7U"),
        ("GitHub Sponsors", "github.com/sponsors/lucaboox", "https://github.com/sponsors/lucaboox"),
    ];
    div().flex().flex_wrap().gap(px(10.)).children(LINKS.iter().enumerate().map(|(index, (label, detail, url))| {
        let url = *url;
        div()
            .id(("about-link", index))
            .w(px(240.))
            .flex_grow()
            .px(px(14.))
            .py(px(11.))
            .flex()
            .items_center()
            .gap(px(11.))
            .rounded(px(10.))
            .border_1()
            .border_color(theme::border())
            .bg(theme::surface())
            .cursor_pointer()
            .hover(|style| style.border_color(rgb(0x6d4b91)))
            .child(ui::icon(Icon::External, 16.).text_color(rgb(0xb794f6)))
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .child(div().text_size(px(13.)).font_weight(gpui::FontWeight::BOLD).child(*label))
                    .child(div().truncate().text_size(px(11.)).text_color(theme::text_dim()).child(*detail)),
            )
            .on_click(cx.listener(move |_, _, _, cx| cx.open_url(url)))
    }))
}

/// Electron's "Core dependencies" card, for the Rust build.
fn dependencies_card(cx: &Context<Settings>) -> impl IntoElement {
    const ROWS: [(&str, &str); 4] = [
        ("Desktop", "Rust · GPUI"),
        ("Bundled resolver", "Streamlink portable runtime"),
        ("Video playback", "Media Foundation · Direct3D 11"),
        ("Chat and emotes", "Twitch · Kick · 7TV · FrankerFaceZ · BetterTTV"),
    ];
    div()
        .px(px(18.))
        .py(px(16.))
        .flex()
        .flex_col()
        .gap(px(10.))
        .rounded(px(12.))
        .border_1()
        .border_color(theme::border())
        .bg(theme::surface())
        .child(div().text_size(px(14.)).font_weight(gpui::FontWeight::BOLD).child("Core dependencies"))
        .child(
            div()
                .text_size(px(12.))
                .text_color(theme::text_dim())
                .child("Software and services that make VioletWire possible."),
        )
        .children(ROWS.iter().map(|(term, value)| {
            div()
                .flex()
                .gap_3()
                .text_size(px(12.))
                .child(div().w(px(140.)).flex_none().text_color(theme::text_dim()).child(*term))
                .child(div().min_w_0().child(*value))
        }))
        .child(
            div()
                .id("third-party-notices")
                .mt(px(4.))
                .flex()
                .items_center()
                .gap(px(6.))
                .text_size(px(12.))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(rgb(0xb794f6))
                .cursor_pointer()
                .hover(|style| style.text_color(rgb(0xd8b4fe)))
                .child("View licenses and third-party notices")
                .child(ui::icon(Icon::External, 14.).text_color(rgb(0xb794f6)))
                .on_click(cx.listener(|_, _, _, cx| {
                    cx.open_url("https://github.com/lucaboox/VioletWire/blob/main/THIRD_PARTY_NOTICES.md")
                })),
        )
}

/// Electron's `settings-section-heading`: a small label, a title and a line.
fn section(label: &'static str, title: &'static str, description: &'static str) -> gpui::Div {
    div()
        .flex()
        .flex_col()
        .gap(px(10.))
        .child(
            div()
                .mb(px(8.))
                .flex()
                .flex_col()
                .child(
                    div()
                        .text_size(px(9.))
                        .font_weight(gpui::FontWeight::EXTRA_BOLD)
                        .text_color(rgb(0xa78bfa))
                        .child(label),
                )
                .child(
                    div()
                        .mt(px(4.))
                        .text_size(px(22.))
                        .font_weight(gpui::FontWeight::BOLD)
                        .text_color(rgb(0xf4f4f5))
                        .child(title),
                )
                .child(
                    div()
                        .mt(px(5.))
                        .text_size(px(11.))
                        .text_color(rgb(0x8f8f99))
                        .child(description),
                ),
        )
}

fn choice<T: PartialEq + Copy + 'static>(
    options: &[(&'static str, T, &'static str)],
    current: T,
    set: fn(&mut Preferences, T),
    cx: &Context<Settings>,
) -> impl IntoElement {
    div().flex().gap_1().children(options.iter().map(|(id, value, label)| {
        let value = *value;
        ui::button(
            id,
            *label,
            None,
            if current == value { ButtonStyle::Selected } else { ButtonStyle::Secondary },
        )
        .px_2()
        .h(px(30.))
        .on_click(cx.listener(move |_, _, _, cx| preferences::update(cx, |s| set(s, value))))
    }))
}

impl Settings {
    fn account_section(&self, cx: &Context<Self>) -> impl IntoElement {
        use crate::twitch::playback_session::Status;
        let (description, label, linked) = match crate::twitch::playback_session::status() {
            Status::Unlinked => (
                "Sign in on twitch.tv so Twitch sends your Turbo or subscriber streams without ads. Used only to find streams.".to_owned(),
                "Link",
                false,
            ),
            Status::Linked(login) => (
                match login {
                    Some(login) => format!("Linked as {login}. Turbo and your subscriptions play without ads."),
                    None => "Linked. Turbo and your subscriptions play without ads.".to_owned(),
                },
                "Unlink",
                true,
            ),
            Status::Expired(_) => (
                "Twitch signed this session out, so streams play with ads again. Link it again.".to_owned(),
                "Link again",
                false,
            ),
        };
        section("ACCOUNT", "Connections", "Manage the accounts and website session VioletWire uses.")
            .child(card(
                "Twitch API account",
                match &self.account {
                    Some(login) => format!("Signed in as {login} with Twitch's official sign-in. Sign out from the account menu."),
                    None => "Not signed in. Use Sign in at the top right.".to_owned(),
                },
                div(),
            ))
            .child({
                let kick = preferences::get(cx).kick_account;
                let signed_in = kick.is_some();
                card(
                    "Kick account",
                    match &kick {
                        Some(account) => format!(
                            "Signed in as {} on Kick's own page. Your followed Kick channels show in the sidebar, and you can chat on Kick.",
                            account.username
                        ),
                        None => "Sign in on kick.com to see the Kick channels you follow and chat on Kick. VioletWire never sees your password.".to_owned(),
                    },
                    ui::button(
                        "kick-account",
                        if signed_in { "Sign out" } else { "Sign in" },
                        None,
                        if signed_in { ButtonStyle::Secondary } else { ButtonStyle::Primary },
                    )
                    .px_3()
                    .h(px(30.))
                    .on_click(cx.listener(move |_, _, _, cx| {
                        cx.emit(if signed_in { Event::KickSignOut } else { Event::KickSignIn })
                    })),
                )
            })
            .child(card(
                "Twitch website session",
                description,
                ui::button(
                    "playback-session",
                    label,
                    None,
                    if linked { ButtonStyle::Secondary } else { ButtonStyle::Primary },
                )
                .px_3()
                .h(px(30.))
                .on_click(cx.listener(move |_, _, _, cx| {
                    cx.emit(if linked { Event::UnlinkPlayback } else { Event::LinkPlayback })
                })),
            ))
    }
}

fn playback_section(settings: &Preferences, cx: &Context<Settings>) -> impl IntoElement {
    section("PLAYBACK", "Video and controls", "Choose how streams play and how the player behaves.")
        .child(card(
            "Low latency",
            "Play about 2 s closer to live, starting on the fragment Twitch is still writing. Off is steadier when a stream hiccups. Applies to the next stream you open.",
            toggle("low-latency", settings.playback_latency_mode != "balanced").on_click(cx.listener(|_, _, _, cx| {
                preferences::update(cx, |s| {
                    s.playback_latency_mode =
                        if s.playback_latency_mode == "balanced" { "ultra-low" } else { "balanced" }.into()
                })
            })),
        ))
        .child(card(
            "Controls auto-hide delay",
            "Controls stay visible while hovered or paused.",
            choice(
                &[("delay-1", 1000u16, "1s"), ("delay-3", 3000, "3s"), ("delay-5", 5000, "5s"), ("delay-10", 10000, "10s")],
                settings.controls_hide_delay,
                |s, delay| s.controls_hide_delay = delay,
                cx,
            ),
        ))
        .child(card(
            "Volume normalizer",
            "Evens out loud and quiet moments, like the player's audio button.",
            toggle("audio-compression", settings.audio_compression).on_click(cx.listener(|_, _, _, cx| {
                preferences::update(cx, |s| s.audio_compression = !s.audio_compression)
            })),
        ))
        .child(card(
            "FPS in the corner",
            "Show the video's frame rate over the player.",
            toggle("fps-overlay", settings.show_fps_overlay).on_click(cx.listener(|_, _, _, cx| {
                preferences::update(cx, |s| s.show_fps_overlay = !s.show_fps_overlay)
            })),
        ))
        .child(card(
            "Keyboard shortcuts",
            "Every key and mouse shortcut. Press ? to open it any time.",
            ui::button("show-shortcuts", "View", None, ButtonStyle::Secondary)
                .px_3()
                .h(px(30.))
                .on_click(cx.listener(|_, _, _, cx| cx.emit(Event::Shortcuts))),
        ))
}

/// Electron's "Generic link previews" card.
fn link_preview_card(settings: &Preferences, cx: &Context<Settings>) -> impl IntoElement {
    let enabled = settings.generic_link_previews;
    card(
        "Generic link previews",
        "Show titles, descriptions and images from any public website. The website sees your IP address; VioletWire caps downloads and never runs the page's scripts. Clips, YouTube and image links always preview.",
        div()
            .flex()
            .items_center()
            .gap_2()
            .when(enabled, |row| {
                row.child(choice(
                    &[("preview-ctrl", "ctrl", "Ctrl"), ("preview-alt", "alt", "Alt"), ("preview-hover", "hover", "Hover")],
                    match settings.generic_link_preview_activation.as_str() {
                        "alt" => "alt",
                        "hover" => "hover",
                        _ => "ctrl",
                    },
                    |s, mode| s.generic_link_preview_activation = mode.into(),
                    cx,
                ))
            })
            .child(toggle("generic-previews", enabled).on_click(cx.listener(|_, _, _, cx| {
                preferences::update(cx, |s| s.generic_link_previews = !s.generic_link_previews)
            }))),
    )
}

fn chat_section(settings: &Preferences, cx: &Context<Settings>) -> impl IntoElement {
    let history = stepper(
        "history-down",
        "history-up",
        settings.chat_history_limit.to_string(),
        |s| s.chat_history_limit = s.chat_history_limit.saturating_sub(10),
        |s| s.chat_history_limit = s.chat_history_limit.saturating_add(10),
        cx,
    );
    let font = stepper(
        "font-down",
        "font-up",
        settings.chat_font_size.to_string(),
        |s| s.chat_font_size = s.chat_font_size.saturating_sub(1),
        |s| s.chat_font_size = s.chat_font_size.saturating_add(1),
        cx,
    );
    let width = stepper(
        "width-down",
        "width-up",
        settings.chat_sidebar_width.to_string(),
        |s| s.chat_sidebar_width = s.chat_sidebar_width.saturating_sub(10),
        |s| s.chat_sidebar_width = s.chat_sidebar_width.saturating_add(10),
        cx,
    );
    let opacity = stepper(
        "opacity-down",
        "opacity-up",
        format!("{}%", settings.chat_overlay_opacity),
        |s| s.chat_overlay_opacity = s.chat_overlay_opacity.saturating_sub(5),
        |s| s.chat_overlay_opacity = s.chat_overlay_opacity.saturating_add(5),
        cx,
    );
    let mention_volume = stepper(
        "mention-volume-down",
        "mention-volume-up",
        format!("{}%", settings.mention_sound_volume),
        |s| s.mention_sound_volume = s.mention_sound_volume.saturating_sub(10),
        |s| s.mention_sound_volume = s.mention_sound_volume.saturating_add(10).min(200),
        cx,
    );
    section("CHAT", "Chat behavior", "These settings also apply to the chat overlay.")
        .child(card(
            "Show timestamps",
            "Display the sent time before every chat message.",
            toggle("timestamps", settings.chat_timestamps).on_click(cx.listener(|_, _, _, cx| {
                preferences::update(cx, |s| s.chat_timestamps = !s.chat_timestamps)
            })),
        ))
        .child(card(
            "Recent messages",
            "Load recent chat when opening a channel. Set to 0 to disable.",
            history,
        ))
        .child(card(
            "Chat on the left",
            "Put the chat sidebar on the left of the stream.",
            toggle("chat-left", settings.chat_on_left).on_click(cx.listener(|_, _, _, cx| {
                preferences::update(cx, |s| s.chat_on_left = !s.chat_on_left)
            })),
        ))
        .child(link_preview_card(settings, cx))
        .child(card(
            "Emote autocomplete",
            "How a typed word is matched against emote names while completing with Tab.",
            choice(
                &[("complete-prefix", "prefix", "Starts with"), ("complete-substring", "substring", "Contains")],
                if settings.emote_autocomplete_match == "substring" { "substring" } else { "prefix" },
                |s, mode| s.emote_autocomplete_match = mode.into(),
                cx,
            ),
        ))
        .child(card(
            "Tab while naming someone",
            if settings.mention_tab_behavior == "cycle" {
                "Tab steps through the names after @; Enter fills in the one highlighted."
            } else {
                "Tab fills in the highlighted name after @; the arrow keys move the highlight."
            },
            choice(
                &[("mention-complete", "complete", "Fill in"), ("mention-cycle", "cycle", "Move through")],
                if settings.mention_tab_behavior == "cycle" { "cycle" } else { "complete" },
                |s, mode| s.mention_tab_behavior = mode.into(),
                cx,
            ),
        ))
        .child(card(
            "Deleted messages",
            "Replace a removed message, or keep its text faded.",
            choice(
                &[("deleted-placeholder", "placeholder", "Replace"), ("deleted-dimmed", "dimmed", "Fade")],
                if settings.chat_deleted_message_style == "dimmed" { "dimmed" } else { "placeholder" },
                |s, style| s.chat_deleted_message_style = style.into(),
                cx,
            ),
        ))
        .child(card(
            "Subscriber GIFs",
            "Draw the GIFs higher-tier subscribers send. Turned off, the description Twitch sends shows in the GIF's place instead.",
            toggle("chat-gifs", settings.chat_show_gifs).on_click(cx.listener(|_, _, _, cx| {
                preferences::update(cx, |s| s.chat_show_gifs = !s.chat_show_gifs)
            })),
        ))
        .child(card(
            "Mention sound",
            "Play a sound when someone mentions or replies to you.",
            toggle("mention-sound", settings.mention_sound_enabled).on_click(cx.listener(|_, _, _, cx| {
                preferences::update(cx, |s| s.mention_sound_enabled = !s.mention_sound_enabled);
                let s = preferences::get(cx);
                if s.mention_sound_enabled {
                    crate::sound::play_mention(&s.mention_sound_id, s.mention_sound_volume);
                }
            })),
        ))
        .when(settings.mention_sound_enabled, |list| {
            list.child(card(
                "Sound",
                "Click one to hear it.",
                div().flex().gap_1().children(crate::preferences::MENTION_SOUNDS.into_iter().map(|(id, label)| {
                    ui::button(
                        match id {
                            "chime" => "sound-chime",
                            "pop" => "sound-pop",
                            "knock" => "sound-knock",
                            _ => "sound-ping",
                        },
                        label,
                        None,
                        if settings.mention_sound_id == id { ButtonStyle::Selected } else { ButtonStyle::Secondary },
                    )
                    .px_2()
                    .h(px(30.))
                    .on_click(cx.listener(move |_, _, _, cx| {
                        preferences::update(cx, |s| s.mention_sound_id = id.into());
                        let s = preferences::get(cx);
                        crate::sound::play_mention(&s.mention_sound_id, s.mention_sound_volume);
                    }))
                })),
            ))
            .child(card("Sound volume", "Up to 200% for a louder alert.", mention_volume))
        })
        .child(card(
            "Blocked chatters",
            if settings.blocked_chat_users.is_empty() {
                "Block someone from their user card (click their name in chat). Their messages are hidden here only.".to_owned()
            } else {
                format!("{} hidden in VioletWire. Twitch is not told.", settings.blocked_chat_users.len())
            },
            div(),
        ))
        .when(!settings.blocked_chat_users.is_empty(), |list| {
            list.child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(6.))
                    .children(settings.blocked_chat_users.iter().take(200).map(|login| {
                        let unblock = login.clone();
                        div()
                            .id(gpui::SharedString::from(format!("blocked-{login}")))
                            .h(px(28.))
                            .pl(px(10.))
                            .pr(px(4.))
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .rounded(px(7.))
                            .border_1()
                            .border_color(theme::border())
                            .bg(theme::surface())
                            .text_size(px(12.))
                            .child(format!("@{login}"))
                            .child(
                                ui::icon_button(
                                    "unblock",
                                    Icon::Close,
                                    "Unblock",
                                    false,
                                )
                                .on_click(cx.listener(move |_, _, _, cx| {
                                    let unblock = unblock.clone();
                                    preferences::update(cx, |s| s.blocked_chat_users.retain(|blocked| *blocked != unblock))
                                })),
                            )
                    })),
            )
        })
        .child(card("Text size", "Message text size in pixels.", font))
        .child(card("Chat width", "Width of the chat sidebar in pixels.", width))
        .child(card("Overlay opacity", "Background opacity of chat over the video.", opacity))
}

fn emotes_section(settings: &Preferences, cx: &Context<Settings>) -> impl IntoElement {
    let size = stepper(
        "emotes-down",
        "emotes-up",
        settings.chat_emote_size.to_string(),
        |s| s.chat_emote_size = s.chat_emote_size.saturating_sub(1),
        |s| s.chat_emote_size = s.chat_emote_size.saturating_add(1),
        cx,
    );
    section("EMOTES", "Emote providers", "Provider sets load with each channel.")
        .child(card("Emote size", "Height of emotes in chat, in pixels.", size))
        .child(card(
            "Emote cache",
            format!(
                "{:.0} MB on disk. Emote images and channel emote lists load from here first.",
                crate::cache::size() as f64 / (1024. * 1024.)
            ),
            ui::button("clear-emote-cache", "Clear", None, ButtonStyle::Secondary)
                .px_3()
                .h(px(30.))
                .on_click(cx.listener(|_, _, _, cx| {
                    crate::cache::clear();
                    cx.notify();
                })),
        ))
        .children([
            ("7TV", "Global and channel emotes, zero-width overlays."),
            ("FrankerFaceZ", "Global and channel emotes, modifier effects."),
            ("BetterTTV", "Global and channel emotes, modifier effects."),
        ]
        .into_iter()
        .map(|(provider, description)| card(provider, description, ui::icon(Icon::Check, 16.).text_color(rgb(0xa78bfa)))))
}

fn appearance_section(settings: &Preferences, cx: &Context<Settings>) -> impl IntoElement {
    section("APPEARANCE", "Interface", "How VioletWire looks.").child(card(
        "OLED mode",
        "Use pure black backgrounds.",
        toggle("oled", settings.oled_mode).on_click(cx.listener(|_, _, _, cx| {
            preferences::update(cx, |s| s.oled_mode = !s.oled_mode)
        })),
    ))
}

fn about_section() -> impl IntoElement {
    section("ABOUT", "VioletWire", "A Windows Twitch viewer.")
        .child(card(
            "Version",
            concat!("VioletWire ", env!("CARGO_PKG_VERSION"), ", built in Rust with GPUI."),
            div(),
        ))
        .child(card(
            "Changes save automatically",
            "Settings are kept in %APPDATA%\\VioletWireRust.",
            div(),
        ))
}

fn stepper(
    down: &'static str,
    up: &'static str,
    label: String,
    decrease: fn(&mut Preferences),
    increase: fn(&mut Preferences),
    cx: &Context<Settings>,
) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .gap_1()
        .child(
            ui::button(down, "−", None, ButtonStyle::Secondary)
                .w(px(28.))
                .h(px(28.))
                .px_0()
                .on_click(cx.listener(move |_, _, _, cx| preferences::update(cx, decrease))),
        )
        .child(
            div()
                .w(px(36.))
                .flex()
                .justify_center()
                .text_size(px(12.))
                .child(label),
        )
        .child(
            ui::button(up, "+", None, ButtonStyle::Secondary)
                .w(px(28.))
                .h(px(28.))
                .px_0()
                .on_click(cx.listener(move |_, _, _, cx| preferences::update(cx, increase))),
        )
}
