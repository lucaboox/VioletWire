//! Short *ordinary* HLS segments for Media Engine, not unsupported LL-HLS tags.
//! Opt-in while Media Engine's remaining startup/seek latency is investigated.
use super::*;

const MAX_BYTES: usize = 48 * 1024 * 1024;
const MAX_SECONDS: f64 = 30.;
const MAX_FRAGMENT: u64 = 16 * 1024 * 1024;

/// Ends this continuous input for a reason that passes: the player opens a
/// fresh one (after an ad, once live content returns) instead of falling back
/// to HLS for the rest of the session.
fn reset(session: &Session, reason: &str) -> bool {
    session.status.retryable.store(true, Ordering::Release);
    *lock(&session.status.failure) = Some(reason.into());
    true
}

pub(super) fn enabled() -> bool {
    LOW_LATENCY.load(Ordering::Acquire)
        && std::env::var_os("VIOLETWIRE_NO_PARTS").is_none()
        && (std::env::var_os("VIOLETWIRE_PARTS_SPIKE").is_some()
            || std::env::var_os("VIOLETWIRE_PARTS").is_some()
            || std::env::var_os("VIOLETWIRE_PROGRESSIVE_SOURCE").is_some())
}

struct Piece {
    sequence: u64,
    bytes: Arc<[u8]>,
    duration: f64,
    discontinuity: bool,
    date_tag: Option<String>,
    position: f64,
    independent: bool,
    delivered: bool,
}
#[derive(Default)]
pub(super) struct Pieces {
    mp4: Option<(String, super::super::mp4::VideoTracks)>,
    raw: VecDeque<(u64, Arc<[u8]>)>,
    raw_bytes: usize,
    raw_next: u64,
    entries: VecDeque<Piece>,
    next: u64,
    bytes: usize,
    seconds: f64,
    discontinuities: u64,
    duration: f64,
}
impl Pieces {
    pub(super) fn next(&self, sequence: u64) -> Option<(u64, Arc<[u8]>)> {
        self.raw
            .iter()
            .find(|(id, _)| *id >= sequence)
            .map(|(id, bytes)| (*id, bytes.clone()))
    }
    fn push_raw(&mut self, bytes: &[u8]) {
        for chunk in bytes.chunks(32 * 1024) {
            self.raw_bytes += chunk.len();
            self.raw.push_back((self.raw_next, Arc::from(chunk)));
            self.raw_next += 1;
        }
        while self.raw_bytes > 8 * 1024 * 1024 {
            if let Some((_, bytes)) = self.raw.pop_front() {
                self.raw_bytes -= bytes.len();
            }
        }
    }
    pub(super) fn get(&self, sequence: u64) -> Option<Arc<[u8]>> {
        self.entries
            .iter()
            .find(|piece| piece.sequence == sequence)
            .map(|piece| piece.bytes.clone())
    }
    pub(super) fn delivered(&mut self, sequence: u64) {
        if let Some(piece) = self
            .entries
            .iter_mut()
            .find(|piece| piece.sequence == sequence)
        {
            piece.delivered = true;
        }
    }
    pub(super) fn safe_target(&self, cushion: f64) -> Option<f64> {
        self.entries
            .iter()
            .enumerate()
            .rev()
            .find_map(|(index, piece)| {
                (piece.independent
                    && piece.delivered
                    && self.entries.len() >= index + 3
                    && self.duration - piece.position >= 1.5 + cushion
                    && self
                        .entries
                        .iter()
                        .skip(index + 1)
                        .take(2)
                        .all(|next| next.delivered && !next.discontinuity))
                .then_some(piece.position + 0.05)
            })
    }
    fn append(
        &mut self,
        cuts: Vec<ts::Piece>,
        source: &ParsedSegment,
        discontinuity: bool,
        first_index: usize,
    ) -> Vec<Arc<[u8]>> {
        let mut published = Vec::new();
        for (index, cut) in cuts.into_iter().enumerate() {
            self.bytes += cut.bytes.len();
            self.seconds += cut.duration;
            let bytes: Arc<[u8]> = cut.bytes.into();
            published.push(bytes.clone());
            self.entries.push_back(Piece {
                sequence: self.next,
                bytes,
                duration: cut.duration,
                discontinuity: index + first_index == 0 && discontinuity && self.next > 0,
                date_tag: (index + first_index == 0)
                    .then(|| {
                        source
                            .tags
                            .iter()
                            .find(|tag| tag.starts_with("#EXT-X-PROGRAM-DATE-TIME:"))
                            .cloned()
                            .or_else(|| source.date.and_then(program_date))
                    })
                    .flatten(),
                position: self.duration,
                independent: cut.independent,
                delivered: false,
            });
            self.duration += cut.duration;
            self.next += 1;
        }
        while self.bytes > MAX_BYTES || self.seconds > MAX_SECONDS {
            let Some(old) = self.entries.pop_front() else {
                break;
            };
            self.bytes -= old.bytes.len();
            self.seconds -= old.duration;
            if old.discontinuity {
                self.discontinuities += 1;
            }
        }
        published
    }
    pub(super) fn render(&self) -> Option<String> {
        let first = self.entries.front()?;
        let mut out = format!(
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:{}\n#EXT-X-DISCONTINUITY-SEQUENCE:{}\n",
            first.sequence, self.discontinuities
        );
        for piece in &self.entries {
            if piece.discontinuity {
                out.push_str("#EXT-X-DISCONTINUITY\n");
            }
            if let Some(tag) = &piece.date_tag {
                out.push_str(tag);
                out.push('\n');
            }
            out.push_str(&format!(
                "#EXTINF:{:.6},live\np/{}.ts\n",
                piece.duration, piece.sequence
            ));
        }
        Some(out)
    }
}

