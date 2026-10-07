/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * CRC-32 (ISO 3309, IEEE 802.3 polynomial 0xEDB88320) used by the zip and
 * gzip container parsers to verify extracted data integrity.
 */

const TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let crc = n;
    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[n] = crc >>> 0;
  }
  return table;
})();

/** Compute the CRC-32 of `data`. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
