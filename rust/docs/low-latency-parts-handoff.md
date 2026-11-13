# Handoff: lower latency in the Rust app by cutting the in-progress fragment

Goal: bring the Rust + GPUI app (`rust/`, branch `rust-gpui`) from ~5 s behind
the broadcaster to ~3 s, matching Twitch's site and the Electron app.

Read `AGENTS.md` (repo root) first. Its rules apply here: no tokens or signed
URLs in logs, argv or commits; loopback relay only; treat network data as
untrusted. Run `cargo test` and `cargo clippy --all-targets -- -D warnings`
in `rust/` before committing.

## Where things stand (commit e954559)

Playback path: native Twitch lookup (`rust/app/src/playback/twitch.rs`) →
loopback **playlist** relay (`playback/relay.rs`) → Windows Media Engine in
frame-server mode (`playback/gpu.rs`) → GPUI surface.

The relay today rewrites only the media playlist. Media URIs point straight at
Twitch's CDN; the relay never carries video bytes. It lists Twitch's two
`#EXT-X-TWITCH-PREFETCH` entries (the fragment being written, and the next) as
ordinary segments, and on MPEG-TS streams starts playback on the first one.

Measured latency to broadcaster (`broadcast=` in the probe output, see
"Measuring"):

| Stream type | Now |
|---|---|
| MPEG-TS (most 1080p streams) | ~4.5–5 s |
| Fragmented MP4 (streams offering 1440p/HEVC) | ~5.5–7 s |

## The constraint, established by measurement

Windows Media Engine plays an HLS segment only once the **whole segment** has
downloaded. Twitch fragments are 2 s, and a finished fragment appears in the
playlist ~2.5–3 s after its last frame was broadcast (call this the edge lag).
So the floor with whole fragments is edge lag + 2 s ≈ 5 s, which is where
MPEG-TS already sits.

Things that were tried on live streams and do **not** work (all reverted; do
not repeat them):

1. **Playback rate catch-up.** `SetPlaybackRate(1.06)` is ignored on live HLS;
   the playhead advances at exactly 1.0x.
2. **Seeking forward after start-up.** Media Engine snaps a seek to the start
   of a segment. A seek whose target lies in a segment that is not fully
   downloaded (the prefetch one) falls back to the start of the *current*
   segment: video replays and latency gets worse (braxy: 5 s → 7 s over four
   seeks).
3. **Seeking to a computed segment boundary.** Same failure: the boundary
   belongs to the unfinished segment.
4. **Nudging forward inside the current, finished segment.** The seek lands
   exactly, but playback then reaches the segment's end before the next one
   is complete and stalls ~3 s.
5. **Starting on the second prefetch entry.** First frame takes 5.5–6 s and
   latency is no better (~4.5 s).
6. **Starting an fMP4 stream on the fragment being written.** 7.8 s to first
   frame.

Useful facts from the same tests:

- A seek to a position inside fully downloaded media works and is quick
  (<100 ms, no visible gap logged).
- `GetBuffered()`/`GetSeekable()` end is just the playlist's total duration,
  not downloaded bytes. Do not use it to judge real buffer.
- Media Engine reloads the playlist about once per target duration. The relay
  declares the real `EXT-X-TARGETDURATION` (2); a hard-coded 6 starved it.
- Do not set `MF_MEDIA_ENGINE_REAL_TIME_MODE`: it corrupts streams with
  B-frames.
- Media Engine does not understand LL-HLS (`EXT-X-PART`, preload hints,
  blocking reload). Electron's approach cannot be copied as-is; see below.

## The approach

Make the relay hand Media Engine short, **complete** segments cut from the
fragment Twitch is still writing.

Electron does the equivalent for hls.js: `src/main/filtered-hls-relay.ts`
(`publishParts`, part rendering around lines 1000–1055) streams the prefetch
fragment and publishes ~0.32 s LL-HLS parts; `src/main/ts-parts.ts`
(`planTsParts`, `tsFrameIsKeyframe`, `tsVideoSpan`) decides where a TS stream
may be cut. Because Media Engine has no LL-HLS, the Rust relay must publish
the pieces as **ordinary segments** in a plain live playlist.

Expected result: latency ≈ arrival lag of chunked data (~1–1.5 s) + piece
length (~0.5 s) + start-up loss, about 3 s.

### Step 0 — feasibility spike (do this first, it decides everything)

Unknown: does Media Engine play consecutive TS segments that do **not** begin
with a key frame, when they are contiguous pieces of one stream?

Cheapest test, no latency gain yet:

