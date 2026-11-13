//! A small loopback relay for the HLS *media playlist* (never media segments),
//! modelled on the Electron client's filtered relay.
//!
//! Each session keeps its own playlist. Every Twitch segment is identified by
//! its PROGRAM-DATE-TIME (stable even when Twitch rotates the CDN path) and gets
//! a local media sequence number that never changes, and the list only moves
//! forward — Media Engine follows the HLS rule that the sequence never goes
//! back, and a playlist that broke it made it skip data and smear the picture.
//!
//! - Start: Media Engine begins at the first listed segment, so the list starts
//!   about [`START_CUSHION_SECONDS`] from the live edge, on a segment whose first
//!   frame is a key frame (checked from its first bytes). Starting mid-GOP left
//!   the decoder without references.
//! - Ads: Twitch stitches ads into the playlist. They are dropped (an "Amazon"
//!   title or a date inside a stitched-ad DATERANGE), and live content resumes
//!   after a discontinuity. Until a pre-roll ends the session is not `ready`, so
//!   playback waits instead of failing.
//! - Twitch declares a 6 s target duration for 2 s segments, so Media Engine
//!   would reload too rarely near the live edge; the real length is declared.
//!
//! Segments stay on Twitch's CDN with their absolute URLs; only playlist text
//! crosses the loopback socket. Every URL carries a random per-process secret,
//! so other local programs cannot use the relay, and signed upstream URLs never
//! leave this process.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::{
    Arc, Mutex, OnceLock, PoisonError, Weak,
    atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
};
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail};

use super::ts;

/// How much media playback starts behind the newest segment's end.
pub const START_CUSHION_SECONDS: f64 = 5.0;

/// How far behind the newest listed content playback starts and is kept.
/// `VIOLETWIRE_CUSHION` overrides it for measurements.
pub fn cushion() -> f64 {
    static CUSHION: OnceLock<f64> = OnceLock::new();
    *CUSHION.get_or_init(|| {
        std::env::var("VIOLETWIRE_CUSHION")
            .ok()
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| (0.5..=20.).contains(value))
            .unwrap_or(START_CUSHION_SECONDS)
    })
}
const MAX_SEGMENTS: usize = 18;
const MAX_SEEN: usize = 512;
const MAX_REQUEST_BYTES: u64 = 8 * 1024;
const MAX_PLAYLIST_BYTES: u64 = 512 * 1024;
/// Media Engine may ask twice in quick succession; one upstream read serves both.
const CACHE_FOR: Duration = Duration::from_millis(300);
/// How long a pre-roll ad may keep a new session waiting.
const PRIME_FOR: Duration = Duration::from_secs(150);
const PROBE_BYTES: u64 = 64 * 1024;
/// Older segments tried for a key-frame start, newest first.
const PROBE_CANDIDATES: usize = 5;

/// What the player needs to know about a session.
#[derive(Default)]
pub struct Status {
    ready: AtomicBool,
    ad_break: AtomicBool,
    ads_skipped: AtomicU32,
    failure: Mutex<Option<String>>,
    /// Twitch's PROGRAM-DATE-TIME (ms) of the first listed segment: the
    /// broadcast moment at the player's time zero.
    start_date: Mutex<Option<f64>>,
}

struct Segment {
    sequence: u64,
    discontinuity: bool,
    tags: Vec<String>,
    uri: String,
    /// The address without its signed query, to recognise a prefetch entry
    /// when Twitch lists it as finished.
    uri_key: String,
    duration: f64,
    prefetch: bool,
}

#[derive(Default)]
struct Playlist {
    started: bool,
    segments: VecDeque<Segment>,
    next_sequence: u64,
    seen: HashMap<String, u64>,
    seen_order: VecDeque<String>,
    pending_discontinuity: bool,
    discontinuity_sequence: u64,
    version: u32,
    ended: bool,
    cached: Option<(Instant, String)>,
}

struct Session {
    upstream: String,
    playlist: Mutex<Playlist>,
    status: Arc<Status>,
}

struct Relay {
    port: u16,
    secret: String,
    agent: ureq::Agent,
    sessions: Mutex<HashMap<u64, Arc<Session>>>,
    next: AtomicU64,
}

static RELAY: OnceLock<Result<Arc<Relay>, String>> = OnceLock::new();

fn relay() -> Result<Arc<Relay>> {
    RELAY
        .get_or_init(|| start().map_err(|error| error.to_string()))
        .clone()
        .map_err(|error| anyhow::anyhow!(error))
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
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
    status: Arc<Status>,
}

