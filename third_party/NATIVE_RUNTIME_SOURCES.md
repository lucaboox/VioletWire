# Native runtime source and license information

VioletWire redistributes an unmodified Streamlink portable runtime and libmpv
Windows development/runtime package. They are aggregated with VioletWire for
installation convenience.

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
optional FFmpeg muxer because Twitch HLS is passed directly to mpv. No
Streamlink, Python, or Python-package binaries are modified.

## libmpv runtime

- Package: `mpv-dev-x86_64-20260610-git-304426c.7z`
- Release:
  <https://github.com/shinchiro/mpv-winbuild-cmake/releases/tag/20260610>
- SHA-256: `8cbb25ea784f01afbb3f904217cab1317430a8bcfd5680fd827a866367f71cc9`
- mpv revision: `304426c39`
- mpv corresponding source:
  <https://github.com/mpv-player/mpv/tree/304426c39>
- Reproducible Windows build scripts and dependency definitions:
  <https://github.com/shinchiro/mpv-winbuild-cmake/tree/20260610>

The packaged libmpv runtime includes mpv's copyright information and complete
GPL and LGPL license texts. The pinned build scripts above identify the source
revisions and build configuration for mpv and all statically linked components.

## Source availability

The links above identify the exact source revisions and build definitions for
the redistributed binaries. VioletWire does not modify Streamlink, FFmpeg,
mpv, or their bundled libraries. If any corresponding-source link becomes
unavailable, open an issue at <https://github.com/lucaboox/VioletWire/issues>
so an equivalent source archive can be restored alongside the release.
