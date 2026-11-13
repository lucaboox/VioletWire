//! Native Twitch stream lookup: what Streamlink's Twitch plugin does for a
//! live channel, without Python.
//!
//! 1. Twitch's public GraphQL API hands out a signed playback token
//!    (`PlaybackAccessToken`, anonymous, with the web player's public client
//!    ID — the same request Streamlink and the Electron client make).
//! 2. Twitch's playlist server (usher) answers with the multivariant playlist:
//!    one media playlist per quality.
//!
//! Streamlink also re-reads every quality's playlist before answering; this
//! does not, which is most of the time it saves. If Twitch changes the API
//! (a new query hash, an integrity requirement), the caller falls back to
//! Streamlink. Signed URLs and tokens never leave this process or reach a log.

use std::time::Duration;

use anyhow::{Context as _, Result, bail};
use serde::Deserialize;

const WEB_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
/// Streamlink 8.4's persisted query for PlaybackAccessToken.
const ACCESS_TOKEN_HASH: &str = "ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9";
/// A desktop browser's, as Streamlink sends (Twitch refuses some agents).
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const MAX_PLAYLIST_BYTES: u64 = 256 * 1024;

/// One quality of a live stream.
#[derive(Clone)]
pub struct Variant {
    /// Streamlink's name for it: `1080p60`, `720p`, `audio_only`.
    pub name: String,
    pub url: String,
    pub bandwidth: u64,
}

impl std::fmt::Debug for Variant {
    // The URL is signed: never print it.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Variant")
            .field("name", &self.name)
            .field("bandwidth", &self.bandwidth)
            .finish_non_exhaustive()
    }
}

pub enum Lookup {
    Offline,
    Live(Vec<Variant>),
}

pub fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(8)))
        .max_idle_age(Duration::from_secs(120))
        .http_status_as_error(false)
        .user_agent(USER_AGENT)
        .build()
        .into()
}

