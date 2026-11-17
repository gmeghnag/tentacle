import { describe, expect, test } from "bun:test";
/**
 * The daemon's per-session artifact store (docs/feat/model-artifacts.md D4, T3.1
 * / T3.3–T3.5): snapshot, versioning, idempotent re-present, the daemon-wide
 * memory budget's oldest-first eviction, and a read that serves only what THIS
 * store listed, one aligned chunk at a time.
 */
import { createHash } from "node:crypto";
import {
  ATTACHMENT_CHUNK_BYTES,
  ArtifactMetaSchema,
  DomainErrorCode,
  JsonRpcErrorCode,
  MAX_ARTIFACT_LIST,
} from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import { ArtifactBudget, ArtifactStore, artifactListResult } from "../src/artifact-store.ts";

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

function bytes(size: number, seed = 7): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

const input = (b: Uint8Array, extra: Record<string, unknown> = {}) => ({
  title: "report.html",
  bytes: b,
  mimeType: "text/html",
  kind: "html",
  callId: "call-1",
  ...extra,
});

async function readAll(store: ArtifactStore, hash: string, size: number): Promise<Uint8Array> {
  const out = new Uint8Array(size);
  for (let at = 0; at < size; at += ATTACHMENT_CHUNK_BYTES) {
    const r = await store.read(hash, at);
    expect(r.size).toBe(size);
    out.set(Buffer.from(r.data, "base64"), at);
  }
  return out;
}

