/**
 * A saved session as a test fixture (docs/feat/session-log-laptop-store.md):
 * the record written as the laptop's `<uid>.jsonl` log (`saveSnapshot`: a
 * laptop-minted segment), with the file's mtime set to `record.updatedAt` —
 * a log's `updatedAt` IS its mtime (Q4), so newest-first order holds.
 */
import { utimes } from "node:fs/promises";
import type { SessionRecord } from "@tentacle/agent";
import type { LogSessionStore } from "@tentacle/daemon";

export async function saveFixture(store: LogSessionStore, record: SessionRecord): Promise<void> {
  await store.saveSnapshot(record);
  const at = new Date(record.updatedAt);
  await utimes(store.file(record.id), at, at);
}
