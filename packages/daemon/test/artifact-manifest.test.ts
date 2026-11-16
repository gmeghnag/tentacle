/**
 * `serve` artifact durability at the store level (docs/feat/model-artifacts.md
 * D5, T4.2 / T4.4 / T4.5 / T4.6 / T4.8): `<uid>.artifacts/` = content-addressed
 * blobs + `manifest.jsonl` (its own `schemaVersion`), written blob FIRST, then
 * the manifest line, in the session's queue.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactMeta } from "@tentacle/protocol";
import { SessionArtifacts, parseManifest } from "../src/session-artifacts.ts";
import type { SessionBlobsIo } from "../src/session-blobs.ts";
import { forkWrite } from "../src/session-fork.ts";
import { LogSessionStore } from "../src/session-log-store.ts";
import { META, asst, tool, user } from "./support/log-fixture.ts";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);

function metaOf(bytes: Uint8Array, callId: string, artifactId = callId, version = 1): ArtifactMeta {
  return {
    artifactId,
    version,
    sha256: sha(bytes),
    size: bytes.length,
    mimeType: "text/html",
    kind: "html",
    title: `page ${artifactId}`,
    callId,
    createdAt: 1,
  };
}

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "artifact-manifest-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A blob io whose durable write fails (ENOSPC). */
const failingIo: SessionBlobsIo = {
  link: async () => {},
  copy: async () => {},
  writeDurable: async () => {
    throw Object.assign(new Error("full"), { code: "ENOSPC" });
  },
};

describe("parseManifest (D5b)", () => {
  test("header v1 + valid lines; a malformed line is skipped, never fatal", () => {
    const a = metaOf(enc("a"), "c1");
    const text = `{"schemaVersion":1}\n${JSON.stringify(a)}\nnot json\n{"artifactId":"../x"}\n`;
    expect(parseManifest(text)).toEqual([a]);
  });
  test("no file text → empty; an unknown or unreadable header → refused", () => {
    expect(parseManifest("")).toEqual([]);
    expect(parseManifest('{"schemaVersion":2}\n')).toBe("refused");
    expect(parseManifest("garbage\n")).toBe("refused");
  });
});

describe("LogSessionStore artifacts (T4)", () => {
  test("put: blob + manifest line on disk; read back by range", async () => {
    await withDir(async (dir) => {
      const store = new LogSessionStore(dir);
      const bytes = enc("<p>hello</p>");
      const meta = metaOf(bytes, "c1");
      await store.putArtifact("S", meta, bytes);
      expect(store.artifactManifest("S")).toEqual([meta]);
      expect((await readdir(join(dir, "S.artifacts"))).sort()).toEqual(
        [meta.sha256, "manifest.jsonl"].sort(),
      );
      const part = await store.readArtifactBlob("S", meta.sha256, 3, 5);
      expect(part ? new TextDecoder().decode(part) : null).toBe("hello");
      expect(await store.readArtifactBlob("S", "b".repeat(64), 0, 5)).toBeNull();
    });
  });

  test("T4.2: a failed blob write → rejects, and NO manifest line is written", async () => {
    await withDir(async (dir) => {
      const store = new LogSessionStore(dir, { artifacts: new SessionArtifacts(dir, failingIo) });
      const bytes = enc("x");
      await expect(store.putArtifact("S", metaOf(bytes, "c1"), bytes)).rejects.toThrow(/ENOSPC/);
      expect(store.artifactManifest("S")).toEqual([]);
      const names = await readdir(join(dir, "S.artifacts")).catch(() => [] as string[]);
      expect(names).not.toContain("manifest.jsonl");
    });
  });

  test("T4.4: an unknown schemaVersion is refused and the dir is never written", async () => {
    await withDir(async (dir) => {
      const adir = join(dir, "S.artifacts");
      await mkdir(adir, { recursive: true });
      const header = '{"schemaVersion":2}\n{"future":true}\n';
      await writeFile(join(adir, "manifest.jsonl"), header);
      await writeFile(join(adir, "c".repeat(64)), "stray");
      const store = new LogSessionStore(dir);
      expect(store.artifactManifest("S")).toBe("refused");
      const bytes = enc("y");
      await expect(store.putArtifact("S", metaOf(bytes, "c1"), bytes)).rejects.toThrow(/newer/);
      await writeFile(join(dir, "S.jsonl"), "");
      await store.sweepArtifacts("S");
      expect((await readdir(adir)).sort()).toEqual(["c".repeat(64), "manifest.jsonl"].sort());
      expect(await readFile(join(adir, "manifest.jsonl"), "utf8")).toBe(header);
    });
  });

  test("T4.5: start-up sweep — a logless dir goes; an unnamed blob goes; named ones (even on a malformed line) stay", async () => {
    await withDir(async (dir) => {
      const store = new LogSessionStore(dir);
      const kept = enc("kept");
      const meta = metaOf(kept, "c1");
      await store.putArtifact("S", meta, kept);
      await store.putArtifact("G", metaOf(kept, "c1"), kept);
      await writeFile(join(dir, "S.jsonl"), "");
      const adir = join(dir, "S.artifacts");
      const orphan = "d".repeat(64);
      const malformedNamed = "e".repeat(64);
      await writeFile(join(adir, orphan), "orphan");
      await writeFile(join(adir, malformedNamed), "m");
      await writeFile(join(adir, "manifest.jsonl"), `${await readFile(join(adir, "manifest.jsonl"), "utf8")}{"sha256":"${malformedNamed}"\n`);
      expect((await store.artifactOwners()).sort()).toEqual(["G", "S"]);
      for (const id of await store.artifactOwners()) await store.sweepArtifacts(id);
      expect(await readdir(dir)).not.toContain("G.artifacts");
      expect((await readdir(adir)).sort()).toEqual(
        [meta.sha256, malformedNamed, "manifest.jsonl"].sort(),
      );
      expect(store.artifactManifest("S")).toEqual([meta]);
    });
  });

  test("T4.6: remove deletes the artifacts dir with the log", async () => {
    await withDir(async (dir) => {
      const store = new LogSessionStore(dir);
      const b = enc("b");
      await store.putArtifact("S", metaOf(b, "c1"), b);
      await writeFile(join(dir, "S.jsonl"), "");
      await store.remove("S");
      expect((await readdir(dir)).filter((n) => n.startsWith("S"))).toEqual([]);
    });
  });

  test("T4.8: a /clear fork gets exactly the artifacts of its callIds; the source keeps all", async () => {
    await withDir(async (dir) => {
      const store = new LogSessionStore(dir);
      const one = enc("one");
      const two = enc("two");
      const m1 = metaOf(one, "c1");
      const m2 = metaOf(two, "c2");
      await store.putArtifact("S", m1, one);
      await store.putArtifact("S", m2, two);
      const messages = [user("show"), asst("", ["c1"]), tool("c1", "Presented")];
      const update = forkWrite({ id: "F", meta: META, messages, title: { source: "auto" } as never, ts: 5 });
      await store.fork("S", update);
      expect(store.artifactManifest("F")).toEqual([m1]);
      expect((await readdir(join(dir, "F.artifacts"))).sort()).toEqual([m1.sha256, "manifest.jsonl"].sort());
      expect(store.artifactManifest("S")).toEqual([m1, m2]);
      // A retry of the landed fork changes nothing (manifest written once, atomically).
      await store.fork("S", update);
      expect(store.artifactManifest("F")).toEqual([m1]);
    });
  });
});