struct Pending {
    sequence: u64,
    published: Vec<Arc<[u8]>>,
    wait_finished: bool,
    retries: u8,
    raw_published: usize,
}

enum Download {
    Complete,
    Retry,
    Skip,
    Ad,
    Failed,
}

fn download(
    relay: &Relay,
    session: &Session,
    source: &ParsedSegment,
    pending: &mut Pending,
    discontinuity: bool,
    need_keyframe: bool,
    spike: bool,
) -> Download {
    let is_mp4 = session.status.mp4.load(Ordering::Acquire);
    if is_mp4 {
        let pieces = lock(&session.pieces);
        let matches = pieces
            .as_ref()
            .and_then(|pieces| pieces.mp4.as_ref())
            .is_some_and(|(map, _)| source.tags.iter().any(|tag| tag == map));
        if !matches {
            if std::env::var_os("VIOLETWIRE_PLAYBACK_LOG").is_some() {
                eprintln!("[mp4-input] init changed before fragment");
            }
            return Download::Failed;
        }
    }
    if !media_url(&source.uri) {
        if is_mp4 && std::env::var_os("VIOLETWIRE_PLAYBACK_LOG").is_some() {
            eprintln!("[mp4-input] rejected media address");
        }
        return Download::Failed;
    }
    let Ok(mut response) = relay
        .agent
        .get(&source.uri)
        .config()
        .max_redirects(0)
        .timeout_global(Some(Duration::from_secs(10)))
        .timeout_per_read(Some(Duration::from_secs(3)))
        .build()
        .call()
    else {
        return Download::Retry;
    };
    if !response.status().is_success() {
        return Download::Retry;
    }
    let mut reader = response.body_mut().as_reader();
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 32 * 1024];
    let mut checked = Instant::now();
    loop {
        if session.status.cancelled.load(Ordering::Acquire) || !LOW_LATENCY.load(Ordering::Acquire)
        {
            return Download::Failed;
        }
        let count = match reader.read(&mut chunk) {
            Ok(count) => count,
            Err(_) => return Download::Retry,
        };
        let complete = count == 0;
        if bytes.len() + count > MAX_FRAGMENT as usize {
            return Download::Failed;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if source.prefetch && checked.elapsed() >= Duration::from_millis(400) {
            checked = Instant::now();
            if let Ok(text) = relay.fetch(&session.upstream) {
                let current = parse(&text, &session.upstream);
                if !eligible(&current) {
                    return Download::Failed;
                }
                if let Some(index) = current
                    .media_sequence
                    .and_then(|first| pending.sequence.checked_sub(first))
                    && current
                        .segments
                        .get(index as usize)
                        .is_some_and(|segment| segment.ad)
                {
                    session.status.ad_break.store(true, Ordering::Release);
                    return Download::Ad;
                }
            }
        }
        if spike && !complete {
            continue;
        }
        if std::env::var_os("VIOLETWIRE_PROGRESSIVE_SOURCE").is_some() {
            if need_keyframe {
                let keyframe = if is_mp4 {
                    lock(&session.pieces)
                        .as_ref()
                        .and_then(|pieces| pieces.mp4.as_ref())
                        .and_then(|(_, tracks)| tracks.first_sync(&bytes))
                } else {
                    ts::first_frame_is_keyframe(&bytes)
                };
                match keyframe {
                    Some(true) => {}
                    Some(false) => {
                        if is_mp4 && std::env::var_os("VIOLETWIRE_PLAYBACK_LOG").is_some() {
                            eprintln!("[mp4-input] rejected non-sync start");
                        }
                        return Download::Skip;
                    }
                    None if !complete && bytes.len() < 256 * 1024 => continue,
                    None => {
                        if is_mp4 && std::env::var_os("VIOLETWIRE_PLAYBACK_LOG").is_some() {
                            eprintln!(
                                "[mp4-input] sync unavailable bytes={} complete={complete}",
                                bytes.len()
                            );
                        }
                        return Download::Failed;
                    }
                }
            }
            if bytes.len() > pending.raw_published {
                lock(&session.pieces)
                    .as_mut()
                    .unwrap()
                    .push_raw(&bytes[pending.raw_published..]);
                pending.raw_published = bytes.len();
                if !session.status.ready.load(Ordering::Acquire) {
                    *lock(&session.status.start_date) = source.date;
                    session.status.ready.store(true, Ordering::Release);
                }
            }
            if complete {
                return Download::Complete;
            }
            continue;
        }
        let duration = if complete && source.prefetch {
            ts::video_duration(&bytes).unwrap_or(source.duration)
        } else {
            source.duration
        };
        let Some(cuts) = ts::split(&bytes, duration, complete) else {
            if complete {
                return Download::Failed;
            }
            continue;
        };
        if cuts.is_empty() {
            if complete {
                return Download::Failed;
            } else {
                continue;
            }
        }
        if need_keyframe && !cuts[0].independent {
            return Download::Skip;
        }
        if cuts
            .iter()
            .any(|cut| cut.duration > 1. || cut.duration <= 0.)
        {
            return Download::Failed;
        }
        // A retry reads the same fragment from the beginning. Never republish
        // an emitted prefix, nor accept changed bytes under the same identity.
        if cuts.len() < pending.published.len() {
            if complete {
                return Download::Failed;
            } else {
                continue;
            }
        }
        if pending
            .published
            .iter()
            .zip(&cuts)
            .any(|(old, cut)| old.as_ref() != cut.bytes.as_slice())
        {
            return Download::Failed;
        }
        if complete {
            let restored: Vec<u8> = cuts
                .iter()
                .flat_map(|cut| cut.bytes[cut.prefix_len..].iter().copied())
                .collect();
            if restored != bytes {
                return Download::Failed;
            }
            capture(&bytes, &cuts);
        }
        let count = cuts.len();
        let first_index = pending.published.len();
        if count > first_index {
            let mut pieces = lock(&session.pieces);
            let published = pieces.as_mut().unwrap().append(
                cuts.into_iter().skip(first_index).collect(),
                source,
                discontinuity,
                first_index,
            );
            pending.published.extend(published);
            let prime = if std::env::var_os("VIOLETWIRE_PROGRESSIVE_SOURCE").is_some() {
                1
            } else {
                3
            };
            if !session.status.ready.load(Ordering::Acquire) && count >= prime {
                *lock(&session.status.start_date) = source.date;
                session.status.ready.store(true, Ordering::Release);
            }
        }
        if complete {
            if std::env::var_os("VIOLETWIRE_PLAYBACK_LOG").is_some() {
                eprintln!(
                    "[parts] source={} pieces={count} progressive={} duration={duration:.3} bytes={}",
                    pending.sequence,
                    source.prefetch,
                    bytes.len()
                );
            }
            return Download::Complete;
        }
    }
}
fn eligible(parsed: &Parsed) -> bool {
    (!parsed.fmp4
        || (std::env::var_os("VIOLETWIRE_PROGRESSIVE_SOURCE").is_some()
            && std::env::var_os("VIOLETWIRE_PROGRESSIVE_MP4").is_some()))
        && parsed.media_sequence.is_some()
        && !parsed.segments.is_empty()
        && parsed.segments.iter().all(|segment| {
            segment
                .tags
                .iter()
                .all(|tag| !tag.starts_with("#EXT-X-KEY:") && !tag.starts_with("#EXT-X-BYTERANGE:"))
        })
}
fn mp4_init(
    relay: &Relay,
    session: &Session,
    parsed: &Parsed,
) -> Option<(String, super::super::mp4::VideoTracks, Vec<u8>)> {
    let tag = parsed
        .segments
        .iter()
        .flat_map(|source| &source.tags)
        .rev()
        .find(|tag| tag.starts_with("#EXT-X-MAP:"))?;
    let values = attributes(tag.strip_prefix("#EXT-X-MAP:")?);
    if std::env::var_os("VIOLETWIRE_PLAYBACK_LOG").is_some() {
        eprintln!(
            "[mp4-input] init_uri_data={} byterange={}",
            values
                .get("URI")
                .is_some_and(|uri| uri.starts_with("data:")),
            values.contains_key("BYTERANGE")
        );
    }
    if values.contains_key("BYTERANGE") {
        return None;
    }
    let uri = absolute(values.get("URI")?, &session.upstream);
    if !media_url(&uri) {
        if std::env::var_os("VIOLETWIRE_PLAYBACK_LOG").is_some() {
            eprintln!("[mp4-input] rejected init address");
        }
        return None;
    }
    let mut response = relay
        .agent
        .get(&uri)
        .config()
        .max_redirects(0)
        .timeout_global(Some(Duration::from_secs(5)))
        .build()
        .call()
        .ok()?;
    if !response.status().is_success() {
        if std::env::var_os("VIOLETWIRE_PLAYBACK_LOG").is_some() {
            eprintln!("[mp4-input] init status={}", response.status().as_u16());
        }
        return None;
    }
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    let tracks = super::super::mp4::VideoTracks::new(&bytes);
    if std::env::var_os("VIOLETWIRE_PLAYBACK_LOG").is_some() {
        eprintln!(
            "[mp4-input] init bytes={} tracks={}",
            bytes.len(),
            tracks.is_some()
        );
    }
    let tracks = tracks?;
    Some((tag.clone(), tracks, bytes))
}
fn media_url(url: &str) -> bool {
    let Ok(uri) = url.parse::<ureq::http::Uri>() else {
        return false;
    };
    uri.scheme_str() == Some("https")
        && uri.port_u16().is_none_or(|port| port == 443)
        && uri
            .authority()
            .is_some_and(|authority| !authority.as_str().contains('@'))
        && uri.host().is_some_and(|host| {
            [
                "ttvnw.net",
                "twitchcdn.net",
                "twitch.tv",
                "cloudfront.net",
                "akamaized.net",
                "akamaihd.net",
            ]
            .iter()
            .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
        })
}

