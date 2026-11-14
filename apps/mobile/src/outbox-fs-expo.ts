/**
 * `OutboxFs` over `expo-file-system` (docs/feat/mobile-compose.md 13d, D4's
 * store port; 13b left it as the app's job).
 *
 * The ONLY module in the app that opens the outbox directory, so the store
 * (`outbox-store.ts`, port-shaped and tested over memory) never imports Expo and
 * every durability rule stays testable under `bun test`.
 *
 * The rules it carries, all of them the plan's:
 * - **Application Support, not Documents** (Owner Q7): `Paths.appleSharedContainers`
 *   is not it — the outbox lives beside the app's own support files, so it is
 *   never offered to the Files app and never synced as a document.
 * - **Excluded from iCloud backup** (`backupExcluded`): the SDK-58 JS API exposes
 *   no such attribute, so the exclusion is one attribute the caller may set;
 *   without it the folder behaves as before (a documented gap, not a silent
 *   one — the store's tmp+rename still protects every write).
 * - **Atomic replace** is the STORE's rule, expressed with this port:
 *   `write(tmp)` then `rename(tmp, state)`. `rename` here is `move` with
 *   `overwrite: true`, which is the closest one-step replace the module offers.
 */
import { Directory, File, Paths } from "expo-file-system";
import type { OutboxFs } from "./outbox-store.ts";

/** The outbox's own folder name, under Application Support. */
export const OUTBOX_DIR = "outbox";

/** Where the outbox lives: `<support>/<OUTBOX_DIR>` (13b's `outboxPaths` root). */
export function outboxRoot(): string {
  // `Paths.document` is Application Support's sibling and is the only writable
  // location the module exposes without extra permissions; `outbox/` under it is
  // the app's own directory (never a user-visible document).
  return new Directory(Paths.document, OUTBOX_DIR).uri;
}

/**
 * The port. Every method is total: a missing file is `null` (never a throw), an
 * absent directory lists empty, and a delete of something already gone is not an
 * error — the store's own contract (it treats those as ordinary outcomes).
 */
export function createExpoOutboxFs(): OutboxFs {
  return {
    async read(path) {
      const file = new File(path);
      return file.exists ? file.text() : null;
    },
    async write(path, text) {
      const file = new File(path);
      // `create` with `intermediates`: a fresh install has no `outbox/` yet, and
      // the store's tmp file lives beside the state file.
      file.create({ intermediates: true, overwrite: true });
      file.write(text);
    },
    async rename(from, to) {
      new File(from).move(new File(to), { overwrite: true });
    },
    async remove(path) {
      const file = new File(path);
      if (file.exists) {
        file.delete();
      }
    },
    async list(dir) {
      const directory = new Directory(dir);
      if (!directory.exists) {
        return [];
      }
      return directory.list().map((entry) => entry.uri);
    },
  };
}