impl Relayed {
    /// Live segments are listed and the player can start.
    pub fn ready(&self) -> bool {
        self.status.ready.load(Ordering::Acquire)
    }
    /// Twitch is showing an ad in place of the stream right now.
    pub fn ad_break(&self) -> bool {
        self.status.ad_break.load(Ordering::Acquire)
    }
    pub fn ads_skipped(&self) -> u32 {
        self.status.ads_skipped.load(Ordering::Acquire)
    }
    pub fn failure(&self) -> Option<String> {
        lock(&self.status.failure).clone()
    }
    /// When (ms since the epoch) Twitch received the media at the player's
    /// time zero; with the playhead it gives the latency to the broadcaster.
    pub fn start_date_ms(&self) -> Option<f64> {
        *lock(&self.status.start_date)
    }
}

impl Drop for Relayed {
    fn drop(&mut self) {
        if let Ok(relay) = relay() {
            lock(&relay.sessions).remove(&self.id);
        }
    }
}

/// Serves the media playlist at `upstream` through the relay. The session
/// primes itself in the background; [`Relayed::ready`] says when to start.
pub fn register(upstream: &str) -> Result<Relayed> {
    let relay = relay()?;
    let id = relay.next.fetch_add(1, Ordering::Relaxed);
    let status = Arc::new(Status::default());
    let session = Arc::new(Session {
        upstream: upstream.to_owned(),
        playlist: Mutex::new(Playlist::default()),
        status: status.clone(),
    });
    lock(&relay.sessions).insert(id, session.clone());
    let weak: Weak<Session> = Arc::downgrade(&session);
    drop(session);
    let priming = relay.clone();
    std::thread::Builder::new()
        .name("vw-playlist-prime".into())
        .spawn(move || priming.prime(weak))?;
    Ok(Relayed {
        id,
        url: format!("http://127.0.0.1:{}/{}/{id}/live.m3u8", relay.port, relay.secret),
        status,
    })
}

impl Relay {
    /// Reads the playlist until live segments can start playback, waiting out
    /// a pre-roll ad. Ends early if the session is dropped.
    fn prime(&self, session: Weak<Session>) {
        let started = Instant::now();
        loop {
            let Some(session) = session.upgrade() else {
                return;
            };
            let _ = self.refresh(&session);
            if session.status.ready.load(Ordering::Acquire) {
                return;
            }
            if started.elapsed() > PRIME_FOR {
                *lock(&session.status.failure) =
                    Some("Twitch did not send the stream (an ad break ran too long).".into());
                return;
            }
            drop(session);
            std::thread::sleep(Duration::from_secs(1));
        }
    }

    fn serve(&self, mut stream: TcpStream) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
        let (status, body) = match read_path(&stream).map(|path| self.respond(&path)) {
            Some(Some(body)) => ("200 OK", body),
            Some(None) | None => ("404 Not Found", String::new()),
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
        let session = lock(&self.sessions).get(&id).cloned()?;
        self.refresh(&session)
    }

    /// Reads Twitch's playlist into the session's and renders it. Refreshes
    /// of one session run one at a time, under its playlist lock.
    fn refresh(&self, session: &Session) -> Option<String> {
        let timer = Instant::now();
        let mut playlist = lock(&session.playlist);
        if let Some((at, body)) = &playlist.cached
            && at.elapsed() < CACHE_FOR
        {
            return Some(body.clone());
        }
        let text = self.fetch(&session.upstream).ok()?;
        let parsed = parse(&text, &session.upstream);
        session
            .status
            .ad_break
            .store(parsed.segments.last().is_some_and(|s| s.ad), Ordering::Release);
        if playlist.started {
            playlist.merge(parsed, &session.status);
        } else {
            let keyframes = self.probe_starts(&parsed);
            if std::env::var_os("VIOLETWIRE_PLAYBACK_LOG").is_some() {
                eprintln!(
                    "[relay] start candidates {:?}, key frames {keyframes:?}",
                    start_candidates(&parsed)
                );
            }
            if !playlist.begin(parsed, &keyframes, &session.status) {
                return None;
            }
            session.status.ready.store(true, Ordering::Release);
        }
        let body = playlist.render()?;
        if std::env::var_os("VIOLETWIRE_PLAYBACK_LOG").is_some() {
            eprintln!("[relay] refresh took {} ms", timer.elapsed().as_millis());
        }
        playlist.cached = Some((Instant::now(), body.clone()));
        Some(body)
    }

