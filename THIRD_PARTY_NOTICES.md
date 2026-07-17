# Third-party notices

VioletWire is an independent application and is not affiliated with Twitch,
7TV, Streamlink, or mpv.

## Streamlink

Project: <https://github.com/streamlink/streamlink>

License: BSD 2-Clause

Copyright (c) 2011-2016 Christopher Rosell  
Copyright (c) 2016-2026 Streamlink Team

VioletWire redistributes Streamlink's official unmodified Windows portable
runtime and launches it as a separate executable. The complete Streamlink
license, Python license, and dependency notices remain inside that runtime.
VioletWire omits Streamlink's optional FFmpeg muxer because mpv handles Twitch
HLS playback directly.

The authoritative Streamlink license is:
<https://github.com/streamlink/streamlink/blob/master/LICENSE>

## mpv

Project: <https://github.com/mpv-player/mpv>

VioletWire redistributes an unmodified pinned mpv Windows build and launches it
as a separate executable. mpv can be built under GPLv2-or-later or, with the
relevant GPL components disabled, LGPLv2.1-or-later. Linked libraries such as
FFmpeg also affect the resulting binary's license. The bundled runtime includes
mpv's copyright information and complete GPL and LGPL license texts.

Authoritative licensing details:
<https://github.com/mpv-player/mpv/blob/master/Copyright>

Exact versions, archive checksums, corresponding-source locations, and build
definitions are documented in
[`third_party/NATIVE_RUNTIME_SOURCES.md`](third_party/NATIVE_RUNTIME_SOURCES.md).

## npm and Electron dependencies

The packaged application includes production dependencies declared in
`package.json`. Their individual license metadata and notices remain with those
packages in the packaged application. `package-lock.json` records the exact
dependency graph used for each build.
