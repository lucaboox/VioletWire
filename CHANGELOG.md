# Changelog

All notable changes to VioletWire are documented in this file.

## [Unreleased]

### Additions

- Added Twitch stream tags to followed-live and category stream cards.
- Added an in-app changelog viewer beside update controls, with an automatic
  once-per-version What's New popup after an update.

### Fixes

- Fixed category pages failing when Twitch returns a null stream-tags field.
- Made Standard playback retry its initial play request and recover from
  Chromium blocking audible autoplay.
- Added a Twitch access refresh action so newly requested permissions, including
  user emotes, can be authorized without first deleting the existing session.

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
