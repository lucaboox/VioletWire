//! Browse (Twitch categories and their live streams), the search page, and
//! the dropdown under the top search box. Same data and layout as the
//! Electron client's Browse and Search sections, Twitch only for now.

use gpui::{
    AnyElement, Context, Div, FontWeight, ImageSource, ObjectFit, SharedString, Task, Window, div,
    img, prelude::*, px, rgb, rgba,
};

use super::{Auth, Root, banner, note};
use crate::format::{compact_count, is_login, uptime};
use crate::session::{self, Failure};
use crate::twitch::auth;
use crate::twitch::helix::{Category, FollowedChannel, Helix, SearchResults};
use crate::twitch::category_viewers;
use crate::theme;
use crate::ui::{self, ButtonStyle, Icon};

/// What the main area shows when no stream is open.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Section {
    Home,
    Browse,
    Search,
}

#[derive(Default)]
pub(super) struct BrowseState {
    /// Kick's directory instead of Twitch's (Electron's `browsePlatform`).
    pub kick: bool,
    pub categories: Vec<Category>,
    pub cursor: Option<String>,
    /// The category search the grid shows; empty for the top categories.
    pub query: String,
    pub loading: bool,
    pub loaded: bool,
    pub error: Option<SharedString>,
    pub selected: Option<Category>,
    pub streams: Vec<FollowedChannel>,
    pub streams_cursor: Option<String>,
    pub streams_loading: bool,
    pub task: Option<Task<()>>,
    pub streams_task: Option<Task<()>>,
    pub typing: Option<Task<()>>,
}

#[derive(Default)]
pub(super) struct SearchState {
    /// What the box held when the results were asked for.
    pub query: String,
    /// The dropdown's quick results and the page's fuller ones.
    pub quick: SearchResults,
    pub full: SearchResults,
    pub quick_loading: bool,
    pub full_loading: bool,
    pub error: Option<SharedString>,
    pub open: bool,
    pub typing: Option<Task<()>>,
    pub task: Option<Task<()>>,
    pub page_task: Option<Task<()>>,
    /// Kick channels for the same query, searched alongside, signed in or not.
    pub kick_quick: Vec<FollowedChannel>,
    pub kick_full: Vec<FollowedChannel>,
    pub kick_categories_quick: Vec<Category>,
    pub kick_categories_full: Vec<Category>,
    pub kick_loading: bool,
    pub kick_task: Option<Task<()>>,
}

const QUICK_CHANNELS: usize = 6;
const QUICK_CATEGORIES: usize = 4;
const PAGE_CHANNELS: usize = 24;
const PAGE_CATEGORIES: usize = 12;

