# Changelog

All notable changes to VioletWire are documented in this file.

## [Unreleased]

## [0.3.4-alpha.3] - 2026-07-30

### Additions

- Kick clip links now show rich hover previews with the clip thumbnail, title,
  channel, duration, views, and creation date. Both current and legacy Kick
  clip URL formats are supported.
- Direct Imgur image links and Imgur album links now show image previews when
  hovered in chat.

### Improvements

- Sent Twitch messages now appear immediately in regular and multistream chat,
  then update with Twitch's authoritative badges, colors, emotes, and reply
  metadata without creating a duplicate.
- Picture-in-picture now sits directly before Theater mode, while overlay-chat
  scrollbars reserve their space without shifting messages when hovered.
- The followed-channel sidebar is controlled consistently by its saved collapse
  button instead of silently collapsing when the window is resized.
- VioletWire now keeps a usable minimum window width that scales consistently
  with Windows per-monitor display scaling.

### Fixes

- Links inside Twitch pinned messages are now clickable, open safely in the
  default browser, and use the same hover previews as normal chat links.
- The centered search bar now switches to a collision-safe responsive layout
  before it can overlap navigation, playback, multistream, or account controls.

## [0.3.4-alpha.2] - 2026-07-29

### Additions

- Efficient HLS playback now includes Chromium picture-in-picture support with
  a dedicated player control and live-edge synchronization when playback
  resumes.
- Windows taskbar previews now provide Play/Pause and Mute/Unmute controls for
  Native playback, with icons that stay synchronized with the current state.
- Middle-clicking a passive video surface now toggles mute in the main player,
  mini player, and multistream tiles.

### Improvements

- Multistream chat tabs use a more compact connected layout, distinguish
  Twitch and Kick status and active audio, and show bounded stream-detail
  tooltips without overflowing the window.
- Stream uptime now updates every second without forcing the channel grid to
  rerender.
- Username autocomplete always includes the broadcaster, retains up to 2,000
  recently observed chatters per channel, and renders recognized mentions in
  bold.
- Paused HLS playback keeps the displayed frame stable and resumes at the
  current live edge instead of briefly replaying stale buffered video.
- Picture-in-picture uses Chromium's stable native video path, avoiding the
  Electron crash caused by the experimental document-based implementation.

### Fixes

- Community gift bombs now appear as one summary card instead of filling chat
  with a separate card for every recipient; standalone gift notices remain
  visible.
- Resubscription and renewal message cards now show the sender's badges in
  both regular chat and the fullscreen chat overlay.
- Explicitly paused HLS streams are no longer restarted by manifest refreshes,
  media recovery, or other background playback events.
- Native HLS connection messages no longer incorrectly refer to mpv.
- Followers-only warnings no longer flash while VioletWire is still resolving
  the viewer's follow status after switching channels.

## [0.3.4-alpha.1] - 2026-07-26

### Additions

- Native playback now includes an Efficient HLS backend that sends
  Streamlink-resolved Twitch and Kick streams through Chromium's
  hardware-accelerated video pipeline while retaining VioletWire's controls,
  overlays, quality selection, and audio features.
- Efficient HLS uses a low-latency live profile by default and is available in
  multistream mode, where each tile receives an isolated playback session and
  audio focus.
- Chat settings now include Twitch's official username-color controls, with
  the standard color palette and custom hex colors for eligible Prime or Turbo
  accounts.
- Efficient HLS playback now has a compact Chromium video-statistics panel and
  a live latency gauge in the player controls.
- Twitch pinned chat messages can appear beneath the chat header with their
  sender, emotes, and a local dismiss control when Twitch authorizes the
  signed-in account to read the channel's current pin.
- Twitch sign-in now requests the permissions needed for the next moderation
  tools batch: moderated-channel discovery, bans and timeouts, message
  deletion, announcements, chat settings, warnings, and Shield Mode.

### Improvements

