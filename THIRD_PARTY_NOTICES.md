# Third-party notices

VioletWire is an independent application and is not affiliated with Twitch,
7TV, Streamlink, or mpv.

## Streamlink

Project: <https://github.com/streamlink/streamlink>

License: BSD 2-Clause

Copyright (c) 2011-2016 Christopher Rosell  
Copyright (c) 2016-2026 Streamlink Team

VioletWire currently discovers and launches a copy of Streamlink installed by
the user. Streamlink is not copied into VioletWire's installer or repository.
Calling the external command-line program is permitted, and the BSD 2-Clause
license allows source and binary redistribution.

If a future VioletWire installer bundles Streamlink, the Streamlink copyright
notice, license conditions, and disclaimer must be reproduced in the installer
documentation or other included materials. The authoritative license text is:
<https://github.com/streamlink/streamlink/blob/master/LICENSE>

## mpv

Project: <https://github.com/mpv-player/mpv>

VioletWire currently discovers and launches a copy of mpv installed by the user.
mpv is not copied into VioletWire's installer or repository.

mpv can be built under GPLv2-or-later or, with the relevant GPL components
disabled, LGPLv2.1-or-later. Linked libraries such as FFmpeg can also affect the
resulting binary's license. Before bundling mpv, VioletWire must select a specific
build and reproduce all license notices required by that build.

Authoritative licensing details:
<https://github.com/mpv-player/mpv/blob/master/Copyright>

## npm and Electron dependencies

The packaged application includes production dependencies declared in
`package.json`. Their individual license metadata and notices remain with those
packages in the packaged application. `package-lock.json` records the exact
dependency graph used for each build.
