/**
 * Builds small fragmented MP4 byte streams shaped like Twitch's CMAF output,
 * for tests: an initialisation segment with an audio and a video track, and
 * fragments of nineteen moof+mdat chunks with a key frame only in the first.
 */

export function uint32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

export function join(...parts: Uint8Array[]): Uint8Array {
  const data = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  return data;
}

export function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = join(...payload);
  return join(uint32(8 + body.length), new TextEncoder().encode(type), body);
}

/** A full box: a version byte and three flag bytes before its fields. */
export function fullBox(type: string, flags: number, ...fields: Uint8Array[]): Uint8Array {
  return box(type, uint32(flags & 0xffffff), ...fields);
}

export const AUDIO_TRACK = 1;
export const VIDEO_TRACK = 2;
export const CHUNK_SECONDS = 0.107;

function track(trackId: number, timescale: number, kind: "soun" | "vide"): Uint8Array {
  return box(
    "trak",
    // Creation and modification times precede the id.
    fullBox("tkhd", 0, new Uint8Array(8), uint32(trackId), new Uint8Array(8)),
    box(
      "mdia",
      fullBox("mdhd", 0, new Uint8Array(8), uint32(timescale), new Uint8Array(4)),
      fullBox("hdlr", 0, new Uint8Array(4), new TextEncoder().encode(kind), new Uint8Array(12)),
    ),
  );
}

/** The shape Twitch serves: audio at 48 kHz, video counted in microseconds. */
export function initSegment(): Uint8Array {
  return join(
    box("ftyp", new Uint8Array(8)),
    box("moov", track(AUDIO_TRACK, 48_000, "soun"), track(VIDEO_TRACK, 1_000_000, "vide")),
  );
}

const SYNC = 0x02000000;
const NON_SYNC = 0x01010000;

function trackFragment(trackId: number, decodeTime: number, firstSampleFlags?: number): Uint8Array {
  return box(
    "traf",
    fullBox("tfhd", 0, uint32(trackId)),
    fullBox("tfdt", 0, uint32(decodeTime)),
    firstSampleFlags === undefined
      ? fullBox("trun", 0, uint32(1))
      : fullBox("trun", 0x04, uint32(1), uint32(firstSampleFlags)),
  );
}

/** One moof+mdat chunk as Twitch writes them: audio first, then video. */
export function chunk(seconds: number, keyFrame: boolean, mediaBytes = 32): Uint8Array {
  return join(
    box(
      "moof",
      trackFragment(AUDIO_TRACK, Math.round(seconds * 48_000)),
      trackFragment(VIDEO_TRACK, Math.round(seconds * 1_000_000), keyFrame ? SYNC : NON_SYNC),
    ),
    box("mdat", new Uint8Array(mediaBytes).fill(Math.round(seconds * 10) % 251)),
  );
}

/**
 * A two-second fragment as a list of pieces in the order they are written:
 * an event message, then nineteen chunks with a key frame in the ones listed.
 */
export function fragmentPieces(start: number, keyFrames: number[] = [0]): Uint8Array[] {
  return [
    box("emsg", new Uint8Array(16)),
    ...Array.from({ length: 19 }, (_, index) =>
      chunk(start + index * CHUNK_SECONDS, keyFrames.includes(index)),
    ),
  ];
}