async function rejection(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("ArtifactStore present + read (T3.1)", () => {
  test("present → v1, listed, every meta passes the wire schema, chunks hash back", async () => {
    const store = new ArtifactStore(new ArtifactBudget(), { now: () => 42 });
    const b = bytes(ATTACHMENT_CHUNK_BYTES * 2 + 17);
    const meta = await store.present(input(b, { source: "out/report.html" }));
    expect(meta).toMatchObject({
      artifactId: "a1",
      version: 1,
      sha256: sha(b),
      size: b.length,
      kind: "html",
      callId: "call-1",
      createdAt: 42,
      source: "out/report.html",
    });
    expect(ArtifactMetaSchema.safeParse(meta).success).toBe(true);
    expect(store.list()).toEqual([meta]);
    expect(sha(await readAll(store, meta.sha256, meta.size))).toBe(meta.sha256);
  });

  test("a SNAPSHOT: mutating the caller's buffer afterwards changes nothing", async () => {
    const store = new ArtifactStore(new ArtifactBudget());
    const b = bytes(100);
    const meta = await store.present(input(b));
    b.fill(0);
    expect(sha(await readAll(store, meta.sha256, meta.size))).toBe(meta.sha256);
  });

  test("a callId longer than the wire's 256 is clamped, so the meta still parses", async () => {
    const store = new ArtifactStore(new ArtifactBudget());
    const meta = await store.present(input(bytes(10), { callId: "c".repeat(400) }));
    expect(meta.callId.length).toBe(256);
    expect(ArtifactMetaSchema.safeParse(meta).success).toBe(true);
  });

  test("a source the wire would refuse is dropped (display only), never fails the present", async () => {
    const store = new ArtifactStore(new ArtifactBudget());
    const m1 = await store.present(input(bytes(10), { source: "a\nb.html" }));
    const m2 = await store.present(input(bytes(11), { source: "x".repeat(600) }));
    expect(m1.source).toBeUndefined();
    expect(m2.source).toBeUndefined();
  });

  test("empty bytes and a meta the wire refuses are refused (nothing stored)", async () => {
    const store = new ArtifactStore(new ArtifactBudget());
    await expect(store.present(input(new Uint8Array(0)))).rejects.toThrow(/empty/);
    await expect(store.present(input(bytes(10), { title: "a\u0007b" }))).rejects.toThrow();
    await expect(store.present(input(bytes(10), { id: "../x" }))).rejects.toThrow();
    expect(store.list()).toEqual([]);
  });
});

describe("versioning (T3.3)", () => {
  test("same id ⇒ v2; same id + same bytes as the latest ⇒ no new version", async () => {
    const store = new ArtifactStore(new ArtifactBudget());
    const v1 = await store.present(input(bytes(10, 1), { id: "chart" }));
    const v2 = await store.present(input(bytes(10, 2), { id: "chart", callId: "call-2" }));
    const again = await store.present(input(bytes(10, 2), { id: "chart", callId: "call-3" }));
    expect([v1.artifactId, v1.version]).toEqual(["chart", 1]);
    expect([v2.artifactId, v2.version]).toEqual(["chart", 2]);
    expect(again).toEqual(v2);
    expect(store.list().map((m) => m.version)).toEqual([1, 2]);
    // The older version stays readable.
    expect(sha(await readAll(store, v1.sha256, v1.size))).toBe(v1.sha256);
  });

  test("no id ⇒ a minted a<N> that never collides with a model-chosen one", async () => {
    const store = new ArtifactStore(new ArtifactBudget());
    await store.present(input(bytes(10, 1), { id: "a1" }));
    const minted = await store.present(input(bytes(10, 2)));
    expect(minted.artifactId).not.toBe("a1");
    expect(minted.version).toBe(1);
  });
});

describe("the daemon-wide memory budget (T3.4)", () => {
  test("over budget: the OLDEST version of any session is evicted, its meta stays, read → evicted", async () => {
    const budget = new ArtifactBudget(250);
    const a = new ArtifactStore(budget);
    const b = new ArtifactStore(budget);
    const old = await a.present(input(bytes(100, 1)));
    const mid = await b.present(input(bytes(100, 2)));
    const fresh = await b.present(input(bytes(100, 3)));
    expect(budget.used).toBe(200);
    expect(a.list()).toEqual([old]);
    const err = await rejection(a.read(old.sha256, 0));
    expect(err.code).toBe(DomainErrorCode.ArtifactUnavailable);
    expect(err.data).toEqual({ reason: "evicted" });
    expect(sha(await readAll(b, mid.sha256, mid.size))).toBe(mid.sha256);
    expect(sha(await readAll(b, fresh.sha256, fresh.size))).toBe(fresh.sha256);
  });

  test("re-presenting an evicted version's bytes restores them", async () => {
    const budget = new ArtifactBudget(150);
    const a = new ArtifactStore(budget);
    const v = await a.present(input(bytes(100, 1), { id: "x" }));
    await a.present(input(bytes(100, 2), { id: "y" }));
    expect((await rejection(a.read(v.sha256, 0))).data).toEqual({ reason: "evicted" });
    const back = await a.present(input(bytes(100, 1), { id: "x" }));
    expect(back).toEqual(v);
    expect(sha(await readAll(a, v.sha256, v.size))).toBe(v.sha256);
  });

  test("dispose returns every byte to the budget and empties the store", async () => {
    const budget = new ArtifactBudget();
    const a = new ArtifactStore(budget);
    await a.present(input(bytes(100, 1)));
    await a.present(input(bytes(100, 2)));
    a.dispose();
    expect(budget.used).toBe(0);
    expect(a.list()).toEqual([]);
  });

  test("one blob presented twice (two ids) is charged once", async () => {
    const budget = new ArtifactBudget();
    const a = new ArtifactStore(budget);
    await a.present(input(bytes(100, 1), { id: "x" }));
    await a.present(input(bytes(100, 1), { id: "y" }));
    expect(budget.used).toBe(100);
    expect(a.list().length).toBe(2);
  });
});

describe("read refusals (T3.5)", () => {
  test("a sha not in THIS store's list → ArtifactUnavailable{unknown}", async () => {
    const a = new ArtifactStore(new ArtifactBudget());
    const b = new ArtifactStore(new ArtifactBudget());
    const meta = await a.present(input(bytes(10)));
    const err = await rejection(b.read(meta.sha256, 0));
    expect(err.code).toBe(DomainErrorCode.ArtifactUnavailable);
    expect(err.data).toEqual({ reason: "unknown" });
  });

  test("an offset that is not chunk-aligned, or at/after the end → InvalidParams", async () => {
    const a = new ArtifactStore(new ArtifactBudget());
    const meta = await a.present(input(bytes(ATTACHMENT_CHUNK_BYTES + 5)));
    for (const offset of [1, ATTACHMENT_CHUNK_BYTES - 1, ATTACHMENT_CHUNK_BYTES * 2]) {
      const err = await rejection(a.read(meta.sha256, offset));
      expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    }
    const last = await a.read(meta.sha256, ATTACHMENT_CHUNK_BYTES);
    expect(Buffer.from(last.data, "base64").length).toBe(5);
  });
});

describe("artifactListResult", () => {
  test("caps at MAX_ARTIFACT_LIST, keeping the NEWEST, oldest first, and says truncated", async () => {
    const store = new ArtifactStore(new ArtifactBudget(), { now: () => 1 });
    for (let i = 0; i < MAX_ARTIFACT_LIST + 3; i++) {
      await store.present(input(bytes(4, i + 1), { id: "same" }));
    }
    const r = artifactListResult(store.list());
    expect(r.artifacts.length).toBe(MAX_ARTIFACT_LIST);
    expect(r.truncated).toBe(true);
    expect(r.artifacts[0]?.version).toBe(4);
    expect(r.artifacts.at(-1)?.version).toBe(MAX_ARTIFACT_LIST + 3);
    expect(artifactListResult(store.list().slice(0, 2))).toEqual({
      artifacts: store.list().slice(0, 2),
    });
  });
});