    /// For the segments a session could start on, whether each opens on a key
    /// frame, read from their first bytes in parallel.
    fn probe_starts(&self, parsed: &Parsed) -> HashMap<usize, Option<bool>> {
        let candidates = start_candidates(parsed);
        // The nearest one nearly always opens on a key frame: ask about it
        // alone first (one connection), and only then about the others.
        let Some((&nearest, older)) = candidates.split_first() else {
            return HashMap::new();
        };
        let first = self.opens_on_keyframe(&parsed.segments[nearest].uri);
        if first == Some(true) {
            return HashMap::from([(nearest, first)]);
        }
        let mut found: HashMap<usize, Option<bool>> = std::thread::scope(|scope| {
            let probes: Vec<_> = older
                .iter()
                .copied()
                .map(|index| {
                    let uri = parsed.segments[index].uri.clone();
                    scope.spawn(move || (index, self.opens_on_keyframe(&uri)))
                })
                .collect();
            probes.into_iter().filter_map(|probe| probe.join().ok()).collect()
        });
        found.insert(nearest, first);
        found
    }

    fn opens_on_keyframe(&self, uri: &str) -> Option<bool> {
        let mut response = self
            .agent
            .get(uri)
            .header("Range", format!("bytes=0-{}", PROBE_BYTES - 1))
            .config()
            .timeout_global(Some(Duration::from_secs(3)))
            .build()
            .call()
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let mut bytes = Vec::with_capacity(PROBE_BYTES as usize);
        response
            .body_mut()
            .as_reader()
            .take(PROBE_BYTES)
            .read_to_end(&mut bytes)
            .ok()?;
        ts::first_frame_is_keyframe(&bytes)
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

// ----- Twitch's playlist ------------------------------------------------------

struct ParsedSegment {
    key: String,
    /// Tags that travel with the segment (date, length, byte range, key, map).
    tags: Vec<String>,
    uri: String,
    uri_key: String,
    duration: f64,
    /// PROGRAM-DATE-TIME in ms (inferred for a prefetch entry).
    date: Option<f64>,
    discontinuity: bool,
    ad: bool,
    /// Twitch's hint for the segment it is still encoding. Listed as an
    /// ordinary segment it brings playback a couple of segments closer to
    /// live, as Streamlink's and the Electron client's low-latency modes do;
    /// the player reads it as it is written.
    prefetch: bool,
}

fn uri_key(uri: &str) -> String {
    uri.split('?').next().unwrap_or(uri).to_owned()
}

fn prefetch_enabled() -> bool {
    std::env::var_os("VIOLETWIRE_NO_PREFETCH").is_none()
}

struct Parsed {
    segments: Vec<ParsedSegment>,
    /// Fragmented MP4 (`EXT-X-MAP`) rather than MPEG-TS.
    fmp4: bool,
    version: u32,
    media_sequence: Option<u64>,
    ended: bool,
}

/// Milliseconds since the epoch for `2026-11-12T10:00:00.123Z`.
fn date_ms(text: &str) -> Option<f64> {
    let text = text.trim().trim_matches('"');
    let seconds = crate::format::unix_from_rfc3339(text)? as f64;
    let fraction = text
        .get(19..)
        .and_then(|rest| rest.strip_prefix('.'))
        .map(|rest| rest.trim_end_matches('Z'))
        .and_then(|digits| format!("0.{digits}").parse::<f64>().ok())
        .unwrap_or(0.);
    Some((seconds + fraction) * 1000.)
}

/// `KEY=value,KEY="quoted, value"` attributes.
fn attributes(list: &str) -> HashMap<String, String> {
    let mut found = HashMap::new();
    let mut rest = list;
    while !rest.is_empty() {
        let Some((key, after)) = rest.split_once('=') else {
            break;
        };
        let (value, next) = if let Some(quoted) = after.strip_prefix('"') {
            match quoted.split_once('"') {
                Some((value, next)) => (value, next.strip_prefix(',').unwrap_or(next)),
                None => (quoted, ""),
            }
        } else {
            match after.split_once(',') {
                Some((value, next)) => (value, next),
                None => (after, ""),
            }
        };
        found.insert(key.trim().to_owned(), value.to_owned());
        rest = next;
    }
    found
}

/// Stitched-ad date ranges, as (start, end) in milliseconds.
fn ad_ranges(text: &str) -> Vec<(f64, f64)> {
    text.lines()
        .filter_map(|line| line.trim().strip_prefix("#EXT-X-DATERANGE:"))
        .filter_map(|list| {
            let found = attributes(list);
            let id = found.get("ID").map(String::as_str).unwrap_or_default();
            let class = found.get("CLASS").map(String::as_str).unwrap_or_default();
            if class != "twitch-stitched-ad" && !id.starts_with("stitched-ad-") {
                return None;
            }
            let start = date_ms(found.get("START-DATE")?)?;
            let end = found
                .get("END-DATE")
                .and_then(|end| date_ms(end))
                .or_else(|| {
                    found
                        .get("DURATION")
                        .or_else(|| found.get("PLANNED-DURATION"))
                        .and_then(|seconds| seconds.parse::<f64>().ok())
                        .filter(|seconds| *seconds > 0.)
                        .map(|seconds| start + seconds * 1000.)
                })
                .unwrap_or(start);
            Some((start, end))
        })
        .collect()
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

fn parse(text: &str, base: &str) -> Parsed {
    let ads = ad_ranges(text);
    let mut parsed = Parsed {
        segments: Vec::new(),
        fmp4: false,
        version: 3,
        media_sequence: None,
        ended: false,
    };
    let (mut tags, mut discontinuity) = (Vec::new(), false);
    let (mut duration, mut title, mut date): (Option<f64>, String, Option<f64>) = (None, String::new(), None);
    let (mut key_tag, mut map_tag): (Option<String>, Option<String>) = (None, None);
    let mut byte_range: Option<String> = None;
    let mut previous_date: Option<f64> = None;
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if line == "#EXT-X-DISCONTINUITY" {
            discontinuity = true;
        } else if line == "#EXT-X-ENDLIST" {
            parsed.ended = true;
        } else if let Some(value) = line.strip_prefix("#EXT-X-VERSION:") {
            parsed.version = value.trim().parse().unwrap_or(3);
        } else if let Some(value) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            parsed.media_sequence = value.trim().parse().ok();
        } else if let Some(value) = line.strip_prefix("#EXT-X-PROGRAM-DATE-TIME:") {
            date = date_ms(value);
            tags.push(line.to_owned());
        } else if let Some(value) = line.strip_prefix("#EXTINF:") {
            let (length, name) = value.split_once(',').unwrap_or((value, ""));
            duration = length.trim().parse().ok();
            title = name.to_owned();
            tags.push(line.to_owned());
        } else if line.starts_with("#EXT-X-BYTERANGE:") {
            byte_range = Some(line.to_owned());
            tags.push(line.to_owned());
        } else if line == "#EXT-X-GAP" {
            tags.push(line.to_owned());
        } else if line.starts_with("#EXT-X-KEY:") {
            key_tag = Some(line.to_owned());
        } else if line.starts_with("#EXT-X-MAP:") {
            map_tag = Some(line.to_owned());
            parsed.fmp4 = true;
        } else if let Some(hint) = line.strip_prefix("#EXT-X-TWITCH-PREFETCH:") {
            let Some(previous) = parsed.segments.last() else {
                continue;
            };
            if !prefetch_enabled() {
                continue;
            }
            let uri = absolute(hint.trim(), base);
            let length = previous.duration;
            // The date it will have once finished: right after the one before.
            let inferred = previous_date.map(|date| date + previous.duration * 1000.);
            // Twitch numbers the fragments it is writing last+1 and last+2,
            // and keeps those numbers once they finish. An inferred date
            // drifts whenever a fragment comes out shorter than the one
            // before, which mismatched entries (see the Electron notes).
            let key = match (parsed.media_sequence, inferred) {
                (Some(first), _) => format!("seq:{}|", first + parsed.segments.len() as u64),
                (None, Some(date)) => format!("pdt:{date}|"),
                (None, None) => format!("{}|", uri_key(&uri)),
            };
            let ad = previous.ad
                || inferred.is_some_and(|date| ads.iter().any(|(start, end)| date >= *start && date < *end));
            previous_date = inferred;
            parsed.segments.push(ParsedSegment {
                key,
                tags: vec![format!("#EXTINF:{length:.3},live")],
                uri_key: uri_key(&uri),
                uri,
                duration: length,
                date: inferred,
                discontinuity: false,
                ad,
                prefetch: true,
            });
        } else if line.starts_with('#') {
            // Date ranges and Twitch's own tags stay behind.
        } else if let Some(length) = duration.filter(|length| length.is_finite()) {
            let uri = absolute(line, base);
            let key = match (parsed.media_sequence, date) {
                (Some(first), _) => format!(
                    "seq:{}|{}",
                    first + parsed.segments.len() as u64,
                    byte_range.as_deref().unwrap_or("")
                ),
                (None, Some(date)) => format!("pdt:{date}|{}", byte_range.as_deref().unwrap_or("")),
                (None, None) => format!(
                    "{}|{}",
                    uri.split('?').next().unwrap_or(&uri),
                    byte_range.as_deref().unwrap_or("")
                ),
            };
            let ad = title.contains("Amazon")
                || date.is_some_and(|date| ads.iter().any(|(start, end)| date >= *start && date < *end));
            let mut segment_tags: Vec<String> = key_tag.iter().chain(map_tag.iter()).cloned().collect();
            segment_tags.append(&mut tags);
            previous_date = date;
            parsed.segments.push(ParsedSegment {
                key,
                tags: segment_tags,
                uri_key: uri_key(&uri),
                uri,
                duration: length,
                date,
                discontinuity,
                ad,
                prefetch: false,
            });
            (discontinuity, duration, date, byte_range) = (false, None, None, None);
            title.clear();
        }
    }
    parsed
}

/// Where playback starts on an MPEG-TS stream: on the fragment Twitch is
/// still writing (the first prefetch entry), the way Electron's parts relay
/// played from it. Media Engine reads a TS fragment as it arrives. Measured on
/// sodapoppin: 4.5 s behind the broadcaster with the first frame at 3.1 s,
/// against 6.8 s and 2.4 s from a finished fragment; no stalls.
///
/// Fragmented MP4 is only readable once a fragment is complete: started this
/// way, summit1g took 7.8 s to show a frame. Those start on a finished one.
fn starts_on_prefetch(parsed: &Parsed) -> bool {
    !parsed.fmp4
        && LOW_LATENCY.load(Ordering::Acquire)
        && std::env::var_os("VIOLETWIRE_NO_PREFETCH_START").is_none()
}

/// Electron's "Low latency" (`playbackLatencyMode: ultra-low`, its default).
/// Off ("balanced") starts every stream on a finished fragment: ~2 s further
/// behind, but a fragment that comes out short never runs playback dry.
static LOW_LATENCY: AtomicBool = AtomicBool::new(true);

pub fn set_low_latency(enabled: bool) {
    LOW_LATENCY.store(enabled, Ordering::Release);
}

/// The newest finished segment from which at least the cushion remains
/// (prefetch entries count towards it), then a few older ones, all after the
/// last ad. On MPEG-TS the fragment being written comes first; see
/// [`starts_on_prefetch`].
fn start_candidates(parsed: &Parsed) -> Vec<usize> {
    let segments = &parsed.segments;
    if segments.last().is_none_or(|segment| segment.ad) {
        return Vec::new();
    }
    let first_live = segments
        .iter()
        .rposition(|segment| segment.ad)
        .map_or(0, |ad| ad + 1);
    // The oldest prefetch entry is the fragment being written.
    let writing = segments
        .iter()
        .position(|segment| segment.prefetch)
        .filter(|&index| index >= first_live && starts_on_prefetch(parsed));
    let mut index = segments.len();
    let mut kept = 0.;
    while index > first_live && kept < cushion() {
        index -= 1;
        kept += segments[index].duration.max(0.);
    }
    let finished = (first_live..=index)
        .rev()
        .filter(|&candidate| !segments[candidate].prefetch);
    writing
        .into_iter()
        .chain(finished)
        .take(PROBE_CANDIDATES)
        .collect()
}

impl Playlist {
    /// The first read with live content: list from a key-frame start near the
    /// live edge and remember everything older so it is never added.
    fn begin(&mut self, parsed: Parsed, keyframes: &HashMap<usize, Option<bool>>, status: &Status) -> bool {
        let candidates = start_candidates(&parsed);
        let Some(&nearest) = candidates.first() else {
            return false;
        };
        // The newest candidate known to open on a key frame; failing that, the
        // nearest one (its first frames may smear until the next key frame).
        let start = candidates
            .iter()
            .copied()
            .find(|index| keyframes.get(index) == Some(&Some(true)))
            .unwrap_or(nearest);
        self.version = parsed.version.max(3);
        self.ended = parsed.ended;
        self.next_sequence = parsed.media_sequence.unwrap_or(0) + start as u64;
        *lock(&status.start_date) = parsed.segments.get(start).and_then(|segment| segment.date);
        for (index, segment) in parsed.segments.into_iter().enumerate() {
            if index < start || segment.ad {
                self.remember(segment.key, u64::MAX);
                if segment.ad && index >= start {
                    status.ads_skipped.fetch_add(1, Ordering::AcqRel);
                }
                continue;
            }
            self.push(segment);
        }
        self.started = true;
        true
    }