- The libmpv compatibility backend now uses the shared-texture Direct
  VideoFrame renderer as its single Windows presentation path. The separate
  mpv child window, transparent controls window, and ImageBitmap presentation
  option have been removed, reducing renderer-process memory use and
  eliminating native-window z-order workarounds.
- Efficient HLS uses platform-specific upstream request headers for Twitch and
  Kick and keeps the libmpv texture renderer as an automatic compatibility
  fallback when a stream cannot start through Chromium.
- The Chromium latency control now previews its compact playback statistics on
  hover, remains clickable for the persistent panel, and targets a closer live
  position without returning to the unstable one-segment buffer.
- The native graphics bridge now attempts to render directly into Electron's
  exported D3D11 texture. Drivers that cannot share the keyed texture through
  OpenGL automatically retain the compatible GPU-copy path, and video
  statistics report which texture bridge is active.
- Windows packages no longer include the unused standalone mpv executable;
  VioletWire now ships only Streamlink and the libmpv runtime used by Native
  playback.

### Fixes

- Native HLS no longer labels the normal live-sync distance as being behind
  live; the indicator now appears only after playback drifts materially beyond
  hls.js's current target latency.
- Chromium playback statistics now report the selected stream level's encoded
  bitrate instead of mistakenly displaying localhost relay throughput.
- Fast manual chat scrolling no longer competes with stale per-batch scroll
  anchors, and background latency-stat refreshes pause while reading older
  messages.
- Efficient HLS keeps playback at the source rate instead of accelerating
  video to chase small latency changes, while isolated chat scroll layers
  reduce video-compositor interference.
- Native player construction no longer reads playback preferences before the
  settings service has initialized, preventing an application-load failure.
- Native mute controls now move the displayed volume to zero and restore the
  previous audible level when unmuted, consistently across Efficient HLS,
  libmpv texture playback, mini-player, and multistream controls.
- Volume sliders now remain stable under the pointer while being dragged and
  avoid redundant mute-state commands during rapid volume changes.
- Efficient HLS is now the default Native backend for new installations;
  existing saved backend choices remain unchanged.
- Multistream now routes HLS commands and playback state to the correct tile
  instead of leaving tiles on the texture renderer.
- Removed Native and presentation preferences are migrated without discarding
  unrelated saved settings.
- Changelog entries now use semantic-version ordering, keeping multi-digit
  alpha versions such as alpha.10 above alpha.9.

## [0.3.3-alpha.12] - 2026-07-25

### Additions

- Playback settings now include an optional Direct VideoFrame presentation
  mode for embedded Native playback. It bypasses the intermediate ImageBitmap
  conversion while preserving quality selection, controls, fullscreen, chat,
  overlays, audio features, and multistream support.

### Improvements

- Native video statistics identify whether the active embedded presentation
  route is ImageBitmap or Direct VideoFrame, making the two modes easy to
  compare on systems affected by mixed-refresh frame limiting.

## [0.3.3-alpha.11] - 2026-07-25

### Additions

- VioletWire now remembers the main window's size, position, and maximized
  state between launches. Saved placement is constrained to connected displays
  so unplugging a monitor cannot leave the window off-screen.
- Native video statistics now separate frames delivered by mpv from frames
  actually presented to the embedded canvas, making display-pacing problems
  easier to identify.

### Improvements

- Embedded Native playback now converts one shared texture at a time and keeps
  only the newest waiting frame, reducing unnecessary GPU work and releasing
  superseded textures immediately.

### Fixes

- Embedded Native playback no longer discards a converted frame merely because
  a newer frame arrived while Chromium was processing it. This targets
  avoidable 60-to-30 FPS drops seen on some mixed-refresh monitor setups.

## [0.3.3-alpha.10] - 2026-07-25

### Additions

- The window-hosted Native player now reports its render path, decoder,
  display refresh, video output, dropped and mistimed frames, VSync jitter,
  buffer, and A/V synchronization in the existing video-statistics panel.
- The optional corner FPS counter now works with both the embedded and
  window-hosted Native players, making backend and mixed-refresh comparisons
  possible without leaving VioletWire.

