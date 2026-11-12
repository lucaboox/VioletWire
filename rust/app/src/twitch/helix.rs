//! Helix (Twitch's official API) reads: the followed list, browsing
//! categories and their live streams, and search.

use std::collections::HashMap;
use std::fmt;

use anyhow::{Context as _, Result, bail};
use serde::Deserialize;
use serde::de::DeserializeOwned;

use super::auth::CLIENT_ID;
use crate::http::short_message;

const HELIX: &str = "https://api.twitch.tv/helix";
/// 100 per page; 50 pages bounds a runaway cursor at 5,000 follows.
const MAX_PAGES: usize = 50;

/// Twitch refused the token. The caller refreshes it once and retries.
#[derive(Debug)]
pub struct Unauthorized;

impl fmt::Display for Unauthorized {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Twitch asked VioletWire to sign in again.")
    }
}

impl std::error::Error for Unauthorized {}

#[derive(Debug, Clone)]
pub struct FollowedChannel {
    pub id: String,
    pub login: String,
    pub display_name: String,
    pub profile_image_url: Option<String>,
    pub stream: Option<LiveStream>,
}

#[derive(Debug, Clone)]
pub struct LiveStream {
    pub title: String,
    pub game_name: String,
    pub viewer_count: u64,
    pub started_at: String,
    pub thumbnail_url: Option<String>,
    pub language: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Category {
    pub id: String,
    pub name: String,
    pub box_art_url: Option<String>,
    /// From Twitch's public GraphQL; absent when that is unavailable.
    pub viewers: Option<u64>,
}

pub struct CategoryPage {
    pub categories: Vec<Category>,
    pub cursor: Option<String>,
}

/// Live streams in a category; each is a channel with its stream.
pub struct StreamPage {
    pub streams: Vec<FollowedChannel>,
    pub cursor: Option<String>,
}

#[derive(Default)]
pub struct SearchResults {
    /// Live ones carry their stream; offline ones have none.
    pub channels: Vec<FollowedChannel>,
    pub categories: Vec<Category>,
}

#[derive(Deserialize)]
struct Page<T> {
    data: Vec<T>,
    #[serde(default)]
    pagination: Pagination,
}

#[derive(Deserialize, Default)]
struct Pagination {
    cursor: Option<String>,
}

#[derive(Deserialize)]
struct Followed {
    broadcaster_id: String,
    broadcaster_login: String,
    broadcaster_name: String,
}

#[derive(Deserialize)]
struct Stream {
    user_id: String,
    #[serde(default)]
    game_name: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    viewer_count: u64,
    #[serde(default)]
    started_at: String,
    #[serde(default)]
    thumbnail_url: String,
    #[serde(default)]
    language: String,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    user_login: String,
    #[serde(default)]
    user_name: String,
}

impl Stream {
    fn into_live(self) -> LiveStream {
        LiveStream {
            thumbnail_url: sized_thumbnail(&self.thumbnail_url, 640, 360),
            title: self.title,
            game_name: self.game_name,
            viewer_count: self.viewer_count,
            started_at: self.started_at,
            language: self.language,
            tags: self.tags.unwrap_or_default(),
        }
    }
}

#[derive(Deserialize)]
struct Game {
    id: String,
    name: String,
    #[serde(default)]
    box_art_url: String,
}

#[derive(Deserialize)]
struct SearchChannel {
    id: String,
    broadcaster_login: String,
    display_name: String,
    #[serde(default)]
    thumbnail_url: String,
    #[serde(default)]
    is_live: bool,
}

#[derive(Deserialize)]
struct User {
    id: String,
    #[serde(default)]
    profile_image_url: String,
}

pub struct Helix<'a> {
    agent: &'a ureq::Agent,
    access_token: &'a str,
}

impl<'a> Helix<'a> {
    pub fn new(agent: &'a ureq::Agent, access_token: &'a str) -> Self {
        Self { agent, access_token }
    }

    /// Live channels first by viewers, then offline ones in follow order,
    /// the same order the Electron sidebar uses.
    pub fn followed_channels(&self, user_id: &str) -> Result<Vec<FollowedChannel>> {
        let followed: Vec<Followed> = self.all("/channels/followed", &[("user_id", user_id)])?;
        let streams: Vec<Stream> = self.all("/streams/followed", &[("user_id", user_id)])?;
        let ids: Vec<&str> = followed.iter().map(|item| item.broadcaster_id.as_str()).collect();
        let images = self.profile_images(&ids)?;
        let mut live: HashMap<String, Stream> = streams
            .into_iter()
            .map(|stream| (stream.user_id.clone(), stream))
            .collect();

        let mut channels: Vec<FollowedChannel> = followed
            .into_iter()
            .map(|item| FollowedChannel {
                profile_image_url: images
                    .get(&item.broadcaster_id)
                    .and_then(|url| sized_profile_image(url, 70)),
                stream: live.remove(&item.broadcaster_id).map(Stream::into_live),
                id: item.broadcaster_id,
                login: item.broadcaster_login,
                display_name: item.broadcaster_name,
            })
            .collect();
        // Stable sort keeps offline channels in follow order.
        channels.sort_by(|left, right| {
            let viewers = |channel: &FollowedChannel| channel.stream.as_ref().map(|s| s.viewer_count);
            viewers(right).cmp(&viewers(left))
        });
        Ok(channels)
    }