impl Root {
    /// Runs a Helix call off the UI thread with the signed-in session,
    /// renewing the token when needed. Nothing happens while signed out.
    pub(super) fn helix_task<T: Send + 'static>(
        &mut self,
        cx: &mut Context<Self>,
        call: impl Fn(&Helix) -> anyhow::Result<T> + Send + 'static,
        done: impl FnOnce(&mut Root, Result<T, SharedString>, &mut Context<Root>) + 'static,
    ) -> Option<Task<()>> {
        let Auth::SignedIn(current) = &self.auth else {
            return None;
        };
        let current = current.clone();
        let epoch = current.epoch;
        let agent = self.agent.clone();
        Some(cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { session::with_helix(&agent, &current, call) })
                .await;
            this.update(cx, |this, cx| {
                // A request from a session that has since ended is dropped.
                if !matches!(&this.auth, Auth::SignedIn(session) if session.epoch == epoch) {
                    return;
                }
                match result {
                    Ok(fetched) => {
                        if let (Some(token), Auth::SignedIn(session)) =
                            (fetched.renewed, &mut this.auth)
                        {
                            session.token = token;
                        }
                        done(this, Ok(fetched.value), cx);
                    }
                    Err(Failure::SignedOut) => {
                        this.end_session(Some("Twitch ended the session. Sign in again."), cx)
                    }
                    Err(Failure::Other(error)) => done(this, Err(error.to_string().into()), cx),
                }
                this.queue_images(cx);
                cx.notify();
            })
            .ok();
        }))
    }

    // ----- Navigation ----------------------------------------------------

    /// Browsing away from the player: a single stream keeps playing in the
    /// corner, as Electron's mini player does; multistream closes.
    fn leave_player(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.playing.is_some() && self.multi.is_none() {
            self.minimize_player(window, cx);
        } else {
            self.close_player(window, cx);
        }
    }

    pub(super) fn show_section(&mut self, section: Section, window: &mut Window, cx: &mut Context<Self>) {
        self.leave_player(window, cx);
        self.section = section;
        self.search.open = false;
        if section == Section::Browse {
            if self.browse.selected.is_some() {
                // Browse again from a category goes back to the categories.
                self.browse.selected = None;
                self.browse.streams.clear();
                self.browse.streams_cursor = None;
            }
            // Twitch's directory needs its sign-in; Kick's does not.
            let kick = crate::preferences::get(cx).browse_kick || !matches!(self.auth, Auth::SignedIn(_));
            if kick != self.browse.kick {
                self.browse.kick = kick;
                self.browse.loaded = false;
                self.browse.categories.clear();
                self.browse.cursor = None;
            }
            if !self.browse.loaded && !self.browse.loading {
                self.load_categories(false, cx);
            }
        }
        self.queue_images(cx);
        cx.notify();
    }

    // ----- Browse --------------------------------------------------------

    /// Switches Browse between Twitch's and Kick's directories.
    pub(super) fn set_browse_kick(&mut self, kick: bool, cx: &mut Context<Self>) {
        if kick == self.browse.kick {
            return;
        }
        crate::preferences::update(cx, |prefs| prefs.browse_kick = kick);
        self.browse.kick = kick;
        self.browse.selected = None;
        self.browse.streams.clear();
        self.browse.streams_cursor = None;
        self.browse.categories.clear();
        self.browse.cursor = None;
        self.browse.loaded = false;
        self.browse.error = None;
        if kick || matches!(self.auth, Auth::SignedIn(_)) {
            self.load_categories(false, cx);
        }
        cx.notify();
    }

    pub(super) fn load_categories(&mut self, append: bool, cx: &mut Context<Self>) {
        let query = self.browse.query.clone();
        let after = append.then(|| self.browse.cursor.clone()).flatten();
        if append && after.is_none() {
            return;
        }
        self.browse.loading = true;
        self.browse.error = None;
        if self.browse.kick {
            self.browse.task = Some(cx.spawn(async move |this, cx| {
                let result = cx
                    .background_executor()
                    .spawn(async move { crate::kick::categories(&query, after.as_deref()) })
                    .await;
                this.update(cx, |this, cx| {
                    if !this.browse.kick {
                        return;
                    }
                    this.browse.loading = false;
                    this.browse.loaded = true;
                    match result {
                        Ok((categories, cursor)) => {
                            if append {
                                this.browse.categories.extend(categories);
                            } else {
                                this.browse.categories = categories;
                            }
                            this.browse.cursor = cursor;
                        }
                        Err(error) => this.browse.error = Some(error.to_string().into()),
                    }
                    this.queue_images(cx);
                    cx.notify();
                })
                .ok();
            }));
            cx.notify();
            return;
        }
        let task = self.helix_task(
            cx,
            move |helix| {
                let mut page = helix.categories(&query, after.as_deref())?;
                let ids: Vec<&str> = page.categories.iter().map(|c| c.id.as_str()).collect();
                let viewers = category_viewers::fetch(&ids);
                for category in &mut page.categories {
                    category.viewers = viewers.get(&category.id).copied();
                }
                Ok(page)
            },
            move |this, result, _| {
                this.browse.loading = false;
                this.browse.loaded = true;
                match result {
                    Ok(page) => {
                        if append {
                            this.browse.categories.extend(page.categories);
                        } else {
                            this.browse.categories = page.categories;
                        }
                        this.browse.cursor = page.cursor;
                    }
                    Err(error) => this.browse.error = Some(error),
                }
            },
        );
        self.browse.task = task;
        cx.notify();
    }

    /// Category search as you type, a moment after the last key.
    pub(super) fn category_query_changed(&mut self, cx: &mut Context<Self>) {
        let query = self.category_input.read(cx).content.trim().to_owned();
        if query == self.browse.query {
            return;
        }
        self.browse.typing = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(300))
                .await;
            this.update(cx, |this, cx| {
                this.browse.query = query;
                this.browse.selected = None;
                this.load_categories(false, cx);
            })
            .ok();
        }));
    }

    pub(super) fn open_category(&mut self, category: Category, window: &mut Window, cx: &mut Context<Self>) {
        self.leave_player(window, cx);
        // Back from a category returns to that service's categories.
        let kick = category.id.starts_with(crate::kick::PREFIX);
        if kick != self.browse.kick {
            self.browse.kick = kick;
            self.browse.categories.clear();
            self.browse.cursor = None;
            self.browse.loaded = false;
        }
        self.section = Section::Browse;
        self.search.open = false;
        self.browse.selected = Some(category);
        self.browse.streams.clear();
        self.browse.streams_cursor = None;
        self.load_category_streams(false, cx);
    }

    pub(super) fn load_category_streams(&mut self, append: bool, cx: &mut Context<Self>) {
        let Some(category) = &self.browse.selected else {
            return;
        };
        let id = category.id.clone();
        let after = append.then(|| self.browse.streams_cursor.clone()).flatten();
        if append && after.is_none() {
            return;
        }
        self.browse.streams_loading = true;
        self.browse.error = None;
        if id.starts_with(crate::kick::PREFIX) {
            // Kick's directory answers its own site, so the hidden Kick page
            // asks for it, as Electron's Kick session did.
            self.browse.streams_task = Some(cx.spawn(async move |this, cx| {
                let result = match crate::kick::category_streams_url(&id, after.as_deref()) {
                    Ok(url) => match crate::kick_web::request(cx, "GET", &url, None).await {
                        Ok((200, value)) => Ok(crate::kick::category_streams(&value)),
                        Ok((status, _)) => Err(anyhow::anyhow!("Kick answered {status}.")),
                        Err(error) => Err(error),
                    },
                    Err(error) => Err(error),
                };
                this.update(cx, |this, cx| {
                    this.browse.streams_loading = false;
                    match result {
                        Ok((streams, cursor)) => {
                            if append {
                                for stream in streams {
                                    if !this.browse.streams.iter().any(|s| s.id == stream.id) {
                                        this.browse.streams.push(stream);
                                    }
                                }
                            } else {
                                this.browse.streams = streams;
                            }
                            this.browse.streams_cursor = cursor;
                        }
                        Err(error) => this.browse.error = Some(error.to_string().into()),
                    }
                    this.queue_images(cx);
                    cx.notify();
                })
                .ok();
            }));
            cx.notify();
            return;
        }
        let task = self.helix_task(
            cx,
            move |helix| helix.category_streams(&id, after.as_deref()),
            move |this, result, _| {
                this.browse.streams_loading = false;
                match result {
                    Ok(page) => {
                        if append {
                            // Twitch's ordering shifts while paging; skip repeats.
                            for stream in page.streams {
                                if !this.browse.streams.iter().any(|s| s.id == stream.id) {
                                    this.browse.streams.push(stream);
                                }
                            }
                        } else {
                            this.browse.streams = page.streams;
                        }
                        this.browse.streams_cursor = page.cursor;
                    }
                    Err(error) => this.browse.error = Some(error),
                }
            },
        );
        self.browse.streams_task = task;
        cx.notify();
    }

    // ----- Search --------------------------------------------------------

    pub(super) fn search_text(&self, cx: &gpui::App) -> String {
        self.channel_input.read(cx).content.trim().to_owned()
    }

    /// The dropdown's results, a moment after the last key.
    /// Which services the search covers (Electron's `searchPlatformFilter`).
    pub(super) fn search_platform(cx: &gpui::App) -> Platform {
        Platform::from(crate::preferences::get(cx).search_platform.as_str())
    }

    fn search_wants(&self, cx: &gpui::App) -> (bool, bool) {
        let platform = Self::search_platform(cx);
        (platform.twitch() && matches!(self.auth, Auth::SignedIn(_)), platform.kick())
    }

    pub(super) fn search_changed(&mut self, cx: &mut Context<Self>) {
        let query = self.search_text(cx);
        if query == self.search.query && (self.search.open || query.is_empty()) {
            return;
        }
        self.search.query = query;
        self.search.open = self.search.query.chars().count() >= 2;
        self.run_quick_search(cx);
    }

    /// The dropdown's results for the current query, from the chosen services.
    fn run_quick_search(&mut self, cx: &mut Context<Self>) {
        let query = self.search.query.clone();
        self.search.quick = SearchResults::default();
        self.search.kick_quick.clear();
        self.search.kick_categories_quick.clear();
        self.search.error = None;
        let (twitch, kick) = self.search_wants(cx);
        if self.search.open && kick {
            self.search_kick(query.clone(), false, cx);
        } else {
            self.search.kick_task = None;
            self.search.kick_loading = false;
        }
        if !self.search.open || !twitch {
            self.search.quick_loading = false;
            self.search.typing = None;
            cx.notify();
            return;
        }
        self.search.quick_loading = true;
        self.search.typing = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(250))
                .await;
            this.update(cx, |this, cx| {
                let asked = query.clone();
                let task = this.helix_task(
                    cx,
                    move |helix| helix.search(&query, QUICK_CHANNELS, QUICK_CATEGORIES),
                    move |this, result, _| {
                        if this.search.query != asked {
                            return;
                        }
                        this.search.quick_loading = false;
                        match result {
                            Ok(results) => this.search.quick = results,
                            Err(error) => this.search.error = Some(error),
                        }
                    },
                );
                this.search.task = task;
            })
            .ok();
        }));
        cx.notify();
    }

    /// The Twitch / Kick / Both switch above the results.
    pub(super) fn set_search_platform(&mut self, platform: Platform, cx: &mut Context<Self>) {
        if Self::search_platform(cx) == platform {
            return;
        }
        crate::preferences::update(cx, |prefs| prefs.search_platform = platform.as_str().into());
        if self.section == Section::Search && self.playing.is_none() {
            self.run_full_search(cx);
        }
        if self.search.open {
            self.run_quick_search(cx);
        }
        cx.notify();
    }

    /// Kick's channel and category search for `query`, into the dropdown or
    /// the page.
    fn search_kick(&mut self, query: String, full: bool, cx: &mut Context<Self>) {
        self.search.kick_loading = true;
        self.search.kick_task = Some(cx.spawn(async move |this, cx| {
            // Wait for typing to settle before asking Kick.
            if !full {
                cx.background_executor().timer(std::time::Duration::from_millis(450)).await;
            }
            let asked = query.clone();
            let result = cx
                .background_executor()
                .spawn(async move { crate::kick::search(&query) })
                .await;
            this.update(cx, |this, cx| {
                if this.search.query != asked {
                    return;
                }
                this.search.kick_loading = false;
                let (channels, categories) = result
                    .map(|(channels, categories)| {
                        (channels.iter().map(crate::kick::Channel::followed).collect::<Vec<_>>(), categories)
                    })
                    .unwrap_or_default();
                if full {
                    this.search.kick_full = channels;
                    this.search.kick_categories_full = categories;
                } else {
                    this.search.kick_quick = channels.into_iter().take(QUICK_CHANNELS).collect();
                    this.search.kick_categories_quick = categories.into_iter().take(QUICK_CATEGORIES).collect();
                }
                this.queue_images(cx);
                cx.notify();
            })
            .ok();
        }));
    }

    /// Enter in the top box: the results page. A Kick address or
    /// `kick:name` opens that Kick channel; signed out with only Twitch
    /// chosen, a login opens that Twitch channel.
    pub(super) fn submit_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let query = self.search_text(cx);
        if let Some(key) = crate::kick::key_from_text(&query) {
            self.search.open = false;
            let name = key.trim_start_matches(crate::kick::PREFIX).to_owned();
            self.play(&key, name.into(), window, cx);
            return;
        }
        let login = query.strip_prefix("twitch:").unwrap_or(&query).to_ascii_lowercase();
        if query.to_ascii_lowercase().starts_with("twitch:") && is_login(&login) {
            self.search.open = false;
            self.play(&login, login.clone().into(), window, cx);
            return;
        }
        let (twitch, kick) = self.search_wants(cx);
        if !twitch && !kick {
            if is_login(&login) {
                self.search.open = false;
                self.play(&login, login.clone().into(), window, cx);
            } else {
                self.message = Some("Enter a Twitch channel login, without a URL.".into());
                cx.notify();
            }
            return;
        }
        if query.chars().count() < 2 {
            return;
        }
        self.leave_player(window, cx);
        self.section = Section::Search;
        self.search.open = false;
        self.search.query = query;
        self.run_full_search(cx);
        window.focus(&self.focus);
        cx.notify();
    }

    /// The results page for the current query, from the chosen services.
    fn run_full_search(&mut self, cx: &mut Context<Self>) {
        let query = self.search.query.clone();
        let (twitch, kick) = self.search_wants(cx);
        self.search.full = SearchResults::default();
        self.search.kick_full.clear();
        self.search.kick_categories_full.clear();
        self.search.error = None;
        if kick {
            self.search_kick(query.clone(), true, cx);
        } else {
            self.search.kick_task = None;
            self.search.kick_loading = false;
        }
        self.search.full_loading = twitch;
        if !twitch {
            self.search.page_task = None;
            return;
        }
        let asked = query.clone();
        let task = self.helix_task(
            cx,
            move |helix| helix.search(&query, PAGE_CHANNELS, PAGE_CATEGORIES),
            move |this, result, _| {
                if this.search.query != asked {
                    return;
                }
                this.search.full_loading = false;
                match result {
                    Ok(results) => this.search.full = results,
                    Err(error) => this.search.error = Some(error),
                }
            },
        );
        self.search.page_task = task;
    }

    pub(super) fn go_to_typed_channel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let login = self.search_text(cx).to_ascii_lowercase();
        if !is_login(&login) {
            return;
        }
        let name = self
            .search
            .quick
            .channels
            .iter()
            .chain(&self.search.full.channels)
            .find(|channel| channel.login == login)
            .map_or_else(|| login.clone().into(), |c| SharedString::from(c.display_name.clone()));
        self.search.open = false;
        self.play(&login, name, window, cx);
        window.focus(&self.focus);
    }

    /// Opens the typed name as a Kick channel.
    fn go_to_typed_kick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let slug = self.search_text(cx).trim().to_ascii_lowercase();
        if !crate::kick::is_slug(&slug) {
            return;
        }
        let key = format!("{}{slug}", crate::kick::PREFIX);
        let name = self
            .search
            .kick_quick
            .iter()
            .chain(&self.search.kick_full)
            .find(|channel| channel.login == key)
            .map_or_else(|| slug.clone().into(), |c| SharedString::from(c.display_name.clone()));
        self.search.open = false;
        self.play(&key, name, window, cx);
        window.focus(&self.focus);
    }

    /// Box art, search avatars and stream thumbnails the open pages show.
    pub(super) fn browse_images(&self, period: u64) -> Vec<(String, u64)> {
        let mut wanted = Vec::new();
        let showing_browse = self.section == Section::Browse && self.playing.is_none();
        if showing_browse {
            if self.browse.selected.is_some() {
                for stream in &self.browse.streams {
                    if let Some(url) = stream.stream.as_ref().and_then(|s| s.thumbnail_url.clone()) {
                        wanted.push((url, period));
                    }
                }
                for stream in &self.browse.streams {
                    if let Some(url) = &stream.profile_image_url {
                        wanted.push((url.clone(), 0));
                    }
                }
            }
            wanted.extend(
                self.browse
                    .categories
                    .iter()
                    .chain(self.browse.selected.iter())
                    .filter_map(|category| category.box_art_url.clone())
                    .map(|url| (url, 0)),
            );
        }
        let results = [
            self.search.open.then_some(&self.search.quick),
            (self.section == Section::Search && self.playing.is_none()).then_some(&self.search.full),
        ];
        let kick = [
            self.search.open.then_some(&self.search.kick_quick),
            (self.section == Section::Search && self.playing.is_none()).then_some(&self.search.kick_full),
        ];
        for channel in kick.into_iter().flatten().flatten() {
            if let Some(url) = &channel.profile_image_url {
                wanted.push((url.clone(), 0));
            }
        }
        let kick_categories = [
            self.search.open.then_some(&self.search.kick_categories_quick),
            (self.section == Section::Search && self.playing.is_none()).then_some(&self.search.kick_categories_full),
        ];
        for category in kick_categories.into_iter().flatten().flatten() {
            if let Some(url) = &category.box_art_url {
                wanted.push((url.clone(), 0));
            }
        }
        for results in results.into_iter().flatten() {
            for channel in &results.channels {
                if let Some(url) = &channel.profile_image_url {
                    wanted.push((url.clone(), 0));
                }
            }
            for category in &results.categories {
                if let Some(url) = &category.box_art_url {
                    wanted.push((url.clone(), 0));
                }
            }
        }
        wanted
    }

    // ----- Rendering -----------------------------------------------------

    pub(super) fn page_header(eyebrow: &'static str, title: impl Into<SharedString>, subtitle: impl Into<SharedString>) -> Div {
        div()
            .flex_1()
            .flex()
            .flex_col()
            .gap(px(6.))
            .min_w_0()
            .child(
                div()
                    .text_size(px(11.))
                    .font_weight(FontWeight::BOLD)
                    .text_color(theme::violet_hover())
                    .child(eyebrow),
            )
            .child(
                div()
                    .text_size(px(34.))
                    .font_weight(FontWeight::BOLD)
                    .line_height(px(40.))
                    .truncate()
                    .child(title.into()),
            )
            .child(
                div()
                    .text_size(px(14.))
                    .text_color(theme::text_dim())
                    .child(subtitle.into()),
            )
    }

    fn box_art(&self, url: Option<&str>, width: f32) -> AnyElement {
        let height = (width * 4. / 3.).round();
        match url.and_then(|url| self.image(url)) {
            Some(image) => img(ImageSource::Image(image))
                .w(px(width))
                .h(px(height))
                .flex_none()
                .rounded(px(6.))
                .object_fit(ObjectFit::Cover)
                .into_any_element(),
            None => div()
                .w(px(width))
                .h(px(height))
                .flex_none()
                .rounded(px(6.))
                .bg(theme::surface_hover())
                .into_any_element(),
        }
    }

    fn load_more(id: &'static str, loading: bool) -> gpui::Stateful<Div> {
        ui::button(
            id,
            if loading { "Loading…" } else { "Load more" },
            (!loading).then_some(Icon::ChevronDown),
            if loading { ButtonStyle::Disabled } else { ButtonStyle::Secondary },
        )
        .h(px(38.))
        .px_5()
    }

    /// Electron's `browse-platforms`: Twitch or Kick.
    fn platform_switch(&self, cx: &Context<Self>) -> impl IntoElement {
        let kick = self.browse.kick;
        div()
            .flex()
            .gap_1()
            .child(
                ui::button("browse-twitch", "Twitch", None, if kick { ButtonStyle::Ghost } else { ButtonStyle::Selected })
                    .h(px(32.))
                    .px_3()
                    .on_click(cx.listener(|this, _, _, cx| this.set_browse_kick(false, cx))),
            )
            .child(
                ui::button("browse-kick", "Kick", None, if kick { ButtonStyle::Selected } else { ButtonStyle::Ghost })
                    .h(px(32.))
                    .px_3()
                    .on_click(cx.listener(|this, _, _, cx| this.set_browse_kick(true, cx))),
            )
    }

    pub(super) fn browse_page(&self, width: f32, cx: &Context<Self>) -> AnyElement {
        if let Some(category) = &self.browse.selected {
            return self.category_page(category, width, cx);
        }
        let available = (width - 76.).max(200.);
        let columns = ((available + 18.) / (176. + 18.)).floor().clamp(2., 10.);
        let card = ((available - (columns - 1.) * 18.) / columns).floor();
        let content: AnyElement = if self.browse.categories.is_empty() {
            match (&self.browse.error, self.browse.loading) {
                (Some(error), _) => banner(error.clone()).into_any_element(),
                (None, true) => note(if self.browse.kick { "Loading Kick categories…" } else { "Loading Twitch categories…" }).into_any_element(),
                (None, false) if !self.browse.kick && !matches!(self.auth, Auth::SignedIn(_)) => {
                    note("Sign in with Twitch to browse its categories, or switch to Kick above.").into_any_element()
                }
                (None, false) => note("No categories found.").into_any_element(),
            }
        } else {
            div()
                .flex()
                .flex_wrap()
                .gap_x(px(18.))
                .gap_y(px(26.))
                .children(self.browse.categories.iter().map(|category| self.category_card(category, card, cx)))
                .into_any_element()
        };
        div()
            .id("browse")
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
                    .justify_between()
                    .gap_6()
                    .child(Self::page_header(
                        "DISCOVER",
                        if self.browse.query.is_empty() {
                            "Browse".to_owned()
                        } else {
                            format!("Categories for “{}”", self.browse.query)
                        },
                        "Find a category, then choose a live channel.",
                    ))
                    .child(div().w(px(340.)).flex_none().child(self.category_input.clone())),
            )
            .child(self.platform_switch(cx))
            .when(!self.browse.categories.is_empty(), |page| {
                page.when_some(self.browse.error.clone(), |page, error| page.child(banner(error)))
            })
            .child(content)
            .when(self.browse.cursor.is_some() && !self.browse.categories.is_empty(), |page| {
                page.child(
                    div().flex().justify_center().pb_4().child(
                        Self::load_more("more-categories", self.browse.loading)
                            .on_click(cx.listener(|this, _, _, cx| this.load_categories(true, cx))),
                    ),
                )
            })
            .into_any_element()
    }

    fn category_card(&self, category: &Category, width: f32, cx: &Context<Self>) -> AnyElement {
        let chosen = category.clone();
        let group = SharedString::from(format!("category-{}", category.id));
        div()
            .id(group.clone())
            .group(group.clone())
            .w(px(width))
            .flex()
            .flex_col()
            .gap(px(8.))
            .cursor_pointer()
            .child(
                div()
                    .rounded(px(7.))
                    .border_2()
                    .border_color(rgba(0))
                    .group_hover(group, |style| style.border_color(theme::violet()))
                    .child(self.box_art(category.box_art_url.as_deref(), width - 4.)),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .child(
                        div()
                            .truncate()
                            .text_size(px(14.))
                            .font_weight(FontWeight::BOLD)
                            .child(category.name.clone()),
                    )
                    .child(
                        div()
                            .text_size(px(13.))
                            .text_color(theme::text_dim())
                            .child(match category.viewers {
                                Some(viewers) => format!("{} viewers", compact_count(viewers)),
                                None => "View live channels".to_owned(),
                            }),
                    ),
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                this.open_category(chosen.clone(), window, cx)
            }))
            .into_any_element()
    }

    fn category_page(&self, category: &Category, width: f32, cx: &Context<Self>) -> AnyElement {
        let available = (width - 76.).max(200.);
        let columns = ((available + 16.) / 316.).floor().max(1.);
        let card = ((available - (columns - 1.) * 16.) / columns).floor();
        let now = auth::now();
        let content: AnyElement = if self.browse.streams.is_empty() {
            match (&self.browse.error, self.browse.streams_loading) {
                (Some(error), _) => banner(error.clone()).into_any_element(),
                (None, true) => note("Loading live channels…").into_any_element(),
                (None, false) => note("Nobody is live in this category right now.").into_any_element(),
            }
        } else {
            div()
                .flex()
                .flex_wrap()
                .gap_x_4()
                .gap_y_7()
                .children(
                    self.browse
                        .streams
                        .iter()
                        .map(|stream| self.card(stream, now, card, cx)),
                )
                .into_any_element()
        };
        div()
            .id("category")
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
                    .items_center()
                    .gap_5()
                    .child(
                        ui::icon_button("browse-back", Icon::Back, "Back to Browse", false)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.browse.selected = None;
                                this.browse.streams.clear();
                                this.browse.streams_cursor = None;
                                this.queue_images(cx);
                                cx.notify();
                            })),
                    )
                    .child(self.box_art(category.box_art_url.as_deref(), 72.))
                    .child(Self::page_header(
                        "CATEGORY",
                        category.name.clone(),
                        match category.viewers {
                            Some(viewers) => format!("{} viewers · live channels, most watched first", compact_count(viewers)),
                            None => "Live channels, most watched first".to_owned(),
                        },
                    )),
            )
            .child(content)
            .when(self.browse.streams_cursor.is_some() && !self.browse.streams.is_empty(), |page| {
                page.child(
                    div().flex().justify_center().pb_4().child(
                        Self::load_more("more-streams", self.browse.streams_loading)
                            .on_click(cx.listener(|this, _, _, cx| this.load_category_streams(true, cx))),
                    ),
                )
            })
            .into_any_element()
    }

    pub(super) fn search_page(&self, width: f32, cx: &Context<Self>) -> AnyElement {
        let query = self.search.query.clone();
        let results = &self.search.full;
        let platform = Self::search_platform(cx);
        let signed_in = matches!(self.auth, Auth::SignedIn(_));
        let available = (width - 76.).max(200.);
        let columns = ((available + 14.) / (300. + 14.)).floor().max(1.);
        let channel_width = ((available - (columns - 1.) * 14.) / columns).floor();
        let now = auth::now();
        let mut page = div()
            .id("search")
            .flex_1()
            .min_w_0()
            .h_full()
            .overflow_y_scroll()
            .px(px(38.))
            .py(px(30.))
            .flex()
            .flex_col()
            .gap(px(26.))
            .child(
                div()
                    .flex_none()
                    .flex()
                    .items_end()
                    .justify_between()
                    .gap_6()
                    .child(Self::page_header(
                        "SEARCH",
                        format!("Results for “{query}”"),
                        "Channels and categories across the services you choose.",
                    ))
                    .child(div().w(px(330.)).flex_none().child(platform_switch("search-page", platform, false, cx))),
            );
        let lowered = query.trim().to_ascii_lowercase();
        let go_twitch = platform.twitch() && is_login(&lowered);
        let go_kick = platform.kick() && crate::kick::is_slug(&lowered);
        if go_twitch || go_kick {
            page = page.child(
                div()
                    .flex_none()
                    .flex()
                    .gap_2()
                    .when(go_twitch, |row| {
                        row.child(direct_button("search-direct", &query, false).on_click(
                            cx.listener(|this, _, window, cx| this.go_to_typed_channel(window, cx)),
                        ))
                    })
                    .when(go_kick, |row| {
                        row.child(direct_button("search-direct-kick", &query, true).on_click(
                            cx.listener(|this, _, window, cx| this.go_to_typed_kick(window, cx)),
                        ))
                    }),
            );
        }
        let twitch_loading = platform.twitch() && self.search.full_loading;
        let kick_loading = platform.kick() && self.search.kick_loading;
        if twitch_loading || kick_loading {
            page = page.child(note(match (twitch_loading, kick_loading) {
                (true, true) => "Searching…",
                (true, false) => "Searching Twitch…",
                _ => "Searching Kick…",
            }));
        }
        if platform == Platform::Twitch && !signed_in {
            page = page.child(note("Sign in with Twitch to search its channels and categories, or switch to Kick above."));
        }
        if let Some(error) = &self.search.error {
            page = page.child(banner(error.clone()));
        }
        let categories = |label: &'static str, kick: bool, list: &[Category]| {
            div()
                .flex_none()
                .flex()
                .flex_col()
                .gap_3()
                .child(provider_section_heading(label, Some(kick)))
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_x(px(16.))
                        .gap_y(px(20.))
                        .children(list.iter().map(|category| self.category_card(category, 150., cx))),
                )
        };
        let channels = |label: &'static str, kick: bool, list: &[FollowedChannel]| {
            div()
                .flex_none()
                .flex()
                .flex_col()
                .gap_3()
                .child(provider_section_heading(label, Some(kick)))
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap(px(14.))
                        .children(list.iter().map(|channel| self.search_channel_card(channel, channel_width, now, cx))),
                )
        };
        if platform.twitch() && !results.categories.is_empty() {
            page = page.child(categories("TWITCH CATEGORIES", false, &results.categories));
        }
        if platform.kick() && !self.search.kick_categories_full.is_empty() {
            page = page.child(categories("KICK CATEGORIES", true, &self.search.kick_categories_full));
        }
        if platform.twitch() && !results.channels.is_empty() {
            page = page.child(channels("TWITCH", false, &results.channels));
        }
        if platform.kick() && !self.search.kick_full.is_empty() {
            page = page.child(channels("KICK", true, &self.search.kick_full));
        }
        let empty = results.channels.is_empty()
            && results.categories.is_empty()
            && self.search.kick_full.is_empty()
            && self.search.kick_categories_full.is_empty();
        if empty && !twitch_loading && !kick_loading && self.search.error.is_none() && (signed_in || platform.kick()) {
            page = page.child(note("No channels or categories found."));
        }
        page.into_any_element()
    }

    fn search_channel_card(&self, channel: &FollowedChannel, width: f32, now: u64, cx: &Context<Self>) -> AnyElement {
        let login = channel.login.clone();
        let name = SharedString::from(channel.display_name.clone());
        div()
            .id(SharedString::from(format!("search-channel-{}", channel.id)))
            .w(px(width))
            .h(px(76.))
            .px_3()
            .flex()
            .items_center()
            .gap_3()
            .rounded(px(10.))
            .border_1()
            .border_color(theme::border())
            .bg(theme::surface())
            .cursor_pointer()
            .hover(|style| style.bg(theme::surface_hover()).border_color(theme::selected_border()))
            .child(self.avatar(channel.profile_image_url.as_deref(), 48.))
            .child(channel_text(channel, now, 14.))
            .on_click(cx.listener(move |this, _, window, cx| this.play(&login, name.clone(), window, cx)))
            .into_any_element()
    }

    /// The panel under the top search box: Electron's `top-search-results`.
    pub(super) fn search_dropdown(&self, cx: &Context<Self>) -> Option<AnyElement> {
        if !self.search.open {
            return None;
        }
        let query = self.search.query.clone();
        let signed_in = matches!(self.auth, Auth::SignedIn(_));
        let platform = Self::search_platform(cx);
        let results = &self.search.quick;
        let now = auth::now();
        let mut panel = div()
            .id("search-dropdown")
            .w_full()
            .max_h(px(520.))
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
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .pb(px(6.))
                    .mb(px(4.))
                    .border_b_1()
                    .border_color(theme::border())
                    .child(platform_switch("search-dropdown", platform, true, cx)),
            );
        let lowered = query.trim().to_ascii_lowercase();
        if platform.twitch() && is_login(&lowered) {
            panel = panel.child(
                dropdown_row("search-go-to")
                    .child(ui::provider_logo(false, 16.))
                    .child(div().truncate().child(format!("Go to {} on Twitch", query.trim())))
                    .on_click(cx.listener(|this, _, window, cx| this.go_to_typed_channel(window, cx))),
            );
        }
        if platform.kick() && crate::kick::is_slug(&lowered) {
            panel = panel.child(
                dropdown_row("search-go-to-kick")
                    .child(ui::provider_logo(true, 16.))
                    .child(div().truncate().child(format!("Go to {} on Kick", query.trim())))
                    .on_click(cx.listener(|this, _, window, cx| this.go_to_typed_kick(window, cx))),
            );
        }
        let twitch_loading = platform.twitch() && signed_in && self.search.quick_loading;
        let kick_loading = platform.kick() && self.search.kick_loading;
        if twitch_loading || kick_loading {
            panel = panel.child(dropdown_state(match (twitch_loading, kick_loading) {
                (true, true) => "Searching…",
                (true, false) => "Searching Twitch…",
                _ => "Searching Kick…",
            }));
        }
        if platform.twitch() && !signed_in {
            panel = panel.child(dropdown_state("Sign in to search Twitch channels and categories."));
        }
        if let Some(error) = &self.search.error {
            panel = panel.child(dropdown_state(error.clone()));
        }
        let category_rows = |mut panel: gpui::Stateful<Div>, label: &'static str, kick: bool, list: &[Category]| {
            if list.is_empty() {
                return panel;
            }
            panel = panel.child(provider_dropdown_heading(label, None));
            for category in list {
                let chosen = category.clone();
                panel = panel.child(
                    dropdown_row(SharedString::from(format!("search-category-{}", category.id)))
                        .child(self.box_art(category.box_art_url.as_deref(), 30.))
                        .child(
                            div()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .child(div().truncate().font_weight(FontWeight::SEMIBOLD).child(category.name.clone()))
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(4.))
                                        .text_size(px(11.))
                                        .text_color(theme::text_dim())
                                        .child(ui::provider_logo(kick, 12.))
                                        .child("Category"),
                                ),
                        )
                        .on_click(cx.listener(move |this, _, window, cx| this.open_category(chosen.clone(), window, cx))),
                );
            }
            panel
        };
        let channel_rows = |mut panel: gpui::Stateful<Div>, label: &'static str, kick: bool, list: &[FollowedChannel]| {
            if list.is_empty() {
                return panel;
            }
            panel = panel.child(provider_dropdown_heading(label, Some(kick)));
            for channel in list {
                let login = channel.login.clone();
                let name = SharedString::from(channel.display_name.clone());
                panel = panel.child(
                    dropdown_row(SharedString::from(format!("search-result-{}", channel.id)))
                        .child(self.avatar(channel.profile_image_url.as_deref(), 32.))
                        .child(channel_text(channel, now, 13.))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.search.open = false;
                            this.play(&login, name.clone(), window, cx);
                        })),
                );
            }
            panel
        };
        if platform.twitch() {
            panel = category_rows(panel, "Twitch categories", false, &results.categories);
        }
        if platform.kick() {
            panel = category_rows(panel, "Kick categories", true, &self.search.kick_categories_quick);
        }
        if platform.twitch() {
            panel = channel_rows(panel, "Twitch", false, &results.channels);
        }
        if platform.kick() {
            panel = channel_rows(panel, "Kick", true, &self.search.kick_quick);
        }
        let empty = results.channels.is_empty()
            && results.categories.is_empty()
            && self.search.kick_quick.is_empty()
            && self.search.kick_categories_quick.is_empty();
        if empty && !twitch_loading && !kick_loading && self.search.error.is_none() && (signed_in || platform.kick()) {
            panel = panel.child(dropdown_state("No channels or categories found."));
        }
        Some(panel.into_any_element())
    }
}