    /// A later read: append new live segments, drop ads, keep identities.
    fn merge(&mut self, parsed: Parsed, status: &Status) {
        self.ended = parsed.ended;
        for segment in parsed.segments {
            if segment.ad {
                // Only a new ad (or a listed entry found to be one) marks a
                // discontinuity; one still in Twitch's window from an earlier
                // read must not mark the next live segment again.
                match self.seen.get(&segment.key).copied() {
                    Some(u64::MAX) => {}
                    Some(sequence) => {
                        self.segments.retain(|kept| kept.sequence != sequence);
                        self.seen.insert(segment.key, u64::MAX);
                        self.pending_discontinuity = true;
                    }
                    None => {
                        self.remember(segment.key, u64::MAX);
                        status.ads_skipped.fetch_add(1, Ordering::AcqRel);
                        self.pending_discontinuity = true;
                    }
                }
                continue;
            }
            if let Some(&sequence) = self.seen.get(&segment.key) {
                // Already known: keep its number, take the newest address,
                // and Twitch's own tags once a prefetch entry is finished.
                if let Some(kept) = self.segments.iter_mut().find(|kept| kept.sequence == sequence) {
                    kept.uri = segment.uri;
                    kept.uri_key = segment.uri_key;
                    if kept.prefetch && !segment.prefetch {
                        kept.prefetch = false;
                        kept.tags = segment.tags;
                        kept.duration = segment.duration;
                    }
                }
                continue;
            }
            // A finished segment whose date was not what the prefetch entry
            // guessed: the same address is the same segment.
            if let Some(kept) = self
                .segments
                .iter_mut()
                .find(|kept| kept.prefetch && kept.uri_key == segment.uri_key)
            {
                let sequence = kept.sequence;
                kept.prefetch = segment.prefetch;
                kept.tags = segment.tags;
                kept.duration = segment.duration;
                kept.uri = segment.uri;
                self.remember(segment.key, sequence);
                continue;
            }
            self.push(segment);
        }
        while self.segments.len() > MAX_SEGMENTS {
            if self.segments.pop_front().is_some_and(|segment| segment.discontinuity) {
                self.discontinuity_sequence += 1;
            }
        }
    }

