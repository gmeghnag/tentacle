/**
 * Read a binary's tentacle version WITHOUT executing it (D2,
 * docs/feat/pod-binary-download.md): scan its bytes for the marker literal
 * `TENTACLE_VERSION_MARKER:<version>:END` compiled in by `buildBinary`. Bun
 * appends the bundled JS at the END of a compiled executable, so the tail is
 * read first; a full backward scan is the fallback. Read-only: the binary is
 * never modified (that would break the macOS signature / Bun's trailing payload).
 */
import { open } from "node:fs/promises";
import { MARKER_PREFIX, MARKER_SUFFIX } from "./version.ts";

const PREFIX: Uint8Array = new TextEncoder().encode(MARKER_PREFIX);
const SUFFIX: Uint8Array = new TextEncoder().encode(MARKER_SUFFIX);
const MAX_VERSION = 64;
/** The longest possible well-formed marker, in bytes (the chunk overlap). */
export const MAX_MARKER_BYTES = PREFIX.length + MAX_VERSION + SUFFIX.length;

/** `[0-9A-Za-z.+-]` — the bytes a marker's version may contain. */
function isVersionByte(b: number): boolean {
  return (
    (b >= 0x30 && b <= 0x39) || // 0-9
    (b >= 0x41 && b <= 0x5a) || // A-Z
    (b >= 0x61 && b <= 0x7a) || // a-z
    b === 0x2e || // .
    b === 0x2b || // +
    b === 0x2d // -
  );
}

/** The version of a well-formed marker whose version starts at `start`, else undefined. */
function versionAt(buf: Buffer, start: number): string | undefined {
  let i = start;
  while (i < buf.length && i - start <= MAX_VERSION && isVersionByte(buf[i] as number)) {
    i++;
  }
  const len = i - start;
  if (len < 1 || len > MAX_VERSION) {
    return undefined;
  }
  if (i + SUFFIX.length > buf.length || !buf.subarray(i, i + SUFFIX.length).equals(SUFFIX)) {
    return undefined;
  }
  return buf.toString("latin1", start, i);
}

/**
 * The version in the LAST well-formed marker in `bytes`, scanning from the end;
 * `undefined` if there is none. A bare or malformed prefix (e.g. the scanner's
 * own `MARKER_PREFIX` literal, which is also in the binary) is skipped.
 */
export function findVersionMarker(bytes: Uint8Array): string | undefined {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let from = buf.length;
  for (;;) {
    const at = buf.lastIndexOf(PREFIX, from);
    if (at < 0) {
      return undefined;
    }
    const version = versionAt(buf, at + PREFIX.length);
    if (version !== undefined) {
      return version;
    }
    if (at === 0) {
      return undefined;
    }
    from = at - 1;
  }
}

export interface ReadBinaryVersionOptions {
  /** Bytes read from the end first (default 16 MiB: the bundle sits there). */
  readonly tailBytes?: number;
  /** Chunk size of the full-scan fallback (default 8 MiB; tests shrink it). */
  readonly chunkBytes?: number;
}

/**
 * The tentacle version compiled into the binary at `path`, or `undefined` when
 * it carries no marker (an unknown version, e.g. a build that predates D2).
 * Reads the tail first, then scans the rest backwards in chunks that overlap by
 * `MAX_MARKER_BYTES`, so a marker split across a chunk boundary is still found.
 * Throws only on I/O errors (e.g. the file does not exist).
 */
export async function readBinaryVersion(
  path: string,
  options: ReadBinaryVersionOptions = {},
): Promise<string | undefined> {
  const tailBytes = Math.max(options.tailBytes ?? 16 * 1024 * 1024, MAX_MARKER_BYTES);
  const chunkBytes = Math.max(options.chunkBytes ?? 8 * 1024 * 1024, 2 * MAX_MARKER_BYTES);
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    const read = async (start: number, end: number): Promise<Uint8Array> => {
      const buf = new Uint8Array(end - start);
      let got = 0;
      while (got < buf.length) {
        const { bytesRead } = await file.read(buf, got, buf.length - got, start + got);
        if (bytesRead === 0) {
          break;
        }
        got += bytesRead;
      }
      return buf.subarray(0, got);
    };
    // 1) The tail, where Bun puts the bundle.
    const tailStart = Math.max(0, size - tailBytes);
    const fromTail = findVersionMarker(await read(tailStart, size));
    if (fromTail !== undefined || tailStart === 0) {
      return fromTail;
    }
    // 2) Full backward scan of the rest; the first chunk overlaps the tail so
    // a marker straddling the tail boundary is not missed.
    let end = Math.min(size, tailStart + MAX_MARKER_BYTES - 1);
    for (;;) {
      const start = Math.max(0, end - chunkBytes);
      const found = findVersionMarker(await read(start, end));
      if (found !== undefined || start === 0) {
        return found;
      }
      end = start + MAX_MARKER_BYTES - 1;
    }
  } finally {
    await file.close();
  }
}