/// Twitch, Kick, or both (Electron's `followedPlatforms` and search filter).
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Platform {
    Twitch,
    Kick,
    Both,
}

impl Platform {
    pub fn twitch(self) -> bool {
        self != Self::Kick
    }
    pub fn kick(self) -> bool {
        self != Self::Twitch
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Twitch => "twitch",
            Self::Kick => "kick",
            Self::Both => "both",
        }
    }
}

impl From<&str> for Platform {
    fn from(text: &str) -> Self {
        match text {
            "twitch" => Self::Twitch,
            "kick" => Self::Kick,
            _ => Self::Both,
        }
    }
}

/// Electron's three-way service switch: `compact` for the dropdown's row,
/// otherwise the search page's. Picking one re-runs the search.
fn platform_switch(id: &'static str, current: Platform, compact: bool, cx: &Context<Root>) -> impl IntoElement {
    div()
        .flex()
        .gap(px(4.))
        .children([Platform::Twitch, Platform::Kick, Platform::Both].into_iter().map(|option| {
            let active = option == current;
            div()
                .id(SharedString::from(format!("{id}-{}", option.as_str())))
                .flex_1()
                .h(px(if compact { 30. } else { 34. }))
                .flex()
                .items_center()
                .justify_center()
                .gap(px(5.))
                .rounded(px(7.))
                .border_1()
                .border_color(if active { rgb(0x6d28d9).into() } else { gpui::transparent_black() })
                .when(active, |button| button.bg(rgb(0x2a1f3d)))
                .text_size(px(12.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(if active { rgb(0xf4f4f5) } else { rgb(0xa1a1aa) })
                .cursor_pointer()
                .hover(|style| style.bg(rgb(0x232329)).text_color(rgb(0xf4f4f5)))
                .children(service_logos(option, 13.))
                .child(match option {
                    Platform::Twitch => "Twitch",
                    Platform::Kick => "Kick",
                    Platform::Both => "Both",
                })
                .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |this, _, _, cx| this.set_search_platform(option, cx)))
        }))
}

