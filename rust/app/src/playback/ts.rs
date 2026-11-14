//! Just enough MPEG-TS reading to tell whether a Twitch segment opens on a
//! key frame, ported from the Electron client's `ts-parts.ts`.
//!
//! A Twitch segment does not always start with one. Where a broadcaster sends
//! a key frame every few seconds and Twitch cuts the stream at other points,
//! a player that starts on such a segment decodes frames whose references it
//! never had, and the picture smears until the next key frame.

const PACKET: usize = 188;
const SYNC: u8 = 0x47;
/// How far into a frame to look for its first picture: past the access unit
/// delimiter, parameter sets and any SEI.
const SCAN_PACKETS: usize = 256;

struct Payload {
    pid: u16,
    start: bool,
    offset: usize,
    length: usize,
}

fn payload(data: &[u8], offset: usize) -> Option<Payload> {
    let pid = (u16::from(data[offset + 1] & 0x1f) << 8) | u16::from(data[offset + 2]);
    let start = data[offset + 1] & 0x40 != 0;
    let adaptation = (data[offset + 3] >> 4) & 0x03;
    if adaptation != 0x01 && adaptation != 0x03 {
        return None;
    }
    let mut at = offset + 4;
    if adaptation == 0x03 {
        at += 1 + usize::from(data[offset + 4]);
    }
    if at >= offset + PACKET {
        return None;
    }
    Some(Payload {
        pid,
        start,
        offset: at,
        length: offset + PACKET - at,
    })
}

/// A video PES packet with a timestamp starts here.
fn opens_video_frame(data: &[u8], payload: &Payload) -> bool {
    let at = payload.offset;
    payload.length >= 14
        && data[at] == 0
        && data[at + 1] == 0
        && data[at + 2] == 1
        && (0xe0..=0xef).contains(&data[at + 3])
        && data[at + 7] & 0x80 != 0
}

/// Whether the frame whose PES packet starts at `offset` is a key frame: one
/// flagged as a random-access point, or whose first picture is an H.264 IDR.
/// `None` while that picture has not arrived in `data`.
fn frame_is_keyframe(data: &[u8], offset: usize) -> Option<bool> {
    if offset + PACKET > data.len() || data[offset] != SYNC {
        return None;
    }
    let adaptation = (data[offset + 3] >> 4) & 0x03;
    if adaptation & 0x02 != 0 && data[offset + 4] > 0 && data[offset + 5] & 0x40 != 0 {
        return Some(true);
    }
    let first = payload(data, offset)?;
    let at = first.offset;
    if !first.start || first.length < 9 || data[at] != 0 || data[at + 1] != 0 || data[at + 2] != 1 {
        return None;
    }
    let pid = first.pid;
    let (mut zeros, mut header_next, mut scanned) = (0, false, 0);
    let mut packet = offset;
    while packet + PACKET <= data.len() && scanned < SCAN_PACKETS {
        if data[packet] != SYNC {
            return None;
        }
        if let Some(part) = payload(data, packet).filter(|part| part.pid == pid) {
            // The next frame began without this one showing a picture.
            if packet != offset && part.start {
                return Some(false);
            }
            scanned += 1;
            let begin = if packet == offset {
                at + 9 + usize::from(data[at + 8])
            } else {
                part.offset
            };
            let end = (part.offset + part.length).min(data.len());
            for &byte in data.get(begin..end).unwrap_or_default() {
                if header_next {
                    header_next = false;
                    match byte & 0x1f {
                        5 => return Some(true),
                        1..=4 => return Some(false),
                        _ => {}
                    }
                }
                if byte == 0 {
                    zeros += 1;
                } else {
                    if byte == 1 && zeros >= 2 {
                        header_next = true;
                    }
                    zeros = 0;
                }
            }
        }
        packet += PACKET;
    }
    None
}

