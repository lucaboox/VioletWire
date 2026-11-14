# Progressive compressed source trial — 2026-11-13

This records the initial TS-only stage. The subsequent
[fMP4 / 1440p results](progressive-mp4-results.md) cover the newer extension;
the launcher now builds the TS/fMP4 trial described there.

Branch: `codex/rust-progressive-source`, based on e954559 and the uncommitted
TS-piece experiment. This is opt-in; no running client was replaced, committed,
or published. The original open `violetwire.exe` process (45496, started 00:43)
predates the new trial executables. Reports of 10–13 s from that open client
are unresolved; they must not be represented as measurements of this source.

## New path

`VIOLETWIRE_PROGRESSIVE_SOURCE=1` selects this path for eligible TS streams in
Ultra Low mode:

Twitch progressive TS response → bounded compressed byte ring → private loopback
byte adapter → native TS demux / async Source Reader → H.264 remux transform →
our compressed sample source → Media Engine GPU decode/audio → GPUI GPU surface.

Media Engine retains its hardware decoder and audio clock; its HLS frontend is
bypassed. No FFmpeg process, CPU pixel conversion or decoded-frame upload is
introduced. This is not a complete independent demuxer/decoder implementation.

The [native H.264 remux transform](https://learn.microsoft.com/en-us/windows/win32/medfound/how-to-use-h-264-avc-remux-)
assembles elementary chunks into compressed pictures with timestamps. Startup
keeps 1.1 s of compressed video after the presentation origin and retains the
preceding IDR with negative timestamps for decoder preroll. Older pictures are
decoded before presentation, following the
[Media Foundation source-start contract](https://learn.microsoft.com/en-us/windows/win32/api/mfidl/nf-mfidl-imfmediasource-start).
There is no post-start seek or playback-rate adjustment in this experiment.

The raw ring is limited to 8 MiB; the byte adapter has 4 MiB pending and 4 MiB
rewind history; queued samples are limited to 16 MiB, 240 samples per track,
4 MiB per sample. Incoming TS responses retain the existing 16 MiB limit.
The adapter accepts only the private literal-loopback HTTP endpoint. Relay
paths require the complete session secret. URLs and authentication are not
printed. Media fetch validation and ad detection remain in the relay.

Async demux permits cancellation while waiting for samples. Shutdown closes
the socket, shuts sources/queues outside the state lock, and joins the owned
workers before MFShutdown. Sample event dispatch is serialized so concurrent
requests and demux publication cannot reverse frame order.

Pause/resume and Go Live refresh the forward-only input. Decode errors, media
changes, interrupted responses and freeze recovery return to normal HLS.
Balanced and fMP4 (including tested 1440p) use HLS from the outset. The stats
panel identifies the active input so HLS fallback is visible.

## Measurements

Individual sequential live-network samples on this PC, not guarantees. The
handoff's reported host-clock offset affects absolute broadcast readings.
`cpu_frame_uploads=0` in every run. Drops include startup/preroll. No claim of
better CPU/GPU usage than Electron has been established.

| Mode / channel | Run | First frame | Final broadcast latency | FPS | Dropped | Post-start gaps >150 ms |
|---|---:|---:|---:|---:|---:|---|
| Unchanged HLS, braxy | 60 s | 2.54 s | 7.20 s | 60.1 | 19 | one, 2.25 s |
| Progressive source, braxy, 1.1 s cushion | 60 s | 2.71 s | 2.93 s | 60.2 | 2 | none |
| Progressive source, robcdee, 1.1 s cushion | 60 s | 2.41 s | 3.90 s | 50.1 | 3 | none |
| Flag enabled, Balanced, braxy (HLS) | 15 s | 2.88 s | 7.26 s | 60.1 | 18 | — |
| Flag enabled, 1440p60 summit1g (HLS) | 15 s | 3.19 s | 6.06 s | 59.9 | 9 | — |

Earlier raw HTTP / native byte-stream adapters remained around 4.9–5.0 s.
An aggressive 0.6 s preroll cushion produced a good 25 s sample at 2.68 s,
but minute-long runs dropped 164–180 frames with recurring 0.15–0.4 s gaps.
That cushion was rejected. Rate changes caused multi-second rebuffering and
were removed. TS cuts are not used in this path: original TS bytes are fed
without injected PAT/PMT prefixes.

The minute-long results above precede the final dispatcher race fix. The fix
has a concurrent sample-order regression test; full app live validation of the
final binary remains outstanding. A hidden full-app attempt did not render
naturally and is **not** a valid test. Opening a visible timed test was blocked
when automatic approval review hit a usage limit; it was never executed.
All timed hidden probes exited; the user's existing client was left running.
Long sessions, audible A/V sync, quality switches and ad transitions need more
live validation before making this the default.

The reported stale broadcaster-latency readout is also addressed on this branch:
visible stats refresh every half second independently of arriving video frames,
the calculation uses the last frame transferred to GPUI rather than the moving
playback clock, and replacing an engine clears cached measurements. This makes
a paused/frozen picture's delay increase instead of concealing it behind the
audio clock. The frame timestamp comes from
[OnVideoStreamTick](https://learn.microsoft.com/en-us/windows/win32/api/mfmediaengine/nf-mfmediaengine-imfmediaengine-onvideostreamtick).
The final readout change has local regression coverage; live UI verification
is still pending the blocked launch. It does not establish that a previously
reported 10–13 s latency was inaccurate or that the old open process is fixed.

## Try this exact branch

PowerShell 7, from the repository root:

```powershell
./rust/scripts/start-progressive-source-trial.ps1 -Channel braxy
# Compare the normal HLS path:
./rust/scripts/start-progressive-source-trial.ps1 -Channel braxy -Baseline
```

The launcher builds a separate `rust/target/progressive-source-trial.exe` and
sets the flag only in its child process. It does not stop an existing client.
Close an earlier trial before rebuilding that same executable. Ultra Low must
be selected in Settings. A 1440p/fMP4 channel remains on Windows HLS; the new
lower-latency figures do not apply to that path. Switching to an available TS
quality can exercise the new source. Check **Playback input** in video stats.

After building, a hidden muted video probe can be run with:

```powershell
$env:VIOLETWIRE_PROGRESSIVE_SOURCE='1'
$env:VIOLETWIRE_PLAYBACK_LOG='1'
./rust/target/progressive-source-trial.exe --play braxy --video-probe-seconds 60 --mute-video
```

Validation: 89 tests passed, one existing image-file-driven test ignored; Clippy
passed with warnings denied. Tests
cover full byte reads across network chunks, EOF, cancellation, bounded rings,
secret paths, native compressed remux, negative preroll/audio alignment,
concurrent sample delivery order and idempotent shutdown.