1. Give the relay a media endpoint (see Step 1).
2. For each *finished* Twitch fragment, download it whole in the relay, cut it
   into ~0.5 s pieces at video PES starts, and list the pieces instead of the
   fragment.
3. Play 60 s of a 1080p60 TS stream. Pass = steady 60 fps (`fps=` in the
   probe), no `[gap]` lines after start-up, clean picture (check a snapshot
   or watch it: smeared macroblocks mean a bad cut).

If Media Engine needs every segment to open on a key frame, pieces can only
be whole GOPs. Twitch's GOP is normally 2 s (= the fragment), so this approach
is dead for TS and the fallback is the "Alternatives" section.

### Step 1 — relay carries media

`relay.rs` today: `start()` binds `127.0.0.1:0`; `serve()` answers one GET for
`/<secret>/<session id>.m3u8` via `refresh()`. Keep the 128-bit secret in every
path, keep loopback-only, keep request size limits.

Add `GET /<secret>/<session>/p/<sequence>.ts`, served from an in-memory ring
of pieces per session (cap by bytes and age, e.g. 30 s / 48 MB; a 1080p60
stream is ~1 MB/s). Answer with `Content-Length`; a piece is immutable once
listed. Unknown or evicted piece → 404.

### Step 2 — the cutter (MPEG-TS)

Port the needed parts of `src/main/ts-parts.ts` into `playback/ts.rs` (which
today has only `first_frame_is_keyframe`). Rules, each learned the hard way in
Electron (see the memory notes quoted at the end):

- Work in 188-byte packets; resync on 0x47.
- Find the video PID from PAT → PMT. Track the latest PAT and PMT packets and
  **prepend a copy of both to every piece**, so each piece demuxes alone.
- Cut only at a packet with `payload_unit_start` on the video PID, and only
  when no audio/ID3 PES is left open across the cut (cut after the open
  bounded PES completes, or carry its packets into the same piece).