/// Whether the first video frame in `data` (a segment's opening bytes) is a
/// key frame. `None` when that cannot be told from these bytes.
pub fn first_frame_is_keyframe(data: &[u8]) -> Option<bool> {
    let mut offset = 0;
    while offset + PACKET <= data.len() {
        if data[offset] != SYNC {
            return None;
        }
        if let Some(part) = payload(data, offset)
            && part.start
            && opens_video_frame(data, &part)
        {
            return frame_is_keyframe(data, offset);
        }
        offset += PACKET;
    }
    None
}

const CLOCK: f64 = 90_000.;
const WRAP: f64 = (1u64 << 33) as f64 / CLOCK;

pub struct Piece {
    pub bytes: Vec<u8>,
    pub duration: f64,
    pub independent: bool,
    pub prefix_len: usize,
}

#[derive(Default)]
struct Section {
    bytes: Vec<u8>,
    packets: Vec<u8>,
    complete: bool,
}
impl Section {
    fn feed(&mut self, data: &[u8], offset: usize, part: &Payload) {
        let end = part.offset + part.length;
        let mut begin = part.offset;
        if part.start {
            let pointer = usize::from(data[begin]);
            begin += pointer + 1;
            self.bytes.clear();
            self.packets.clear();
            self.complete = false;
        } else if self.bytes.is_empty() || self.complete {
            return;
        }
        if begin >= end {
            return;
        }
        self.bytes.extend_from_slice(&data[begin..end]);
        self.packets
            .extend_from_slice(&data[offset..offset + PACKET]);
        if self.bytes.len() >= 3 {
            let length = 3 + (usize::from(self.bytes[1] & 0x0f) << 8) + usize::from(self.bytes[2]);
            if !(12..=4096).contains(&length) {
                self.bytes.clear();
                self.packets.clear();
                return;
            }
            if self.bytes.len() >= length {
                self.bytes.truncate(length);
                self.complete = true;
            }
        }
    }
}

fn tables(data: &[u8]) -> Option<(u16, Vec<u8>)> {
    read_tables(data, false)
}
fn read_tables(data: &[u8], latest: bool) -> Option<(u16, Vec<u8>)> {
    let (mut pat, mut pmt) = (Section::default(), Section::default());
    let mut pmt_pid = None;
    let mut found = None;
    for offset in (0..data.len().saturating_sub(PACKET - 1)).step_by(PACKET) {
        if data[offset] != SYNC || data[offset + 1] & 0x80 != 0 || data[offset + 3] & 0xc0 != 0 {
            return None;
        }
        let Some(part) = payload(data, offset) else {
            continue;
        };
        if part.pid == 0 {
            pat.feed(data, offset, &part);
            if pat.complete && pat.bytes[0] == 0 {
                for entry in pat.bytes.get(8..pat.bytes.len() - 4)?.chunks_exact(4) {
                    if entry[0] != 0 || entry[1] != 0 {
                        pmt_pid = Some((u16::from(entry[2] & 0x1f) << 8) | u16::from(entry[3]));
                        break;
                    }
                }
            }
        } else if Some(part.pid) == pmt_pid {
            pmt.feed(data, offset, &part);
            if pmt.complete && pmt.bytes[0] == 2 && pmt.bytes.len() >= 16 {
                let mut at =
                    12 + (usize::from(pmt.bytes[10] & 0x0f) << 8) + usize::from(pmt.bytes[11]);
                while at + 5 <= pmt.bytes.len() - 4 {
                    let kind = pmt.bytes[at];
                    let pid =
                        (u16::from(pmt.bytes[at + 1] & 0x1f) << 8) | u16::from(pmt.bytes[at + 2]);
                    if kind == 0x1b {
                        let mut prefix = pat.packets.clone();
                        prefix.extend_from_slice(&pmt.packets);
                        if !latest {
                            return Some((pid, prefix));
                        }
                        found = Some((pid, prefix));
                        break;
                    }
                    at += 5
                        + (usize::from(pmt.bytes[at + 3] & 0x0f) << 8)
                        + usize::from(pmt.bytes[at + 4]);
                }
            }
        }
    }
    found
}