### Improvements

- Window-hosted Native playback now explicitly uses mpv's D3D11 renderer and
  keeps its diagnostics visible after the rest of the player controls hide.

### Fixes

- The window-hosted Native player now retries placing mpv above its host after
  playback actually begins, reducing intermittent black video that previously
  disappeared only after restarting VioletWire.

## [0.3.3-alpha.9] - 2026-07-25

### Additions

- The Native player's video statistics now identify Chromium's preferred GPU,
  the D3D11 texture adapter, the OpenGL renderer, and both the requested and
  selected hardware decoder, making multi-GPU playback problems easier to
  diagnose.

### Fixes

- NVIDIA systems now select NVDEC from the graphics adapter the embedded player
  actually created. Previously, Chromium could report every adapter as inactive
  and make VioletWire unnecessarily fall back to `d3d11va-copy`, even while the
  Native renderer was running on an RTX GPU.

## [0.3.3-alpha.8] - 2026-07-24

### Additions

- A "Show FPS in the corner" option in the Native player's video stats. When on,
  the live frame rate sits at the top-left of the stream and stays visible while
  the controls fade, so a drop is easy to spot.

### Improvements

- Offline followed channels now dim their avatar and its service ring, so live
  channels stand out.

### Fixes

- The Native player's frame-rate reading now shows a real, live value that dips
  when frames drop, instead of staying at 0.

## [0.3.3-alpha.7] - 2026-07-24

### Additions

- The search box takes a `twitch:` or `kick:` prefix, which becomes a small
  service chip; pressing Enter then opens whatever name you type straight on that
  service — a quick jump to a known channel.

### Improvements

- Multistream tiles and chat tabs now show a small service logo and the plain
  channel name instead of a raw `kick:<name>` key.
- The multistream add box has a service toggle: click the logo to switch between
  Twitch and Kick, then add a channel by name on that service.
- The multistream chat tab bar is now the same height as the stream bar beside
  it, so their tops line up.
- In the collapsed followed list, a divider now separates live from offline and
  offline channels are dimmed a little more, so live ones read first.
- The subscribe modal opens centered on the app's own window instead of always
  the primary monitor.

### Fixes

- Kick chat now connects for Kick streams watched in multistream; previously each
  tile tried to join Twitch and a Kick tile's chat stayed empty.
- Kick sign-in is picked up on launch, so chat, following, and the Kick settings
  card no longer look signed out until the followed filter is switched to Kick.
- The console no longer fills with mpv/demuxer logging during playback, nor with
  repeated Twitch errors for Kick multistream tiles.

## [0.3.3-alpha.6] - 2026-07-24

### Additions

- Search has its own results page. Pressing Enter opens a full page of matching
  channels and categories, with "Go to <name>" shortcuts for opening an exact
  login on Twitch or Kick. The quick type-ahead dropdown stays for fast picks.
- Search now has its own Twitch/Kick/Both scope, separate from the followed
  list, and remembers it.
- Browse now covers Kick. A service toggle switches the directory between Twitch
  and Kick; Kick's categories and the live channels within one load without a
  Twitch account, highest viewer count first, and keep loading as you scroll.
- Search covers Kick categories too, so a query returns Kick categories
  alongside its channels; choosing one opens it in Browse on the Kick tab.

### Improvements

- The subscribe button opens a titled modal showing the channel's real subscribe
  page — Twitch or Kick, from that service's signed-in session — replacing the
  cropped drawer that broke whenever Twitch renamed a class.
- Search results group by service: the channel lists read "Twitch" and "Kick",
  the category lists read "Twitch Categories" and "Kick Categories", and the
  go-to shortcuts sit at the top.
- Kick search is capped to a shortlist like Twitch's rather than returning every
  match, so short queries no longer flood the results.

### Fixes

- The search page and the Browse service toggle now follow OLED mode instead of
  keeping a dark-grey background, and the selected service stays visibly purple
  in OLED.

