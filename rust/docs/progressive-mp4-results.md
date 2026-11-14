# Progressive fMP4 / 1440p continuation — 2026-11-13

Branch: `codex/rust-progressive-source`. This extends the
[TS source experiment](progressive-source-results.md). It remains opt-in;
the Electron app and normal Rust default are unchanged.

## Change

The TS-only trial left Summit1G's 1440p stream on **Windows HLS**, reproducing
the reported high latency. The new path also accepts unencrypted fMP4 with
an initialization map and no byte ranges. On the tested live stream the native
video type is HEVC, at 2560×1440 and 60 fps.

The relay validates and fetches the current initialization segment (maximum
1 MiB), checks its video track IDs, and follows growing prefetch responses.
The first video sample's sync flag is checked before publishing media. The
initialization header and original compressed fragments feed the bounded
private byte stream, then the native MP4 demux/async Source Reader and our
compressed sample source. Media Engine continues GPU decode, video conversion,
audio and GPUI GPU rendering. No FFmpeg process or decoded CPU frames are used.
The retained startup cushion is 0.6 s for fMP4; TS retains 1.1 s.

Prefetch entries now inherit the active `EXT-X-MAP` and encryption tags.
Previously only completed entries carried those tags, so the experimental
source correctly rejected the in-progress entry as lacking its initialization.
Initialization changes, encrypted/byte-range inputs, interrupted responses,
decode failures and freezes fail back to HLS. A new engine that never produces
a first frame is now covered by the existing startup watchdog too.

Memory, request limits, secret paths and CDN validation retain the TS trial's
bounds. Both `/live.ts` and `/live.mp4` require the full secret/session and
must match the session's container. Logs contain numeric timing, sizes, codec
GUIDs and rejection stages; never media addresses or authentication.

## Measurements

Individual live-network samples on this PC, not guarantees. Broadcast values
depend on Twitch's program dates and the host clock. All runs below used
**Summit1G, 1440p60** and reported zero CPU frame uploads.

| Input / run | Duration | First frame | Final broadcast latency | FPS | Dropped | Post-start gaps >150 ms |
|---|---:|---:|---:|---:|---:|---|
| Windows HLS (confirmed fallback) | 15 s | 3.34 s | 9.66 s | 60.7 | 4 | none |
| Progressive fMP4, 1.1 s cushion | 25 s | 2.67 s | 4.74 s | 60.6 | 1 | none |
| Progressive fMP4, 0.6 s cushion | 60 s | 2.86 s | 4.42 s | 59.5 | 0 | none |
| Full app + chat, clean repeat | 30 s | 2.58 s | 4.55 s | 59.9 | 36 | none |

The first full-app 25 s run had real connected chat, 113 received messages,
1,433 emote definitions and decoded images/animations. Its snapshot showed
clean video, normal chat and emotes. It ended at 4.44 s latency, but reported
110 dropped frames while an older client and a compiler were also running;
that run is not accepted as a smoothness result. The clean repeat used one
client with no compilation, connected chat (104 received messages), 1,433 emote
definitions and decoded animated images. It exited cleanly and retained the
fMP4 source throughout. The full UI still reported 36 dropped frames, unlike
the isolated video probe; performance with chat/assets needs further work.
Long-session drift, audible A/V sync and ad/quality
transitions still need broader validation before making this the default.

## Launch / verify

From the repository root in PowerShell 7:

```powershell
./rust/scripts/start-progressive-source-trial.ps1 -Channel summit1g
```

The launcher builds `rust/target/progressive-source-mp4-trial.exe` separately
and sets `VIOLETWIRE_PROGRESSIVE_SOURCE=1` plus
`VIOLETWIRE_PROGRESSIVE_MP4=1` in that child only. Low latency must be on.
Video stats should show **Progressive fMP4 (experimental)** at 1440p. Balanced
and `-Baseline` use HLS; clearing the MP4 flag retains the TS-only trial.

Local validation: 93 tests passed, one existing image-file test ignored;
Clippy passed with warnings denied. New tests cover initialization/video IDs,
sync and non-sync chunks, incomplete/oversized boxes, prefetch tag inheritance,
and native compressed MP4 delivery before HTTP EOF. The generated H.264/AAC
fixture has small fragments and no final index, and contains no captured
broadcast media. HEVC was exercised in the live probes above.