/// Opens (and pools) the connections a lookup uses: TLS set-up is most of a
/// first lookup's time. The answers themselves are ignored.
pub fn warm(agent: &ureq::Agent) {
    for url in ["https://gql.twitch.tv/gql", "https://usher.ttvnw.net/"] {
        if let Ok(mut response) = agent.get(url).call() {
            let _ = response.body_mut().with_config().limit(64 * 1024).read_to_vec();
        }
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    data: Option<TokenData>,
    #[serde(default)]
    errors: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct TokenData {
    #[serde(rename = "streamPlaybackAccessToken")]
    token: Option<Token>,
}

#[derive(Deserialize)]
struct Token {
    value: String,
    signature: String,
}

/// The channel's qualities, best first, or `Offline`.
pub fn resolve(agent: &ureq::Agent, login: &str) -> Result<Lookup> {
    if !crate::format::is_login(login) {
        bail!("Invalid Twitch channel.");
    }
    let body = serde_json::json!({
        "operationName": "PlaybackAccessToken",
        "extensions": {"persistedQuery": {"version": 1, "sha256Hash": ACCESS_TOKEN_HASH}},
        "variables": {
            "isLive": true, "login": login, "isVod": false, "vodID": "",
            "playerType": "embed", "platform": "site",
        },
    });
    let mut response = agent
        .post("https://gql.twitch.tv/gql")
        .header("Client-ID", WEB_CLIENT_ID)
        .send_json(&body)
        .context("Could not reach Twitch.")?;
    if !response.status().is_success() {
        bail!("Twitch refused the playback token ({}).", response.status().as_u16());
    }
    // Read the whole body before parsing: a reply left half-read keeps its
    // connection from going back to the pool.
    let text = response
        .body_mut()
        .with_config()
        .limit(MAX_PLAYLIST_BYTES)
        .read_to_string()
        .context("Twitch sent an unexpected playback token.")?;
    drop(response);
    let reply: TokenResponse =
        serde_json::from_str(&text).context("Twitch sent an unexpected playback token.")?;
    if !reply.errors.is_empty() {
        bail!("Twitch refused the playback token.");
    }
    let Some(token) = reply.data.and_then(|data| data.token) else {
        return Ok(Lookup::Offline);
    };

    let random = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.subsec_nanos() % 999_999);
    let mut response = agent
        .get(format!("https://usher.ttvnw.net/api/v2/channel/hls/{login}.m3u8"))
        .header("Referer", "https://player.twitch.tv")
        .header("Origin", "https://player.twitch.tv")
        .query("platform", "web")
        .query("p", random.to_string())
        .query("allow_source", "true")
        .query("allow_audio_only", "true")
        .query("playlist_include_framerate", "true")
        .query("supported_codecs", "h264")
        .query("fast_bread", "true")
        .query("sig", &token.signature)
        .query("token", &token.value)
        .call()
        .context("Could not reach Twitch.")?;
    match response.status().as_u16() {
        200..=299 => {}
        // usher answers 404 for a channel that is not live.
        404 => return Ok(Lookup::Offline),
        status => bail!("Twitch's playlist server returned {status}."),
    }
    let master = response
        .body_mut()
        .with_config()
        .limit(MAX_PLAYLIST_BYTES)
        .read_to_string()
        .context("Twitch sent an unexpected playlist.")?;
    drop(response);
    let variants = parse_master(&master);

    if variants.is_empty() {
        bail!("Twitch's playlist listed no qualities.");
    }
    Ok(Lookup::Live(variants))
}

/// `KEY=value,KEY="quoted, value"` attributes.
fn attribute(list: &str, wanted: &str) -> Option<String> {
    let mut rest = list;
    while !rest.is_empty() {
        let (key, after) = rest.split_once('=')?;
        let (value, next) = if let Some(quoted) = after.strip_prefix('"') {
            match quoted.split_once('"') {
                Some((value, next)) => (value, next.strip_prefix(',').unwrap_or(next)),
                None => (quoted, ""),
            }
        } else {
            after.split_once(',').unwrap_or((after, ""))
        };
        if key.trim() == wanted {
            return Some(value.to_owned());
        }
        rest = next;
    }
    None
}

/// Qualities named the way Streamlink names them: Twitch's `IVS-NAME` (or,
/// in the older layout, the video group's NAME without " (source)").
/// Highest bandwidth first; audio only last.
fn parse_master(text: &str) -> Vec<Variant> {
    let mut names: Vec<(String, String)> = Vec::new();
    let mut variants = Vec::new();
    let mut pending: Option<(String, u64)> = None;
    for line in text.lines().map(str::trim) {
        if let Some(list) = line.strip_prefix("#EXT-X-MEDIA:") {
            if let (Some(group), Some(name)) = (attribute(list, "GROUP-ID"), attribute(list, "NAME")) {
                names.push((group, name));
            }
        } else if let Some(list) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            let group = attribute(list, "IVS-NAME")
                .map(|name| format!("ivs:{name}"))
                .or_else(|| attribute(list, "VIDEO"))
                .unwrap_or_default();
            let bandwidth = attribute(list, "BANDWIDTH")
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
            pending = Some((group, bandwidth));
        } else if !line.is_empty()
            && !line.starts_with('#')
            && let Some((group, bandwidth)) = pending.take()
        {
            if !line.starts_with("https://") {
                continue;
            }
            let raw = match group.strip_prefix("ivs:") {
                Some(name) => name,
                None => names
                    .iter()
                    .find(|(id, _)| *id == group)
                    .map_or(group.as_str(), |(_, name)| name.as_str()),
            };
            let name = raw
                .trim_end_matches(" (source)")
                .trim()
                .to_ascii_lowercase()
                .replace(' ', "_");
            if !crate::playback::resolver::is_quality(&name) {
                continue;
            }
            variants.push(Variant {
                name,
                url: line.to_owned(),
                bandwidth,
            });
        }
    }
    variants.sort_by_key(|variant| (variant.name == "audio_only", std::cmp::Reverse(variant.bandwidth)));
    variants
}