## [0.3.3-alpha.5] - 2026-07-23

### Additions

- Added Kick.com alongside Twitch. Kick channels play in the Native player, and
  the header, viewer count, category, uptime, thumbnail, and offline state all
  read the same as a Twitch channel.
- Search now covers Kick. A selector by the search box chooses Twitch, Kick, or
  both, and each result is marked with the service it belongs to.
- Kick sign-in lives in Settings. Once signed in, your followed Kick channels
  join the sidebar, and the Both filter rings each avatar in purple for a Twitch
  follow or green for a Kick follow so the two stay legible when collapsed.
- Kick chat reads and sends, with history loaded on connect, Kick and 7TV emotes
  (grouped by set in the picker), and Kick's built-in badges — moderator,
  verified, VIP, sub gifter, and subscriber tiers — drawn from its own artwork.
- Following a Kick channel now works from the player, with a spinner while it is
  in flight and the button settling on the real follow state.

### Improvements

- The toolbar's open-in-browser, subscribe, and clip buttons follow the channel's
  service: on Kick they open the channel, its subscribe page, and its clip editor
  on kick.com. The emote picker and its tabs also name the right service.
- Chat shows when a channel restricts posting — followers-only, subscribers-only,
  slow mode, and the like — and blocks sending when it is certain a message would
  be refused.

### Fixes

- Fixed search hanging on "Searching Twitch…" when the filter was set to Kick
  only.
- Fixed the chat-on-left layout breaking after the title-bar changes.
- Fixed three errors logged every time a Kick channel loaded, from Twitch-only
  emote lookups being handed a Kick channel identifier.

## [0.3.3-alpha.4] - 2026-07-22

### Additions

- Added a video stats panel to the Native player, opened from an info button in
  the player controls. It reports resolution, frame rate, codec, hardware
  decoder, bitrate, dropped frames, buffer, and A/V sync, read live from the
  player while the panel is open.
- Added a title bar of VioletWire's own in place of the system one. It follows
  OLED mode and names where you are, showing Home, Browse, the category you are
  browsing, the channel you are watching, or Multistream.

### Improvements

- Updates now install silently. Choosing Restart applies the update in a few
  seconds and reopens VioletWire instead of running the installer again.
  Per-machine installations still show a Windows elevation prompt.
- The stream picture is noticeably sharper above 100% display scaling. Video is
  now rendered at the display's real pixel count rather than being drawn smaller
  and scaled back up, and downscaling to smaller windows uses a filter matched
  to the scale instead of discarding most of the source.
- Theater mode floats the channel information over the video and fades it with
  the player controls, so the picture fills the height.
- Chat now runs the full height of the page rather than starting below an empty
  strip, and its header lines up with the player toolbar.
- Player toggles show their state in the icon rather than tinting the button
  purple, so the audio compressor, chat overlay, and theater each read at a
  glance.
- The chat layout menu is now a single button that turns the overlay on and off.
  Hiding chat entirely is unchanged, from the toolbar button or the C shortcut.
- Settings dialogs dim the window instead of blurring it, which the system
  window buttons could not follow.

### Fixes

- Fixed the chat-on-left layout putting chat in the wide column and squeezing
  the video into the narrow one.
- Fixed the chat-on-left header controls, sidebar collapse, restore-chat tab,
  and chat settings panel opening on the wrong side or off screen, and restored
  the app name hidden behind the top bar in that layout.
- Fixed the audio compressor icon shifting slightly when toggled.

### Additions

- Added native Unicode emoji to the emote picker, organized into familiar
  categories with a compact skin-tone selector. Emoji data is cached locally,
  and unsupported characters are filtered against the installed Windows emoji
  font so blank or broken glyphs are not offered.
- Added a saved globe toggle to search every emote provider at once. Search
  results remain grouped by their useful subcategories, including channel,
  global, event, and native emoji groups.

### Improvements

