import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionBlobs, type SessionBlobsIo } from "../src/session-blobs.ts";

// docs/feat/attachments-durable.md T1: a session's image bytes on disk beside
// its log — round-trip, idempotence, path safety, fork links, temp sweep.

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-blobs-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const blob = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return { bytes, id: createHash("sha256").update(bytes).digest("hex") };
};

const same = (got: Uint8Array | null, want: Uint8Array): boolean =>
  got !== null && Buffer.compare(got, want) === 0;

let n = 0;
const freshDir = async () => {
  const dir = join(root, `d${n++}`);
  await mkdir(dir);
  return dir;
};

/** The real io, counting every call. */
const spyIo = (overrides: Partial<SessionBlobsIo> = {}) => {
  const calls: string[] = [];
  const io: SessionBlobsIo = {
    async link(from, to) {
      calls.push("link");
      if (overrides.link) return overrides.link(from, to);
      const { link } = await import("node:fs/promises");
      await link(from, to);
    },
    async copy(from, to) {
      calls.push("copy");
      const { copyFile } = await import("node:fs/promises");
      await copyFile(from, to);
    },
    async writeDurable(path, bytes) {
      calls.push("write");
      await writeFile(path, bytes);
    },
  };
  return { io, calls };
};

describe("SessionBlobs", () => {
  test("write → index and read round-trip; a second write of the same blob is a no-op", async () => {
    const dir = await freshDir();
    const { io, calls } = spyIo();
    const blobs = new SessionBlobs(dir, io);
    const a = blob("a png");
    expect(blobs.index("S")).toEqual(new Map());
    expect(await blobs.read("S", a.id)).toBeNull();
    await blobs.write("S", a.id, a.bytes);
    expect(blobs.index("S")).toEqual(new Map([[a.id, a.bytes.length]]));
    const got = await blobs.read("S", a.id);
    expect(same(got, a.bytes)).toBe(true);
    await blobs.write("S", a.id, a.bytes);
    expect(calls).toEqual(["write"]);
    // Only the blob itself is in the dir (the temp was renamed in).
    expect(await readdir(join(dir, "S.attachments"))).toEqual([a.id]);
  });

  test("a bad id or session id is refused before any file is touched", async () => {
    const dir = join(root, `missing-${n++}`);
    const { io, calls } = spyIo();
    const blobs = new SessionBlobs(dir, io);
    const a = blob("x");
    await expect(blobs.write("S", "../../etc/passwd", a.bytes)).rejects.toThrow(
      "invalid attachment id",
    );
    await expect(blobs.write("../S", a.id, a.bytes)).rejects.toThrow("invalid session id");
    await expect(blobs.link("S", "T", ["../x"])).rejects.toThrow("invalid attachment id");
    expect(await blobs.read("S", "ABC")).toBeNull();
    expect(await blobs.read("../S", a.id)).toBeNull();
    expect(blobs.index("../S")).toEqual(new Map());
    expect(calls).toEqual([]);
    // Not even the folder was created.
    expect(await stat(dir).catch(() => null)).toBeNull();
  });

  test("index skips names that are not an id", async () => {
    const dir = await freshDir();
    const blobs = new SessionBlobs(dir);
    const a = blob("a");
    await blobs.write("S", a.id, a.bytes);
    await writeFile(join(dir, "S.attachments", "notes.txt"), "x");
    expect([...blobs.index("S").keys()]).toEqual([a.id]);
  });

  test("link hardlinks (same inode); a missing source id is skipped", async () => {
    const dir = await freshDir();
    const blobs = new SessionBlobs(dir);
    const a = blob("linked");
    const missing = blob("never written");
    await blobs.write("S", a.id, a.bytes);
    await blobs.link("S", "F", [a.id, missing.id]);
    const src = await stat(join(dir, "S.attachments", a.id));
    const dst = await stat(join(dir, "F.attachments", a.id));
    expect(dst.ino).toBe(src.ino);
    expect([...blobs.index("F").keys()]).toEqual([a.id]);
    // Removing the source keeps the fork's link.
    await blobs.removeAll("S");
    expect(await stat(join(dir, "S.attachments")).catch(() => null)).toBeNull();
    const got = await blobs.read("F", a.id);
    expect(same(got, a.bytes)).toBe(true);
  });

  test("link falls back to a copy when the file system cannot link (EXDEV)", async () => {
    const dir = await freshDir();
    const { io, calls } = spyIo({
      link: async () => {
        throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
      },
    });
    const blobs = new SessionBlobs(dir, io);
    const a = blob("copied");
    await blobs.write("S", a.id, a.bytes);
    await blobs.link("S", "F", [a.id]);
    expect(calls).toEqual(["write", "link", "copy"]);
    const src = await stat(join(dir, "S.attachments", a.id));
    const dst = await stat(join(dir, "F.attachments", a.id));
    expect(dst.ino).not.toBe(src.ino);
    const got = await blobs.read("F", a.id);
    expect(same(got, a.bytes)).toBe(true);
    expect(await readdir(join(dir, "F.attachments"))).toEqual([a.id]);
  });

  test("a link error that is not 'cannot link here' is thrown", async () => {
    const dir = await freshDir();
    const { io } = spyIo({
      link: async () => {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
    });
    const blobs = new SessionBlobs(dir, io);
    const a = blob("x2");
    await blobs.write("S", a.id, a.bytes);
    await expect(blobs.link("S", "F", [a.id])).rejects.toThrow("disk full");
  });

  test("sweep removes a dead writer's temp, keeps a live one's and the blobs", async () => {
    const dir = await freshDir();
    const blobs = new SessionBlobs(dir);
    const a = blob("kept");
    await blobs.write("S", a.id, a.bytes);
    const bdir = join(dir, "S.attachments");
    const dead = `.${a.id}.tmp-999999999-abcd1234`;
    const live = `.${a.id}.tmp-${process.pid}-abcd1234`;
    const oldLive = `.${a.id}.tmp-${process.ppid}-abcd1234`;
    await writeFile(join(bdir, dead), "x");
    await writeFile(join(bdir, live), "x");
    await writeFile(join(bdir, oldLive), "x");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(join(bdir, oldLive), old, old);
    await blobs.sweep();
    expect((await readdir(bdir)).sort()).toEqual([live, a.id].sort());
  });

  test("owners lists the sessions with a blob dir", async () => {
    const dir = await freshDir();
    const blobs = new SessionBlobs(dir);
    const a = blob("o");
    await blobs.write("S", a.id, a.bytes);
    await writeFile(join(dir, "S.jsonl"), "");
    await mkdir(join(dir, ".hidden.attachments"));
    expect(await blobs.owners()).toEqual(["S"]);
  });
});
