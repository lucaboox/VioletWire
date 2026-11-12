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
}