- Native emoji categories now load as they approach the visible area, keeping
  the complete catalog available without mounting thousands of emoji at once
  or making picker resizing sluggish.
- Pressing Tab after an emote name now starts completion and repeatedly pressing
  Tab cycles through matching emotes. Exact matches are prioritized, and Tab no
  longer unexpectedly moves focus to another chat control when nothing matches.
- Ctrl-clicking an emote inserts it while keeping the picker open; Alt-clicking
  still toggles favorites. Their tooltip now presents both shortcuts on clear,
  separate lines.
- Emotes inserted into the composer now match the configured chat emote size.
- Twitch account-wide and event emotes are grouped into meaningful sections
  instead of appearing as fake channel-owned collections.
- The VioletWire website now reads the latest version and download totals from
  GitHub, and its main Windows download button links directly to the newest
  installer.

### Fixes

- Kept Twitch and native emoji category icons at a consistent size when the
  picker is shortened, and removed the unwanted horizontal category scrollbar.
- Prevented Alt-clicking an emote from revealing Electron's default
  File/Edit/View application menu.

## [0.3.3-alpha.2] - 2026-07-21

### Additions

- Added a VioletWire project website and refreshed the README with current
  screenshots, including the Multistream view, so new users can see the app
  before installing it.

### Improvements

- The global search field now keeps the text you entered when you open a
  stream, rather than replacing it with the selected channel's username.

### Fixes

- Kept the top app bar above sticky category headers while browsing, preventing
  category content from drawing over the navigation controls.

## [0.3.3-alpha.1] - 2026-07-21

### Additions

- Added favorite channels: right-click any followed channel to add or remove it
  from favorites. Favorites are marked with a star on their avatar and sort to
  the top of the Live and Offline groups, so a favorite that goes offline drops
  out of the way of channels that are actually live. Favorites are saved across
  launches.

### Improvements

- Chat emotes and badges are now cached per channel instead of being unloaded
  and refetched on every chat switch, and all multistream tile channels are
  warmed in the background when multistream opens. Switching a chat tab is now
  instant with the right custom emotes already loaded.
- Hiding chat no longer unmounts it, so bringing it back is instant instead of
  re-rendering the whole message list. It re-pins to the newest message on
  re-show if it was following live.
- Stopped two timers running when there was nothing to do: the multistream chat
  batch flush no longer ticks when multistream is closed, and the shared uptime
  tick (which re-renders the app) only runs while a stream is open or a
  followed channel is live.

### Fixes

- Fixed the followed-channel right-click menu closing itself a second after
  opening, caused by live chat's auto-scrolling triggering its close handler.

## [0.3.2-alpha.7] - 2026-07-21

### Additions

- Added multistream Theater mode and a Fullscreen button that hide the app
  sidebar and top bar so the stream grid and chat fill the window. Both toggle
  from the bar or with the T and F shortcuts.
- Added a per-tile volume slider and an audio compressor toggle to each
  multistream tile, alongside mute, matching the single player's audio
  controls.
- Kept every multistream tile's chat connected at once, each with its own
  buffered history, so switching chat tabs is instant and nothing is missed
  while a tab is in the background.
- Saved and restored the native player volume: each stream now opens at your
  last level instead of resetting to 100%.

### Improvements

- Multistream tile controls now auto-hide when idle and reveal on mouse
  movement, using the same auto-hide delay and cursor-hiding as the single
  player. The channel name moved to its own box at the top-left, with the
  active-audio dot always visible.
- Restyled the multistream top bar to match the single player toolbar — a back
  chevron, borderless hover buttons, and matching height — laid out as Add
  stream, Theater, Fullscreen, and Exit.
- Clicking a tile moves audio focus and switches its chat into view; the
  add-stream menu closes when clicking outside it.

### Fixes

- Fixed the multistream chat sometimes getting stuck "scrolled up" after
  switching tabs; it now only pauses on a deliberate scroll and shows the
  paused indicator like the main chat.
- Formatted chat timeout durations into readable units (for example "1m 30s"
  or "2d 2h") instead of a raw seconds count.
