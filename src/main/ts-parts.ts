/**
 * Cuts an MPEG-TS byte stream into low-latency HLS parts.
 *
 * Twitch names the fragment it is still writing, and that fragment arrives as a
 * growing response. Handing those bytes to the player as they arrive means
 * transmuxing at whatever granularity the socket happens to deliver, which is
 * where high-bitrate playback falls behind. Cutting the same bytes into a few
 * complete parts instead keeps the latency while giving the player whole,
 * ordinary responses to work with.
 *
 * The player finishes every part as if it were the end of the stream: any
 * audio or video packet still open at the cut is parsed as it stands and the
 * rest of it, arriving in the next part, is thrown away. So a part only ever
 * ends where a video frame begins and nothing else is half-written — every
 * frame and every run of audio is whole in exactly one part. A video packet
 * with a timestamp is not always a frame's beginning: some encoders (xQc's,
 * for one) carry the end of the previous frame into it ahead of the next
 * frame's start code, and a cut there cost that frame its last bytes and
 * smeared the picture until the next key frame. Durations come
 * from the video's own timestamps rather than from arrival timing; a fragment
 * usually arrives faster than it plays, so wall-clock timing would be wrong.
 */

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;
const PTS_UNITS_PER_SECOND = 90_000;
// A timestamp counts 33 bits at 90kHz and wraps roughly every 26.5 hours.
const PTS_WRAP = 2 ** 33;

export interface TsPart {
  /** Byte offset just past this part, always a packet boundary. */
  end: number;
  /** Media seconds the part covers. */
  duration: number;
  /** Whether its first video frame is a key frame, so playback can start at it. */
  independent: boolean;
}

interface PesStart {
  pid: number;
  video: boolean;
  /**
   * Whether its payload opens with an Annex B start code. Some encoders let
   * a frame's last bytes run on into the next PES packet, ahead of the next
   * frame's start code; those packets do not begin a frame.
   */
  opensFrame: boolean;
  /** Bytes of the PES packet after this transport packet, or null if unbounded. */
  remaining: number | null;
  /** Decode time in seconds (the presentation time when there is none). */
  time: number | null;
}

interface PacketPayload {
  pid: number;
  start: boolean;
  offset: number;
  length: number;
}

function readPayload(data: Uint8Array, offset: number): PacketPayload | null {
  const pid = ((data[offset + 1] & 0x1f) << 8) | data[offset + 2];
  const start = (data[offset + 1] & 0x40) !== 0;
  const adaptationControl = (data[offset + 3] >> 4) & 0x03;
  // 0b00 and 0b10 carry no payload at all.
  if (adaptationControl !== 0x01 && adaptationControl !== 0x03) return null;
  let payload = offset + 4;
  if (adaptationControl === 0x03) payload += 1 + data[offset + 4];
  if (payload >= offset + TS_PACKET_SIZE) return null;
  return { pid, start, offset: payload, length: offset + TS_PACKET_SIZE - payload };
}

function readTimestamp(data: Uint8Array, at: number): number {
  return (
    // The timestamp is 33 bits, so the top bits are combined by multiplying
    // rather than shifting; a shift would work on 32 bits and lose the highest.
    ((data[at] >> 1) & 0x07) * 2 ** 30 +
    data[at + 1] * 2 ** 22 +
    ((data[at + 2] >> 1) & 0x7f) * 2 ** 15 +
    data[at + 3] * 2 ** 7 +
    ((data[at + 4] >> 1) & 0x7f)
  );
}

/** The PES packet a payload opens, or null for a table (PAT, PMT) or nothing. */
function readPesStart(data: Uint8Array, payload: PacketPayload): PesStart | null {
  const at = payload.offset;
  if (payload.length < 6) return null;
  // A PES packet opens with the start code 00 00 01; tables do not.
  if (data[at] !== 0 || data[at + 1] !== 0 || data[at + 2] !== 1) return null;
  const streamId = data[at + 3];
  const declared = (data[at + 4] << 8) | data[at + 5];
  const remaining = declared === 0 ? null : Math.max(0, declared + 6 - payload.length);
  let time: number | null = null;
  if (payload.length >= 14 && (data[at + 7] & 0x80) !== 0) {
    const hasDecodeTime = (data[at + 7] & 0xc0) === 0xc0 && payload.length >= 19;
    time = readTimestamp(data, at + (hasDecodeTime ? 14 : 9)) / PTS_UNITS_PER_SECOND;
  }
  // The elementary stream starts after the PES header's own length byte.
  const body = payload.length >= 9 ? at + 9 + data[at + 8] : Number.POSITIVE_INFINITY;
  const end = at + payload.length;
  const opensFrame =
    body + 3 <= end &&
    data[body] === 0 &&
    data[body + 1] === 0 &&
    (data[body + 2] === 1 || (body + 4 <= end && data[body + 2] === 0 && data[body + 3] === 1));
  return {
    pid: payload.pid,
    video: streamId >= 0xe0 && streamId <= 0xef,
    opensFrame,
    remaining,
    time,
  };
}