/// The logos for a service choice: one, or Twitch's and Kick's together.
pub(super) fn service_logos(platform: Platform, size: f32) -> Vec<gpui::Svg> {
    match platform {
        Platform::Twitch => vec![ui::provider_logo(false, size)],
        Platform::Kick => vec![ui::provider_logo(true, size)],
        Platform::Both => vec![ui::provider_logo(false, size), ui::provider_logo(true, size)],
    }
}

/// "Go to NAME on Twitch/Kick", on the search page.
fn direct_button(id: &'static str, name: &str, kick: bool) -> gpui::Stateful<Div> {
    div()
        .id(id)
        .h(px(40.))
        .px_4()
        .flex()
        .items_center()
        .gap_2()
        .rounded(px(8.))
        .border_1()
        .border_color(theme::button_border())
        .bg(theme::button())
        .text_size(px(13.))
        .cursor_pointer()
        .hover(|style| style.bg(theme::button_hover()))
        .child(ui::provider_logo(kick, 15.))
        .child("Go to")
        .child(div().font_weight(FontWeight::BOLD).child(name.trim().to_owned()))
        .child(if kick { "on Kick" } else { "on Twitch" })
}

fn provider_section_heading(text: &'static str, kick: Option<bool>) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(6.))
        .text_size(px(11.))
        .font_weight(FontWeight::BOLD)
        .text_color(theme::text_dim())
        .when_some(kick, |row, kick| row.child(ui::provider_logo(kick, 13.)))
        .child(text)
}