    /// Top categories by viewers, or categories matching `query`, 30 a page.
    pub fn categories(&self, query: &str, after: Option<&str>) -> Result<CategoryPage> {
        let query = query.trim();
        let mut params = vec![("first", "30")];
        if !query.is_empty() {
            params.push(("query", query));
        }
        if let Some(after) = after {
            params.push(("after", after));
        }
        let path = if query.is_empty() { "/games/top" } else { "/search/categories" };
        let page: Page<Game> = self.get(path, &params)?;
        Ok(CategoryPage {
            categories: page.data.into_iter().map(category).collect(),
            cursor: page.pagination.cursor.filter(|cursor| !cursor.is_empty()),
        })
    }

    /// A category's live streams, most watched first, 30 a page.
    pub fn category_streams(&self, game_id: &str, after: Option<&str>) -> Result<StreamPage> {
        let mut params = vec![("game_id", game_id), ("first", "30")];
        if let Some(after) = after {
            params.push(("after", after));
        }
        let page: Page<Stream> = self.get("/streams", &params)?;
        let ids: Vec<&str> = page.data.iter().map(|stream| stream.user_id.as_str()).collect();
        let images = self.profile_images(&ids)?;
        let streams = page
            .data
            .into_iter()
            .map(|stream| FollowedChannel {
                id: stream.user_id.clone(),
                login: stream.user_login.clone(),
                display_name: stream.user_name.clone(),
                profile_image_url: images
                    .get(&stream.user_id)
                    .and_then(|url| sized_profile_image(url, 70)),
                stream: Some(stream.into_live()),
            })
            .collect();
        Ok(StreamPage {
            streams,
            cursor: page.pagination.cursor.filter(|cursor| !cursor.is_empty()),
        })
    }

    /// Channels and categories matching `query`. Live channels are filled in
    /// with one batched streams request, since search omits viewer counts.
    pub fn search(&self, query: &str, channels: usize, categories: usize) -> Result<SearchResults> {
        let query = query.trim();
        if query.chars().count() < 2 {
            return Ok(SearchResults::default());
        }
        let first_channels = channels.clamp(1, 100).to_string();
        let first_categories = categories.clamp(1, 100).to_string();
        let found: Page<SearchChannel> = self.get(
            "/search/channels",
            &[("query", query), ("first", &first_channels), ("live_only", "false")],
        )?;
        let games: Page<Game> = self.get(
            "/search/categories",
            &[("query", query), ("first", &first_categories)],
        )?;
        let live_ids: Vec<(&str, &str)> = found
            .data
            .iter()
            .filter(|channel| channel.is_live)
            .map(|channel| ("user_id", channel.id.as_str()))
            .take(100)
            .collect();
        let mut live: HashMap<String, Stream> = if live_ids.is_empty() {
            HashMap::new()
        } else {
            let page: Page<Stream> = self.get("/streams", &live_ids)?;
            page.data
                .into_iter()
                .map(|stream| (stream.user_id.clone(), stream))
                .collect()
        };
        let channels = found
            .data
            .into_iter()
            .map(|channel| FollowedChannel {
                stream: live.remove(&channel.id).map(Stream::into_live),
                profile_image_url: sized_profile_image(&channel.thumbnail_url, 70),
                id: channel.id,
                login: channel.broadcaster_login,
                display_name: channel.display_name,
            })
            .collect();
        Ok(SearchResults {
            channels,
            categories: games.data.into_iter().map(category).collect(),
        })
    }

    fn profile_images(&self, ids: &[&str]) -> Result<HashMap<String, String>> {
        let mut images = HashMap::new();
        for chunk in ids.chunks(100) {
            let query: Vec<(&str, &str)> = chunk.iter().map(|id| ("id", *id)).collect();
            let page: Page<User> = self.get("/users", &query)?;
            images.extend(page.data.into_iter().map(|user| (user.id, user.profile_image_url)));
        }
        Ok(images)
    }

    fn all<T: DeserializeOwned>(&self, path: &str, query: &[(&str, &str)]) -> Result<Vec<T>> {
        let mut items = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let mut params = query.to_vec();
            params.push(("first", "100"));
            if let Some(after) = cursor.as_deref() {
                params.push(("after", after));
            }
            let page: Page<T> = self.get(path, &params)?;
            let empty = page.data.is_empty();
            items.extend(page.data);
            cursor = page.pagination.cursor.filter(|next| !next.is_empty());
            if cursor.is_none() || empty {
                break;
            }
        }
        Ok(items)
    }

    fn get<T: DeserializeOwned>(&self, path: &str, query: &[(&str, &str)]) -> Result<T> {
        let mut request = self
            .agent
            .get(format!("{HELIX}{path}"))
            .header("Client-Id", CLIENT_ID)
            .header("Authorization", format!("Bearer {}", self.access_token));
        for (key, value) in query {
            request = request.query(key, value);
        }
        let mut response = request.call().context("Could not reach Twitch.")?;
        match response.status().as_u16() {
            200..=299 => response
                .body_mut()
                .read_json()
                .context("Twitch sent an unexpected reply."),
            401 => Err(Unauthorized.into()),
            status => {
                let message = response
                    .body_mut()
                    .read_json::<serde_json::Value>()
                    .ok()
                    .and_then(|body| body.get("message").and_then(|m| m.as_str()).map(short_message))
                    .unwrap_or_default();
                bail!("Twitch returned {status}. {message}")
            }
        }
    }
}

