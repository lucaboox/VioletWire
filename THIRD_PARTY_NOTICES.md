# Third-party notices

VioletWire is an independent application and is not affiliated with Twitch,
Kick, 7TV, FrankerFaceZ, BetterTTV, or Streamlink.

The GNU General Public License v3.0 or later in the repository root applies
only to VioletWire-authored source code. The software and assets listed below
retain their original licenses and are not relicensed under the GPL.

## Emote-provider logos

The 7TV, FrankerFaceZ, BetterTTV, and Twitch marks shown in VioletWire's emote
picker are adapted from the SVG logo assets in the
[7TV Extension repository](https://github.com/SevenTV/Extension/tree/master/src/assets/svg/logos).
That repository is distributed under the
[Apache License 2.0 with Commons Clause](https://github.com/SevenTV/Extension/blob/master/LICENSE.md).

The marks are used only to identify their respective emote providers. Their use
does not imply affiliation with or endorsement by 7TV, FrankerFaceZ, BetterTTV,
or Twitch. All provider names and marks remain the property of their respective
owners.

## Streamlink

Project: <https://github.com/streamlink/streamlink>

License: BSD 2-Clause

Copyright (c) 2011-2016 Christopher Rosell  
Copyright (c) 2016-2026 Streamlink Team

VioletWire redistributes Streamlink's official unmodified Windows portable
runtime and launches it as a separate executable. The complete Streamlink
license, Python license, and dependency notices remain inside that runtime.
VioletWire omits Streamlink's optional FFmpeg muxer because Chromium handles
HLS playback directly.

The authoritative Streamlink license is:
<https://github.com/streamlink/streamlink/blob/master/LICENSE>

## hls.js

Project: <https://github.com/video-dev/hls.js>

License: Apache License 2.0

VioletWire uses hls.js to play Streamlink-resolved HLS streams through
Chromium's Media Source Extensions pipeline. The bundled package retains its
license and copyright notice.

## flag-icons

Project: <https://github.com/lipis/flag-icons>

License: MIT

VioletWire uses the bundled flag-icons SVG artwork to display country flag
emoji on Windows, which otherwise renders regional indicators as letters.

## npm and Electron dependencies

The packaged application includes production dependencies declared in
`package.json`. Their individual license metadata and notices remain with those
packages in the packaged application. `package-lock.json` records the exact
dependency graph used for each build.
