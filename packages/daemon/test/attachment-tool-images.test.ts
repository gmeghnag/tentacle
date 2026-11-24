/**
 * `AttachmentStore.putTool` / `resolve` (docs/feat/image-view.md T2): the only
 * new write path. The property: a tool picture is held under ids that ARE the
 * sha256 of its bytes, both variant ids resolve to one entry, and the tool
 * sub-cap refuses BEFORE reserving anything, so user uploads keep their room.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ToolImageEntry } from "@tentacle/core";
import { AttachmentStore, UploadBudget } from "../src/attachment-store.ts";

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (size: number, seed: number): Uint8Array =>
  new Uint8Array(size).map((_, i) => (i * 31 + seed) % 251);
const put = (high: Uint8Array, low?: Uint8Array, label = "doc.pdf p.1") => ({
  variants: {
    high: { bytes: high, width: 1568, height: 784 },
    ...(low !== undefined ? { low: { bytes: low, width: 768, height: 384 } } : {}),
  },
  mimeType: "image/png" as const,
  label,
});
const entryOf = (r: ToolImageEntry | { refused: string }): ToolImageEntry => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r;
};

describe("putTool (memory store)", () => {
  test("ids are the sha256 of the bytes; both variants are held and readable", async () => {
    const s = new AttachmentStore(new UploadBudget());
    const hi = bytesOf(4000, 1);
    const lo = bytesOf(1000, 2);
    const e = entryOf(await s.putTool(put(hi, lo)));
    expect(e.high.ref.id).toBe(sha(hi));
    expect(e.low.ref.id).toBe(sha(lo));
    expect(e.high.ref.name).toBe("doc.pdf p.1");
    expect(e.low.width).toBe(768);
    expect(s.holds(e.high.ref) && s.holds(e.low.ref)).toBe(true);
    expect(Buffer.compare((await s.read(e.low.ref)) ?? new Uint8Array(), lo)).toBe(0);
    expect(s.held).toBe(5000);
  });

  test("no low variant → low IS high (one blob)", async () => {
    const s = new AttachmentStore(new UploadBudget());
    const e = entryOf(await s.putTool(put(bytesOf(500, 3))));
    expect(e.low.ref.id).toBe(e.high.ref.id);
    expect(s.held).toBe(500);
  });

  test("the same picture twice (concurrent reads) dedupes: one entry, bytes counted once", async () => {
    const s = new AttachmentStore(new UploadBudget());
    const hi = bytesOf(3000, 4);
    const [a, b] = await Promise.all([s.putTool(put(hi)), s.putTool(put(hi))]);
    expect(entryOf(a).high.ref.id).toBe(entryOf(b).high.ref.id);
    expect(s.held).toBe(3000);
  });

  test("the tool sub-cap refuses WITHOUT reserving; a user upload still fits after", async () => {
    const budget = new UploadBudget();
    const s = new AttachmentStore(budget, { maxBytes: 10_000, toolMaxBytes: 6_000 });
    entryOf(await s.putTool(put(bytesOf(5000, 5))));
    const before = { held: s.held, used: budget.used };
    const r = await s.putTool(put(bytesOf(2000, 6)));
    expect(r).toEqual({ refused: "image store full" });
    expect({ held: s.held, used: budget.used }).toEqual(before);
    const user = bytesOf(4000, 7);
    const ack = s.put({
      id: sha(user),
      size: user.length,
      offset: 0,
      data: Buffer.from(user).toString("base64"),
    });
    expect(ack).toEqual({ have: 4000, complete: true });
  });

  test("resolve: none / one (by either variant's prefix) / ambiguous with labels", async () => {
    const s = new AttachmentStore(new UploadBudget());
    expect(s.resolve("abcdef12")).toEqual({ kind: "none" });
    const e = entryOf(await s.putTool(put(bytesOf(900, 8), bytesOf(300, 9))));
    expect(s.resolve(e.high.ref.id.slice(0, 12))).toEqual({ kind: "found", entry: e });
    expect(s.resolve(e.low.ref.id.slice(0, 12))).toEqual({ kind: "found", entry: e });
    const f = entryOf(await s.putTool(put(bytesOf(901, 10), undefined, "doc.pdf p.2")));
    const r = s.resolve("");
    expect(r.kind).toBe("ambiguous");
    expect(r.kind === "ambiguous" ? [...r.labels].sort() : []).toEqual([e.label, f.label].sort());
  });

  test("a user upload never enters the tool index", async () => {
    const s = new AttachmentStore(new UploadBudget());
    const user = bytesOf(700, 11);
    s.put({ id: sha(user), size: 700, offset: 0, data: Buffer.from(user).toString("base64") });
    expect(s.resolve(sha(user).slice(0, 12))).toEqual({ kind: "none" });
  });
});

describe("putTool (disk store, `serve`)", () => {
  function disk(fail: (id: string) => boolean) {
    const files = new Map<string, Uint8Array>();
    return {
      index: new Map<string, number>(),
      async write(id: string, bytes: Uint8Array): Promise<void> {
        if (fail(id)) throw new Error("ENOSPC");
        files.set(id, bytes);
      },
      async read(id: string): Promise<Uint8Array | null> {
        return files.get(id) ?? null;
      },
    };
  }

  test("resolves once landed: both refs held (durable)", async () => {
    const s = new AttachmentStore(new UploadBudget(), { disk: disk(() => false) });
    const e = entryOf(await s.putTool(put(bytesOf(800, 12), bytesOf(200, 13))));
    expect(s.holds(e.high.ref) && s.holds(e.low.ref)).toBe(true);
  });

  test("a failed land → {refused}, not indexed, the failed blob's reservation released", async () => {
    const lo = bytesOf(200, 15);
    const s = new AttachmentStore(new UploadBudget(), { disk: disk((id) => id === sha(lo)) });
    const hi = bytesOf(800, 14);
    const r = await s.putTool(put(hi, lo));
    expect(r).toEqual({ refused: "image could not be stored" });
    expect(s.resolve(sha(hi).slice(0, 12))).toEqual({ kind: "none" });
    expect(s.held).toBe(800);
  });
});
