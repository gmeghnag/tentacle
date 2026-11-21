/**
 * The `Compact shell rows` Beta switch, remembered on this device
 * (docs/feat/shell-intent-line.md §7): a versioned record `{v:1, compactShell}`
 * behind the `SecureKV` port — `theme-settings-store.ts`'s shape and fail-safe
 * rules, so this module has no native import (`shell-rows-expo.ts` is the
 * wiring). Its OWN record (`tentacle.shell-rows`): a build that ships one
 * Beta switch must not have to read another's.
 *
 * - an unreadable, missing or unknown-version record reads OFF: a broken store
 *   never turns the beta on;
 * - an unknown `v` (or bytes that are not the record) is left untouched: a write
 *   over it is refused (`ShellRowsPreserved`), the switch still works this run;
 * - a write failure rejects — the holder keeps the pick in memory for this run.
 */
import type { SecureKV } from "./computer-store.ts";

export const SHELL_ROWS_KEY = "tentacle.shell-rows";
export const SHELL_ROWS_VERSION = 1;

export interface ShellRowsSettings {
  readonly compactShell: boolean;
}

export const DEFAULT_SHELL_ROWS: ShellRowsSettings = { compactShell: false };

export interface ShellRowsRead {
  readonly settings: ShellRowsSettings;
  /** `false`: a record this build cannot read — never written over. */
  readonly writable: boolean;
}

export class ShellRowsPreserved extends Error {
  constructor() {
    super("a newer build's shell-rows setting is on this phone — left untouched");
    this.name = "ShellRowsPreserved";
  }
}

function parse(raw: string | null): ShellRowsRead {
  if (raw === null) return { settings: DEFAULT_SHELL_ROWS, writable: true };
  const unreadable = { settings: DEFAULT_SHELL_ROWS, writable: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unreadable;
  }
  if (typeof parsed !== "object" || parsed === null) return unreadable;
  const r = parsed as { v?: unknown; compactShell?: unknown };
  if (r.v !== SHELL_ROWS_VERSION || typeof r.compactShell !== "boolean") {
    return unreadable;
  }
  return { settings: { compactShell: r.compactShell }, writable: true };
}

export interface ShellRowsStore {
  /** Never rejects: a read error reads OFF (and refuses later writes). */
  read(): Promise<ShellRowsRead>;
  /** Rejects on a write error, or with `ShellRowsPreserved` over an unreadable record. */
  write(settings: ShellRowsSettings): Promise<void>;
}

export function createShellRowsStore(deps: {
  readonly kv: SecureKV;
  readonly keychainAccessible: number;
}): ShellRowsStore {
  let preserved = false;
  return {
    async read() {
      let raw: string | null;
      try {
        raw = await deps.kv.get(SHELL_ROWS_KEY);
      } catch {
        preserved = true;
        return { settings: DEFAULT_SHELL_ROWS, writable: false };
      }
      const read = parse(raw);
      preserved = !read.writable;
      return read;
    },
    async write(settings) {
      if (preserved) throw new ShellRowsPreserved();
      await deps.kv.set(
        SHELL_ROWS_KEY,
        JSON.stringify({ v: SHELL_ROWS_VERSION, compactShell: settings.compactShell }),
        { keychainAccessible: deps.keychainAccessible },
      );
    },
  };
}

/**
 * The app's in-memory copy. `load` reads the record ONCE per run; a pick always
 * applies for this run, even when the write fails or is refused.
 */
export interface ShellRowsHolder {
  current(): ShellRowsSettings;
  load(): Promise<void>;
  /** Rejects when the pick was not saved (it is still published). */
  set(next: ShellRowsSettings): Promise<void>;
  subscribe(listener: (settings: ShellRowsSettings) => void): () => void;
}

export function createShellRowsHolder(store: ShellRowsStore): ShellRowsHolder {
  let current = DEFAULT_SHELL_ROWS;
  let writable = true;
  let loading: Promise<void> | null = null;
  let picked = false;
  const listeners = new Set<(settings: ShellRowsSettings) => void>();
  const publish = (next: ShellRowsSettings) => {
    current = next;
    for (const l of listeners) {
      l(next);
    }
  };
  return {
    current: () => current,
    load() {
      loading ??= store.read().then((read) => {
        writable = read.writable;
        // A pick made while the read was in flight wins over the stored one.
        if (!picked) publish(read.settings);
      });
      return loading;
    },
    async set(next) {
      picked = true;
      publish(next);
      if (!writable) throw new ShellRowsPreserved();
      await store.write(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
