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

    pub(super) fn show_section(&mut self, section: Section, window: &mut Window, cx: &mut Context<Self>) {
        self.close_player(window, cx);
        self.section = section;
        self.search.open = false;
        if section == Section::Browse {
            if self.browse.selected.is_some() {
                // Browse again from a category goes back to the categories.
                self.browse.selected = None;
                self.browse.streams.clear();
                self.browse.streams_cursor = None;
            }
            if !self.browse.loaded && !self.browse.loading {
                self.load_categories(false, cx);
            }
        }
        self.queue_images(cx);
        cx.notify();
    }

    // ----- Browse --------------------------------------------------------

    pub(super) fn load_categories(&mut self, append: bool, cx: &mut Context<Self>) {
        let query = self.browse.query.clone();
        let after = append.then(|| self.browse.cursor.clone()).flatten();
        if append && after.is_none() {
            return;
        }
        self.browse.loading = true;
        self.browse.error = None;
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
        self.close_player(window, cx);
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
    pub(super) fn search_changed(&mut self, cx: &mut Context<Self>) {
        let query = self.search_text(cx);
        if query == self.search.query && (self.search.open || query.is_empty()) {
            return;
        }
        self.search.query = query.clone();
        self.search.open = query.chars().count() >= 2;
        self.search.quick = SearchResults::default();
        self.search.error = None;
        if !self.search.open || !matches!(self.auth, Auth::SignedIn(_)) {
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

    /// Enter in the top box: the results page when signed in; otherwise (or
    /// for an exact login with no sign-in) open the channel directly.
    pub(super) fn submit_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let query = self.search_text(cx);
        let login = query.to_ascii_lowercase();
        if !matches!(self.auth, Auth::SignedIn(_)) {
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
        self.close_player(window, cx);
        self.section = Section::Search;
        self.search.open = false;
        self.search.full = SearchResults::default();
        self.search.full_loading = true;
        self.search.error = None;
        self.search.query = query.clone();
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
        window.focus(&self.focus);
        cx.notify();
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
                (None, true) => note("Loading Twitch categories…").into_any_element(),
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
        let available = (width - 76.).max(200.);
        let columns = ((available + 14.) / (300. + 14.)).floor().max(1.);
        let channel_width = ((available - (columns - 1.) * 14.) / columns).floor();
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
            .child(div().flex().child(Self::page_header(
                "SEARCH",
                format!("Results for “{query}”"),
                "Channels and categories on Twitch.",
            )));
        if is_login(&query.to_ascii_lowercase()) {
            page = page.child(
                div().flex().child(
                    ui::button("search-direct", format!("Go to {query} on Twitch"), Some(Icon::Forward), ButtonStyle::Secondary)
                        .h(px(40.))
                        .px_4()
                        .on_click(cx.listener(|this, _, window, cx| this.go_to_typed_channel(window, cx))),
                ),
            );
        }
        if self.search.full_loading {
            return page.child(note("Searching Twitch…")).into_any_element();
        }
        if let Some(error) = &self.search.error {
            page = page.child(banner(error.clone()));
        }
        if !results.categories.is_empty() {
            page = page.child(
                div()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(section_heading("CATEGORIES"))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap_x(px(16.))
                            .gap_y(px(20.))
                            .children(results.categories.iter().map(|category| self.category_card(category, 150., cx))),
                    ),
            );
        }
        if !results.channels.is_empty() {
            let now = auth::now();
            page = page.child(
                div()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(section_heading("CHANNELS"))
                    .child(
                        div().flex().flex_wrap().gap(px(14.)).children(
                            results
                                .channels
                                .iter()
                                .map(|channel| self.search_channel_card(channel, channel_width, now, cx)),
                        ),
                    ),
            );
        }
        if results.channels.is_empty() && results.categories.is_empty() && self.search.error.is_none() {
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

    /// The panel under the top search box.
    pub(super) fn search_dropdown(&self, cx: &Context<Self>) -> Option<AnyElement> {
        if !self.search.open {
            return None;
        }
        let query = self.search.query.clone();
        let signed_in = matches!(self.auth, Auth::SignedIn(_));
        let results = &self.search.quick;
        let now = auth::now();
        let mut panel = div()
            .id("search-dropdown")
            .w_full()
            .max_h(px(470.))
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
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation());
        if is_login(&query.to_ascii_lowercase()) {
            panel = panel.child(
                dropdown_row("search-go-to")
                    .child(ui::icon(Icon::Forward, 16.).text_color(theme::violet_hover()))
                    .child(
                        div()
                            .truncate()
                            .child(format!("Go to {query} on Twitch")),
                    )
                    .on_click(cx.listener(|this, _, window, cx| this.go_to_typed_channel(window, cx))),
            );
        }
        if !signed_in {
            return Some(
                panel
                    .child(dropdown_state("Sign in to search Twitch channels and categories."))
                    .into_any_element(),
            );
        }
        if self.search.quick_loading {
            return Some(panel.child(dropdown_state("Searching Twitch…")).into_any_element());
        }
        if let Some(error) = &self.search.error {
            return Some(panel.child(dropdown_state(error.clone())).into_any_element());
        }
        if !results.categories.is_empty() {
            panel = panel.child(dropdown_heading("Categories"));
            for category in &results.categories {
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
                                .child(div().text_size(px(11.)).text_color(theme::text_dim()).child("Category")),
                        )
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.open_category(chosen.clone(), window, cx)
                        })),
                );
            }
        }
        if !results.channels.is_empty() {
            panel = panel.child(dropdown_heading("Channels"));
            for channel in &results.channels {
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
        }
        if results.channels.is_empty() && results.categories.is_empty() {
            panel = panel.child(dropdown_state("No channels or categories found."));
        }
        Some(panel.into_any_element())
    }
}

fn section_heading(text: &'static str) -> Div {
    div()
        .text_size(px(11.))
        .font_weight(FontWeight::BOLD)
        .text_color(theme::text_dim())
        .child(text)
}

fn dropdown_heading(text: &'static str) -> Div {
    div()
        .px(px(10.))
        .pt(px(10.))
        .pb(px(4.))
        .text_size(px(10.))
        .font_weight(FontWeight::BOLD)
        .text_color(theme::text_dim())
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
            Some(format!("{} viewers", compact_count(stream.viewer_count))),
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
                .truncate()
                .text_size(px(size - 2.))
                .text_color(theme::text_dim())
                .child(detail),
        )
}