/** Keeps a timestamp comparable across the point where the counter wraps. */
function unwrap(time: number, reference: number): number {
  const wrapSeconds = PTS_WRAP / PTS_UNITS_PER_SECOND;
  if (time < reference - wrapSeconds / 2) return time + wrapSeconds;
  return time;
}

// How far into a frame to look for its first picture: past the access unit
// delimiter, parameter sets and any SEI, which can run to a few kilobytes.
const KEYFRAME_SCAN_PACKETS = 256;

/**
 * Whether the video frame whose PES packet starts in the transport packet at
 * `offset` is a key frame: one flagged as a random access point, or whose
 * first picture is an H.264 IDR. Null while that picture has not arrived.
 *
 * A Twitch MPEG-TS fragment does not always open on one. Where a broadcaster
 * sends a key frame every eight seconds and Twitch cuts the stream into 5.1
 * and 3.2 second fragments, every other fragment has none at all, and a
 * player that starts there gets no picture.
 */
export function tsFrameIsKeyframe(data: Uint8Array, offset: number): boolean | null {
  if (offset + TS_PACKET_SIZE > data.length || data[offset] !== TS_SYNC_BYTE) return null;
  const adaptationControl = (data[offset + 3] >> 4) & 0x03;
  if ((adaptationControl & 0x02) !== 0 && data[offset + 4] > 0 && (data[offset + 5] & 0x40) !== 0) {
    return true;
  }
  const first = readPayload(data, offset);
  if (!first?.start) return null;
  const at = first.offset;
  if (first.length < 9 || data[at] !== 0 || data[at + 1] !== 0 || data[at + 2] !== 1) return null;
  const pid = first.pid;

  // Walk the frame's bytes packet by packet, watching for NAL start codes
  // (00 00 01) even where one straddles two packets.
  let zeros = 0;
  let headerNext = false;
  let scanned = 0;
  for (
    let packet = offset;
    packet + TS_PACKET_SIZE <= data.length && scanned < KEYFRAME_SCAN_PACKETS;
    packet += TS_PACKET_SIZE
  ) {
    if (data[packet] !== TS_SYNC_BYTE) return null;
    const payload = readPayload(data, packet);
    if (!payload || payload.pid !== pid) continue;
    // The next frame began without this one showing a picture.
    if (packet !== offset && payload.start) return false;
    scanned += 1;
    const begin = packet === offset ? at + 9 + data[at + 8] : payload.offset;
    const end = payload.offset + payload.length;
    for (let index = begin; index < end; index += 1) {
      const byte = data[index];
      if (headerNext) {
        headerNext = false;
        const type = byte & 0x1f;
        // Coded slices: 5 is an IDR picture, 1 to 4 are not.
        if (type === 5) return true;
        if (type >= 1 && type <= 4) return false;
      }
      if (byte === 0) {
        zeros += 1;
      } else {
        if (byte === 1 && zeros >= 2) headerNext = true;
        zeros = 0;
      }
    }
  }
  return null;
}

/**
 * Whether the first video frame at or after `from` is a key frame, or null
 * when its picture has not arrived (or there is no video yet).
 */
export function tsFirstFrameIsKeyframe(data: Uint8Array, from: number): boolean | null {
  for (let offset = from; offset + TS_PACKET_SIZE <= data.length; offset += TS_PACKET_SIZE) {
    if (data[offset] !== TS_SYNC_BYTE) return null;
    const payload = readPayload(data, offset);
    if (!payload?.start) continue;
    const pes = readPesStart(data, payload);
    if (pes?.video && pes.time !== null) return tsFrameIsKeyframe(data, offset);
  }
  return null;
}

/**
 * Parts that can be cut from `data` starting at `from`, each covering about
 * `targetSeconds`. `from` must itself be a cut, where nothing was left open.
 * Only whole packets are considered, and the bytes of a part that has not
 * reached the target yet are left for a later call. A key frame always opens
 * a part of its own, so playback can start wherever one is.
 */
