//! Kick, watch-only (Electron's `kick-service.ts`, without sign-in). Kick's
//! official API has no playback address or chat feed, and Kick's site API
//! sits behind a browser check, so channel, search and playback lookups go
//! through Streamlink's Kick plugin (`playback/kick.rs`), which handles that
//! check. Chat itself is Kick's public Pusher feed. Everything returned is
//! untrusted.
//!
//! Kick channels are keyed `kick:<slug>` wherever the app passes a channel.

use std::time::Duration;

use anyhow::{Context as _, Result, bail};
use serde_json::Value;

const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
pub const PREFIX: &str = "kick:";

/// A Kick channel slug: lowercase letters, digits, `_` and `-`.
pub fn is_slug(text: &str) -> bool {
    (1..=40).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// The slug of a `kick:<slug>` key.
pub fn slug(key: &str) -> Option<&str> {
    key.strip_prefix(PREFIX).filter(|slug| is_slug(slug))
}

pub fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(10)))
        .max_redirects(0)
        .user_agent(USER_AGENT)
        .build()
        .into()
}

fn text(value: &Value, limit: usize) -> String {
    value
        .as_str()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(limit)
        .collect()
}

/// Kick's own image hosts, the only ones whose pictures are shown.
pub fn is_image_url(url: &str) -> bool {
    url.strip_prefix("https://")
        .and_then(|rest| rest.split(['/', '?', '#']).next())
        .is_some_and(|host| matches!(host, "files.kick.com" | "stream.kick.com" | "images.kick.com" | "ext.cdn.kick.com"))
}

fn image(value: &Value) -> Option<String> {
    let url = text(value, 400);
    is_image_url(&url).then_some(url)
}

#[derive(Clone, Debug)]
pub struct Live {
    pub title: String,
    pub viewers: u64,
    pub category: String,
    pub thumbnail: Option<String>,
    /// RFC 3339, from Kick's `2026-11-13 22:03:56` (UTC).
    pub started: String,
}

#[derive(Clone, Debug)]
pub struct Channel {
    /// The channel's own ID, which Kick's chat connection is keyed by.
    pub id: u64,
    pub slug: String,
    pub name: String,
    pub avatar: Option<String>,
    /// The user ID 7TV keys Kick emote sets by.
    pub user_id: u64,
    pub chatroom_id: u64,
    pub live: Option<Live>,
    /// Subscriber badge images by months, longest first.
    pub subscriber_badges: Vec<(u64, String)>,
}

impl Channel {
    pub fn key(&self) -> String {
        format!("{PREFIX}{}", self.slug)
    }

    fn from_json(value: &Value) -> Option<Self> {
        let slug = text(&value["slug"], 40).to_ascii_lowercase();
        if !is_slug(&slug) {
            return None;
        }
        let user = &value["user"];
        let livestream = &value["livestream"];
        let live = (livestream.is_object() && livestream["is_live"].as_bool().unwrap_or(true)).then(|| Live {
            title: text(&livestream["session_title"], 200),
            viewers: livestream["viewer_count"].as_u64().unwrap_or(0),
            category: livestream["categories"]
                .get(0)
                .map(|category| text(&category["name"], 60))
                .unwrap_or_default(),
            thumbnail: image(&livestream["thumbnail"]["url"]).or_else(|| image(&livestream["thumbnail"]["src"])),
            started: Some(text(&livestream["start_time"], 19))
                .filter(|time| time.len() == 19 && time.as_bytes()[10] == b' ')
                .map(|time| format!("{}T{}Z", &time[..10], &time[11..]))
                .unwrap_or_default(),
        });
        let mut subscriber_badges: Vec<(u64, String)> = value["subscriber_badges"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|badge| Some((badge["months"].as_u64()?, image(&badge["badge_image"]["src"])?)))
            .collect();
        subscriber_badges.sort_by_key(|badge| std::cmp::Reverse(badge.0));
        Some(Self {
            name: Some(text(&user["username"], 40))
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| slug.clone()),
            id: value["id"].as_u64().unwrap_or(0),
            avatar: image(&user["profile_pic"]),
            user_id: value["user_id"].as_u64().or_else(|| user["id"].as_u64()).unwrap_or(0),
            chatroom_id: value["chatroom"]["id"].as_u64().unwrap_or(0),
            live,
            subscriber_badges,
            slug,
        })
    }
}

impl Channel {
    /// The shape the sidebar, search and player header already show.
    pub fn followed(&self) -> crate::twitch::helix::FollowedChannel {
        crate::twitch::helix::FollowedChannel {
            id: format!("kick-{}", self.id),
            login: self.key(),
            display_name: self.name.clone(),
            profile_image_url: self.avatar.clone(),
            stream: self.live.as_ref().map(|live| crate::twitch::helix::LiveStream {
                title: live.title.clone(),
                game_name: live.category.clone(),
                viewer_count: live.viewers,
                started_at: live.started.clone(),
                thumbnail_url: live.thumbnail.clone(),
                language: String::new(),
                tags: Vec::new(),
            }),
        }
    }
}

