/**
 * Cuts a fragmented MP4 byte stream into low-latency HLS parts.
 *
 * Twitch serves some streams as transport streams and others as fragmented MP4
 * (CMAF), and the two cannot be cut the same way. A CMAF fragment is already
 * built from a run of `moof`+`mdat` chunks — Twitch writes nineteen of about
 * 0.107s into a two-second fragment, each carrying both audio and video — so
 * every chunk boundary is a place the stream can be split without touching the
 * media itself.
 *
 * Chunk boundaries carry no duration of their own. The decode time in each
 * chunk's `tfdt` does, but it counts in the track's own timescale, which is
 * only stated in the initialisation segment; {@link readMp4Tracks} reads it
 * from there so parts can be measured in seconds.
 *
 * A part can only be where playback starts if its video begins on a key frame.
 * Twitch puts exactly one at the head of each fragment, but that is read from
 * the sample flags here rather than assumed.
 */

interface Mp4Box {
  type: string;
  /** Offset of the box header. */
  start: number;
  /** Offset just past the box. */
  end: number;
  /** Offset of the box's contents. */
  body: number;
}

export interface Mp4Track {
  timescale: number;
  /** The handler type: "vide" for video, "soun" for audio. */
  kind: string;
}

export interface Mp4Part {
  /** Byte offset just past this part, always a chunk boundary. */
  end: number;
  /** Media seconds the part covers. */
  duration: number;
  /** Whether the part's video opens on a key frame, so playback can start at it. */
  independent: boolean;
}

function readUint32(data: Uint8Array, offset: number): number {
  return (
    data[offset] * 2 ** 24 +
    data[offset + 1] * 2 ** 16 +
    data[offset + 2] * 2 ** 8 +
    data[offset + 3]
  );
}

function readUint64(data: Uint8Array, offset: number): number {
  return readUint32(data, offset) * 2 ** 32 + readUint32(data, offset + 4);
}

/** The box starting at `offset`, or null when it is not fully present yet. */
function readBox(data: Uint8Array, offset: number): Mp4Box | null {
  if (offset + 8 > data.length) return null;
  let size = readUint32(data, offset);
  let body = offset + 8;
  if (size === 1) {
    if (offset + 16 > data.length) return null;
    size = readUint64(data, offset + 8);
    body = offset + 16;
  }
  // A size of zero runs to the end of the file, which a growing stream has not
  // reached; anything below the header is malformed.
  if (size < body - offset) return null;
  const end = offset + size;
  if (end > data.length) return null;
  return {
    type: String.fromCharCode(...data.subarray(offset + 4, offset + 8)),
    start: offset,
    end,
    body,
  };
}

function* boxes(data: Uint8Array, from: number, to: number): Generator<Mp4Box> {
  let offset = from;
  while (offset < to) {
    const box = readBox(data, offset);
    if (!box || box.end > to) return;
    yield box;
    offset = box.end;
  }
}

function findBox(data: Uint8Array, from: number, to: number, type: string): Mp4Box | null {
  for (const box of boxes(data, from, to)) {
    if (box.type === type) return box;
  }
  return null;
}

/**
 * The tracks an initialisation segment declares, keyed by track id: each
 * one's timescale, since a decode time only becomes seconds once paired with
 * the timescale of its track, and its kind, since only video decides where
 * playback can start.
 */
export function readMp4Tracks(init: Uint8Array): Map<number, Mp4Track> {
  const tracks = new Map<number, Mp4Track>();
  const moov = findBox(init, 0, init.length, "moov");
  if (!moov) return tracks;
  for (const trak of boxes(init, moov.body, moov.end)) {
    if (trak.type !== "trak") continue;
    const header = findBox(init, trak.body, trak.end, "tkhd");
    const media = findBox(init, trak.body, trak.end, "mdia");
    if (!header || !media) continue;
    const description = findBox(init, media.body, media.end, "mdhd");
    const handler = findBox(init, media.body, media.end, "hdlr");
    if (!description || !handler) continue;
    // Both are full boxes: a version byte, three flag bytes, then two times
    // whose width the version decides, and the field wanted after them.
    const trackId = readUint32(init, header.body + 4 + (init[header.body] === 1 ? 16 : 8));
    const timescale = readUint32(
      init,
      description.body + 4 + (init[description.body] === 1 ? 16 : 8),
    );
    // hdlr: version/flags, pre_defined, then the four-letter handler type.
    const kind = String.fromCharCode(...init.subarray(handler.body + 8, handler.body + 12));
    if (timescale > 0) tracks.set(trackId, { timescale, kind });
  }
  return tracks;
}

/**
 * Whether the first sample of a track fragment is a sync sample. The flags
 * come from the run's first-sample flags when it has them, else its per-sample
 * flags, else the track fragment's defaults; a sample is a sync sample when
 * its sample_is_non_sync_sample bit is clear.
 */
