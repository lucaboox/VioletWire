# VioletWire in Rust + GPUI

An experimental rewrite of VioletWire as a native Rust app on
[GPUI](https://crates.io/crates/gpui), the GPU UI framework behind Zed. It lives
on the `rust-gpui` branch next to the Electron app, which stays the reference
and the shipping build until this one can replace it.

## Run it

Needs Rust stable (1.85+, edition 2024) with the MSVC toolchain and the Visual
Studio C++ build tools.

```powershell
cd rust
cargo run            # debug build; dependencies are optimised so it renders smoothly
cargo test
cargo clippy --all-targets
```

The first build compiles GPUI and takes a few minutes. Later builds take seconds.

## What works

- A frameless dark window with VioletWire's palette and its own caption
  buttons. GPUI gives Windows the real caption areas, so snap layouts, double-click
  to maximise and dragging all behave natively.
- Twitch sign-in with the official Device Code flow, using the same public client
  ID and scopes as the Electron build. VioletWire never sees a password.
- The token is stored in Windows Credential Manager, then validated, renewed and
  revoked as Electron does. Refresh-and-save is a single step because Twitch rotates
  refresh tokens. Signing out ends a "token epoch", so a renewal still in flight
  cannot save the token back.
- A followed-channels sidebar, live first by viewers and offline dimmed in
  follow order, plus a Home grid of live cards with thumbnails, viewer counts and
  uptime. Both refresh every two minutes. Thumbnails are re-fetched every Twitch
  thumbnail period, and the old frame stays on screen until the new one arrives.
- Home/sidebar images are loaded only from `static-cdn.jtvnw.net` over HTTPS. Their format is
  checked from their bytes, and each one is capped at 4 MB.

- In-app GPU-surface playback on Windows. Streamlink resolves the playlist once,
  then Windows Media Engine handles decoding, audio and playback timing in the
  app. Its GPU-processed BGRA texture is sampled directly by GPUI; frames never
  travel through CPU memory or GPUI's image atlas. FFmpeg is not used on this path.
  Settings > Ad-free playback links Twitch's website session, as Electron's
  "playback session" does: Turbo users and a channel's subscribers then get the
  stream without ads. The user signs in on twitch.tv in an InPrivate WebView2
  window (`playback_link.rs`), which only allows Twitch's sign-in hosts. The
  session token is kept in Windows Credential Manager and sent only as the
  lookup's `Authorization` header, or over the Streamlink worker's stdin pipe,
  never in argv. If Twitch refuses it, lookups fall back to anonymous and
  Settings asks you to link it again.
- A loopback playlist relay (`playback/relay.rs`), modelled on Electron's. Each
  session keeps its own forward-only playlist: Twitch segments keep a stable local
  media sequence number (keyed by PROGRAM-DATE-TIME), so Media Engine never sees
  the sequence go back. Playback starts about 5 s from the live edge (Media Engine
  otherwise starts at the oldest segment, ~28 s behind) on a segment whose first
  frame is a key frame, checked from its first 64 KB. Ads are filtered (an
  "Amazon" title or a stitched-ad DATERANGE) with a discontinuity where the stream
  resumes; a pre-roll keeps the session waiting ("Ad break") instead of failing,
  and the freeze watchdog ignores ad breaks. It declares the real 2 s target
  duration and drops prefetch hints. Only playlist text crosses the socket,
  behind a random per-process secret; segments come straight from Twitch's CDN.
- Native stream lookup (`playback/twitch.rs`): Twitch's GraphQL playback token
  and the usher playlist, as Streamlink does, without Python. About 0.25–0.5 s
  instead of Streamlink's ~2 s (Streamlink also re-reads every quality's playlist
  first). Quality names come from Twitch's `IVS-NAME`. Streamlink is only a
  fallback now, started if the native lookup ever fails; GPU playback no longer
  needs it installed. Lookups are cached briefly, and hovering a live channel
  looks it up ahead of the click; the connections are opened once the app is idle.
- Twitch's prefetch hints are listed as ordinary segments, as in Streamlink's and
  Electron's low-latency modes: latency to the broadcaster fell from ~9.3 s to
  ~5.5 s (sodapoppin, 1080p60, no stalls or recoveries). Stats show "Latency to
  broadcaster" from the segments' PROGRAM-DATE-TIME, as Electron does. Click to
  first frame is about 2.5–3 s (it was 4.5–5 s).
