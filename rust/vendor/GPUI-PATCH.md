# GPUI Windows video surface patch

`gpui/` is the crates.io GPUI **0.2.2** source distribution, licensed under its
included Apache-2.0 license. Upstream metadata records Zed revision
`69e2130295c2649963eb639fc70b4f2ee8ea1624` (published from a dirty tree).
The workspace's `[patch.crates-io]` selects this local copy. The Cargo registry
cache is never modified.

Local changes are restricted to:

- `src/elements/surface.rs`: retain a shader-readable BGRA D3D11 texture and its
  SRV; reject incompatible layouts. Preserve aspect ratio through ObjectFit.
- `src/scene.rs`: retain the texture in Windows surface primitives.
- `src/platform.rs`, `src/platform/windows/window.rs`, `src/window.rs`: expose
  the window's render device and insert GPU surfaces using the normal clip mask
  and scene order. Add an offscreen render entry point for the bounded probe.
- `src/platform/windows/directx_renderer.rs`: draw each surface with the existing
  polychrome shader, binding the texture directly without an atlas upload.
  Unbind both vertex/pixel SRVs before the decoder writes the next frame.
- `src/platform/windows/directx_devices.rs`: prefer a video-capable device,
  retaining upstream device creation as a fallback on older adapters.
- `src/window.rs` (`on_request_frame`): when a frame is requested while the app
  is already inside an update, keep the `on_next_frame` callbacks for the next
  frame instead of dropping them. Media Engine's COM calls (mute, volume,
  start-up) pump messages on the UI thread, so a frame can be requested from
  inside a click handler. Upstream lost the callbacks silently, which ended the
  player's per-frame poll: the picture froze while the sound kept playing.

No new shaders or dependency versions are needed. The video engine and renderer
share a multithread-protected device. Texture ownership is checked, and the app
discards/recreates video surfaces when GPUI replaces the device.

This is **not literally copy-free**: Windows performs a GPU video-processing
blit into a reusable BGRA render texture. It removes application CPU readback,
BGRA frame pipes, and GPUI image-atlas uploads. No staging texture is used by the
playback path. Resolution changes recreate the texture/SRV; normal frames reuse
them. Native audio and video timing stay together in Windows Media Engine.

The UI validation path can explicitly capture the renderer's own BGRA target to
RGBA bytes for PNG snapshots. It uses one staging texture **only on a requested
probe snapshot**, never during normal video/UI rendering and never to capture
the desktop. The app's `--ui-snapshot-dir` option is limited to its hidden UI
probe. Windows programmatic resize also retains focus/z-order, allowing accurate
compact-layout probes without activating their hidden windows.
Capture repaints the current scene and reads before `Present`; flip/discard
swapchain contents cannot be relied upon after presentation. Normal draws use
the same scene helper and then present, without any readback.

Custom caption hit testing now queries the current native pointer position
instead of using the preceding mouse event's cached hit test. The rendered
caption lookup and input-dispatch result are public so the hidden UI probe can
verify caption routing without desktop input. VioletWire's drag region occludes
the root focus listener, which otherwise prevents Windows' default drag action.
