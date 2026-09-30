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

/**
 * Parts that can be cut from `data` starting at `from`, each covering about
 * `targetSeconds`. `from` must itself be a cut, where nothing was left open.
 * Only whole packets are considered, and the bytes of a part that has not
 * reached the target yet are left for a later call.
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
  let partStart: number | null = null;

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
      const seconds: number = partStart === null ? pes.time : unwrap(pes.time, partStart);
      if (partStart === null) {
        partStart = seconds;
      } else if (open.size === 0 && pes.opensFrame && seconds - partStart >= targetSeconds) {
        // This frame opens the next part, so the part being measured ends here.
        parts.push({ end: offset, duration: Number((seconds - partStart).toFixed(3)) });
        partStart = seconds;
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

/** Whether the buffer begins with a plausible transport stream. */
export function looksLikeTransportStream(data: Uint8Array): boolean {
  return data.length >= TS_PACKET_SIZE && data[0] === TS_SYNC_BYTE;
}