function firstSampleIsSync(data: Uint8Array, traf: Mp4Box): boolean | null {
  const header = findBox(data, traf.body, traf.end, "tfhd");
  const run = findBox(data, traf.body, traf.end, "trun");
  if (!header || !run) return null;
  const headerFlags = readUint32(data, header.body) & 0xffffff;
  let offset = header.body + 8; // version and flags, then the track id
  if (headerFlags & 0x01) offset += 8; // base data offset
  if (headerFlags & 0x02) offset += 4; // sample description index
  if (headerFlags & 0x08) offset += 4; // default sample duration
  if (headerFlags & 0x10) offset += 4; // default sample size
  const defaultFlags = headerFlags & 0x20 ? readUint32(data, offset) : null;

  const runFlags = readUint32(data, run.body) & 0xffffff;
  let cursor = run.body + 8; // version and flags, then the sample count
  if (runFlags & 0x01) cursor += 4; // data offset
  let flags: number | null;
  if (runFlags & 0x04) {
    flags = readUint32(data, cursor);
  } else if (runFlags & 0x400) {
    let sample = cursor;
    if (runFlags & 0x100) sample += 4; // sample duration
    if (runFlags & 0x200) sample += 4; // sample size
    flags = readUint32(data, sample);
  } else {
    flags = defaultFlags;
  }
  if (flags === null) return null;
  return ((flags >>> 16) & 0x1) === 0;
}

interface ChunkInfo {
  seconds: number;
  /** Null when the chunk carries no video, or its flags cannot be read. */
  videoSync: boolean | null;
}

/** When a chunk starts, and whether its video opens on a key frame. */
function readChunk(data: Uint8Array, moof: Mp4Box, tracks: Map<number, Mp4Track>): ChunkInfo | null {
  // Timed by the video where there is one: fragments are cut on its key
  // frames, and audio frames do not divide a fragment evenly (Twitch's audio
  // chunks run about 1.3% longer than its video ones).
  let seconds: number | null = null;
  let videoSeconds: number | null = null;
  let videoSync: boolean | null = null;
  for (const traf of boxes(data, moof.body, moof.end)) {
    if (traf.type !== "traf") continue;
    const header = findBox(data, traf.body, traf.end, "tfhd");
    const decode = findBox(data, traf.body, traf.end, "tfdt");
    if (!header || !decode) continue;
    const track = tracks.get(readUint32(data, header.body + 4));
    if (!track) continue;
    const decodeTime =
      data[decode.body] === 1
        ? readUint64(data, decode.body + 4)
        : readUint32(data, decode.body + 4);
    seconds ??= decodeTime / track.timescale;
    if (track.kind === "vide") {
      videoSeconds ??= decodeTime / track.timescale;
      videoSync = firstSampleIsSync(data, traf);
    }
  }
  const at = videoSeconds ?? seconds;
  return at === null ? null : { seconds: at, videoSync };
}

/**
 * Parts that can be cut from `data` starting at `from`, each covering about
 * `targetSeconds`. Only whole chunks are considered, so the bytes of a chunk
 * that is still arriving are left for a later call. A part also always ends
 * before a key frame, so a key frame opens a part of its own and playback can
 * start there.
 */
export function planMp4Parts(
  data: Uint8Array,
  from: number,
  targetSeconds: number,
  tracks: Map<number, Mp4Track>,
): Mp4Part[] {
  if (targetSeconds <= 0 || tracks.size === 0) return [];
  const parts: Mp4Part[] = [];
  let partStart: { seconds: number; independent: boolean } | null = null;

  for (const box of boxes(data, from, data.length)) {
    if (box.type !== "moof") continue;
    const chunk = readChunk(data, box, tracks);
    if (!chunk) continue;
    if (partStart === null) {
      partStart = { seconds: chunk.seconds, independent: chunk.videoSync === true };
      continue;
    }
    const elapsed = chunk.seconds - partStart.seconds;
    if (elapsed < targetSeconds && chunk.videoSync !== true) continue;
    // This chunk opens the next part, so the part being measured ends here.
    parts.push({
      end: box.start,
      duration: Number(elapsed.toFixed(3)),
      independent: partStart.independent,
    });
    partStart = { seconds: chunk.seconds, independent: chunk.videoSync === true };
  }

  return parts;
}

/**
 * The decode time, in seconds, of the first chunk in `data` (of its video,
 * where there is one), once that chunk's header has arrived.
 */
export function firstMp4ChunkTime(data: Uint8Array, tracks: Map<number, Mp4Track>): number | null {
  for (const box of boxes(data, 0, data.length)) {
    if (box.type !== "moof") continue;
    return readChunk(data, box, tracks)?.seconds ?? null;
  }
  return null;
}

/**
 * Whether the fragment that starts `data` opens with a key frame, read from
 * its first chunk. Needed for the part that closes a fragment, which is cut
 * from whatever is left rather than planned.
 */
export function mp4StartsIndependent(
  data: Uint8Array,
  from: number,
  tracks: Map<number, Mp4Track>,
): boolean {
  for (const box of boxes(data, from, data.length)) {
    if (box.type !== "moof") continue;
    return readChunk(data, box, tracks)?.videoSync === true;
  }
  return false;
}

/**
 * Whether the buffer begins with a fragmented MP4. Twitch opens a fragment with
 * an event message rather than a file or segment type box, so all of those
 * count.
 */
export function looksLikeFragmentedMp4(data: Uint8Array): boolean {
  // Only the opening header is needed, which matters while the fragment is
  // still arriving and its first box has not finished.
  if (data.length < 8) return false;
  const type = String.fromCharCode(...data.subarray(4, 8));
  return type === "emsg" || type === "styp" || type === "ftyp" || type === "moof";
}
