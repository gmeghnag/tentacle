/**
 * The iPhone diagram look, on disk (docs/feat/model-diagrams.md, owner answer
 * Q1: "a setting to switch the iPhone diagrams to the B look"; built by
 * docs/fix/mobile-qa-1117.md, bug 3): `outline` (1A/2A, the default) or `filled`
 * (1B/2B — soft slot-1 fills, caption below). A versioned record `{v:1, style}`
 * behind the `SecureKV` port — the `activity-settings-store.ts` pattern, so this
 * module has no native import.
 *
 * Fail-safe rules (each pinned by `test/diagram-style.test.ts`):
 * - missing, unreadable or an unknown version → `outline`; an unknown version is
 *   never written over (`DiagramSettingsPreserved`), and Settings says so;
 * - an unknown style inside our own v1 record → `outline` (a diagram always draws);
 * - a write failure rejects; the holder still publishes the pick for this run.
 */
import type { SecureKV } from "./computer-store.ts";

export const DIAGRAM_SETTINGS_KEY = "tentacle.diagrams";
export const DIAGRAM_SETTINGS_VERSION = 1;

export type DiagramStyle = "outline" | "filled";

export interface DiagramSettings {
  readonly style: DiagramStyle;
}

export const DEFAULT_DIAGRAM_SETTINGS: DiagramSettings = { style: "outline" };

export interface DiagramSettingsRead {
  readonly settings: DiagramSettings;
  /** `false`: a record this build cannot read — never written over. */
  readonly writable: boolean;
}

export class DiagramSettingsPreserved extends Error {
  constructor() {
    super("a newer build's diagram setting is on this phone — left untouched");
    this.name = "DiagramSettingsPreserved";
  }
}

function parse(raw: string | null): DiagramSettingsRead {
  if (raw === null) {
    return { settings: DEFAULT_DIAGRAM_SETTINGS, writable: true };
  }
  const unreadable = { settings: DEFAULT_DIAGRAM_SETTINGS, writable: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unreadable;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return unreadable;
  }
  const r = parsed as { v?: unknown; style?: unknown };
  if (r.v !== DIAGRAM_SETTINGS_VERSION) {
    return unreadable;
  }
  return {
    settings: { style: r.style === "filled" ? "filled" : "outline" },
    writable: true,
  };
}

export interface DiagramSettingsStore {
  /** Never rejects: a read error reads the default (and refuses later writes). */
  read(): Promise<DiagramSettingsRead>;
  /** Rejects on a write error, or with `DiagramSettingsPreserved` over an unreadable record. */
  write(settings: DiagramSettings): Promise<void>;
}

export function createDiagramSettingsStore(deps: {
  readonly kv: SecureKV;
  readonly keychainAccessible: number;
}): DiagramSettingsStore {
  let preserved = false;
  return {
    async read() {
      let raw: string | null;
      try {
        raw = await deps.kv.get(DIAGRAM_SETTINGS_KEY);
      } catch {
        preserved = true;
        return { settings: DEFAULT_DIAGRAM_SETTINGS, writable: false };
      }
      const read = parse(raw);
      preserved = !read.writable;
      return read;
    },
    async write(settings) {
      if (preserved) {
        throw new DiagramSettingsPreserved();
      }
      await deps.kv.set(
        DIAGRAM_SETTINGS_KEY,
        JSON.stringify({ v: DIAGRAM_SETTINGS_VERSION, ...settings }),
        { keychainAccessible: deps.keychainAccessible },
      );
    },
  };
}

/** The app's in-memory copy (one per app): a failed write still holds the pick for this run. */
export interface DiagramSettingsHolder {
  current(): DiagramSettings;
  /** False over a record this build cannot read (the Settings rows are disabled). */
  writable(): boolean;
  load(): Promise<void>;
  set(next: DiagramSettings): Promise<void>;
  subscribe(listener: (settings: DiagramSettings) => void): () => void;
}

export function createDiagramSettingsHolder(store: DiagramSettingsStore): DiagramSettingsHolder {
  let current = DEFAULT_DIAGRAM_SETTINGS;
  let writable = true;
  const listeners = new Set<(settings: DiagramSettings) => void>();
  const publish = (next: DiagramSettings) => {
    current = next;
    for (const l of listeners) {
      l(next);
    }
  };
  return {
    current: () => current,
    writable: () => writable,
    async load() {
      const read = await store.read();
      writable = read.writable;
      publish(read.settings);
    },
    async set(next) {
      if (!writable) {
        throw new DiagramSettingsPreserved();
      }
      try {
        await store.write(next);
      } finally {
        publish(next);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
