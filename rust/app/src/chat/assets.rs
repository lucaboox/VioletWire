use super::model::asset_id;
use crate::session::Session;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Default)]
pub struct Assets {
    /// Every emote name this account can type, for the picker and completion.
    pub emotes: HashMap<String, String>,
    /// Third-party emotes found by name in message text, with what is needed
    /// to draw them as Electron does.
    pub providers: HashMap<String, ProviderEmote>,
    pub badges: HashMap<String, String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    Twitch,
    SevenTv,
    Ffz,
    Bttv,
}

impl Provider {
    pub fn label(self) -> &'static str {
        match self {
            Self::Twitch => "Twitch",
            Self::SevenTv => "7TV",
            Self::Ffz => "FrankerFaceZ",
            Self::Bttv => "BetterTTV",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ProviderEmote {
    pub url: String,
    pub provider: Provider,
    /// The emote's 1x size: Electron scales small emotes down rather than
    /// stretching everything to the chat emote height.
    pub width: f32,
    pub height: f32,
    /// Drawn over the emote before it (7TV's zero-width flag).
    pub zero_width: bool,
    /// BTTV/FFZ modifier emotes change a neighbouring emote instead of
    /// showing themselves.
    pub modifier: bool,
    /// FFZ's modifier effect bits.
    pub modifier_flags: u32,
}

pub fn image_url(url: &str) -> bool {
    url.strip_prefix("https://")
        .and_then(|s| s.split(['/', '?', '#']).next())
        .is_some_and(|host| {
            matches!(
                host,
                "static-cdn.jtvnw.net"
                    | "cdn.betterttv.net"
                    | "cdn.frankerfacez.com"
                    | "cdn.7tv.app"
            )
        })
}
fn json(agent: &ureq::Agent, url: &str, session: Option<&Session>) -> Option<Value> {
    json_query(agent, url, session, &[])
}
fn json_query(
    agent: &ureq::Agent,
    url: &str,
    session: Option<&Session>,
    params: &[(&str, &str)],
) -> Option<Value> {
    let mut request = agent.get(url).config().max_redirects(0).build();
    if let Some(s) = session {
        if !url.starts_with("https://api.twitch.tv/helix/")
            || s.epoch != crate::twitch::token_store::epoch()
        {
            return None;
        }
        request = request
            .header("Client-Id", crate::twitch::auth::CLIENT_ID)
            .header("Authorization", format!("Bearer {}", s.token.access_token));
    }
    for (name, value) in params {
        request = request.query(name, value);
    }
    let mut response = request.call().ok()?;
    if !response.status().is_success() {
        return None;
    }
    let bytes = response
        .body_mut()
        .with_config()
        .limit(2 * 1024 * 1024)
        .read_to_vec()
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}
fn insert(map: &mut HashMap<String, String>, name: &str, url: String) {
    if !name.is_empty()
        && name.len() <= 100
        && !name.chars().any(char::is_whitespace)
        && !name.chars().any(char::is_control)
        && image_url(&url)
        && map.len() < 8000
    {
        map.insert(name.into(), url);
    }
}
fn insert_provider(map: &mut HashMap<String, ProviderEmote>, name: &str, emote: ProviderEmote) {
    if !name.is_empty()
        && name.len() <= 100
        && !name.chars().any(char::is_whitespace)
        && !name.chars().any(char::is_control)
        && image_url(&emote.url)
        && map.len() < 8000
    {
        map.insert(name.into(), emote);
    }
}

/// A 1x size within reason, or the provider's usual square.
fn logical(width: &Value, height: &Value, fallback: f32) -> (f32, f32) {
    match (width.as_f64(), height.as_f64()) {
        (Some(width), Some(height))
            if width > 0. && height > 0. && width <= 512. && height <= 128. =>
        {
            (width as f32, height as f32)
        }
        _ => (fallback, fallback),
    }
}

pub fn load(room: &str, session: Option<&Session>) -> Assets {
    if !room.bytes().all(|b| b.is_ascii_digit()) || room.is_empty() {
        return Assets::default();
    }
    let agent = crate::http::agent();
    std::thread::scope(|scope| {
        let bttv = scope.spawn(|| {
            let mut emotes = Vec::new();
            for endpoint in [
                "https://api.betterttv.net/3/cached/emotes/global".into(),
                format!("https://api.betterttv.net/3/cached/users/twitch/{room}"),
            ] {
                if let Some(v) = json(&agent, &endpoint, None) {
                    let list: Vec<&Value> = if let Some(a) = v.as_array() {
                        a.iter().collect()
                    } else {
                        ["channelEmotes", "sharedEmotes"]
                            .iter()
                            .flat_map(|k| v[*k].as_array().into_iter().flatten())
                            .collect()
                    };
                    for e in list {
                        if let (Some(name), Some(id)) = (e["code"].as_str(), e["id"].as_str())
                            && asset_id(id)
                        {
                            let (width, height) = logical(&e["width"], &e["height"], 28.);
                            emotes.push((
                                name.to_owned(),
                                ProviderEmote {
                                    url: format!("https://cdn.betterttv.net/emote/{id}/2x.webp"),
                                    provider: Provider::Bttv,
                                    width,
                                    height,
                                    zero_width: false,
                                    modifier: e["modifier"].as_bool().unwrap_or(false),
                                    modifier_flags: 0,
                                },
                            ));
                        }
                    }
                }
            }
            emotes
        });
        let ffz = scope.spawn(|| {
            let mut emotes = Vec::new();
            for endpoint in [
                "https://api.frankerfacez.com/v1/set/global".into(),
                format!("https://api.frankerfacez.com/v1/room/id/{room}"),
            ] {
                if let Some(v) = json(&agent, &endpoint, None)
                    && let Some(sets) = v["sets"].as_object()
                {
                    for set in sets.values() {
                        for e in set["emoticons"].as_array().into_iter().flatten() {
                            let Some(name) = e["name"].as_str() else {
                                continue;
                            };
                            let url = e["animated"]["2"]
                                .as_str()
                                .or(e["urls"]["2"].as_str())
                                .or(e["animated"]["1"].as_str())
                                .or(e["urls"]["1"].as_str());
                            let Some(url) = url else {
                                continue;
                            };
                            let (width, height) = logical(&e["width"], &e["height"], 32.);
                            emotes.push((
                                name.to_owned(),
                                ProviderEmote {
                                    url: if url.starts_with("//") {
                                        format!("https:{url}")
                                    } else {
                                        url.into()
                                    },
                                    provider: Provider::Ffz,
                                    width,
                                    height,
                                    zero_width: false,
                                    modifier: e["modifier"].as_bool().unwrap_or(false),
                                    modifier_flags: e["modifier_flags"]
                                        .as_u64()
                                        .and_then(|flags| u32::try_from(flags).ok())
                                        .unwrap_or(0),
                                },
                            ));
                        }
                    }
                }
            }
            emotes
        });
        let seven = scope.spawn(|| {
            let mut emotes = Vec::new();
            for endpoint in [
                "https://7tv.io/v3/emote-sets/global".into(),
                format!("https://7tv.io/v3/users/twitch/{room}"),
            ] {
                if let Some(v) = json(&agent, &endpoint, None) {
                    let data = if v.get("emote_set").is_some() {
                        &v["emote_set"]
                    } else {
                        &v
                    };
                    for e in data["emotes"].as_array().into_iter().flatten() {
                        if let (Some(name), Some(id)) = (e["name"].as_str(), e["id"].as_str())
                            && asset_id(id)
                        {
                            let files = e["data"]["host"]["files"].as_array();
                            let one = files.and_then(|files| {
                                files
                                    .iter()
                                    .find(|file| {
                                        file["name"].as_str().is_some_and(|n| n.starts_with("1x."))
                                    })
                                    .or_else(|| files.first())
                            });
                            let (width, height) = one
                                .map(|file| logical(&file["width"], &file["height"], 32.))
                                .unwrap_or((32., 32.));
                            emotes.push((
                                name.to_owned(),
                                ProviderEmote {
                                    url: format!("https://cdn.7tv.app/emote/{id}/2x.webp"),
                                    provider: Provider::SevenTv,
                                    width,
                                    height,
                                    zero_width: seven_zero_width(e),
                                    modifier: false,
                                    modifier_flags: 0,
                                },
                            ));
                        }
                    }
                }
            }
            emotes
        });
        let twitch = scope.spawn(|| twitch_assets(&agent, room, session));
        let mut result = twitch.join().unwrap_or_default();
        // Electron's precedence: 7TV, then FFZ, then BTTV; within each, the
        // channel's set over the global one (listed later, so it replaces).
        let mut providers = HashMap::new();
        for provider in [
            bttv.join().unwrap_or_default(),
            ffz.join().unwrap_or_default(),
            seven.join().unwrap_or_default(),
        ] {
            for (name, emote) in provider {
                insert(&mut result.emotes, &name, emote.url.clone());
                insert_provider(&mut providers, &name, emote);
            }
        }
        result.providers = providers;
        result
    })
}
fn seven_zero_width(emote: &Value) -> bool {
    emote["flags"]
        .as_u64()
        .map(|flags| flags & 1 != 0)
        .unwrap_or_else(|| {
            emote["data"]["flags"]
                .as_u64()
                .is_some_and(|flags| flags & 256 != 0)
        })
}

fn twitch_assets(agent: &ureq::Agent, room: &str, session: Option<&Session>) -> Assets {
    let mut result = Assets::default();
    let Some(session) = session else {
        return result;
    };
    for endpoint in [
        "https://api.twitch.tv/helix/chat/badges/global".into(),
        format!("https://api.twitch.tv/helix/chat/badges?broadcaster_id={room}"),
    ] {
        if let Some(value) = json(agent, &endpoint, Some(session)) {
            for set in value["data"].as_array().into_iter().flatten() {
                let Some(name) = set["set_id"].as_str() else {
                    continue;
                };
                for version in set["versions"].as_array().into_iter().flatten() {
                    if let (Some(id), Some(url)) =
                        (version["id"].as_str(), version["image_url_2x"].as_str())
                    {
                        insert(&mut result.badges, &format!("{name}/{id}"), url.into());
                    }
                }
            }
        }
    }
    // Only offer native emotes Twitch says this account can use, including
    // subscriber emotes from other channels and this room's follower emotes.
    let (mut cursor, started) = (String::new(), std::time::Instant::now());
    for _ in 0..20 {
        if started.elapsed() > std::time::Duration::from_secs(10) {
            break;
        }
        let mut params = vec![
            ("user_id", session.identity.user_id.as_str()),
            ("broadcaster_id", room),
        ];
        if !cursor.is_empty() {
            params.push(("after", &cursor));
        }
        let Some(value) = json_query(
            agent,
            "https://api.twitch.tv/helix/chat/emotes/user",
            Some(session),
            &params,
        ) else {
            break;
        };
        add_twitch_emotes(&mut result.emotes, &value);
        let Some(next) = value["pagination"]["cursor"]
            .as_str()
            .filter(|next| !next.is_empty() && next.len() <= 2048 && *next != cursor)
        else {
            break;
        };
        cursor = next.into();
    }
    if result.emotes.is_empty()
        && let Some(value) = json(
            agent,
            "https://api.twitch.tv/helix/chat/emotes/global",
            Some(session),
        )
    {
        add_twitch_emotes(&mut result.emotes, &value);
    }
    result
}

fn add_twitch_emotes(map: &mut HashMap<String, String>, value: &Value) {
    for emote in value["data"].as_array().into_iter().flatten() {
        if let (Some(name), Some(id)) = (emote["name"].as_str(), emote["id"].as_str())
            && asset_id(id)
        {
            insert(
                map,
                name,
                format!("https://static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/2.0"),
            );
        }
    }
}

pub fn send(room: &str, text: &str, reply: Option<&str>, session: &Session) -> anyhow::Result<()> {
    if session.epoch != crate::twitch::token_store::epoch() {
        anyhow::bail!("Your sign-in changed. Try again.");
    }
    let body = outgoing_body(room, &session.identity.user_id, text, reply)?;
    let mut response = crate::http::agent()
        .post("https://api.twitch.tv/helix/chat/messages")
        .config()
        .max_redirects(0)
        .build()
        .header("Client-Id", crate::twitch::auth::CLIENT_ID)
        .header(
            "Authorization",
            format!("Bearer {}", session.token.access_token),
        )
        .send_json(body)
        .map_err(|_| anyhow::anyhow!("Could not send the message. Check your connection."))?;
    if !response.status().is_success() {
        anyhow::bail!(
            "Twitch refused the message (HTTP {}). Sign in again if your session expired.",
            response.status().as_u16()
        );
    }
    let result: Value = response.body_mut().read_json()?;
    if result["data"][0]["is_sent"] != true {
        let reason = result["data"][0]["drop_reason"]["message"]
            .as_str()
            .unwrap_or("Twitch did not accept the message.");
        anyhow::bail!("{}", crate::http::short_message(reason));
    }
    Ok(())
}
fn outgoing_body(
    room: &str,
    sender: &str,
    text: &str,
    reply: Option<&str>,
) -> anyhow::Result<Value> {
    if text.trim().is_empty() || text.chars().count() > 500 || text.chars().any(char::is_control) {
        anyhow::bail!("Messages must contain 1–500 characters on one line.");
    }
    if room.is_empty()
        || room.len() > 20
        || !room.bytes().all(|b| b.is_ascii_digit())
        || sender.is_empty()
        || sender.len() > 20
        || !sender.bytes().all(|b| b.is_ascii_digit())
    {
        anyhow::bail!("Chat is still connecting.");
    }
    if reply.is_some_and(|id| !asset_id(id)) {
        anyhow::bail!("Invalid reply target.");
    }
    let mut body = serde_json::json!({"broadcaster_id":room,"sender_id":sender,"message":text});
    if let Some(id) = reply {
        body["reply_parent_message_id"] = id.into();
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn emote_sizes_fall_back_to_the_provider_square() {
        assert_eq!(logical(&96.into(), &32.into(), 32.), (96., 32.));
        assert_eq!(logical(&20.into(), &18.into(), 28.), (20., 18.));
        for (width, height) in [(0, 1), (1, 0), (513, 100), (56, 129)] {
            assert_eq!(logical(&width.into(), &height.into(), 28.), (28., 28.));
        }
        assert_eq!(logical(&"wide".into(), &56.into(), 32.), (32., 32.));
    }
    #[test]
    fn reply_payload_preserves_unicode_and_excludes_unused_fields() {
        let text = "👋".repeat(500);
        let body = outgoing_body("1", "2", &text, Some("parent-1")).unwrap();
        assert_eq!(body["message"], text);
        assert_eq!(body["reply_parent_message_id"], "parent-1");
        assert!(
            outgoing_body("1", "2", "hello", None)
                .unwrap()
                .get("reply_parent_message_id")
                .is_none()
        );
    }
    #[test]
    fn outgoing_validation_rejects_control_frames_and_invalid_targets() {
        for text in [" ", "hello\r\nPRIVMSG #other :injected", &"界".repeat(501)] {
            assert!(outgoing_body("1", "2", text, None).is_err());
        }
        assert!(outgoing_body("bad", "2", "hello", None).is_err());
        assert!(outgoing_body("1", "2", "hello", Some("../bad")).is_err());
    }
    #[test]
    fn channel_layer_flags_override_global_defaults() {
        assert!(seven_zero_width(
            &serde_json::json!({"flags":1,"data":{"flags":0}})
        ));
        assert!(!seven_zero_width(
            &serde_json::json!({"flags":0,"data":{"flags":256}})
        ));
        assert!(seven_zero_width(&serde_json::json!({"data":{"flags":256}})));
    }
    #[test]
    fn allows_only_fixed_media_cdns() {
        assert!(image_url("https://cdn.7tv.app/emote/a/2x.webp"));
        for u in [
            "http://cdn.7tv.app/x",
            "https://cdn.7tv.app.evil/x",
            "https://user@cdn.7tv.app/x",
            "https://127.0.0.1/a",
        ] {
            assert!(!image_url(u));
        }
    }
}