    fn push(&mut self, segment: ParsedSegment) {
        let sequence = self.next_sequence;
        self.next_sequence += 1;
        self.remember(segment.key, sequence);
        let discontinuity = (segment.discontinuity || self.pending_discontinuity)
            && !self.segments.is_empty();
        self.pending_discontinuity = false;
        self.segments.push_back(Segment {
            sequence,
            discontinuity,
            tags: segment.tags,
            uri: segment.uri,
            uri_key: segment.uri_key,
            duration: segment.duration,
            prefetch: segment.prefetch,
        });
    }

    fn remember(&mut self, key: String, sequence: u64) {
        if self.seen.insert(key.clone(), sequence).is_none() {
            self.seen_order.push_back(key);
        }
        while self.seen_order.len() > MAX_SEEN {
            if let Some(oldest) = self.seen_order.pop_front() {
                self.seen.remove(&oldest);
            }
        }
    }

    fn render(&self) -> Option<String> {
        let first = self.segments.front()?;
        let target = self
            .segments
            .iter()
            .map(|segment| segment.duration.ceil() as u64)
            .max()
            .unwrap_or(2)
            .max(1);
        let mut out = format!(
            "#EXTM3U\n#EXT-X-VERSION:{}\n#EXT-X-TARGETDURATION:{target}\n#EXT-X-MEDIA-SEQUENCE:{}\n",
            self.version, first.sequence
        );
        if self.discontinuity_sequence > 0 {
            out.push_str(&format!(
                "#EXT-X-DISCONTINUITY-SEQUENCE:{}\n",
                self.discontinuity_sequence
            ));
        }
        for segment in &self.segments {
            if segment.discontinuity {
                out.push_str("#EXT-X-DISCONTINUITY\n");
            }
            for tag in &segment.tags {
                out.push_str(tag);
                out.push('\n');
            }
            out.push_str(&segment.uri);
            out.push('\n');
        }
        if self.ended {
            out.push_str("#EXT-X-ENDLIST\n");
        }
        Some(out)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn playlist(first: u64, segments: &[(&str, &str)]) -> String {
        let mut text = format!(
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:{first}\n"
        );
        for (index, (title, extra)) in segments.iter().enumerate() {
            let n = first + index as u64;
            text.push_str(extra);
            text.push_str(&format!(
                "#EXT-X-PROGRAM-DATE-TIME:2026-11-12T10:00:{:02}.000Z\n#EXTINF:2.000,{title}\nhttps://cdn.example/{n}.ts?sig=x\n",
                n % 60
            ));
        }
        text
    }

    /// Twitch's hints for the next segments, numbered after the listed ones.
    fn with_prefetch(mut text: String, numbers: &[u64]) -> String {
        for n in numbers {
            text.push_str(&format!("#EXT-X-TWITCH-PREFETCH:https://cdn.example/{n}.ts?sig=p\n"));
        }
        text
    }

    #[test]
    fn lists_prefetch_entries_and_keeps_their_numbers_once_finished() {
        let status = Status::default();
        let mut list = Playlist::default();
        let first = with_prefetch(playlist(0, &[("live", ""); 10]), &[10, 11]);
        assert!(list.begin(parse(&first, "https://up/x.m3u8"), &HashMap::new(), &status));
        let (start, uris) = sequences(&list.render().unwrap());
        // MPEG-TS starts on the fragment being written.
        assert_eq!(uris, ["10.ts", "11.ts"]);
        assert_eq!(start, 10);
        // 10 finishes (its real date differs from the guess), 12 is the new hint.
        let next = with_prefetch(playlist(1, &[("live", ""); 10]), &[11, 12]);
        list.merge(parse(&next, "https://up/x.m3u8"), &status);
        let body = list.render().unwrap();
        let (start, uris) = sequences(&body);
        assert_eq!(start, 10);
        assert_eq!(uris, ["10.ts", "11.ts", "12.ts"]);
        // The finished one now carries Twitch's own date.
        assert!(body.contains("10.000Z\n#EXTINF:2.000,live\nhttps://cdn.example/10.ts"));
    }

    #[test]
    fn fragmented_mp4_never_starts_on_a_fragment_being_written() {
        let status = Status::default();
        let mut list = Playlist::default();
        let first = with_prefetch(playlist(0, &[("live", ""); 10]), &[10, 11])
            .replacen("#EXT-X-MEDIA-SEQUENCE", "#EXT-X-MAP:URI=\"https://cdn.example/init.mp4\"
#EXT-X-MEDIA-SEQUENCE", 1);
        assert!(list.begin(parse(&first, "https://up/x.m3u8"), &HashMap::new(), &status));
        let (start, uris) = sequences(&list.render().unwrap());
        // 5 s back counting the two prefetch entries, on a finished fragment.
        assert_eq!(uris, ["9.ts", "10.ts", "11.ts"]);
        assert_eq!(start, 9);
    }

    fn sequences(body: &str) -> (u64, Vec<String>) {
        let first = body
            .lines()
            .find_map(|line| line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:"))
            .unwrap()
            .parse()
            .unwrap();
        let uris = body
            .lines()
            .filter(|line| line.starts_with("https://"))
            .map(|line| line.split('?').next().unwrap().rsplit('/').next().unwrap().to_owned())
            .collect();
        (first, uris)
    }

    #[test]
    fn starts_near_the_edge_and_only_ever_moves_forward() {
        let status = Status::default();
        let mut list = Playlist::default();
        let live: Vec<(&str, &str)> = vec![("live", ""); 10];
        assert!(list.begin(parse(&playlist(100, &live), "https://up/x.m3u8"), &HashMap::new(), &status));
        let (first, uris) = sequences(&list.render().unwrap());
        // 5 s of 2 s segments from the end: the last three.
        assert_eq!(uris, ["107.ts", "108.ts", "109.ts"]);
        assert_eq!(first, 107);
        // The next read has the old window plus one more; nothing old returns.
        list.merge(parse(&playlist(101, &[("live", ""); 10]), "https://up/x.m3u8"), &status);
        let (first, uris) = sequences(&list.render().unwrap());
        assert_eq!(first, 107);
        assert_eq!(uris, ["107.ts", "108.ts", "109.ts", "110.ts"]);
        let body = list.render().unwrap();
        assert!(body.contains("#EXT-X-TARGETDURATION:2\n"));
        assert!(!body.contains("PREFETCH"));
    }

    #[test]
    fn prefers_a_key_frame_start() {
        let status = Status::default();
        let mut list = Playlist::default();
        let parsed = parse(&playlist(0, &[("live", ""); 10]), "https://up/x.m3u8");
        // Candidates are 7, 6, 5, ...; 7 opens mid-GOP, 6 on a key frame.
        let keyframes = HashMap::from([(7, Some(false)), (6, Some(true)), (5, Some(true))]);
        list.begin(parsed, &keyframes, &status);
        let (first, uris) = sequences(&list.render().unwrap());
        assert_eq!((first, uris.first().map(String::as_str)), (6, Some("6.ts")));
    }

    #[test]
    fn drops_ads_and_marks_where_the_stream_resumes() {
        let status = Status::default();
        let mut list = Playlist::default();
        assert!(list.begin(parse(&playlist(0, &[("live", ""); 6]), "https://up/x.m3u8"), &HashMap::new(), &status));
        let mut next: Vec<(&str, &str)> = vec![("live", ""); 5];
        next.push(("Amazon|123", ""));
        next.push(("Amazon|123", ""));
        next.push(("live", ""));
        list.merge(parse(&playlist(1, &next), "https://up/x.m3u8"), &status);
        let body = list.render().unwrap();
        assert!(!body.contains("6.ts") && !body.contains("7.ts"));
        assert!(body.contains("#EXT-X-DISCONTINUITY\n#EXT-X-PROGRAM-DATE-TIME:2026-11-12T10:00:08.000Z"));
        assert_eq!(status.ads_skipped.load(Ordering::Acquire), 2);
        // Local numbers stay contiguous across the gap.
        let (first, uris) = sequences(&body);
        assert_eq!(first, 3);
        assert_eq!(uris, ["3.ts", "4.ts", "5.ts", "8.ts"]);
    }

    #[test]
    fn an_old_ad_still_in_the_window_adds_no_more_discontinuities() {
        let status = Status::default();
        let mut list = Playlist::default();
        let first: Vec<(&str, &str)> = vec![("live", ""); 6];
        assert!(list.begin(parse(&playlist(0, &first), "https://up/x.m3u8"), &HashMap::new(), &status));
        let mut next: Vec<(&str, &str)> = vec![("live", ""); 6];
        next.extend([("Amazon|1", ""), ("live", "")]);
        list.merge(parse(&playlist(0, &next), "https://up/x.m3u8"), &status);
        next.push(("live", ""));
        list.merge(parse(&playlist(0, &next), "https://up/x.m3u8"), &status);
        let body = list.render().unwrap();
        assert_eq!(body.matches("#EXT-X-DISCONTINUITY\n").count(), 1);
    }

    #[test]
    fn a_pre_roll_keeps_the_session_waiting() {
        let status = Status::default();
        let mut list = Playlist::default();
        let ads: Vec<(&str, &str)> = vec![("Amazon|1", ""); 4];
        assert!(!list.begin(parse(&playlist(0, &ads), "https://up/x.m3u8"), &HashMap::new(), &status));
        assert!(list.render().is_none());
    }

    #[test]
    fn stitched_ad_date_ranges_mark_segments_as_ads() {
        let range = "#EXT-X-DATERANGE:ID=\"stitched-ad-1\",CLASS=\"twitch-stitched-ad\",START-DATE=\"2026-11-12T10:00:02.000Z\",DURATION=4.0\n";
        let parsed = parse(
            &playlist(0, &[("live", range), ("live", ""), ("live", ""), ("live", "")]),
            "https://up/x.m3u8",
        );
        // The test playlist dates segment n at n seconds: 2 and 3 fall in
        // the 4-second range starting at 2.
        let flags: Vec<bool> = parsed.segments.iter().map(|s| s.ad).collect();
        assert_eq!(flags, [false, false, true, true]);
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
        assert!(relay.respond("/wrong/1/live.m3u8").is_none());
        assert!(relay.respond("/abc/2/live.m3u8").is_none());
        assert!(relay.respond("/abc/../1/live.m3u8").is_none());
    }
}