struct Pes {
    video: bool,
    opens_frame: bool,
    remaining: usize,
    time: Option<f64>,
}
fn timestamp(bytes: &[u8]) -> f64 {
    (u64::from((bytes[0] >> 1) & 7) * (1 << 30)
        + u64::from(bytes[1]) * (1 << 22)
        + u64::from((bytes[2] >> 1) & 127) * (1 << 15)
        + u64::from(bytes[3]) * (1 << 7)
        + u64::from((bytes[4] >> 1) & 127)) as f64
        / CLOCK
}
fn pes(data: &[u8], part: &Payload) -> Option<Pes> {
    let bytes = &data[part.offset..part.offset + part.length];
    if bytes.len() < 9 || bytes[..3] != [0, 0, 1] {
        return None;
    }
    let length = (usize::from(bytes[4]) << 8) | usize::from(bytes[5]);
    let video = (0xe0..=0xef).contains(&bytes[3]);
    let time = if bytes.len() >= 14 && bytes[7] & 0x80 != 0 {
        // Decode time is monotonic even when presentation order has B frames.
        let at = if bytes[7] & 0xc0 == 0xc0 && bytes.len() >= 19 {
            14
        } else {
            9
        };
        Some(timestamp(&bytes[at..at + 5]))
    } else {
        None
    };
    let body = bytes.get(9 + usize::from(bytes[8])..).unwrap_or_default();
    Some(Pes {
        video,
        time,
        opens_frame: body.starts_with(&[0, 0, 1]) || body.starts_with(&[0, 0, 0, 1]),
        remaining: if length == 0 {
            if video { 0 } else { usize::MAX }
        } else {
            (length + 6).saturating_sub(bytes.len())
        },
    })
}

/// Packet boundaries that leave no bounded audio/metadata/video PES half open.
/// The final boundary is emitted only once the source fragment is complete.
pub fn split(data: &[u8], total_duration: f64, complete: bool) -> Option<Vec<Piece>> {
    if data.len() > 16 * 1024 * 1024
        || (complete && !data.len().is_multiple_of(PACKET))
        || !total_duration.is_finite()
        || total_duration <= 0.
    {
        return None;
    }
    let (video_pid, prefix) = tables(data)?;
    let mut open = std::collections::HashMap::<u16, usize>::new();
    let (mut start, mut first_time, mut first_video) = (0, None, 0);
    let mut plans = Vec::new();
    for offset in (0..data.len().saturating_sub(PACKET - 1)).step_by(PACKET) {
        if data[offset] != SYNC || data[offset + 1] & 0x80 != 0 || data[offset + 3] & 0xc0 != 0 {
            return None;
        }
        let Some(part) = payload(data, offset) else {
            continue;
        };
        if !part.start {
            if let Some(remaining) = open.get_mut(&part.pid) {
                *remaining = remaining.saturating_sub(part.length);
                if *remaining == 0 {
                    open.remove(&part.pid);
                }
            }
            continue;
        }
        let Some(pes) = pes(data, &part) else {
            continue;
        };
        if pes.video
            && part.pid == video_pid
            && let Some(time) = pes.time
        {
            let reference = *first_time.get_or_insert_with(|| {
                first_video = offset;
                time
            });
            let time = if time < reference - WRAP / 2. {
                time + WRAP
            } else {
                time
            };
            let seconds = time - reference;
            if seconds >= 0.5 && open.is_empty() && pes.opens_frame {
                plans.push((
                    start,
                    offset,
                    seconds,
                    frame_is_keyframe(data, first_video) == Some(true),
                ));
                start = offset;
                first_time = Some(time);
                first_video = offset;
            }
        }
        if pes.remaining > 0 {
            open.insert(part.pid, pes.remaining);
        } else {
            open.remove(&part.pid);
        }
    }
    if complete {
        let used: f64 = plans.iter().map(|(_, _, duration, _)| duration).sum();
        let remaining = total_duration - used;
        if remaining <= 0. || remaining > 6. {
            return None;
        }
        plans.push((
            start,
            data.len(),
            remaining,
            frame_is_keyframe(data, first_video) == Some(true),
        ));
    }
    Some(
        plans
            .into_iter()
            .map(|(start, end, duration, independent)| {
                // Freeze the latest complete tables preceding THIS cut; tables
                // appearing later in a growing response cannot change its prefix.
                let prefix = if start == 0 {
                    prefix.clone()
                } else {
                    read_tables(&data[..start], true)
                        .map_or_else(|| prefix.clone(), |(_, prefix)| prefix)
                };
                let mut bytes = prefix.clone();
                bytes.extend_from_slice(&data[start..end]);
                Piece {
                    bytes,
                    duration,
                    independent,
                    prefix_len: prefix.len(),
                }
            })
            .collect(),
    )
}

