/**
 * A `serve` session's artifacts on disk, beside its log
 * (docs/feat/model-artifacts.md D5): `<dir>/<uid>.artifacts/` holds the
 * content-addressed `<sha256>` blobs (the `SessionBlobs` code, suffix
 * `.artifacts`) and `manifest.jsonl` — line 1 `{"schemaVersion":1}`, then one
 * `ArtifactMeta` per line.
 *
 * - A manifest, not a session-log entry: compaction and `context_reset` start
 *   a new log segment, and an artifact the user saw must not leave the gallery
 *   with it. Versioned on its own: an unknown `schemaVersion` is REFUSED (the
 *   session's store stays memory-only, the dir is never written); a malformed
 *   line is skipped and kept on disk.
 * - Order on present: blob (temp + fsync + rename) → manifest line (append +
 *   fsync). A crash between leaves an orphan blob, swept at the next start;
 *   never a manifest line whose bytes are missing.
 *
 * `LogSessionStore` owns one and routes every MUTATION through the session's
 * queue and lock; reads go straight here.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { ATTACHMENT_ID_RE, type ArtifactMeta, ArtifactMetaSchema } from "@tentacle/protocol";
import { SessionBlobs, type SessionBlobsIo } from "./session-blobs.ts";

export const ARTIFACT_DIR_SUFFIX = ".artifacts";
export const MANIFEST_FILE = "manifest.jsonl";
export const ARTIFACT_MANIFEST_VERSION = 1;

const HEADER = `${JSON.stringify({ schemaVersion: ARTIFACT_MANIFEST_VERSION })}\n`;
const MANIFEST_TEMP = /^\.manifest\.jsonl\.tmp-/;

/** Thrown when a session's manifest is of a version this build does not know. */
export class ManifestRefusedError extends Error {}

/**
 * The metas of a manifest's text: `[]` for none (no file), `"refused"` when
 * the header is not this build's version (or unreadable). Lines that do not
 * parse as an `ArtifactMeta` are skipped.
 */
export function parseManifest(text: string): ArtifactMeta[] | "refused" {
  if (text === "") return [];
  const lines = text.split("\n");
  let header: unknown;
  try {
    header = JSON.parse(lines[0] ?? "");
  } catch {
    return "refused";
  }
  if ((header as { schemaVersion?: unknown } | null)?.schemaVersion !== ARTIFACT_MANIFEST_VERSION) {
    return "refused";
  }
  const out: ArtifactMeta[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    try {
      const parsed = ArtifactMetaSchema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // Malformed (a torn append): skipped, kept on disk.
    }
  }
  return out;
}

/** The text of `path`, `""` when there is no file. */
function textOf(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return "";
    throw error;
  }
}

export class SessionArtifacts {
  private readonly blobs: SessionBlobs;

  constructor(dir: string, io?: SessionBlobsIo) {
    this.blobs = new SessionBlobs(dir, io, ARTIFACT_DIR_SUFFIX);
  }

  private manifestPath(uid: string): string {
    return join(this.blobs.blobDir(uid), MANIFEST_FILE);
  }

  /** The session's metas, oldest first (synchronous: a store is built synchronously). */
  manifest(uid: string): ArtifactMeta[] | "refused" {
    try {
      return parseManifest(textOf(this.manifestPath(uid)));
    } catch {
      return "refused";
    }
  }

  /** Blob FIRST, then the manifest line. Refused manifest → throws before touching the dir. */
  async append(uid: string, meta: ArtifactMeta, bytes: Uint8Array): Promise<void> {
    if (this.manifest(uid) === "refused") {
      throw new ManifestRefusedError(
        `the artifacts of session ${uid} were written by a newer tentacle; not written`,
      );
    }
    await this.blobs.write(uid, meta.sha256, bytes);
    const path = this.manifestPath(uid);
    const line = `${JSON.stringify(meta)}\n`;
    if (textOf(path) === "") {
      await this.writeWhole(uid, HEADER + line);
      return;
    }
    const handle = await open(path, "r+");
    try {
      const { size } = await handle.stat();
      const last = new Uint8Array(1);
      await handle.read(last, 0, 1, size - 1);
      // A torn last line (a crash mid-append) is closed first, so it stays one bad line.
      const data = Buffer.from(last[0] === 0x0a ? line : `\n${line}`);
      await handle.write(data, 0, data.length, size);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** At most `length` bytes of a blob from `offset`, or `null`. */
  readRange(uid: string, sha256: string, offset: number, length: number) {
    return this.blobs.readRange(uid, sha256, offset, length);
  }

  /**
   * A `/clear` fork: give `toUid` the artifacts presented by the calls in
   * `callIds` — blobs linked first, then its manifest written whole and
   * atomically. A target that already has a manifest is left as is (the fork
   * landed before; it may have moved on since).
   */
  async fork(fromUid: string, toUid: string, callIds: ReadonlySet<string>): Promise<void> {
    const source = this.manifest(fromUid);
    if (source === "refused") return;
    const picked = source.filter((m) => callIds.has(m.callId));
    if (picked.length === 0 || textOf(this.manifestPath(toUid)) !== "") return;
    await this.blobs.link(fromUid, toUid, new Set(picked.map((m) => m.sha256)));
    await this.writeWhole(toUid, HEADER + picked.map((m) => `${JSON.stringify(m)}\n`).join(""));
  }

  /**
   * Start-up sweep of one session's dir (nothing is live yet): `hasLog` false
   * → the whole dir goes; else a blob whose sha256 the manifest text does not
   * mention anywhere (a malformed line still counts) and a manifest temp go.
   * A refused manifest's dir is left untouched.
   */
  async sweep(uid: string, hasLog: boolean): Promise<void> {
    if (!hasLog) {
      await this.blobs.removeAll(uid);
      return;
    }
    const dir = this.blobs.blobDir(uid);
    let text: string;
    try {
      text = await readFile(this.manifestPath(uid), "utf8");
    } catch {
      text = "";
    }
    if (parseManifest(text) === "refused") return;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const unnamedBlob = ATTACHMENT_ID_RE.test(name) && !text.includes(name);
      if (unnamedBlob || MANIFEST_TEMP.test(name)) {
        await rm(join(dir, name), { force: true }).catch(() => {});
      }
    }
  }

  removeAll(uid: string): Promise<void> {
    return this.blobs.removeAll(uid);
  }

  /** The session ids that have an artifacts dir. */
  owners(): Promise<string[]> {
    return this.blobs.owners();
  }

  /** Blob temps of dead writers (best-effort). */
  sweepTemps(): Promise<void> {
    return this.blobs.sweep();
  }

  /** temp + fsync + rename: the manifest whole, or the old state. */
  private async writeWhole(uid: string, data: string): Promise<void> {
    const dir = this.blobs.blobDir(uid);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, `.${MANIFEST_FILE}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`);
    try {
      const handle = await open(temp, "w", 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.manifestPath(uid));
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }
}