- Media Engine runs without `MF_MEDIA_ENGINE_REAL_TIME_MODE`: its low-latency
  decoding skips B-frame reordering, and streams that use B-frames smeared into
  blocks until the next key frame.
- Experimental short TS pieces (`VIOLETWIRE_PARTS=1`, off by default). The relay
  cuts the growing fragment at safe video/PES boundaries, adds PAT/PMT tables,
  and serves immutable ordinary HLS segments from a 30-second / 48 MiB ring.
  Live tests reduced measured latency by about 0.9–1.4 s while keeping native
  video framerate, but did not reach the handoff's 3–3.5 s target. Startup varied
  between roughly 2.8 and 4.2 s. Balanced and fMP4 retain the existing path.
  Automatic settling is separately opt-in: it caused pauses in testing.
  See [the experiment results](docs/low-latency-parts-results.md) for measurements,
  limits and the separate dev-build launcher.
- A second opt-in trial bypasses Media Engine's HLS frontend using a custom
  compressed-sample source, retaining GPU decode/rendering. Two one-minute TS
  runs reported 2.93–3.90 s broadcast latency without post-start stalls;
  a 1440p60 HEVC fMP4 run reported 4.42 s with zero dropped frames over a minute.
  Balanced retains HLS. This is not enabled in the normal build.
  See [progressive source results](docs/progressive-source-results.md) and
  [fMP4 / 1440p results](docs/progressive-mp4-results.md), plus
  `scripts/start-progressive-source-trial.ps1` for the separate trial launcher
  and outstanding long-session validation.
- Clip: Twitch's official Create Clip API (`clips:edit`), then Twitch's editor in
  the browser.
- Keyboard and mouse shortcuts as in Electron: Space, M or middle-click, F or
  double-click, T, C, O, G, the arrow keys and Esc. Press `?` (or open
  Settings > Keyboard shortcuts) for the full list.
- Latency and smoothness. On MPEG-TS streams with Low latency on (Electron's
  default "ultra-low", in Settings > Playback), playback starts on the fragment
  Twitch is still writing: ~4.5 s behind the broadcaster instead of ~6.5 s,
  first frame ~3 s. Fragmented-MP4 streams (the 1440p ones) start on a
  finished fragment, since Media Engine cannot read one being written.
  Fragments are matched across reloads by Twitch's media sequence number.
  Windows' player ignores playback-rate changes on live HLS, so there is no
  rate catch-up. Chat is a cached view, and animated emotes redraw only when
  their next frame is due, which keeps 60 fps video with busy chat.
- 1440p: Twitch offers it only to a signed-in viewer (the linked website
  session) whose player accepts HEVC, so lookups ask for `h265,h264`. Windows'
  HEVC Video Extensions decode it (summit1g at 2560x1440, 59.8 fps).