/// The variant for `quality`: an exact match, or the best video for `best`
/// and anything not on offer.
pub fn choose<'a>(variants: &'a [Variant], quality: &str) -> Option<&'a Variant> {
    variants
        .iter()
        .find(|variant| quality != "best" && variant.name == quality)
        .or_else(|| variants.iter().find(|variant| variant.name != "audio_only"))
        .or_else(|| variants.first())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MASTER: &str = "#EXTM3U\n\
#EXT-X-SESSION-DATA:DATA-ID=\"NODE\",VALUE=\"x\"\n\
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"chunked\",NAME=\"1080p60 (source)\",AUTOSELECT=YES,DEFAULT=YES\n\
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS=\"avc1.64002A,mp4a.40.2\",VIDEO=\"chunked\",FRAME-RATE=60.000\n\
https://weaver.example/v1/playlist/source.m3u8\n\
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"720p60\",NAME=\"720p60\",AUTOSELECT=YES,DEFAULT=YES\n\
#EXT-X-STREAM-INF:BANDWIDTH=3400000,RESOLUTION=1280x720,CODECS=\"avc1.4D401F,mp4a.40.2\",VIDEO=\"720p60\",FRAME-RATE=60.000\n\
https://weaver.example/v1/playlist/720.m3u8\n\
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"audio_only\",NAME=\"audio_only\",AUTOSELECT=NO,DEFAULT=NO\n\
#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS=\"mp4a.40.2\",VIDEO=\"audio_only\"\n\
https://weaver.example/v1/playlist/audio.m3u8\n\
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"160p30\",NAME=\"160p\",AUTOSELECT=YES,DEFAULT=YES\n\
#EXT-X-STREAM-INF:BANDWIDTH=230000,RESOLUTION=284x160,VIDEO=\"160p30\",FRAME-RATE=30.000\n\
https://weaver.example/v1/playlist/160.m3u8\n";

    #[test]
    fn names_qualities_like_streamlink() {
        let variants = parse_master(MASTER);
        let names: Vec<&str> = variants.iter().map(|v| v.name.as_str()).collect();
        assert_eq!(names, ["1080p60", "720p60", "160p", "audio_only"]);
        assert!(variants[0].url.ends_with("source.m3u8"));
    }

    #[test]
    fn reads_twitchs_current_ivs_names() {
        let master = "#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=7705756,RESOLUTION=1920x1080,CODECS=\"avc1.64002A,mp4a.40.2\",FRAME-RATE=60.000,STABLE-VARIANT-ID=\"1080p60\",IVS-NAME=\"1080p60\",IVS-VARIANT-SOURCE=\"source\"
https://weaver.example/a.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1427999,RESOLUTION=852x480,CODECS=\"avc1.4D401F,mp4a.40.2\",FRAME-RATE=30.000,STABLE-VARIANT-ID=\"480p30\",IVS-NAME=\"480p\",IVS-VARIANT-SOURCE=\"transcode\"
https://weaver.example/b.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS=\"mp4a.40.2\",STABLE-VARIANT-ID=\"audio_only\",IVS-NAME=\"audio_only\",IVS-VARIANT-SOURCE=\"transcode\"
https://weaver.example/c.m3u8
";
        let names: Vec<String> = parse_master(master).into_iter().map(|v| v.name).collect();
        assert_eq!(names, ["1080p60", "480p", "audio_only"]);
    }

    #[test]
    fn chooses_the_asked_quality_or_the_best_video() {
        let variants = parse_master(MASTER);
        assert_eq!(choose(&variants, "720p60").unwrap().name, "720p60");
        assert_eq!(choose(&variants, "best").unwrap().name, "1080p60");
        assert_eq!(choose(&variants, "480p").unwrap().name, "1080p60");
        assert_eq!(choose(&variants, "audio_only").unwrap().name, "audio_only");
    }

    #[test]
    fn debug_output_hides_signed_urls() {
        let variants = parse_master(MASTER);
        assert!(!format!("{variants:?}").contains("weaver"));
    }
}