/// The video span of a completed prefetch response, whose EXTINF is not yet
/// available. Timestamp spacing, not the speed of its HTTP delivery, sets it.
pub fn video_duration(data: &[u8]) -> Option<f64> {
    let mut times = Vec::new();
    for offset in (0..data.len().saturating_sub(PACKET - 1)).step_by(PACKET) {
        if data[offset] != SYNC {
            return None;
        }
        let Some(part) = payload(data, offset) else {
            continue;
        };
        if part.start
            && let Some(pes) = pes(data, &part)
            && pes.video
            && let Some(time) = pes.time
        {
            let reference = times.first().copied().unwrap_or(time);
            times.push(if time < reference - WRAP / 2. {
                time + WRAP
            } else {
                time
            });
        }
    }
    times.sort_by(f64::total_cmp);
    let mut gaps: Vec<f64> = times
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .filter(|gap| *gap > 0.)
        .collect();
    gaps.sort_by(f64::total_cmp);
    let frame = *gaps.get(gaps.len() / 2)?;
    let duration = times.last()? - times.first()? + frame;
    (duration > 0. && duration <= 6.).then_some(duration)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One transport packet carrying the start of a video PES packet whose
    /// payload holds `nal` after a start code.
    fn video_packet(nal_type: u8) -> Vec<u8> {
        let mut packet = vec![0xffu8; PACKET];
        packet[0] = SYNC;
        packet[1] = 0x40 | 0x01; // payload unit start, PID 0x100
        packet[2] = 0x00;
        packet[3] = 0x10; // payload only
        let pes = [
            0x00, 0x00, 0x01, 0xe0, 0x00, 0x00, // start code, video stream, unbounded
            0x80, 0x80, 0x05, // flags: PTS only, header length 5
            0x21, 0x00, 0x01, 0x00, 0x01, // PTS
            0x00, 0x00, 0x00, 0x01, 0x09, 0xf0, // access unit delimiter
            0x00, 0x00, 0x01, nal_type, // the picture
        ];
        packet[4..4 + pes.len()].copy_from_slice(&pes);
        packet
    }

    #[test]
    fn recognises_idr_and_non_idr_openings() {
        assert_eq!(first_frame_is_keyframe(&video_packet(0x65)), Some(true));
        assert_eq!(first_frame_is_keyframe(&video_packet(0x41)), Some(false));
        assert_eq!(first_frame_is_keyframe(&[0u8; 400]), None);
        assert_eq!(first_frame_is_keyframe(&[]), None);
    }

    #[test]
    fn cuts_real_h264_and_aac_without_losing_bytes_or_time() {
        let source = include_bytes!("fixtures/cutter.mpegts");
        let pieces = split(source, 2., true).unwrap();
        assert!(pieces.len() >= 3);
        assert!(pieces[0].independent);
        assert!(pieces.iter().skip(1).any(|piece| !piece.independent));
        assert!((pieces.iter().map(|piece| piece.duration).sum::<f64>() - 2.).abs() < 1e-6);
        let restored: Vec<u8> = pieces
            .iter()
            .flat_map(|piece| piece.bytes[piece.prefix_len..].iter().copied())
            .collect();
        assert_eq!(restored, source);
        for piece in &pieces {
            assert!(piece.duration > 0. && piece.duration <= 1.);
            assert_eq!(piece.bytes.len() % PACKET, 0);
            assert_eq!(tables(&piece.bytes).unwrap().0, 256);
        }
    }

    #[test]
    fn incomplete_input_never_publishes_a_partial_pes_or_changes_a_published_piece() {
        let source = include_bytes!("fixtures/cutter.mpegts");
        let full = split(source, 2., true).unwrap();
        for end in (PACKET..source.len()).step_by(997) {
            if let Some(pieces) = split(&source[..end], 2., false) {
                for (index, piece) in pieces.iter().enumerate() {
                    assert_eq!(piece.bytes, full[index].bytes);
                    assert_eq!(piece.duration, full[index].duration);
                }
            }
        }
    }

    #[test]
    fn rejects_corrupt_transport_and_invalid_durations() {
        let mut source = include_bytes!("fixtures/cutter.mpegts").to_vec();
        assert!(split(&source, f64::NAN, true).is_none());
        assert!(split(&source[..source.len() - 1], 2., true).is_none());
        source[PACKET * 4] = 0;
        assert!(split(&source, 2., true).is_none());
    }

    fn stamp(bytes: &mut [u8], time: u64) {
        bytes[0] = (bytes[0] & 0xf0) | (((time >> 30) as u8 & 7) << 1) | 1;
        bytes[1] = (time >> 22) as u8;
        bytes[2] = (((time >> 15) as u8 & 127) << 1) | 1;
        bytes[3] = (time >> 7) as u8;
        bytes[4] = ((time as u8 & 127) << 1) | 1;
    }
    #[test]
    fn video_clock_wrap_keeps_piece_durations_and_the_completed_span() {
        let mut source = include_bytes!("fixtures/cutter.mpegts").to_vec();
        for offset in (0..source.len()).step_by(PACKET) {
            let Some(part) = payload(&source, offset) else {
                continue;
            };
            if !part.start || !pes(&source, &part).is_some_and(|pes| pes.video) {
                continue;
            }
            let flags = source[part.offset + 7];
            for at in [part.offset + 9, part.offset + 14]
                .into_iter()
                .take(if flags & 0xc0 == 0xc0 { 2 } else { 1 })
            {
                let old = (timestamp(&source[at..at + 5]) * CLOCK).round() as u64;
                stamp(
                    &mut source[at..at + 5],
                    (old + (1 << 33) - 180_000) % (1 << 33),
                );
            }
        }
        assert!((video_duration(&source).unwrap() - 2.).abs() < 0.001);
        let pieces = split(&source, 2., true).unwrap();
        assert!(
            pieces
                .iter()
                .all(|piece| piece.duration > 0. && piece.duration <= 1.)
        );
        assert!((pieces.iter().map(|piece| piece.duration).sum::<f64>() - 2.).abs() < 1e-6);
    }
    #[test]
    fn cuts_wait_for_bounded_audio_and_refuse_a_video_pes_with_a_frame_tail() {
        for bounded_audio in [true, false] {
            let (_, mut data) = tables(include_bytes!("fixtures/cutter.mpegts")).unwrap();
            data.extend(video_packet(0x65));
            if bounded_audio {
                let mut audio = vec![0xff; PACKET];
                audio[..13]
                    .copy_from_slice(&[SYNC, 0x41, 1, 0x10, 0, 0, 1, 0xc0, 1, 44, 0x80, 0, 0]);
                data.extend(audio);
            }
            let mut next = video_packet(0x41);
            stamp(&mut next[13..18], 54_000);
            if !bounded_audio {
                next[18] = 0x99;
            }
            data.extend(next);
            if bounded_audio {
                let mut audio = vec![0xff; PACKET];
                audio[..4].copy_from_slice(&[SYNC, 1, 1, 0x11]);
                data.extend(audio);
            }
            let mut next = video_packet(0x41);
            stamp(&mut next[13..18], 99_000);
            let boundary = data.len();
            data.extend(next);
            let pieces = split(&data, 2., true).unwrap();
            assert_eq!(pieces[0].bytes.len() - pieces[0].prefix_len, boundary);
        }
    }
}
