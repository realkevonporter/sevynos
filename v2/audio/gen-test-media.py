#!/usr/bin/env python3
"""Generate the 7 test WAVs for the audiod harness (v2/audio/test-audiod.mjs).

The harness plays all 7 WAVs and checks real durations (trackDurations in
test-audiod.mjs, 21.5–29.5 s) plus seek-to-10s on the first one. The WAVs
live on the author's dev machine at ~/workspace/sevynos-test-media/audio
and are NOT in the repo — CI runners have no such directory, so without
this step the harness finds 0 WAVs, falls back to the 2 s fixtures, and
the seek section fails deterministically (SEEK 10 is past the end of a
2 s clip, the track ends, and every "still playing" check after it
fails too — 7 of the 8 failures in the first #127 CI round).

The harness only checks duration, format, and real-time position — not
audio content — so plain sine tones at the exact durations satisfy every
check. Stdlib only; writes to the target dir (default
/tmp/sevyn-test-media/audio, wired via SEVYN_AUDIO_TEST_MEDIA).
"""

import math
import os
import struct
import sys
import wave

TRACKS = [
    ("01-sunrise-acoustic.wav", 21.5),
    ("02-midnight-jazz.wav", 25.5),
    ("03-ocean-breeze.wav", 24.833),
    ("04-city-lights.wav", 27.75),
    ("05-forest-dawn.wav", 22.833),
    ("06-desert-drive.wav", 22.929),
    ("07-starlight-lullaby.wav", 29.5),
]

SAMPLE_RATE = 44100
CHANNELS = 2
FREQ_HZ = 440.0
AMPLITUDE = 12000


def main() -> int:
    outdir = sys.argv[1] if len(sys.argv) > 1 else "/tmp/sevyn-test-media/audio"
    os.makedirs(outdir, exist_ok=True)
    for name, seconds in TRACKS:
        frames = round(seconds * SAMPLE_RATE)
        path = os.path.join(outdir, name)
        with wave.open(path, "wb") as w:
            w.setnchannels(CHANNELS)
            w.setsampwidth(2)
            w.setframerate(SAMPLE_RATE)
            chunk = bytearray()
            for i in range(frames):
                sample = int(AMPLITUDE * math.sin(2 * math.pi * FREQ_HZ * i / SAMPLE_RATE))
                chunk += struct.pack("<hh", sample, sample)
                if len(chunk) >= 1 << 20:
                    w.writeframes(chunk)
                    chunk = bytearray()
            if chunk:
                w.writeframes(chunk)
        actual = frames / SAMPLE_RATE
        print(f"{name}: {actual:.3f}s ({frames} frames)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
