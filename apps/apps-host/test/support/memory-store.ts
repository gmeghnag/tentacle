/** An in-memory `Store` whose operations a test can fail or hold. */
import type { AppRecord, LeaseSnapshot } from "../../src/records.ts";
import { contentTag } from "../../src/records.ts";
import type { Report, Store } from "../../src/store.ts";

export type StoreOp =
  | "writeContent"
  | "writeRecord"
  | "removeContent"
  | "removeRecord"
  | "writeSnapshot"
  | "appendReport"
  | "pruneReports"
  | "freeBytes";

export function memoryStore() {
  const records = new Map<string, AppRecord>();
  const contents = new Map<string, Uint8Array>();
  const reports: Report[] = [];
  const snapshots: LeaseSnapshot[] = [];
  const failures = new Map<StoreOp, string>();
  const holds = new Map<StoreOp, Promise<void>>();
  const waiting: StoreOp[] = [];
  const disk = { free: 1024 ** 4 };
  /** Every operation, in the order it was asked for. */
  const ops: StoreOp[] = [];
  /** The cutoffs reports were pruned with. */
  const pruned: number[] = [];

  const run = async (op: StoreOp): Promise<void> => {
    ops.push(op);
    const hold = holds.get(op);
    if (hold !== undefined) {
      waiting.push(op);
      await hold;
    }
    const code = failures.get(op);
    if (code !== undefined) {
      throw Object.assign(new Error(code), { code });
    }
  };
  const name = (id: string, sha256: string): string => `${id}-${contentTag(sha256)}`;

  const store: Store = {
    async load() {
      return { records: [], skipped: [], contents: [], problems: [] };
    },
    async writeContent(id, sha256, bytes) {
      await run("writeContent");
      contents.set(name(id, sha256), bytes);
    },
    async writeRecord(record) {
      await run("writeRecord");
      records.set(record.id, record);
    },
    async removeContent(id, sha256) {
      await run("removeContent");
      contents.delete(name(id, sha256));
    },
    async removeRecord(id) {
      await run("removeRecord");
      records.delete(id);
    },
    async content(id, sha256) {
      return contents.get(name(id, sha256));
    },
    async writeSnapshot(snapshot) {
      await run("writeSnapshot");
      snapshots.push(snapshot);
    },
    async appendReport(report) {
      await run("appendReport");
      reports.push(report);
    },
    async pruneReports(cutoff) {
      await run("pruneReports");
      pruned.push(cutoff);
    },
    async freeBytes() {
      await run("freeBytes");
      return disk.free;
    },
  };

  return {
    store,
    records,
    contents,
    reports,
    snapshots,
    disk,
    ops,
    pruned,
    /** The operations currently held. */
    waiting,
    fail(op: StoreOp, code = "ENOSPC"): void {
      failures.set(op, code);
    },
    heal(): void {
      failures.clear();
    },
    /** Make every `op` wait until the returned function is called. */
    hold(op: StoreOp): () => void {
      let release = (): void => {};
      holds.set(
        op,
        new Promise<void>((resolve) => {
          release = () => {
            holds.delete(op);
            resolve();
          };
        }),
      );
      return release;
    },
  };
}
