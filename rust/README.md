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
- Images are loaded only from `static-cdn.jtvnw.net` over HTTPS. Their format is
  checked from their bytes, and each one is capped at 4 MB.

Clicking a channel opens it on twitch.tv for now. In-app playback is the next
big piece of work (see below).

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
| `app/src/theme.rs` | Colours and fonts | `styles.css` |

Network calls use blocking `ureq` on GPUI's background executor. The UI thread
never waits on the network.

## Roadmap

1. **Browse.** Categories (with the viewer totals), a category's streams,
   search, channel pages, and React-style tooltips as a GPUI tooltip view.
2. **Playback.** The hard part; see the next section.
3. **Chat.** Twitch IRC over WebSocket, Twitch/7TV/BTTV/FFZ emotes and badges,
   sending, replies, mentions and moderation actions. GPUI can play animated GIF
   and WebP frames. It cannot decode AVIF, so 7TV's WebP variants would be used.
4. **Multistream.** Up to four tiles with the same resource clean-up rules as
   `MultiStreamManager`.
5. **Kick, link previews, settings, updates and packaging.**

## Playback design

GPUI has no video element. Its macOS `surface()` element draws a CoreVideo
buffer, but on Windows 0.2.2's DirectX renderer leaves `draw_surfaces` empty.
The parts that are not tied to Electron carry over unchanged in design:

- **Streamlink** resolves the authenticated playlist through the same warm
  worker pipe. It is spawned with an argument array, never through a shell.
- **The relay logic**: ad filtering, LL-HLS parts, keyframe-safe cuts,
  `EXT-X-START`, and the lessons in the engine notes. With the player in the same
  process, this no longer needs a localhost HTTP server. Segments can go
  straight from the relay to the decoder.

What is new is getting decoded frames onto the screen:

| Option | How | Trade-off |
| --- | --- | --- |
| A. CPU frames | Decode (FFmpeg or Media Foundation), convert to BGRA, hand GPUI a new `RenderImage` per frame | Works on stock GPUI. About 500 MB/s of uploads at 1080p60, and four tiles would be heavy. Good for a first spike. |
| B. GPU surface in a GPUI fork | Implement `draw_surfaces` for D3D11 NV12 textures from a hardware decoder (FFmpeg `d3d11va` or the Media Foundation H.264 MFT), on GPUI's own D3D11 device | Zero-copy and the right long-term answer. It means keeping a small fork of GPUI's Windows renderer. |
| C. DirectComposition visual | Put a video swap chain or `MediaPlayer` surface in GPUI's DComp tree | Native compositing, but it needs the same fork. UI drawn over the video (controls, tooltips) needs care. |
| D. WebView2 + hls.js | Embed the existing `HlsNativeVideo` in a WebView2 child | Fastest way to reuse today's player. It brings back a browser engine, which undercuts the rewrite. |

libmpv stays retired.

**Proposed path:**

1. Spike A with FFmpeg (`libavformat` + `d3d11va`, frames copied back to the
   CPU) to prove the relay → decode → GPUI chain, audio through WASAPI and A/V
   sync on the audio clock.
2. Then build B, so tiles and 1080p60 stay cheap.