/// `kick:<slug>` from `kick:slug`, `kick.com/slug` or a full Kick address.
pub fn key_from_text(text: &str) -> Option<String> {
    let text = text.trim();
    let rest = text
        .strip_prefix(PREFIX)
        .or_else(|| text.strip_prefix("https://"))
        .or_else(|| text.strip_prefix("http://"))
        .unwrap_or(text);
    let rest = rest.strip_prefix("www.").unwrap_or(rest);
    let slug = match rest.strip_prefix("kick.com/") {
        Some(path) => path.split(['/', '?', '#']).next()?,
        None if text.starts_with(PREFIX) => rest,
        None => return None,
    }
    .to_ascii_lowercase();
    is_slug(&slug).then(|| format!("{PREFIX}{slug}"))
}

/// Channel lookups are shared by the chat and the player header for a while.
static CHANNELS: std::sync::Mutex<Vec<(std::time::Instant, Channel)>> = std::sync::Mutex::new(Vec::new());

/// The channel, through Streamlink's Kick plugin.
pub fn channel(slug: &str) -> Result<Channel> {
    if !is_slug(slug) {
        bail!("Invalid Kick channel.");
    }
    {
        let cache = CHANNELS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((_, channel)) = cache
            .iter()
            .find(|(at, channel)| channel.slug == slug && at.elapsed() < Duration::from_secs(60))
        {
            return Ok(channel.clone());
        }
    }
    let value = crate::playback::kick::query(&serde_json::json!({"kind": "channel", "slug": slug}))?;
    let channel = Channel::from_json(&value).context("Kick sent an unexpected channel.")?;
    let mut cache = CHANNELS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    cache.retain(|(at, cached)| cached.slug != slug && at.elapsed() < Duration::from_secs(60));
    cache.push((std::time::Instant::now(), channel.clone()));
    Ok(channel)
}

pub fn search(term: &str) -> Result<Vec<Channel>> {
    let term: String = term.chars().filter(|c| !c.is_control()).take(60).collect();
    let value = crate::playback::kick::query(&serde_json::json!({"kind": "search", "slug": "search", "term": term}))?;
    Ok(value["channels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Channel::from_json)
        .take(12)
        .collect())
}

/// Pusher's app key and cluster for Kick chat, as Kick hands them to its site.
pub fn chat_connection(agent: &ureq::Agent, channel_id: u64) -> Result<(String, String)> {
    let mut response = agent
        .post(format!("https://web.kick.com/api/v1/realtime/channels/{channel_id}/chat/connection"))
        .header("Accept", "application/json")
        .header("Referer", "https://kick.com/")
        .send_json(serde_json::json!({
            "client": {"id": "00000000-0000-4000-8000-000000000001", "type": "web"},
            "capabilities": {"accepted_providers": [{"provider": "pusher"}]},
        }))
        .context("Could not reach Kick chat.")?;
    if !response.status().is_success() {
        bail!("Kick chat is unavailable ({}).", response.status().as_u16());
    }
    let value: Value = response
        .body_mut()
        .with_config()
        .limit(64 * 1024)
        .read_json()
        .context("Kick chat sent an unexpected answer.")?;
    let credentials = value["data"]["connections"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|connection| connection["provider"] == "pusher")
        .map(|connection| &connection["credentials"])
        .context("Kick chat offered no supported connection.")?;
    let key = text(&credentials["app_key"], 64);
    let cluster = text(&credentials["cluster"], 16);
    let plain = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if !plain(&key) || !plain(&cluster) {
        bail!("Kick chat sent an unexpected connection.");
    }
    Ok((key, cluster))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_and_hosts_are_strict() {
        assert_eq!(slug("kick:xqc"), Some("xqc"));
        assert_eq!(slug("kick:some-user_1"), Some("some-user_1"));
        assert_eq!(slug("kick:Bad Slug"), None);
        assert_eq!(slug("xqc"), None);
        assert!(is_image_url("https://files.kick.com/emotes/1/fullsize"));
        assert!(!is_image_url("https://files.kick.com.evil.example/x"));
        assert_eq!(key_from_text("https://kick.com/XQC?x=1").as_deref(), Some("kick:xqc"));
        assert_eq!(key_from_text("kick:some-one").as_deref(), Some("kick:some-one"));
        assert_eq!(key_from_text("www.kick.com/a_b").as_deref(), Some("kick:a_b"));
        assert_eq!(key_from_text("xqc"), None);
        assert_eq!(key_from_text("https://evil.example/kick.com/x"), None);
    }

    #[test]
    fn reads_a_channel() {
        let channel = Channel::from_json(&serde_json::json!({
            "slug": "xqc", "user_id": 676, "chatroom": {"id": 668},
            "user": {"username": "xQc", "profile_pic": "https://files.kick.com/images/user/676/p.webp"},
            "livestream": {"is_live": true, "session_title": "hi", "viewer_count": 12, "start_time": "2026-11-13 22:03:56",
                "categories": [{"name": "Just Chatting"}], "thumbnail": {"url": "https://evil.example/t.jpg"}},
            "subscriber_badges": [{"months": 1, "badge_image": {"src": "https://files.kick.com/b/1"}},
                                  {"months": 6, "badge_image": {"src": "https://files.kick.com/b/6"}}]
        }))
        .unwrap();
        assert_eq!(channel.key(), "kick:xqc");
        assert_eq!(channel.name, "xQc");
        assert_eq!(channel.chatroom_id, 668);
        let live = channel.live.unwrap();
        assert_eq!((live.viewers, live.category.as_str()), (12, "Just Chatting"));
        assert!(live.thumbnail.is_none(), "foreign image hosts are dropped");
        assert_eq!(live.started, "2026-11-13T22:03:56Z");
        assert_eq!(channel.subscriber_badges[0].0, 6);
    }
}