- Chat user cards as in Electron (`ChatUserCard.tsx`): click a name for the
  chatter's picture, bio, badges, account age, follow and subscription
  details (IVR's public subage API, as Chatterino uses), their recent
  messages here, and Block. Blocking hides their messages in VioletWire only;
  the list is in Settings > Chat and was copied from Electron once.
- The account chip shows the signed-in account's profile picture.
- Chat emotes as in Electron (`ProviderEmoteText.tsx`, `ChatEmote.tsx`):
  animated GIF/WebP emotes play; small 7TV/FFZ/BTTV emotes keep their size;
  zero-width emotes stack on the emote before them; BTTV and FFZ modifiers flip,
  rotate, widen or fade the emote next to them (the animated effects are not
  ported); hovering shows a large preview with the provider; a reply's leading
  `@name` is dropped and other `@mentions` are bold.
- Window placement as in Electron: position, size, maximized state and monitor
  are restored on launch (if that monitor is still connected).
- Chat on the left, deleted messages replaced or faded, and Electron's mention
  sound (Ping, Chime, Pop or Knock, 0–200 %), synthesized in `sound.rs`. The
  pointer hides with the player controls. These settings were copied from
  Electron once.
- Favourites as in Electron: right-click a followed channel (or use the star in
  the stream header) to add or remove one. Favourites sort first within Live and
  Offline and carry a star badge. Electron's list is imported once.
- Player controls as in Electron: the live indicator ("Live", "Behind live" —
  click to return — or "Paused"), video stats (latency read-out on the bar, a hover
  summary, and a panel with latency, buffer, resolution, framerate, bitrate,
  dropped frames, quality and stall recoveries; optional FPS in the corner), the
  stream quality menu (Auto plays the highest quality; a change builds the new
  stream silently and swaps when its first frame is ready, so the picture never
  stops), and audio compression — a Media Foundation effect matching Electron's
  WebAudio compressor (−18 dB, 12 dB knee, 4:1, 20/250 ms, WebAudio's make-up gain).
- A freeze watchdog: four seconds without a new frame returns to the live edge;
  if that does not help, it reconnects with a fresh playlist (up to three times).
  Playback that drifts more than six seconds past its target catches up.
- The previous Streamlink → FFmpeg → CPU-image player remains a compatibility
  fallback. Use `cargo run -- --cpu-video --play <channel>` to compare it explicitly.
  Its Windows Job object still stops all helpers when playback closes or the app
  is killed. The GPU path uses one job-managed Streamlink resolver warmed at
  launch, reusing its HTTP connections between channels. A bounded private pipe
  carries signed URLs; cancellation and worker failure retain a CLI fallback.
- Live Twitch chat with correctly cased display names, name colors, badges when
  signed in, native Twitch emotes and 7TV/BTTV/FFZ channel/global emotes. GIF and
  WebP animations retain their frame timing. Native emote ranges respect Unicode.
  Chat reconnects automatically and applies message deletion, timeout/ban and
  room-clear events. The virtualized list keeps at most 500 messages; scrolling
  up pauses following and offers a Jump to live button.
  Emotes reserve their layout space before image download; image completion
  repaints without resetting the list. Provider dimensions preserve wide emotes,
  and a displayed message retains its geometry through image eviction/retry.
- A searchable emote picker and a native text composer with selection, clipboard,
  Unicode editing and IME support. Sign in to send through Twitch's official chat
  API. The picker includes the account's available native emotes, including
  subscriber emotes and the current room's follower emotes. Sending requires an
  explicit Enter or Chat action; failed sends preserve the draft.
- Fullscreen, theater mode, hideable sidebar chat and translucent chat over the
  video. Pause/resume, mute, a draggable volume slider and Go live sit in a control
  overlay that hides after inactivity and stays visible while hovered or paused.
  Double-clicking the video toggles fullscreen. Resuming GPU playback returns to
  the live edge; Go live explicitly seeks there.
- Electron's top bar: Home and Browse, a search box with a dropdown as you type
  (go to the typed channel, matching categories, matching channels with live
  state, viewers and uptime) and a results page on Enter, the account chip with
  sign-out, and settings. Signed out, Enter opens a typed channel login directly.
- Browse: Twitch's top categories with live viewer totals (anonymous GraphQL,
  as in Electron), category search as you type, each category's live streams,
  and Load more. Home and stream cards carry the language and tag chips.
- The UI uses the Electron client's logo, Lucide geometry, OLED/dark colors,
  30 px title bar, 68 px navigation, 244 px followed rail and compact icon controls.
  Stream title/category/viewers/uptime share a 54 px header aligned with chat.
  The rail can collapse, including automatically in narrow windows. Controls
  adapt to the actual video pane width instead of the whole window width.
- Chat has inline text/emote/badge layout, aspect-correct emotes, safe URL clicks,
  7TV zero-width layers, colored `/me` text, first-time chatter and mention
  highlighting, local timestamps, subscription notices and reply previews.
  Hover to reply; right-click to copy a message, reply or open a profile.
  Reply sends use Twitch's parent-message field and preserve drafts on failure.
- Recent chat uses the same optional public log sources as Electron, without
  account credentials. History and live messages merge by ID/time. History
  loading is cancelled on racing moderation events so it cannot restore a
  message a moderator has just removed. Unavailable history does not block IRC.
- The emote picker has provider filters and a virtualized grid for the complete
  set. Only visible thumbnails load, as stills; message emotes retain animation.
  Sorting/filtering is cached and image requests reuse HTTP connections.
- Native settings cover OLED, timestamps, chat text/emote size, recent-message
  count, sidebar width, overlay opacity and control hide delay. Visual preferences
  initially import from Electron's `twitch-windows-viewer/preferences.json`;
  Rust saves independently in `%APPDATA%/VioletWireRust/preferences.json`.
  The old preference file is never written. Volume and rail collapse also persist.

`cargo run -- --play <channel>` opens a channel at launch without signing in,
which is handy for working on playback.

### Player shortcuts

| Key | Action |
| --- | --- |
| F / F11 | Toggle fullscreen |
| Escape | Exit fullscreen |
| T | Toggle theater mode |
| C | Show/hide chat |
| O | Switch sidebar/overlay chat |
| Space | Pause/resume |
| M | Mute/unmute |
| Up / Down | Adjust volume by 5% |
| G | Return to live |

Player letter/volume shortcuts are suppressed while typing in the channel field,
composer or emote search. F11 and Escape remain available. Fullscreen hides the
title/navigation bars; chat can stay beside the video, overlay it, or be hidden.

Chat reads use anonymous, certificate-verified TLS IRC; account tokens never go
to IRC or third-party emote providers. Authenticated chat sends, badges and account
emotes use fixed Twitch Helix endpoints with bearer headers. Chat images use an
exact HTTPS CDN allowlist with redirects disabled. Downloads are capped at 512 KiB,
65,536 pixels per frame (up to 1,536×256 for wide emotes), 120 frames and 2 MiB decoded per emote (longer animations become a
still). The per-chat cache holds at most 160 images and 32 MiB of decoded pixels,
with four image workers. Eviction/channel close removes their atlas entries.
Pending downloads carry a cache generation, so an evicted request cannot
overwrite a newer entry. Failed downloads back off before retry; readable emote
codes remain in the message when an image is unavailable.

## Layout

| Rust module | Role | Electron counterpart |
| --- | --- | --- |
| `app/src/main.rs` | App start, window | `src/main/index.ts` |
| `app/src/root.rs` | Title bar, sidebar, Home grid, sign-in screens | `App.tsx`, `WindowControls.tsx` |
| `app/src/session.rs` | Restore / renew / sign-out / followed load (blocking, run off the UI thread) | `twitch-service.ts` (session parts) |
| `app/src/twitch/auth.rs` | Device flow, refresh, validate, revoke | `twitch-service.ts` (auth parts) |
| `app/src/twitch/helix.rs` | Helix followed channels, streams, users | `twitch-service.ts` (Helix parts) |
| `app/src/twitch/token_store.rs` | Credential Manager storage | Electron `safeStorage` token file |
| `app/src/images.rs` | CDN image download for GPUI | `emote-image-store.ts` (later) |
| `app/src/chat/` | TLS IRC, moderation events, bounded emote cache, picker/composer, Helix sends | Chat services and chat views |
| `app/src/input.rs` | Native Unicode text input and clipboard/IME handling | React inputs |
| `app/src/ui.rs`, `app/assets/` | Shared buttons, tooltips and embedded Lucide/logo assets | Lucide React, controls and tooltip CSS |
| `app/src/settings.rs`, `app/src/preferences.rs` | Native settings and separate visual preference persistence | Preferences service and settings views |
| `app/src/player.rs` | Video view; redraws only when a frame is due | `HlsNativeVideo.tsx` |
| `app/src/playback/` | Streamlink → FFmpeg pipeline, audio clock, sound output, process job | `hls-native-player.ts`, hls.js |
| `app/src/theme.rs` | Colours and fonts | `styles.css` |

Network calls use blocking `ureq` on GPUI's background executor. The UI thread
never waits on the network.

## Roadmap

1. **Channel extras.** Channel pages and picture-in-picture.
2. **Playback parity.** LL-HLS parts in the relay; see the next section.
3. **Advanced chat.** Moderation commands, room modes, editable emote
   chips in the composer, rich selection and pop-out windows. The live reader,
   history, regular/layered emotes, picker, replies, mentions, timestamps, sending
   and basic moderation events work now.
4. **Multistream.** Up to four tiles with the same resource clean-up rules as
   `MultiStreamManager`.
5. **Kick, link previews, the remaining settings, updates and packaging.**

## Playback design

GPUI has no video element. Its macOS `surface()` element draws a CoreVideo
buffer, but on Windows 0.2.2's DirectX renderer leaves `draw_surfaces` empty.
This workspace now patches GPUI 0.2.2 locally to draw
Windows GPU textures; see [the patch notes](vendor/GPUI-PATCH.md).
Remaining pieces to port from Electron:

- **Lower-latency delivery**: short ordinary TS segments are implemented as an
  opt-in experiment; fMP4 subdivision and a satisfactory startup/settling policy
  remain. The Rust relay has stable numbering, ad filtering and key-frame start. Media Engine
  ignores `EXT-X-START`; it always begins at the first listed segment, which is
  what the relay's trimmed first response relies on.

What is new is getting decoded frames onto the screen:

| Option | How | Trade-off |
| --- | --- | --- |
| A. CPU frames | Decode (FFmpeg or Media Foundation), convert to BGRA, hand GPUI a new `RenderImage` per frame | Works on stock GPUI. About 500 MB/s of uploads at 1080p60, and four tiles would be heavy. Good for a first spike. |
| B. GPU surface in a GPUI fork (implemented) | Windows Media Engine decodes and GPU-converts video into a reusable BGRA texture on GPUI's D3D11 device; GPUI samples it directly | No CPU readback/upload; one GPU video-processing blit remains. Requires the local GPUI patch. |
| C. DirectComposition visual | Put a video swap chain or `MediaPlayer` surface in GPUI's DComp tree | Native compositing, but it needs the same fork. UI drawn over the video (controls, tooltips) needs care. |
| D. WebView2 + hls.js | Embed the existing `HlsNativeVideo` in a WebView2 child | Fastest way to reuse today's player. It brings back a browser engine, which undercuts the rewrite. |

libmpv stays retired.

**Original baseline:** option A (see `playback/pipeline.rs`). Other GPUI projects do the
same on Windows: [gpui-video-player](https://lib.rs/crates/gpui-video-player)
(GStreamer) and Zed's screen sharing both push frames through GPUI's image atlas.

Measured on 2026-11-12, both apps playing summit1g at 1080p60 at the same time.
Release build, RTX 5070 Ti, 15-second sample. CPU is the share of one core;
memory is private memory:

| | CPU | Memory |
| --- | --- | --- |
| Electron VioletWire (hls.js, Chromium GPU decode) | 42% | 736 MB |
| Rust, option A (FFmpeg → BGRA frames → atlas) | 135% | 882 MB |

Option A proves the chain, but it is about 3× Electron's CPU. Chromium keeps
decoded frames on the GPU. Option A has the GPU decode a frame, then copies it to
the CPU, converts it to BGRA, sends it through a pipe and uploads it again:
roughly 500 MB/s of copying at 1080p60. Redrawing only when a frame is due
already cut the app's own share from a full core to 12% on a 30 fps stream.

## GPU-surface implementation and measurements

Option B is now the default. It uses Windows Media Engine frame-server mode,
`MF_MEDIA_ENGINE_DXGI_MANAGER`, `OnVideoStreamTick`, and `TransferVideoFrame`.
The device manager uses GPUI's own multithread-protected D3D11 device. A single
BGRA texture and shader view are reused until resolution/device changes. Only a
new decoder frame notifies the player view. Native audio and video share a clock.
Shutdown stops the media engine before releasing its surfaces/device references.

This removes CPU frame copying and the separate FFmpeg process. It still performs
one GPU color-conversion blit, so calling it literally zero-copy would be misleading.
The actual renderer changes are listed in [GPUI-PATCH.md](vendor/GPUI-PATCH.md).

A new release-build comparison on 2026-11-12, summit1g, sequential 35-second
hidden/muted **video-only probes**, with 10 seconds warmup and a 15-second steady
sample. CPU and private memory include each probe's descendant processes:

| Path | CPU (% of one core) | Private memory | Steady processes |
| --- | ---: | ---: | ---: |
| Old Rust CPU frames / FFmpeg | 81.9% | 939.0 MiB | 5 |
| Native GPU surfaces | 2.7% | 210.2 MiB | 1 |

The GPU probe transferred 1,782 frames, approximately 60 fps after startup.
An additional UFDTech probe transferred 363 frames at 1920×1080 in 20 seconds
(including startup), also without CPU frame uploads.
These results show a substantial improvement over the old Rust video path.
They are **not a new apples-to-apples comparison with the full Electron client**:
the probe omits sidebar/auth/chat, GPU memory is excluded, and the older Electron
numbers above came from a different run. Full-app CPU, total GPU memory, live
latency, audio synchronization and visual quality still need a paired review.
The existing Electron ad filtering and custom LL-HLS relay are not ported by this
change; Media Engine currently consumes the resolved upstream playlist directly.

### Reproduce

```powershell
cd rust
cargo build --release
# Normal player (no automation or desktop input):
cargo run --release -- --play summit1g
# Old path, for comparison:
cargo run --release -- --cpu-video --play summit1g
# Bounded, hidden, muted probe. Nonzero exit if no frames played:
.\target\release\violetwire.exe --play summit1g --video-probe-seconds 35 --mute-video
# Measures only the process trees it starts, never kills by program name:
.\scripts\benchmark-video.ps1 -Channel summit1g
cargo test
cargo clippy --all-targets -- -D warnings
```

The GPU probe never silently changes to the CPU backend. Normal playback can
fall back if native media playback fails; the reason is printed without a stream
URL. Probe logs are under `target/video-benchmark`. Signed media URLs stay on the
private lookup stdout pipe/in memory and are not logged or placed in argv.

### Chat/UI validation

```powershell
# Public read-only chat check (counts only; never logs message bodies):
.\target\release\violetwire.exe --play summit1g --chat-probe
# Compare the previous CLI lookup with three warm lookups (timings only):
.\target\release\violetwire.exe --play ufdtech --resolver-probe
# Hidden, muted complete UI check; no desktop input or chat sends:
.\target\release\violetwire.exe --play summit1g --ui-probe-seconds 30 --mute-video
# Save the test window's own render target (no desktop screenshots/input):
.\target\release\violetwire.exe --play summit1g --ui-probe-seconds 47 --mute-video --ui-snapshot-dir target/ui-check
# Check compact layout at 760x480 logical pixels:
.\target\release\violetwire.exe --play summit1g --ui-probe-seconds 15 --ui-probe-small --mute-video --ui-snapshot-dir target/ui-small
```

The UI probe exercises sidebar/overlay chat, the emote picker, theater and the
fullscreen **layout**, settings and reply menus without changing desktop window
state. Settings/menu stages run in the extended 47-second snapshot check. It exits nonzero
unless caption hit testing permits native dragging/buttons, video frames,
a connected chat, emote metadata and a usable chat viewport
were observed. It renders at a bounded 10 Hz, so its frame count is not an FPS
benchmark. Normal playback remains paced by display/decoder frames.

An anonymous UFDTech resolver check measured the old CLI at 2,433 ms and reused
worker lookups at 734 and 606 ms. The first lookup in that worker took 1,870 ms;
warming Python at launch does not eliminate Twitch's first network handshake.
A separate fresh-launch UI probe resolved in 2,128 ms and displayed its first
GPU frame at 3,795 ms. These are individual live-network samples, not guaranteed
startup times. Probe diagnostics report lookup and first-frame times separately.

Snapshots explicitly read the **test window's** render target back to CPU memory
only when `--ui-snapshot-dir` is supplied with a UI probe. Normal rendering and
playback do not use this path. Hidden probe windows are explicitly sized because
GPUI's Windows implementation otherwise defers placement until a window is shown.
The resize operation preserves desktop focus and window stacking.

Embedded icon assets include Lucide's ISC license. Regenerate them from the
Electron dependency and existing logo with `node rust/scripts/sync-ui-assets.mjs`
from the repository root.

Live reads and image downloads have been exercised together with GPU video.
Sending is implemented against Twitch's documented API but live message sends
are deliberately excluded from automated checks. Physical fullscreen transitions,
IME composition and pointer interactions still need hands-on review. This is a
Twitch UI increment; Kick and full Electron feature parity remain on the roadmap.