fn provider_dropdown_heading(text: &'static str, kick: Option<bool>) -> Div {
    div()
        .px(px(10.))
        .pt(px(10.))
        .pb(px(4.))
        .flex()
        .items_center()
        .gap(px(5.))
        .text_size(px(10.))
        .font_weight(FontWeight::BOLD)
        .text_color(theme::text_dim())
        .when_some(kick, |row, kick| row.child(ui::provider_logo(kick, 11.)))
        .child(text.to_uppercase())
}

fn dropdown_row(id: impl Into<gpui::ElementId>) -> gpui::Stateful<Div> {
    div()
        .id(id)
        .min_h(px(44.))
        .px(px(10.))
        .py(px(6.))
        .flex()
        .items_center()
        .gap(px(10.))
        .rounded(px(7.))
        .text_size(px(13.))
        .cursor_pointer()
        .hover(|style| style.bg(theme::selected()))
}

fn dropdown_state(text: impl Into<SharedString>) -> Div {
    div()
        .px(px(10.))
        .py(px(12.))
        .text_size(px(13.))
        .text_color(theme::text_dim())
        .child(text.into())
}

/// Name with a LIVE pill, then "category · viewers · uptime" or "Offline".
fn channel_text(channel: &FollowedChannel, now: u64, size: f32) -> Div {
    let detail = match &channel.stream {
        Some(stream) => [
            Some(if stream.game_name.is_empty() {
                "Live channel".to_owned()
            } else {
                stream.game_name.clone()
            }),
            // Kick's search gives no viewer count.
            (stream.viewer_count > 0).then(|| format!("{} viewers", compact_count(stream.viewer_count))),
            uptime(&stream.started_at, now),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · "),
        None => "Offline".to_owned(),
    };
    div()
        .flex_1()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(2.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .min_w_0()
                .child(
                    div()
                        .truncate()
                        .text_size(px(size))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(channel.display_name.clone()),
                )
                .when(channel.stream.is_some(), |row| {
                    row.child(
                        div()
                            .flex_none()
                            .px(px(5.))
                            .rounded(px(4.))
                            .bg(theme::live())
                            .text_size(px(9.))
                            .font_weight(FontWeight::BOLD)
                            .text_color(rgb(0xffffff))
                            .child("LIVE"),
                    )
                }),
        )
        .child(
            div()
                .min_w_0()
                .flex()
                .items_center()
                .gap(px(4.))
                .text_size(px(size - 2.))
                .text_color(theme::text_dim())
                .child(ui::provider_logo(channel.login.starts_with(crate::kick::PREFIX), size - 2.))
                .child(div().truncate().child(detail)),
        )
}
