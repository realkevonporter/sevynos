/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Computes how many of the OSD's level segments are filled for a volume.
 * Dependency-free so it can be unit-tested without a React Native renderer.
 */
export function computeFilledSegments(
  volume: number,
  muted: boolean,
  total = 16,
): number {
  if (muted) return 0;
  const clamped = Math.min(100, Math.max(0, Math.round(volume)));
  return Math.round((clamped / 100) * total);
}
