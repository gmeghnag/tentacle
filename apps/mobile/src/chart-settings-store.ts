import type { LabelMode } from "./chart-layout-kit.ts";
/**
 * The Charts setting, on disk (docs/feat/mobile-chart-labels.md D7): a versioned
 * record `{v:1, labels}` behind the `SecureKV` port — the
 * `activity-settings-store.ts` / `voice-settings-store.ts` shape, so this module
 * has no native import.
 *
 * It is its OWN record (`tentacle.charts`) rather than a field of the Activity
 * button's: the two settings have nothing to do with each other, and a build
 * that ships one must not have to read the other.
 *
 * Fail-safe rules, each pinned by `test/chart-settings-store.test.ts`:
 * - an unreadable, missing or unknown-version record reads the DEFAULTS
 *   ("inside"): a chart always has labels on its lines;
 * - an unknown `v` (or bytes that are not the record) is left untouched: a
 *   write over it is refused (`ChartSettingsPreserved`), and Settings says this
 *   build cannot change it;
 * - a write failure rejects, so Settings says "didn't save" — the holder keeps
 *   the pick in memory for this run.
 */
import type { SecureKV } from "./computer-store.ts";

export const CHART_SETTINGS_KEY = "tentacle.charts";
export const CHART_SETTINGS_VERSION = 1;

export interface ChartSettings {
  readonly labels: LabelMode;
}

export const DEFAULT_CHART_SETTINGS: ChartSettings = { labels: "inside" };

export interface ChartSettingsRead {
  readonly settings: ChartSettings;
  /** `false`: a record this build cannot read — never written over. */
  readonly writable: boolean;
}

export class ChartSettingsPreserved extends Error {
  constructor() {
    super("a newer build's Charts setting is on this phone — left untouched");
    this.name = "ChartSettingsPreserved";
  }
}

function parse(raw: string | null): ChartSettingsRead {
  if (raw === null) return { settings: DEFAULT_CHART_SETTINGS, writable: true };
  const unreadable = { settings: DEFAULT_CHART_SETTINGS, writable: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unreadable;
  }
  if (typeof parsed !== "object" || parsed === null) return unreadable;
  const r = parsed as { v?: unknown; labels?: unknown };
  if (r.v !== CHART_SETTINGS_VERSION || (r.labels !== "inside" && r.labels !== "legend")) {
    return unreadable;
  }
  return { settings: { labels: r.labels }, writable: true };
}

export interface ChartSettingsStore {
  /** Never rejects: a read error reads the defaults (and refuses later writes). */
  read(): Promise<ChartSettingsRead>;
  /** Rejects on a write error, or with `ChartSettingsPreserved` over an unreadable record. */
  write(settings: ChartSettings): Promise<void>;
}

export function createChartSettingsStore(deps: {
  readonly kv: SecureKV;
  readonly keychainAccessible: number;
}): ChartSettingsStore {
  let preserved = false;
  return {
    async read() {
      let raw: string | null;
      try {
        raw = await deps.kv.get(CHART_SETTINGS_KEY);
      } catch {
        preserved = true;
        return { settings: DEFAULT_CHART_SETTINGS, writable: false };
      }
      const read = parse(raw);
      preserved = !read.writable;
      return read;
    },
    async write(settings) {
      if (preserved) throw new ChartSettingsPreserved();
      await deps.kv.set(
        CHART_SETTINGS_KEY,
        JSON.stringify({ v: CHART_SETTINGS_VERSION, ...settings }),
        { keychainAccessible: deps.keychainAccessible },
      );
    },
  };
}

/**
 * The app's in-memory copy (one per app). A write that FAILS still publishes the
 * pick — the reader sees the mode they chose for this run — while a preserved
 * record refuses and changes nothing.
 */
export interface ChartSettingsHolder {
  current(): ChartSettings;
  /** False over a record this build cannot read (the Settings row is disabled). */
  writable(): boolean;
  load(): Promise<void>;
  set(next: ChartSettings): Promise<void>;
  subscribe(listener: (settings: ChartSettings) => void): () => void;
}

export function createChartSettingsHolder(store: ChartSettingsStore): ChartSettingsHolder {
  let current = DEFAULT_CHART_SETTINGS;
  let writable = true;
  const listeners = new Set<(settings: ChartSettings) => void>();
  const publish = (next: ChartSettings) => {
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
      if (!writable) throw new ChartSettingsPreserved();
      try {
        await store.write(next);
      } finally {
        publish(next);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
