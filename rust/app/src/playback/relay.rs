//! A small loopback relay for the HLS *media playlist* (never media segments).
//!
//! Windows Media Engine follows the HLS spec literally, which is a poor fit
//! for Twitch's live playlists:
//!
//! - It starts at the oldest segment in Twitch's ~30-second window, so
//!   playback sat half a minute behind the broadcast. The relay's first
//!   response lists only the newest few seconds, so playback starts there.
//!   Later refreshes pass the whole window through, so a segment's identity
//!   (its media sequence number) never changes under the player.
//! - It reloads the playlist only once per EXT-X-TARGETDURATION, which Twitch
//!   sets to 6 s for 2 s segments; near the live edge the buffer would run dry
//!   between reloads. The relay declares the real segment length instead.
//! - Twitch's prefetch hints are not standard HLS and are dropped.
//!
//! Segments stay on Twitch's CDN with their absolute URLs; only playlist text
//! crosses the loopback socket. Every URL carries a random per-process secret,
//! so other local programs cannot use the relay, and signed upstream URLs
//! never leave this process.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::{
    Arc, Mutex, OnceLock, PoisonError,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;

use anyhow::{Context as _, Result, bail};

/// How much media the first playlist response keeps, counted back from the
/// newest segment's end. Media Engine starts at the first listed segment.
pub const START_CUSHION_SECONDS: f64 = 5.0;
const MAX_REQUEST_BYTES: u64 = 8 * 1024;
const MAX_PLAYLIST_BYTES: u64 = 512 * 1024;

struct Session {
    upstream: String,
    /// The first response positions the player; later ones do not.
    positioned: bool,
}

struct Relay {
    port: u16,
    secret: String,
    agent: ureq::Agent,
    sessions: Mutex<HashMap<u64, Session>>,
    next: AtomicU64,
}

static RELAY: OnceLock<Result<Arc<Relay>, String>> = OnceLock::new();

fn relay() -> Result<Arc<Relay>> {
    RELAY
        .get_or_init(|| start().map_err(|error| error.to_string()))
        .clone()
        .map_err(|error| anyhow::anyhow!(error))
}

fn start() -> Result<Arc<Relay>> {
    let listener =
        TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).context("Could not open the playlist relay.")?;
    let relay = Arc::new(Relay {
        port: listener.local_addr()?.port(),
        secret: secret()?,
        agent: ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(8)))
            .http_status_as_error(false)
            .build()
            .into(),
        sessions: Mutex::new(HashMap::new()),
        next: AtomicU64::new(1),
    });
    let serving = relay.clone();
    std::thread::Builder::new()
        .name("vw-playlist-relay".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                if !stream.peer_addr().is_ok_and(|peer| peer.ip().is_loopback()) {
                    continue;
                }
                let relay = serving.clone();
                let _ = std::thread::Builder::new()
                    .name("vw-playlist-request".into())
                    .spawn(move || relay.serve(stream));
            }
        })?;
    Ok(relay)
}

/// 128 random bits from the OS, hex encoded.
fn secret() -> Result<String> {
    use windows::Win32::Security::Cryptography::{
        BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
    };
    let mut bytes = [0u8; 16];
    // SAFETY: fills a stack buffer of the stated length.
    unsafe { BCryptGenRandom(None, &mut bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG) }
        .ok()
        .context("Could not create the relay secret.")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// A registered stream. Dropping it ends the session.
pub struct Relayed {
    id: u64,
    pub url: String,
}

impl Drop for Relayed {
    fn drop(&mut self) {
        if let Ok(relay) = relay() {
            relay
                .sessions
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&self.id);
        }
    }
}

/// Serves the media playlist at `upstream` through the relay.
pub fn register(upstream: &str) -> Result<Relayed> {
    let relay = relay()?;
    let id = relay.next.fetch_add(1, Ordering::Relaxed);
    relay
        .sessions
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(
            id,
            Session {
                upstream: upstream.to_owned(),
                positioned: false,
            },
        );
    Ok(Relayed {
        id,
        url: format!("http://127.0.0.1:{}/{}/{id}/live.m3u8", relay.port, relay.secret),
    })
}

