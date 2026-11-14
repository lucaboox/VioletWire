# TS pieces experiment — 2026-11-13

Continuation of `low-latency-parts-handoff.md`, starting from e954559.
**The ~3 s target is not achieved. This remains opt-in.** No changes to GPUI,
the normal latency preference, playback authentication or the Electron app.

## What works

- Step 0 passed: a 60 s braxy run on finished-fragment pieces delivered 60 fps,
  six dropped frames and no post-startup gaps. Consecutive non-IDR pieces work
  in Media Engine. A captured 120-frame fragment decoded to identical FFmpeg
  frame hashes before and after cutting, without decoder warnings.
- The progressive producer follows Twitch media sequence numbers and reads the
  prefetch response incrementally. Immutable completed pieces become ordinary
  HLS segments with target duration 1. No LL-HLS tags are used.
- TS cuts keep bounded audio/ID3 PES complete and require an elementary-stream
  start code. Durations use monotonic video decode timestamps (PTS fallback),
  including 33-bit wrap. Each cut gets the most recent complete PAT/PMT preceding
  it. Complete cuts reconstruct the source byte-for-byte after these prefixes
  are removed. Lost sync fails closed rather than publishing damaged media.
- The ring retains at most 30 media seconds / 48 MiB, with 16 MiB per incoming
  fragment. The relay permits 32 simultaneous local requests. Every media path
  requires the existing per-process 128-bit secret and session ID. Media fetches
  allow HTTPS media CDNs only, disable redirects, and time out a stalled read
  after 3 s. Session drop cancels the producer.
- A failed prefetch is retried as a finished fragment. Already-published pieces
  must compare byte-for-byte and are not reissued with new identities. Unsafe
  cuts before startup fall back to the old playlist relay; later failures
  reconnect through that relay with parts disabled for the playback.
- Ad metadata is checked during growing downloads; ads stop publication and
  the next live fragment gets a discontinuity. Settling skips sessions with
  skipped ads, whose time mapping cannot be trusted.

The PAT/PMT prefixes follow [RFC 8216 §3.2](https://www.rfc-editor.org/rfc/rfc8216.html#section-3.2).

## Measurements

These are individual live-network samples on this PC, not guarantees. The
handoff's reported clock offset (~0.4 s fast) applies to both sides. UFDTech
was not used for latency measurements. FPS is compared to the source framerate.

| Channel / mode | Run | First frame | Final broadcast latency | FPS | Dropped | Gaps after startup |
|---|---:|---:|---:|---:|---:|---:|
| braxy, original low latency | 60 s | 3.45 s | 6.62 s | 60.5 | 11 | one, 2.14 s |
| braxy, finished-piece spike | 60 s | 3.79 s | 6.54 s | 60.0 | 6 | none |
| braxy, progressive / three-piece startup | 60 s | 3.17 s | 5.21 s | 60.4 | 9 | none |
| robcdee, original low latency | 60 s | 3.38 s | 7.05 s | 50.0 | 5 | none |
| robcdee, progressive / three-piece startup | 60 s | 2.85 s | 6.16 s | 49.4 | 5 | none |
| braxy, full visible app with chat | 25 s | 4.00 s | 5.87 s | 59.7 | 11 | none |

An earlier 25 s braxy progressive run started in 4.22 s and ended at 5.26 s
latency. Startup varies; it does not reliably meet the 3.5 s acceptance bound.
The full-app snapshot (`rust/target/latency-app-check/app.png`) was visually
checked: clean video, normal chat/emotes, no obvious block corruption.

Balanced mode with the experimental flag set still used zero TS pieces and
played at 60 fps. A 1440p60 summit1g run also used zero TS pieces and played at
59.9 fps. fMP4 subdivision remains deferred because the TS acceptance target
has not been reached.

## Settling is unresolved

The first settling experiment sought only after the key-frame piece and two
following pieces had been completely served to the client. Nonetheless, three
seeks caused 1.04–1.58 s pauses and 177 dropped frames over 60 s; final latency
was 5.85 s. This fails smoothness acceptance. The normal trial does not seek.

`VIOLETWIRE_PARTS_STEER=1` enables the diagnostic policy (45 frames before the
first seek, 15 s minimum interval, maximum three seeks per engine). A >600 ms
gap within 20 s of a seek now disables further automatic seeks for that engine;
its cushion grows by 0.75 s and decays during stall-free playback. The older
seekable-range drift controller is bypassed for piece sessions.

Piece responses are privately cacheable for 30 s; playlist responses remain
uncacheable. A 25 s follow-up with caching still paused for 1.02 s after its
first seek and ended at 5.88 s latency. The new guard suppressed further seeks;
there were zero reported dropped frames, but smoothness still failed. Even a
successful SetCurrentTime is not evidence of a smooth catch-up. Do not enable
settling by default without a new 60 s, gap-free validation.

## Try / reproduce

Validation: 81 tests pass, one existing file-driven image test remains ignored,
and Clippy passes with warnings denied. The generated H.264/AAC fixture covers
byte preservation, growing responses, partial PES, frame tails and clock wrap;
the captured live fragment was also decoded and compared with FFmpeg.

From the repository root in PowerShell 7:

```powershell
# Builds a separate debug executable and opens Home; preserves a running client.
./rust/scripts/start-low-latency-trial.ps1
# Open a channel immediately, or compare without pieces:
./rust/scripts/start-low-latency-trial.ps1 -Channel braxy
./rust/scripts/start-low-latency-trial.ps1 -Channel braxy -Baseline
```

Close an existing **trial** window before rebuilding its executable. The
existing dev executable is not replaced. Low latency in Settings must be on;
Balanced bypasses pieces. `VIOLETWIRE_NO_PARTS=1` is the escape hatch.

After the launcher has built `rust/target/latency-trial.exe`:

```powershell
$env:VIOLETWIRE_PARTS = '1'
$env:VIOLETWIRE_PLAYBACK_LOG = '1'
./rust/target/latency-trial.exe --play braxy --video-probe-seconds 60 --mute-video
# Natural visible-app rendering, with real chat, no synthetic hidden-window ticks:
./rust/target/latency-trial.exe --play braxy --app-probe-seconds 30 --mute-video --ui-snapshot-dir rust/target/parts-app
# Check the compatibility paths without saving preference changes:
./rust/target/latency-trial.exe --play braxy --video-probe-seconds 15 --mute-video --probe-balanced
./rust/target/latency-trial.exe --play summit1g --video-probe-seconds 20 --mute-video --probe-initial-quality 1440p60
```

`VIOLETWIRE_PARTS_SPIKE=1` restricts the experiment to finished-fragment cuts.
`VIOLETWIRE_PARTS_FINISHED_START=1` starts progressive playback on the newest
finished key-frame fragment. `VIOLETWIRE_CAPTURE_PARTS=1` writes one media-only
source/cut pair under `rust/target/parts-capture` for FFmpeg verification. No
upstream URLs or authentication are written to the captures or diagnostic logs.

Remaining acceptance work: reach ≤3.5 s broadcaster latency on two TS channels
without post-startup gaps, avoid startup regressions, validate long sessions,
ad transitions and network failure recovery, then consider fMP4 chunks. If
Media Engine's HLS front end remains the limit, the handoff's custom media-source
alternative is the next architectural experiment; it is not implemented here.