export function planTsParts(
  data: Uint8Array,
  from: number,
  targetSeconds: number,
): TsPart[] {
  if (targetSeconds <= 0) return [];
  const parts: TsPart[] = [];
  // Bytes still to come of each PES packet that states its length. Video
  // packets usually do not; one ends only where the next begins.
  const open = new Map<number, number>();
  let partStart: { seconds: number; offset: number } | null = null;

  for (
    let offset = from;
    offset + TS_PACKET_SIZE <= data.length;
    offset += TS_PACKET_SIZE
  ) {
    // Lost sync: cut nothing more, and let the fragment arrive whole.
    if (data[offset] !== TS_SYNC_BYTE) break;
    const payload = readPayload(data, offset);
    if (!payload) continue;
    if (!payload.start) {
      const left = open.get(payload.pid);
      if (left !== undefined) {
        if (left <= payload.length) open.delete(payload.pid);
        else open.set(payload.pid, left - payload.length);
      }
      continue;
    }
    const pes = readPesStart(data, payload);
    if (!pes) continue;
    if (pes.video && pes.time !== null) {
      const seconds: number = partStart === null ? pes.time : unwrap(pes.time, partStart.seconds);
      if (partStart === null) {
        partStart = { seconds, offset };
      } else if (open.size === 0 && pes.opensFrame && seconds > partStart.seconds) {
        let cut = seconds - partStart.seconds >= targetSeconds;
        if (!cut) {
          // A key frame cuts early; until its picture arrives there is no
          // telling, so nothing past it is planned yet.
          const keyframe = tsFrameIsKeyframe(data, offset);
          if (keyframe === null) break;
          cut = keyframe;
        }
        if (cut) {
          // This frame opens the next part, so the part being measured ends
          // here, and all of its own first frame has arrived.
          parts.push({
            end: offset,
            duration: Number((seconds - partStart.seconds).toFixed(3)),
            independent: tsFrameIsKeyframe(data, partStart.offset) === true,
          });
          partStart = { seconds, offset };
        }
      }
    }
    if (pes.remaining) open.set(pes.pid, pes.remaining);
    else open.delete(pes.pid);
  }

  return parts;
}

/** The decode time of the first video frame in `data`, once it has arrived. */
export function firstTsVideoTime(data: Uint8Array): number | null {
  for (let offset = 0; offset + TS_PACKET_SIZE <= data.length; offset += TS_PACKET_SIZE) {
    if (data[offset] !== TS_SYNC_BYTE) return null;
    const payload = readPayload(data, offset);
    if (!payload?.start) continue;
    const pes = readPesStart(data, payload);
    if (pes?.video && pes.time !== null) return pes.time;
  }
  return null;
}

/**
 * How much video a whole fragment holds: its first and last frames' decode
 * times and the usual gap between frames, so it lasts last - first + frame.
 * Twitch's fragments are not always two seconds; this is the real length.
 */
export function tsVideoSpan(data: Uint8Array): VideoSpan | null {
  const times: number[] = [];
  for (let offset = 0; offset + TS_PACKET_SIZE <= data.length; offset += TS_PACKET_SIZE) {
    if (data[offset] !== TS_SYNC_BYTE) break;
    const payload = readPayload(data, offset);
    if (!payload?.start) continue;
    const pes = readPesStart(data, payload);
    if (pes?.video && pes.time !== null) {
      times.push(times.length === 0 ? pes.time : unwrap(pes.time, times[0]));
    }
  }
  return videoSpan(times);
}

export interface VideoSpan {
  first: number;
  last: number;
  /** The usual time from one frame to the next. */
  frame: number;
}

/** First, last and typical spacing of a set of frame times, in any order. */
export function videoSpan(times: readonly number[]): VideoSpan | null {
  if (times.length < 2) return null;
  const sorted = [...times].sort((left, right) => left - right);
  const gaps = sorted
    .slice(1)
    .map((time, index) => time - sorted[index])
    .filter((gap) => gap > 0)
    .sort((left, right) => left - right);
  if (gaps.length === 0) return null;
  return { first: sorted[0], last: sorted[sorted.length - 1], frame: gaps[Math.floor(gaps.length / 2)] };
}

/** Whether the buffer begins with a plausible transport stream. */
export function looksLikeTransportStream(data: Uint8Array): boolean {
  return data.length >= TS_PACKET_SIZE && data[0] === TS_SYNC_BYTE;
}