impl Relay {
    fn serve(&self, mut stream: TcpStream) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
        let (status, body) = match read_path(&stream).and_then(|path| self.respond(&path)) {
            Some(body) => ("200 OK", body),
            None => ("404 Not Found", String::new()),
        };
        let head = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nCache-Control: no-cache, no-store\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.write_all(body.as_bytes());
        let _ = stream.flush();
    }

    fn respond(&self, path: &str) -> Option<String> {
        let rest = path.strip_prefix('/')?.strip_prefix(self.secret.as_str())?;
        let id: u64 = rest
            .strip_prefix('/')?
            .strip_suffix("/live.m3u8")?
            .parse()
            .ok()?;
        let upstream = self.session(id, |session| session.upstream.clone())?;
        let text = self.fetch(&upstream).ok()?;
        let position =
            self.session(id, |session| !std::mem::replace(&mut session.positioned, true))?;
        Some(rewrite_media(
            &text,
            &upstream,
            position.then_some(START_CUSHION_SECONDS),
        ))
    }

    fn session<T>(&self, id: u64, f: impl FnOnce(&mut Session) -> T) -> Option<T> {
        self.sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get_mut(&id)
            .map(f)
    }

    fn fetch(&self, url: &str) -> Result<String> {
        let mut response = self.agent.get(url).call()?;
        if !response.status().is_success() {
            bail!("Playlist request returned {}.", response.status().as_u16());
        }
        Ok(response
            .body_mut()
            .with_config()
            .limit(MAX_PLAYLIST_BYTES)
            .read_to_string()?)
    }
}

/// The request path of a simple `GET`, or nothing.
fn read_path(stream: &TcpStream) -> Option<String> {
    let mut reader = BufReader::new(stream.take(MAX_REQUEST_BYTES));
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let path = parts.next()?.to_owned();
    // Drain the headers so the client sees a clean response.
    loop {
        let mut header = String::new();
        match reader.read_line(&mut header) {
            Ok(0) | Err(_) => break,
            Ok(_) if header.trim().is_empty() => break,
            Ok(_) => {}
        }
    }
    Some(path)
}

fn absolute(uri: &str, base: &str) -> String {
    if uri.starts_with("https://") || uri.starts_with("http://") {
        return uri.to_owned();
    }
    let base = base.split('?').next().unwrap_or(base);
    match base.rfind('/') {
        Some(slash) => format!("{}{}", &base[..=slash], uri.trim_start_matches('/')),
        None => uri.to_owned(),
    }
}

/// Tags that belong to the segment that follows them.
fn is_segment_tag(line: &str) -> bool {
    [
        "#EXTINF",
        "#EXT-X-PROGRAM-DATE-TIME",
        "#EXT-X-DISCONTINUITY",
        "#EXT-X-DATERANGE",
        "#EXT-X-BYTERANGE",
        "#EXT-X-KEY",
        "#EXT-X-MAP",
        "#EXT-X-GAP",
    ]
    .iter()
    .any(|tag| line.starts_with(tag))
}

