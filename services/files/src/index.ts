/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * @sevynos/file-archives — archive inspection, extraction and creation for
 * the File Manager. Pure-TS container parsers (zip, tar, gzip framing) plus
 * the Node.js host service that drives them with `node:zlib`.
 */
export { crc32 } from "./crc32.js";
export {
  parseZipArchive,
  readZipEntryData,
  type DeflateInflater as ZipDeflateInflater,
  type ZipArchive,
  type ZipEntry,
} from "./zip.js";
export { parseTarArchive, type TarEntry } from "./tar.js";
export { isGzipStream, parseGzipHeader, type GzipHeader } from "./gzip.js";
export {
  detectArchiveFormat,
  FileArchiveService,
  isSafeArchiveEntryName,
  type ArchiveEntryInfo,
  type ArchiveExtractResult,
  type ArchiveFormat,
  type ArchiveProgress,
  type ArchiveProgressListener,
  type FileArchiveServiceOptions,
  type SevynArchiveService,
} from "./archive-service.js";
