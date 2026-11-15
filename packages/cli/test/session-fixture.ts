/**
 * A saved session as a test fixture (docs/feat/session-log-laptop-store.md):
 * the record written as the laptop's `<uid>.jsonl` log (a cold `write`, the
 * only way a laptop persists one now — `saveSnapshot` is gone with the
 * in-process path, docs/feat/remove-in-process.md), with the file's mtime set
 * to `record.updatedAt` — a log's `updatedAt` IS its mtime (Q4), so
 * newest-first order holds.
 */
import { utimes } from "node:fs/promises";
import { type SessionRecord, recordTitleState } from "@tentacle/agent";
import { type LogSessionStore, type LogWrite, forkWrite } from "@tentacle/daemon";

/** `record` as the one cold write that puts its whole history in a new log. */
export function recordWrite(record: SessionRecord): LogWrite {
  return forkWrite({
    id: record.id,
    meta: { cwd: record.cwd, model: record.model, createdAt: record.createdAt },
    messages: record.messages,
    title: recordTitleState(record),
    ts: Date.now(),
  });
}

export async function saveFixture(store: LogSessionStore, record: SessionRecord): Promise<void> {
  await store.write(recordWrite(record));
  const at = new Date(record.updatedAt);
  await utimes(store.file(record.id), at, at);
}