- The chat overlay button now toggles the overlay on and off instead of
  switching to the side layout when the overlay is already on.
- The followed-channels scrollbar now sits flush against the sidebar edge.

## [0.3.2-alpha.6] - 2026-07-20

### Additions

- Added Multistream: watch up to four native streams at once in a grid. Toggle
  it from the new Multistream button in the top bar, then add channels from
  your live followed list or by name. Two streams stack vertically and three or
  four use a 2×2 grid; tiles sit flush and theme to OLED mode.
- Added multistream audio focus: only one stream plays sound at a time — click
  a tile to move audio to it, and its bar marks the active stream.
- Added per-tile multistream controls in each tile's hover bar: mute a stream
  independently and change its resolution without affecting the others.
- Added a tabbed Stream Chat for multistream with a tab per stream. Selecting a
  tab, or giving a tile audio focus, switches the chat to that channel with the
  full message rendering, emote picker, chat settings, and user cards.

## [0.3.2-alpha.5] - 2026-07-20

### Additions

- Added rich hover cards for Twitch Clip links using Twitch's official clip
  metadata, including the thumbnail, title, broadcaster, duration, publish
  date, and view count.
- Added keyless YouTube hover cards with the video thumbnail, title, and
  channel name. Full YouTube statistics intentionally remain out of scope
  because they require a separate YouTube Data API key.
- Added a resizable side chat: drag its inner edge to set the width between
  300 and 620 pixels, double-click the handle to reset, and the width is
  saved and restored across sessions.
- Added a movable, resizable overlay chat for the Native player: drag its
  top bar to reposition it, drag the top-left grip to resize it (280–560
  wide, 200–1000 tall), and its position and size are clamped to the video
  area and remembered across sessions. Double-click to reset.
- Added a Settings control for how long the Native player controls stay
  visible before auto-hiding, adjustable from 1 to 10 seconds and saved
  across sessions.
- Added a four-sound mention alert picker (Ping, Chime, Pop, Knock) with a
  preview button, and raised the mention volume ceiling to 200% (default
  100%).
- Added the ability to collapse the followed-channels sidebar to icons.

### Improvements

- Moved the Native live indicator from a fixed corner into the control bar,
  left of the quality button, so it no longer sits underneath the overlay
  chat, and restyled it as a transparent label with a red live dot.
- Hide the mouse cursor over the Native player once the controls auto-hide in
  windowed mode as well as fullscreen, and hide the controls immediately when
  the pointer leaves the video for chat instead of waiting out the timer.
- Made the "Show stream chat" button match the "Hide chat" button size so the
  control no longer changes size when toggled.
- Open the emote picker at the user's saved size immediately instead of
  briefly showing the default size and then resizing.
- Made the pop and knock mention sounds noticeably louder so they are audible
  on small speakers.

### Fixes

- Make the “Open channel on Twitch” control launch the channel in the user’s default browser instead of VioletWire’s isolated action window.
- Treat expected 404 responses from 7TV, FrankerFaceZ, and BetterTTV channel-emote endpoints as an empty channel set instead of emitting Electron handler errors.
- Keep the Native player selected for offline channels, with VioletWire's own offline state and Retry control instead of replacing it with Twitch's Standard offline page.
- Removed the stray status dot from the Native offline screen and made its loading spinner easier to see.
- Keep the known channel avatar in the player toolbar while metadata loads, and label offline channels simply as “Offline.”
- Carry the selected channel’s display name and avatar from followed, browse, and search cards into the player immediately instead of briefly showing the lowercase login.
- Preserve that same identity when opening an exact channel match through Enter or the “Go to…” search action.
- Show the known viewer count and stream uptime from a selected live card immediately while Twitch metadata refreshes in the background.
- Show the known category, language, and stream tags immediately as a live card opens; category navigation activates once its Twitch ID is refreshed.
- Enriched live search results with viewer count, uptime, language, tags, and mature-state data using one batched Twitch stream lookup.
- Treat a GitHub release that is temporarily missing `latest.yml` while its
  assets are still uploading as a non-error update state instead of displaying
  an alarming updater failure.
