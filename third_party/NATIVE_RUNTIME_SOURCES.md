# Bundled Streamlink source and license information

VioletWire redistributes an unmodified Streamlink portable Windows runtime for
authenticated Twitch and Kick stream discovery. Chromium and hls.js handle the
resolved HLS playback inside the application.

## Streamlink portable runtime

- Package: `streamlink-8.4.0-1-py314-x86_64.zip`
- Release: <https://github.com/streamlink/windows-builds/releases/tag/8.4.0-1>
- SHA-256: `a8d3bd2b409e6d1b1f7a0e2a5c0cbfba619775e475da3f31285af08d680fb71c`
- Build recipes and component versions:
  <https://github.com/streamlink/windows-builds/tree/8.4.0-1>
- Streamlink source:
  <https://github.com/streamlink/streamlink/tree/8.4.0>

The staged package retains Streamlink's BSD 2-Clause license, Python's license,
and dependency license metadata. VioletWire omits the portable archive's
optional FFmpeg muxer because Chromium consumes the HLS stream directly. No
Streamlink, Python, or Python-package binaries are modified.

## Source availability

The links above identify the exact source revision and build definitions for
the redistributed runtime. If a source link becomes unavailable, open an issue
at <https://github.com/lucaboox/VioletWire/issues> so an equivalent source
archive can be restored alongside the release.