fn category(game: Game) -> Category {
    Category {
        box_art_url: sized_box_art(&game.box_art_url, 285, 380),
        id: game.id,
        name: game.name,
        viewers: None,
    }
}

/// Box art comes either as a `{width}x{height}` template or at a fixed size
/// such as `-52x72.jpg`; both are asked for at `width`×`height`.
fn sized_box_art(url: &str, width: u32, height: u32) -> Option<String> {
    let url = url
        .replace("{width}", &width.to_string())
        .replace("{height}", &height.to_string());
    let sized = match url.rfind('-') {
        Some(dash) => {
            let tail = &url[dash + 1..];
            match tail.split_once('.') {
                Some((size, extension))
                    if size
                        .split_once('x')
                        .is_some_and(|(w, h)| {
                            !w.is_empty()
                                && !h.is_empty()
                                && w.bytes().all(|b| b.is_ascii_digit())
                                && h.bytes().all(|b| b.is_ascii_digit())
                        })
                        && !extension.contains('/') =>
                {
                    format!("{}-{width}x{height}.{extension}", &url[..dash])
                }
                _ => url.clone(),
            }
        }
        None => url.clone(),
    };
    is_twitch_image_url(&sized).then_some(sized)
}

/// Image URLs come from Twitch's API but are still untrusted input: only load
/// HTTPS images from Twitch's static CDN.
pub fn is_twitch_image_url(url: &str) -> bool {
    url.strip_prefix("https://")
        .and_then(|rest| rest.split(['/', '?', '#']).next())
        .is_some_and(|host| host == "static-cdn.jtvnw.net")
}

fn sized_thumbnail(template: &str, width: u32, height: u32) -> Option<String> {
    let url = template
        .replace("{width}", &width.to_string())
        .replace("{height}", &height.to_string());
    is_twitch_image_url(&url).then_some(url)
}

/// Profile images come as `…-profile_image-300x300.png`; Twitch also serves
/// 70x70 and 150x150, which is all a sidebar avatar needs.
fn sized_profile_image(url: &str, size: u32) -> Option<String> {
    if !is_twitch_image_url(url) {
        return None;
    }
    let sized = match url.rfind("-300x300.") {
        Some(at) => format!("{}-{size}x{size}{}", &url[..at], &url[at + "-300x300".len()..]),
        None => url.to_string(),
    };
    Some(sized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_twitch_image_cdn() {
        assert!(is_twitch_image_url("https://static-cdn.jtvnw.net/previews-ttv/live_user_a-640x360.jpg"));
        assert!(!is_twitch_image_url("http://static-cdn.jtvnw.net/a.jpg"));
        assert!(!is_twitch_image_url("https://static-cdn.jtvnw.net.example.com/a.jpg"));
        assert!(!is_twitch_image_url("https://example.com/static-cdn.jtvnw.net/a.jpg"));
    }

    #[test]
    fn sizes_thumbnails_and_avatars() {
        assert_eq!(
            sized_thumbnail("https://static-cdn.jtvnw.net/previews-ttv/live_user_a-{width}x{height}.jpg", 640, 360)
                .as_deref(),
            Some("https://static-cdn.jtvnw.net/previews-ttv/live_user_a-640x360.jpg")
        );
        assert_eq!(
            sized_profile_image("https://static-cdn.jtvnw.net/jtv_user_pictures/abc-profile_image-300x300.png", 70)
                .as_deref(),
            Some("https://static-cdn.jtvnw.net/jtv_user_pictures/abc-profile_image-70x70.png")
        );
        assert_eq!(sized_profile_image("https://example.com/a-300x300.png", 70), None);
    }

    #[test]
    fn sizes_box_art_from_templates_and_fixed_sizes() {
        assert_eq!(
            sized_box_art("https://static-cdn.jtvnw.net/ttv-boxart/509658-{width}x{height}.jpg", 285, 380)
                .as_deref(),
            Some("https://static-cdn.jtvnw.net/ttv-boxart/509658-285x380.jpg")
        );
        assert_eq!(
            sized_box_art("https://static-cdn.jtvnw.net/ttv-boxart/32982_IGDB-52x72.jpg", 285, 380)
                .as_deref(),
            Some("https://static-cdn.jtvnw.net/ttv-boxart/32982_IGDB-285x380.jpg")
        );
        assert_eq!(sized_box_art("https://example.com/a-52x72.jpg", 285, 380), None);
    }
}
