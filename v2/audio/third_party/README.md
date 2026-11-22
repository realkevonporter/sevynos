# Vendored decoders

audiod decodes with vendored single-file decoders so the image build
needs no audio `-dev` packages from the sysroot and stages no
decoder library closures — only `libasound.so.2`. Each file is
unmodified upstream source, kept intact with its own license header.

| File | Upstream | License | sha256 |
|---|---|---|---|
| `minimp3.h` | https://github.com/lieff/minimp3 (master) | CC0-1.0 (public domain) | `af5a24330f4c5029be0f1aa32f3f81f6339bc823df1e2ce1b87292c0b9013286` |
| `minimp3_ex.h` | https://github.com/lieff/minimp3 (master) | CC0-1.0 (public domain) | `ae416e86661a552373aaea614cddd1b7d42b0f743bdf29d4eeac5e94a05f9293` |
| `dr_flac.h` | https://github.com/mackron/dr_libs (master) | Public domain or MIT-0 | `bd569c910a7c465e481fd50af84e2871e81e2154e30ac510d98f953cc0d5a546` |
| `stb_vorbis.c` | https://github.com/nothings/stb (master) | Public domain (or MIT) | `b52cf518355f7b2d181f18b97b812f361ffeb26299d935c8cf29e842401d60a6` |

Fetched 2026-11-17. The hashes above are the pin: if a file is
 ever refreshed, update its hash here in the same commit.

Notes:

- `minimp3_ex.h` is the file-level API (`mp3dec_ex_open` /
  `mp3dec_ex_read` / `mp3dec_ex_seek`); `minimp3.h` alone is only the
  low-level frame decoder.
- `stb_vorbis.c` compiles as its own translation unit (see
  `audio-decode.c`): its static `get_bits` collides with minimp3's
  when both are included in one file. With `STB_VORBIS_HEADER_ONLY`
  defined, including it yields declarations only.
- All four licenses are permissive and compatible with this repo's
  GPL-3.0-or-later: CC0 / public domain / MIT-0 / MIT.