/// Makes segment URIs absolute, drops Twitch's prefetch hints, declares the
/// real target duration, and — for the first response only — trims the front
/// so the newest `cushion` seconds remain, renumbering MEDIA-SEQUENCE and
/// DISCONTINUITY-SEQUENCE to match.
fn rewrite_media(text: &str, upstream: &str, cushion: Option<f64>) -> String {
    let mut header = Vec::new();
    let mut segments: Vec<(Vec<String>, String, f64)> = Vec::new();
    let mut pending: Vec<String> = Vec::new();
    let mut media_sequence: Option<u64> = None;
    let mut discontinuity_sequence: u64 = 0;
    let mut in_segments = false;
    for line in text.lines() {
        let line = line.trim_end();
        if line.is_empty() || line.starts_with("#EXT-X-TWITCH-PREFETCH") {
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            media_sequence = value.trim().parse().ok();
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXT-X-DISCONTINUITY-SEQUENCE:") {
            discontinuity_sequence = value.trim().parse().unwrap_or(0);
            continue;
        }
        if line.starts_with("#EXT-X-TARGETDURATION:") {
            continue;
        }
        if line.starts_with('#') {
            in_segments |= is_segment_tag(line);
            if in_segments {
                pending.push(line.to_owned());
            } else {
                header.push(line.to_owned());
            }
            continue;
        }
        let duration = pending
            .iter()
            .find_map(|tag| tag.strip_prefix("#EXTINF:"))
            .and_then(|value| value.split(',').next())
            .and_then(|value| value.trim().parse::<f64>().ok())
            .unwrap_or(0.);
        segments.push((std::mem::take(&mut pending), absolute(line, upstream), duration));
    }
    // Tags after the last segment (such as ENDLIST) stay at the end.
    let trailing = pending;

    let mut keep_from = 0;
    if let Some(cushion) = cushion {
        let mut kept = 0.;
        keep_from = segments.len();
        while keep_from > 0 && kept < cushion {
            keep_from -= 1;
            kept += segments[keep_from].2.max(0.);
        }
    }
    let dropped_discontinuities = segments[..keep_from]
        .iter()
        .filter(|(tags, _, _)| tags.iter().any(|tag| tag == "#EXT-X-DISCONTINUITY"))
        .count() as u64;
    let target = segments
        .iter()
        .map(|(_, _, duration)| duration.ceil() as u64)
        .max()
        .unwrap_or(2)
        .max(1);

    let mut out = String::with_capacity(text.len());
    let mut lines = header.iter();
    // #EXTM3U must stay first.
    if let Some(first) = lines.next() {
        out.push_str(first);
        out.push('\n');
    }
    out.push_str(&format!("#EXT-X-TARGETDURATION:{target}\n"));
    for line in lines {
        out.push_str(line);
        out.push('\n');
    }
    if let Some(sequence) = media_sequence {
        out.push_str(&format!(
            "#EXT-X-MEDIA-SEQUENCE:{}\n",
            sequence + keep_from as u64
        ));
    }
    let discontinuity = discontinuity_sequence + dropped_discontinuities;
    if discontinuity > 0 {
        out.push_str(&format!("#EXT-X-DISCONTINUITY-SEQUENCE:{discontinuity}\n"));
    }
    for (tags, uri, _) in &segments[keep_from..] {
        for tag in tags {
            out.push_str(tag);
            out.push('\n');
        }
        out.push_str(uri);
        out.push('\n');
    }
    for tag in &trailing {
        out.push_str(tag);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAYLIST: &str = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:100\n#EXT-X-TWITCH-ELAPSED-SECS:5.0\n\
#EXT-X-PROGRAM-DATE-TIME:2026-11-12T10:00:00.000Z\n#EXTINF:2.000,live\nhttps://cdn.example/a.ts\n\
#EXT-X-DISCONTINUITY\n#EXTINF:2.000,live\nhttps://cdn.example/b.ts\n\
#EXTINF:2.000,live\nseg/c.ts\n\
#EXTINF:2.000,live\nhttps://cdn.example/d.ts\n\
#EXTINF:2.000,live\nhttps://cdn.example/e.ts\n\
#EXT-X-TWITCH-PREFETCH:https://cdn.example/f.ts\n";

    #[test]
    fn first_response_starts_near_the_live_edge() {
        let out = rewrite_media(
            PLAYLIST,
            "https://up.example/path/index.m3u8?sig=x",
            Some(6.0),
        );
        assert!(out.starts_with("#EXTM3U\n#EXT-X-TARGETDURATION:2\n"));
        assert!(out.contains("#EXT-X-MEDIA-SEQUENCE:102\n"));
        assert!(out.contains("#EXT-X-DISCONTINUITY-SEQUENCE:1\n"));
        assert!(!out.contains("a.ts") && !out.contains("b.ts"));
        assert!(out.contains("https://up.example/path/seg/c.ts"));
        assert!(out.contains("e.ts"));
        assert!(!out.contains("PREFETCH") && !out.contains("TARGETDURATION:6"));
    }

    #[test]
    fn later_responses_keep_the_whole_window() {
        let out = rewrite_media(PLAYLIST, "https://up.example/index.m3u8", None);
        assert!(out.contains("#EXT-X-MEDIA-SEQUENCE:100\n"));
        assert!(out.contains("a.ts") && out.contains("#EXT-X-DISCONTINUITY\n"));
        assert!(!out.contains("DISCONTINUITY-SEQUENCE"));
        assert!(!out.contains("f.ts"));
    }

    #[test]
    fn rejects_requests_without_the_secret() {
        let relay = Relay {
            port: 0,
            secret: "abc".into(),
            agent: ureq::Agent::new_with_defaults(),
            sessions: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
        };
        relay.sessions.lock().unwrap().insert(
            1,
            Session {
                upstream: "https://example.invalid/live.m3u8".into(),
                positioned: false,
            },
        );
        assert!(relay.respond("/wrong/1/live.m3u8").is_none());
        assert!(relay.respond("/abc/2/live.m3u8").is_none());
        assert!(relay.respond("/abc/../1/live.m3u8").is_none());
    }
}
