# Changelog

All notable changes to VioletWire are documented in this file.

## [Unreleased]

## [0.3.0-alpha.1] - 2026-07-18

### Additions

- Added an embedded Native playback backend that renders libmpv through
  Electron's shared D3D11 texture pipeline, keeping video and React controls,
  menus, chat, and overlays in one composited window.
- Added GPU-accelerated OpenGL rendering for embedded Native playback, with
  orientation correction, bounded frame transport, renderer recovery, and the
  existing external-window Native backend retained as a fallback.
- Bundled the Windows texture-player addon and its required libmpv runtime into
  packaged builds so the embedded backend is available after installation.
- Made Native playback and the embedded renderer the defaults for new
  installations while keeping the official Twitch Standard player available.
- Added clickable Twitch reply threads that show retained conversation context,
  badges, emotes, timestamps, and reply actions in side and overlay chat.
- Added timeout and permanent-ban handling with a persistent choice between
  revealable placeholders and dimmed moderated messages.
- Replaced native browser tooltips with a consistent app-wide React tooltip
  layer that works above the embedded player.
- Added Twitch stream tags to followed-live and category stream cards.
- Added an in-app changelog viewer beside update controls, with an automatic
  once-per-version What's New popup after an update.

### Fixes

- Fixed Native overlays, quality menus, fullscreen chat, and keyboard shortcuts
  freezing or disappearing over video, and added M as the mute shortcut.
- Improved embedded-player startup so the player surface appears immediately
  while libmpv initializes, and restored controls after optimistic mounting.
- Hardened embedded playback against transient shared-texture import failures,
  stale frames, renderer-surface replacement, rapid channel switching, and
  resize-related white or black frames.
- Fixed the embedded video orientation and reduced CPU usage by replacing the
  software rendering path with the GPU-backed OpenGL bridge.
- Restored Native control visibility and five-second mouse-idle auto-hiding,
  including over fullscreen chat overlays and player menus.
- Fixed Standard fullscreen recovery so Escape and F11 cannot leave the app
  trapped in Chromium's HTML fullscreen state.
- Fixed missing Twitch badges by retrying multiple official CDN image sizes and
  hiding assets cleanly when every variant fails.
- Improved emote startup by loading 7TV, FrankerFaceZ, and BetterTTV
  independently, preserving provider priority, and lazily loading picker images
  below the visible rows.
- Fixed malformed Twitch emote-owner identifiers preventing otherwise valid
  badges and emotes from loading.
- Fixed small provider emotes being enlarged to the normal emote height.
- Fixed chat reply previews, deleted-message explanations, event-card hover
  styling, and Scroll to current positioning as the composer changes height.
- Fixed custom tooltips disappearing whenever live chat generated a scroll
  event; tooltips now remain attached to their hovered or focused controls.
- Fixed category pages failing when Twitch returns a null stream-tags field.
- Made Standard playback retry its initial play request and recover from
  Chromium blocking audible autoplay.
- Added a Twitch access refresh action so newly requested permissions, including
  user emotes, can be authorized without first deleting the existing session.
- Tightened the Twitch subscription drawer, removed overlapping website
  navigation, and constrained tall drawers to their internally scrollable
  content area.
- Applied the VioletWire icon to authentication, Twitch action, and detached
  control windows instead of Electron's default icon.
- Added loading and open states to the Subscribe button and delayed the
  subscription drawer reveal until Twitch's panel has rendered.
- Kept the Subscribe star unfilled while its drawer is merely open, reserving
  the filled state for a confirmed active subscription.

## [0.2.0-alpha.1] - 2026-07-17

### Additions

- Added FrankerFaceZ and BetterTTV global and channel emotes alongside Twitch
  and 7TV emotes.
- Added provider-aware emote rendering, rich emote previews, provider logos,
  animated variants, and support for FFZ and BetterTTV modifier effects.
- Redesigned the emote picker with resizing, favorites via Alt+Click, provider
  navigation, global and channel groups, unified search, and predictable
  progressive loading.
- Added official Twitch chat replies, reply context previews, and reply-thread
  metadata.
- Added username and emote autocomplete with mouse, keyboard, and Tab
  selection.
- Added subscription, resubscription, gift, raid, and other Twitch chat
  notices.
- Added clickable HTTP, HTTPS, and common bare-domain links that open safely in
  the system browser.
- Added mention highlighting and an optional mention notification sound.
- Added persistent chat font size, emote size, timestamps, history length,
  overlay transparency, chat-side placement, OLED mode, and audio-compression
  preferences.
- Added a settings modal that keeps the current stream open in the background.
- Added richer stream metadata with clickable categories, language, tags,
  subscription state, and channel details.
- Added a resizable native-player chat overlay and improved parity between the
  Standard and Native player chat experiences.
- Added project screenshots and expanded feature documentation.
- Licensed VioletWire-authored source under GPL-3.0-or-later and documented
  bundled third-party software and assets separately.

### Fixes

- Fixed player-mode and chat preferences not surviving application restarts.
- Fixed the Standard player opening paused and improved reuse of the
  authenticated Twitch playback session.
- Fixed chat autoscroll moving while the user reads older messages, including
  when bounded history removes old entries.
- Fixed duplicated chat messages and reduced unnecessary chat asset and emote
  fetching.
- Fixed slow or out-of-order emote loading with cached, deduplicated provider
  data and deterministic rendering.
- Fixed emote replacement spacing, URL parsing, wide emotes, and modifier
  emotes rendering as standalone images.
- Fixed native-player overlay ordering and bounds for the emote picker, search
  results, settings, and other application surfaces.
- Fixed emote and settings menus remaining open after clicking elsewhere.
- Fixed chat shortcuts activating while modifier keys are held, including
  Ctrl+C.
- Fixed OLED-mode hover states and improved chat-row hover and reply controls.
- Fixed native-player control and overlay positioning across resizing,
  fullscreen, and chat layout changes.
- Improved shutdown and IPC safeguards to avoid destroyed-window and broken-pipe
  errors.

## [0.1.0-alpha.1] - 2026-07-17

### Additions

- Initial public alpha release of VioletWire.
- Added Twitch authentication, followed streams, category browsing, Standard
  Twitch playback, experimental Native playback, native chat, and 7TV emotes.
- Added Windows packaging, bundled Streamlink and mpv runtimes, and GitHub
  release-based automatic updates.

### Fixes

- Fixed the packaged Standard player session and initial release startup.