/// True once this producer owns the session, false to retain the old relay.
pub(super) fn run(relay: &Relay, session: &Session) -> bool {
    let Some(text) = relay.fetch(&session.upstream).ok() else {
        return false;
    };
    let initial = parse(&text, &session.upstream);
    if std::env::var_os("VIOLETWIRE_PLAYBACK_LOG").is_some() {
        eprintln!(
            "[progressive-input] fmp4={} eligible={} segments={}",
            initial.fmp4,
            eligible(&initial),
            initial.segments.len()
        );
    }
    if !eligible(&initial) {
        return false;
    }
    let mut pieces = Pieces::default();
    if initial.fmp4 {
        let Some((tag, tracks, init)) = mp4_init(relay, session, &initial) else {
            return false;
        };
        pieces.mp4 = Some((tag, tracks));
        pieces.push_raw(&init);
        session.status.mp4.store(true, Ordering::Release);
    }
    *lock(&session.pieces) = Some(pieces);
    session.status.parts.store(true, Ordering::Release);
    let mut parsed = initial;
    let mut last_source = None;
    let mut pending: Option<Pending> = None;
    let mut discontinuity = false;
    let spike = std::env::var_os("VIOLETWIRE_PARTS_SPIKE").is_some();
    let started = Instant::now();
    while !session.status.cancelled.load(Ordering::Acquire) {
        if !LOW_LATENCY.load(Ordering::Acquire) {
            *lock(&session.status.failure) = Some("Playback latency mode changed.".into());
            return true;
        }
        session.status.ad_break.store(
            parsed.segments.last().is_some_and(|segment| segment.ad),
            Ordering::Release,
        );
        let first = parsed.media_sequence.unwrap_or(0);
        let start =
            if last_source.is_none() && parsed.segments.last().is_some_and(|source| source.ad) {
                parsed.segments.len()
            } else if let Some(current) = &pending {
                if current.sequence < first {
                    return reset(session, "The unfinished TS fragment left the live window.");
                }
                (current.sequence - first) as usize
            } else if last_source.is_none() {
                if spike || std::env::var_os("VIOLETWIRE_PARTS_FINISHED_START").is_some() {
                    parsed
                        .segments
                        .iter()
                        .rposition(|segment| !segment.prefetch && !segment.ad)
                        .unwrap_or(0)
                } else {
                    parsed
                        .segments
                        .iter()
                        .position(|segment| segment.prefetch && !segment.ad)
                        .unwrap_or_else(|| {
                            parsed
                                .segments
                                .iter()
                                .rposition(|segment| !segment.ad)
                                .unwrap_or(0)
                        })
                }
            } else {
                0
            };
        for (index, source) in parsed.segments.iter().enumerate().skip(start) {
            let sequence = first + index as u64;
            if last_source.is_some_and(|last| sequence <= last) || (spike && source.prefetch) {
                continue;
            }
            if source.ad
                && std::env::var_os("VIOLETWIRE_PROGRESSIVE_SOURCE").is_some()
                && session.status.ready.load(Ordering::Acquire)
            {
                session.status.ad_break.store(true, Ordering::Release);
                return reset(session, "Continuous source reset for an ad break.");
            }
            if source.ad {
                session.status.ads_skipped.fetch_add(1, Ordering::AcqRel);
                last_source = Some(sequence);
                pending = None;
                discontinuity = true;
                continue;
            }
            if last_source.is_some_and(|last| sequence != last + 1) || source.discontinuity {
                discontinuity = true;
                if std::env::var_os("VIOLETWIRE_PROGRESSIVE_SOURCE").is_some()
                    && session.status.ready.load(Ordering::Acquire)
                {
                    return reset(session, "Continuous source reset at a stream discontinuity.");
                }
            }
            if pending
                .as_ref()
                .is_none_or(|pending| pending.sequence != sequence)
            {
                pending = Some(Pending {
                    sequence,
                    published: Vec::new(),
                    wait_finished: false,
                    retries: 0,
                    raw_published: 0,
                });
            }
            let current = pending.as_mut().unwrap();
            if current.wait_finished && source.prefetch {
                break;
            }
            match download(
                relay,
                session,
                source,
                current,
                discontinuity,
                last_source.is_none() || discontinuity,
                spike,
            ) {
                Download::Complete => {
                    last_source = Some(sequence);
                    pending = None;
                    discontinuity = false;
                    if source.prefetch {
                        break;
                    }
                }
                Download::Ad => {
                    if std::env::var_os("VIOLETWIRE_PROGRESSIVE_SOURCE").is_some()
                        && session.status.ready.load(Ordering::Acquire)
                    {
                        return reset(session, "Continuous source reset for an ad break.");
                    }
                    session.status.ads_skipped.fetch_add(1, Ordering::AcqRel);
                    last_source = Some(sequence);
                    pending = None;
                    discontinuity = true;
                    break;
                }
                Download::Skip => {
                    last_source = Some(sequence);
                    pending = None;
                    discontinuity = true;
                    if !session.status.ready.load(Ordering::Acquire) {
                        *lock(&session.pieces) = None;
                        session.status.parts.store(false, Ordering::Release);
                        return false;
                    }
                }
                Download::Retry => {
                    if current.raw_published > 0 {
                        return reset(session, "The continuous source was interrupted.");
                    }
                    current.retries = current.retries.saturating_add(1);
                    current.wait_finished = source.prefetch;
                    if !source.prefetch && current.retries >= 3 {
                        if !session.status.ready.load(Ordering::Acquire) {
                            *lock(&session.pieces) = None;
                            session.status.parts.store(false, Ordering::Release);
                            return false;
                        }
                        return reset(session, "The TS fragment could not be completed.");
                    }
                    break;
                }
                Download::Failed => {
                    if !session.status.ready.load(Ordering::Acquire) {
                        *lock(&session.pieces) = None;
                        session.status.parts.store(false, Ordering::Release);
                        return false;
                    }
                    *lock(&session.status.failure) =
                        Some("This stream cannot safely use short TS pieces.".into());
                    return true;
                }
            }
        }
        if started.elapsed() > PRIME_FOR && !session.status.ready.load(Ordering::Acquire) {
            *lock(&session.status.failure) = Some("No safe live TS pieces arrived.".into());
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
        if let Ok(text) = relay.fetch(&session.upstream) {
            parsed = parse(&text, &session.upstream);
            if !eligible(&parsed) {
                *lock(&session.status.failure) = Some("The stream's media format changed.".into());
                return true;
            }
        }
    }
    true
}
fn capture(source: &[u8], cuts: &[ts::Piece]) {
    static CAPTURED: AtomicBool = AtomicBool::new(false);
    if std::env::var_os("VIOLETWIRE_CAPTURE_PARTS").is_none()
        || CAPTURED.swap(true, Ordering::AcqRel)
    {
        return;
    }
    let directory = std::path::Path::new("rust/target/parts-capture");
    let _ = std::fs::create_dir_all(directory);
    let _ = std::fs::write(directory.join("source.ts"), source);
    let bytes: Vec<u8> = cuts
        .iter()
        .flat_map(|cut| cut.bytes.iter().copied())
        .collect();
    let _ = std::fs::write(directory.join("cut.ts"), bytes);
}
fn program_date(milliseconds: f64) -> Option<String> {
    use windows::Win32::{
        Foundation::{FILETIME, SYSTEMTIME},
        System::Time::FileTimeToSystemTime,
    };
    if !milliseconds.is_finite() || !(0.0..4_102_444_800_000.).contains(&milliseconds) {
        return None;
    }
    let ticks = (milliseconds.round() as u64)
        .checked_mul(10_000)?
        .checked_add(116_444_736_000_000_000)?;
    let file = FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    };
    let mut time = SYSTEMTIME::default();
    // SAFETY: both pointers refer to correctly initialized stack values.
    unsafe {
        FileTimeToSystemTime(&file, &mut time).ok()?;
    }
    Some(format!(
        "#EXT-X-PROGRAM-DATE-TIME:{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        time.wYear,
        time.wMonth,
        time.wDay,
        time.wHour,
        time.wMinute,
        time.wSecond,
        time.wMilliseconds
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prefetch_dates_keep_utc_millisecond_precision() {
        let milliseconds = date_ms("2026-11-13T10:00:00.123Z").unwrap();
        assert_eq!(
            program_date(milliseconds).unwrap(),
            "#EXT-X-PROGRAM-DATE-TIME:2026-11-13T10:00:00.123Z"
        );
        assert!(program_date(f64::NAN).is_none());
        assert!(program_date(-1.).is_none());
    }
    fn source() -> ParsedSegment {
        parse("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-PROGRAM-DATE-TIME:2026-11-13T10:00:00.000Z\n#EXTINF:2,live\nhttps://video.hls.ttvnw.net/a.ts\n", "https://video.hls.ttvnw.net/live.m3u8")
            .segments.remove(0)
    }
    fn cuts() -> Vec<ts::Piece> {
        ts::split(include_bytes!("../fixtures/cutter.mpegts"), 2., true).unwrap()
    }
    #[test]
    fn piece_identities_are_immutable_and_expire_forward_with_bounded_memory() {
        let mut ring = Pieces::default();
        ring.append(cuts(), &source(), false, 0);
        let first = ring.render().unwrap();
        let first_bytes = ring.get(0).unwrap();
        ring.append(cuts(), &source(), true, 0);
        let next = ring.render().unwrap();
        assert!(next.contains("#EXT-X-DISCONTINUITY\n"));
        assert_eq!(ring.get(0).unwrap(), first_bytes);
        assert!(
            first
                .lines()
                .filter(|line| line.starts_with("p/"))
                .all(|line| next.lines().any(|next| next == line))
        );
        for _ in 0..40 {
            ring.append(cuts(), &source(), false, 0);
        }
        assert!(ring.get(0).is_none());
        assert!(ring.bytes <= MAX_BYTES && ring.seconds <= MAX_SECONDS);
        assert!(ring.entries.front().unwrap().sequence > 0);
        assert!(ring.discontinuities > 0);
        assert!(ring.render().unwrap().contains("#EXT-X-TARGETDURATION:1\n"));
    }
    #[test]
    fn settling_never_trusts_a_playlist_entry_that_was_not_fully_served() {
        let mut ring = Pieces::default();
        ring.append(cuts(), &source(), false, 0);
        ring.append(cuts(), &source(), false, 0);
        assert_eq!(ring.safe_target(0.), None);
        for sequence in 0..7 {
            ring.delivered(sequence);
        }
        assert_eq!(ring.safe_target(0.), Some(2.05));
        assert_eq!(ring.safe_target(3.), None);
    }
    #[test]
    fn segmented_progressive_publication_does_not_repeat_dates_or_reset_ids() {
        let mut ring = Pieces::default();
        let mut pieces = cuts();
        let last = pieces.split_off(2);
        ring.append(pieces, &source(), true, 0);
        ring.append(last, &source(), true, 2);
        assert_eq!(
            ring.render()
                .unwrap()
                .matches("#EXT-X-PROGRAM-DATE-TIME:")
                .count(),
            1
        );
        assert_eq!(
            ring.entries
                .iter()
                .map(|piece| piece.sequence)
                .collect::<Vec<_>>(),
            [0, 1, 2, 3]
        );
        assert!(!ring.entries.iter().any(|piece| piece.discontinuity));
    }
    #[test]
    fn media_fetches_reject_private_addresses_and_encrypted_or_mp4_formats() {
        assert!(media_url(
            "https://video.hls.ttvnw.net/part.ts?private=value"
        ));
        for url in [
            "http://video.hls.ttvnw.net/a",
            "https://127.0.0.1/a",
            "https://video.hls.ttvnw.net.evil/a",
            "https://user@video.hls.ttvnw.net/a",
            "https://video.hls.ttvnw.net:444/a",
        ] {
            assert!(!media_url(url));
        }
        let mut parsed = parse(
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2,live\na.ts\n",
            "https://video.hls.ttvnw.net/live.m3u8",
        );
        assert!(eligible(&parsed));
        parsed.fmp4 = true;
        assert!(!eligible(&parsed));
        parsed.fmp4 = false;
        parsed.segments[0]
            .tags
            .push("#EXT-X-KEY:METHOD=AES-128,URI=key".into());
        assert!(!eligible(&parsed));
    }
    #[test]
    fn media_endpoint_requires_the_full_secret_session_and_immutable_piece_id() {
        let relay = Relay {
            port: 0,
            secret: "test-secret".into(),
            agent: ureq::Agent::new_with_defaults(),
            sessions: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            requests: AtomicU32::new(0),
        };
        let mut pieces = Pieces::default();
        pieces.append(cuts(), &source(), false, 0);
        let expected = pieces.get(0).unwrap();
        lock(&relay.sessions).insert(
            1,
            Arc::new(Session {
                upstream: "https://unused.invalid/".into(),
                playlist: Mutex::new(Playlist::default()),
                status: Arc::default(),
                pieces: Mutex::new(Some(pieces)),
                allow_parts: true,
            }),
        );
        assert_eq!(relay.piece("/test-secret/1/p/0.ts").unwrap(), expected);
        for path in [
            "/wrong/1/p/0.ts",
            "/test-secretX/1/p/0.ts",
            "/test-secret/2/p/0.ts",
            "/test-secret/1/p/999.ts",
            "/test-secret/1/p/../0.ts",
            "/test-secret/1/p/0.ts?other=1",
        ] {
            assert!(relay.piece(path).is_none());
        }
        assert!(
            relay
                .respond("/test-secret/1/live.m3u8")
                .unwrap()
                .contains("p/0.ts")
        );
        assert!(relay.continuous_session("/test-secret/1/live.ts").is_none());
        let session = lock(&relay.sessions).get(&1).unwrap().clone();
        session.status.parts.store(true, Ordering::Release);
        lock(&session.pieces)
            .as_mut()
            .unwrap()
            .push_raw(&[0x47; 188]);
        assert!(relay.continuous_session("/test-secret/1/live.ts").is_some());
        for path in [
            "/wrong/1/live.ts",
            "/test-secretX/1/live.ts",
            "/test-secret/2/live.ts",
            "/test-secret/1/../live.ts",
            "/test-secret/1/live.ts?other=1",
        ] {
            assert!(relay.continuous_session(path).is_none());
        }
    }
    #[test]
    fn continuous_bytes_are_immutable_ordered_and_memory_bounded() {
        let mut pieces = Pieces::default();
        pieces.push_raw(&vec![1; 32 * 1024]);
        let (_, held) = pieces.next(0).unwrap();
        for byte in 2..=10 {
            pieces.push_raw(&vec![byte; 1024 * 1024]);
        }
        assert!(pieces.raw_bytes <= 8 * 1024 * 1024);
        let (oldest, _) = pieces.next(0).unwrap();
        assert!(oldest > 0);
        assert!(held.iter().all(|byte| *byte == 1));
        assert!(
            pieces
                .raw
                .iter()
                .zip(pieces.raw.iter().skip(1))
                .all(|(a, b)| b.0 == a.0 + 1)
        );
        assert!(pieces.next(pieces.raw_next).is_none());
    }
}