- Only cut where that video PES payload begins with a start code. Some
  encoders (xQc's source: ~23% of video PES) put the previous frame's tail at
  the front of a PES; cutting there smears macroblocks.
- Piece length: aim for ≥0.5 s of video by PTS (33-bit, handle wrap). The
  first piece of a Twitch fragment begins at its key frame.
- Piece duration for `EXTINF`: last video PTS − first video PTS + one frame
  interval (median PTS gap, see `videoSpan`). The pieces of one fragment must
  sum to the fragment's real duration; put any remainder in the last piece.
- Unit-test with a captured `.ts` fragment: concatenating the pieces minus
  the injected PAT/PMT must equal the input byte for byte.

### Step 3 — follow the in-progress fragment

Per session, a worker thread:

1. Reads the upstream playlist (reuse `refresh()`'s fetch/parse; `parse()`
   already returns prefetch entries, `fmp4`, ads and `media_sequence`).
2. For the first prefetch URL, opens a streaming GET and feeds bytes to the
   cutter as they arrive (Twitch serves it with chunked transfer while
   writing). Completed pieces go to the ring and into the playlist.
3. When that fragment ends, moves to the next. Identify fragments by Twitch's
   **media sequence number** (in-progress entries are last+1 and last+2);
   never by inferred `PROGRAM-DATE-TIME`, which drifts.
4. On an ad (`ad == true`: "Amazon" title or `twitch-stitched-ad` daterange)
   stop, emit nothing for it, and set `EXT-X-DISCONTINUITY` on the next live
   piece, as `Playlist::merge` does today.

Timeouts and failure: if the streaming GET stalls >3 s or errors, fall back to
cutting the fragment once it is listed as finished. Never let the playlist
stop growing silently; `gpu.rs`'s freeze watchdog reconnects after 4 s + 6 s.

### Step 4 — the playlist

A session that uses pieces must list **only** pieces from its first segment
on. hls players (and the notes below) forbid changing a listed segment, so a
fragment once cut is never re-listed whole.

- `EXT-X-MEDIA-SEQUENCE` counts pieces; forward-only, as now.
- `EXT-X-TARGETDURATION`: ceil of the longest piece (1). This also makes
  Media Engine reload about every second, which the approach relies on.
- Carry `EXT-X-PROGRAM-DATE-TIME` on the first piece of each fragment.
- Keep `Status::start_date` meaning "date of the first listed piece":
  `gpu.rs` derives "latency to broadcaster" from it plus the playhead.
- Start point: the newest piece that opens on a key frame (first piece of a
  fragment) and has at least one more piece after it.

### Step 5 — settle near the edge

Start-up costs ~1.7 s (engine creation to first frame), during which the live
edge moves on. With pieces, a seek can land on finished media close to the
edge, which whole fragments never allowed:

- After ~45 frames, if playback is >0.7 s behind the newest key-frame piece
  that has ≥2 complete pieces after it, `SetCurrentTime` to that piece's start
  (+0.05 s so the snap does not pick the piece before).
- At most one such seek per 15 s and a few per engine. If a stall (>600 ms
  without a frame) follows within 20 s, keep an extra 0.75 s back from then on
  (Electron's hysteresis; its cushion also decays 0.5 s per stall-free
  minute).
- Skip all steering during ad breaks and after any skipped ad
  (`Relayed::ads_skipped() > 0`): the playhead ↔ date mapping is broken then.

### Step 6 — fragmented MP4 (after TS works)

fMP4 streams (`EXT-X-MAP`; `Parsed::fmp4`) are the 1440p/HEVC ones. A fragment
being written is a sequence of `moof`+`mdat` chunks; each pair is already a
complete piece. Cut on box boundaries, keep the init segment (`EXT-X-MAP`)
unchanged, and compute each piece's duration from `tfdt`/`trun` and the track
timescale in the init segment. Electron notes: Twitch names an fMP4 fragment
differently while writing and when complete (only the date links them), and
the prefetch URL serves the identical full fragment.

## Scope and switches

- Only when "Low latency" is on (`relay::set_low_latency`, preference
  `playbackLatencyMode != "balanced"`). Balanced keeps today's behaviour.
- Keep an escape hatch env var (e.g. `VIOLETWIRE_NO_PARTS`) for A/B runs.
- Multistream is not ported yet; keep per-session memory bounded for it.

## Measuring

Build, then (PowerShell or Git Bash; the app must not be running, or build to
another dir with `CARGO_TARGET_DIR`):

```bash
VIOLETWIRE_PLAYBACK_LOG=1 ./target/debug/violetwire.exe --play <login> --video-probe-seconds 60 --mute-video
```

- Final line: `fps=`, `first_frame_ms=`, `broadcast=` (latency to
  broadcaster, s), `dropped=`, `recoveries=`.
- `[gap] N ms without a frame` marks every stall >150 ms. One at start-up is
  normal.
- `[playback]` lines every 2 s show the playhead and list end.
- `--qualities-probe a,b,c` lists each channel's qualities; a channel listing
  `1440p60` is fMP4, otherwise TS. `--probe-quality 1440p60` switches mid-run.
- `VIOLETWIRE_FRAME_LOG=1` in the full app prints slow UI frames and renders
  per view; video must stay at 60 fps with chat open.
- The hidden probe window hides UI-thread problems. Confirm the final result
  in the full app too: `./target/debug/violetwire.exe --play <login>`.
- This PC's clock runs ~0.4 s fast, inflating `broadcast=` by that much.
  Compare builds against each other, or against the site by matching frames.
- A 24/7 restream channel (ufdtech) reports ~25 s by design; do not use it
  for latency numbers.

Acceptance: on two TS channels, 60 s runs with `broadcast` ≤ 3.5 s, no `[gap]`
after start-up, `dropped` in single digits, first frame ≤ 3.5 s; Balanced mode
unchanged; `cargo test` and Clippy clean; README's latency bullet and
`vendor/GPUI-PATCH.md` (if GPUI is touched) updated.

## Alternatives if the spike fails

- **Replace the HLS front end, keep Media Engine's decoders:** feed Media
  Engine through a custom `IMFByteStream`/media source that presents one
  endless TS stream assembled by the relay, instead of HLS. Media Engine then
  reads progressively. Larger change; unverified.
- **Own demux + Media Foundation decoders (`IMFTransform`) + own A/V clock:**
  full control over latency, largest effort. `playback/pipeline.rs` (the
  FFmpeg CPU fallback) shows the app's existing clock/audio plumbing.

## Electron lessons to respect (from earlier debugging)

- Never change a listed segment's URI or identity between reloads.
- Identify an in-progress fragment by media sequence number, not inferred
  date: inferred dates drift when fragment lengths vary and caused duplicates.
- TS cuts: only at a video PES start with no bounded PES open, and only when
  the payload opens with a start code.
- Verify cuts by decoding the pieces (FFmpeg), not by eye.
- A stall cushion must decay, or latency creeps up over a long session.
- An unmarked ad fragment can have timestamps that do not continue the
  previous one; leave such a fragment whole and mark a discontinuity.
