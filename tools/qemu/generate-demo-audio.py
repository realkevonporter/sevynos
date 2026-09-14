#!/usr/bin/env python3
"""Generate deterministic, royalty-free SevynOS demo tracks for the live image."""

from __future__ import annotations

import math
import pathlib
import struct
import sys
import wave


SAMPLE_RATE = 22_050
DURATION_SECONDS = 28
TRACKS = {
    "genesis-horizon": (110.0, 164.81, 220.0),
    "silicon-pulse": (98.0, 146.83, 196.0),
    "nebula-drift": (82.41, 123.47, 164.81),
    "digital-dawn": (130.81, 196.0, 261.63),
    "midnight-terminal": (73.42, 110.0, 146.83),
}


def sample_value(index: int, frequencies: tuple[float, float, float]) -> int:
    time = index / SAMPLE_RATE
    beat = 0.5 + 0.5 * math.sin(2.0 * math.pi * 0.42 * time)
    shimmer = 0.5 + 0.5 * math.sin(2.0 * math.pi * 0.071 * time)
    fade = min(1.0, time / 1.2, (DURATION_SECONDS - time) / 1.8)
    chord = sum(
        math.sin(2.0 * math.pi * frequency * time + phase)
        for frequency, phase in zip(frequencies, (0.0, 0.7, 1.4), strict=True)
    ) / 3.0
    bass = math.sin(2.0 * math.pi * frequencies[0] * 0.5 * time)
    signal = (0.23 * chord * (0.65 + 0.35 * shimmer) + 0.08 * bass * beat) * fade
    return max(-32_767, min(32_767, round(signal * 32_767)))


def main() -> None:
    output = pathlib.Path(sys.argv[1])
    output.mkdir(parents=True, exist_ok=True)
    frame_count = SAMPLE_RATE * DURATION_SECONDS
    for name, frequencies in TRACKS.items():
        destination = output / f"{name}.wav"
        with wave.open(str(destination), "wb") as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(SAMPLE_RATE)
            frames = bytearray()
            for index in range(frame_count):
                frames.extend(struct.pack("<h", sample_value(index, frequencies)))
            stream.writeframes(frames)


if __name__ == "__main__":
    main()