- Ensure the automatic post-update changelog waits for fresh GitHub Release
  notes instead of briefly displaying a stale cached changelog.
- Ensure an explicit fresh changelog request cannot be satisfied by an
  in-flight cached request from app startup.
- Reliably detect offline channels even when Streamlink exits without any
  diagnostic output, so they stay on the offline surface instead of showing an
  "Embedded Native unavailable" notice and falling back to the window-hosted
  Native player.
- Read Streamlink's output on process close rather than exit so resolved
  stream URLs, quality lists, and offline error messages are captured
  completely instead of being intermittently truncated.
- Show a clear "stream ended" state over the Native player when a channel goes
  offline mid-broadcast, instead of freezing on the last frame, and recover
  automatically if the channel goes live again.
- Fixed the Native overlay chat settings so the panel is no longer part of the
  draggable title bar (settings stay adjustable), gave its Hide/Settings
  buttons top spacing, stopped clicks in the divider gaps above toggles from
  flipping them, and centered the toggle knobs so they no longer drift lower in
  fullscreen.
- Kept long chat tooltips on-screen without wrapping their text awkwardly near
  the window edge.
- Fixed the top-bar alignment when chat is placed on the left so the
  followed-channels header lines up with the account bar.

## [0.3.2-alpha.3] - 2026-07-19

### Additions

- Added Twitch-style rendering for chat `/me` action messages, including
  correct removal of IRC control bytes and colored action text.
- Added enlarged hover previews for chat badges and supported image links,
  including direct HTTPS images plus compatible Imgur and Gyazo image pages.

### Improvements

- Refresh the signed-in followed-channel list in the background and whenever
  VioletWire returns to the foreground, without surfacing transient refresh
  failures as disruptive notices.
- Improved emote hover cards so wide emotes stay contained and previews scale
  appropriately with the user's configured chat emote size.
- Keep chat-user-card message history pinned to the newest message unless the
  viewer deliberately scrolls upward.
- Improved the embedded Native player's Go Live behavior by reloading the
  current channel at the live edge instead of starving playback after a buffer
  drop.

### Fixes

- Prevented chat from pausing itself when late-loading emotes or layout reflow
  changes the scroll position; pausing now requires recent user scroll intent.

## [0.3.2-alpha.2] - 2026-07-19

### Additions

- Added versioned GitHub Release notes as the changelog viewer's primary
  source, with validated responses, a bounded local cache, and the bundled
  changelog retained as an offline fallback.

### Fixes

- Prevented automatic and manual update checks from opening duplicate restart
  prompts after the same installer has already downloaded.
- Fixed the in-app changelog viewer omitting every entry under Improvements.

## [0.3.2-alpha.1] - 2026-07-19

### Additions

- Added a persistent mention-sound volume control with an in-settings preview
  button, and replaced chat-setting checkboxes with clearer toggle switches.
- Added a large centered play control whenever Native playback is paused.
- Added a Twitch-style floating mini player while browsing, with draggable and
  resizable bounds, pause, mute, close, and click-to-restore controls.
- Added hover-intent stream pre-resolution so followed and browse cards can
  begin preparing Native playback before the channel is clicked.

### Improvements

- Reworked embedded Native channel and quality switching to reuse the healthy
  mpv process, D3D/OpenGL bridge, and shared-texture pool through mpv's
  `loadfile replace` path instead of starting an entirely new player.
- Made stream switches stop outgoing playback immediately, discard stale
  in-flight frames, suppress intentional end-of-file events, and report
  whether the active transition is changing channel or quality.
- Overlapped fresh mpv/addon initialization with Streamlink URL resolution,
  cached resolved URLs for 60 seconds with in-flight deduplication and bounded
  concurrency, and skipped unnecessary FFmpeg container probing for HLS.
