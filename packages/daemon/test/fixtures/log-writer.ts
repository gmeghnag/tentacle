/**
 * A second WRITER PROCESS for the laptop log store's lock test (W4,
 * docs/feat/session-log-laptop-store.md): applies the `LogWrite`s of a JSON
 * file to `<dir>` through its own `LogSessionStore`, in order, then prints
 * `done` (or the first error). Usage: bun log-writer.ts <dir> <writes.json>
 */
import { readFileSync } from "node:fs";
import { LogSessionStore, type LogWrite } from "../../src/session-log-store.ts";

const [dir, file] = process.argv.slice(2);
if (dir === undefined || file === undefined) {
  process.stderr.write("usage: log-writer.ts <dir> <writes.json>\n");
  process.exit(2);
}
const writes = JSON.parse(readFileSync(file, "utf8")) as LogWrite[];
const store = new LogSessionStore(dir, { lockWaitMs: 10_000 });
try {
  for (const update of writes) {
    await store.write(update);
    await new Promise((r) => setTimeout(r, Math.random() * 3));
  }
  process.stdout.write("done\n");
} catch (error) {
  process.stdout.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
}