- Unified side chat and Native overlay chat behind one feed engine for message
  batching, scroll pause/resume, bottom anchoring, history trimming, and
  deleted-message reveal state.
- Rendered the embedded player at the mini player's actual pixel dimensions
  and preserved a seamless video transition when moving between full and
  floating layouts.
- Cached chat-user profile lookups for 60 seconds with in-flight deduplication,
  bounded third-party subscription-age requests to five seconds, and memoized
  retained user-card messages.
- Debounced preference persistence so rapidly adjusted chat and overlay
  controls no longer issue a settings write for every intermediate value.
- Hardened Electron's trust boundaries by isolating the official Twitch player
  cross-origin, locking privileged renderer navigation, validating every IPC
  sender, and narrowing the legacy controls window's preload capabilities.
- Kept authenticated/source-quality Streamlink playback while moving the
  website token from visible process arguments to a private stdin handoff.
- Moved the application renderer into an ephemeral storage partition while
  retaining encrypted playback credentials and synchronizing only the
  in-memory Twitch cookie required by the official player.
- Hardened release automation with exact dependency versions, immutable
  GitHub Action commits, read-only build permissions, non-replaceable release
  assets, automated dependency update proposals, and signing-ready Windows
  configuration.
- Made reply threads compact and content-sized above the chat composer instead
  of occupying a tall fixed panel.
- Refined overlay chat so its border, composer, tools, and scrollbar stay out
  of the way until needed, while the paused-chat indicator remains available.
- Made overlay chat resize smoothly above its revealed composer and keep live
  messages pinned to the newest entry without moving readers who scrolled up.
- Kept profile cards inside the visible application area as asynchronous
  profile data changes their size or the window is resized.

### Fixes

- Fixed rapid Native stream switches allowing a cancelled older startup or
  stale end-of-file event to clear the new stream, reset its state, or trigger
  the legacy window-player fallback.
- Fixed reselecting the channel already playing from rebuilding its metadata,
  chat, and player; it now simply restores the existing player surface.
- Fixed closing playback briefly flashing a loading state by unmounting the
  player page before tearing down its main-process session.
- Fixed paused or history-trimmed chat drifting while new messages arrive by
  sharing the same anchored feed logic between side and overlay layouts.
- Fixed profile-card data loading or application resizing moving the card
  partly outside the visible window.
- Fixed overlay-opacity changes racing between synchronized renderer state and
  rapidly cycling through stale percentages.
- Fixed overlay scrollbars remaining visible while inactive and extending
  behind the chat composer.
- Fixed resuming Native playback from a paused stream causing frame skips or
  failing to return to the live edge.
- Reduced delays when opening chat-user profiles and other external links in
  the system browser.

## [0.3.1-alpha.1] - 2026-07-19

### Additions

- Added clickable chat usernames with an in-app profile card showing Twitch
  profile details, badges, available follow and subscription status, and the
  user's retained messages from the current chat.
- Added a live paused-chat indicator with its pending message count and a
  one-click return to the newest message.
- Rendered embedded Native controls directly in the main app window so player
  menus, chat overlays, and profile cards share the video canvas's compositor
  without a second Electron renderer. The separate controls window remains
  available only for the legacy window-hosted fallback.

### Fixes

- Hid Twitch's redundant leading `@username` in reply messages while preserving
  the official reply relationship and original message contents.
- Batched fast-moving chat updates and preserved the reader's position while
  paused, including when old messages must eventually be trimmed.
- Fixed rapid stream switching so a cancelled older startup cannot clear the
  selected embedded backend, trigger the window-hosted fallback, or tear down
  the newer stream.
- Fixed embedded video turning black after moving Native controls into the main
  window by isolating the video canvas and controls into explicit compositor
  layers.
- Kept the legacy Native fallback working when an embedded texture session
  fails after startup by switching its backend and controls together.
- Kept Twitch event cards purple when hovered in OLED mode and limited the
  hover feedback to the row behind the card.

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
