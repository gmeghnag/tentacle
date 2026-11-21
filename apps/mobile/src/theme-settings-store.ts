/**
 * The Figtree try-out switch, remembered on this device (docs/feat/mobile-theme-beta.md):
 * a versioned record `{v:2, figtree}` behind the `SecureKV` port — the
 * `gallery-settings-store.ts` shape and fail-safe rules, so this module has no
 * native import (`theme-settings-expo.ts` is the wiring).
 *
 * Its OWN record (`tentacle.theme`): the voice Beta record is versioned for the
 * voice switches, and a build that ships one must not have to read the other.
 *
 * - an unreadable, missing or unknown-version record reads the DEFAULT (OFF):
 *   a broken store never turns the try-out on;
 * - an unknown `v` (or bytes that are not the record) is left untouched: a write
 *   over it is refused (`ThemeSettingsPreserved`), the switch still changes the
 *   look for this run;
 * - a write failure rejects — the holder keeps the pick in memory for this run.
 */
import type { SecureKV } from "./computer-store.ts";
import { DEFAULT_THEME_BETA, type ThemeBeta } from "./theme-beta.ts";

export const THEME_SETTINGS_KEY = "tentacle.theme";
export const THEME_SETTINGS_VERSION = 2;
/** The Lato try-out's `{v:1, lato}` — an older build's, not a newer one's. */
const SUPERSEDED_THEME_SETTINGS_VERSION = 1;

export type ThemeSettings = ThemeBeta;

export const DEFAULT_THEME_SETTINGS: ThemeSettings = DEFAULT_THEME_BETA;

export interface ThemeSettingsRead {
  readonly settings: ThemeSettings;
  /** `false`: a record this build cannot read — never written over. */
  readonly writable: boolean;
}

export class ThemeSettingsPreserved extends Error {
  constructor() {
    super("a newer build's theme setting is on this phone — left untouched");
    this.name = "ThemeSettingsPreserved";
  }
}

function parse(raw: string | null): ThemeSettingsRead {
  if (raw === null) return { settings: DEFAULT_THEME_SETTINGS, writable: true };
  const unreadable = { settings: DEFAULT_THEME_SETTINGS, writable: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unreadable;
  }
  if (typeof parsed !== "object" || parsed === null) return unreadable;
  const r = parsed as { v?: unknown; figtree?: unknown };
  // The Lato build's v1 record is superseded (Owner decision 2026-11-21): the
  // switch resets to OFF and the next pick replaces it.
  if (r.v === SUPERSEDED_THEME_SETTINGS_VERSION) {
    return { settings: DEFAULT_THEME_SETTINGS, writable: true };
  }
  if (r.v !== THEME_SETTINGS_VERSION || typeof r.figtree !== "boolean") {
    return unreadable;
  }
  return { settings: { figtree: r.figtree }, writable: true };
}

export interface ThemeSettingsStore {
  /** Never rejects: a read error reads the default (and refuses later writes). */
  read(): Promise<ThemeSettingsRead>;
  /** Rejects on a write error, or with `ThemeSettingsPreserved` over an unreadable record. */
  write(settings: ThemeSettings): Promise<void>;
}

export function createThemeSettingsStore(deps: {
  readonly kv: SecureKV;
  readonly keychainAccessible: number;
}): ThemeSettingsStore {
  let preserved = false;
  return {
    async read() {
      let raw: string | null;
      try {
        raw = await deps.kv.get(THEME_SETTINGS_KEY);
      } catch {
        preserved = true;
        return { settings: DEFAULT_THEME_SETTINGS, writable: false };
      }
      const read = parse(raw);
      preserved = !read.writable;
      return read;
    },
    async write(settings) {
      if (preserved) throw new ThemeSettingsPreserved();
      await deps.kv.set(
        THEME_SETTINGS_KEY,
        JSON.stringify({ v: THEME_SETTINGS_VERSION, ...settings }),
        { keychainAccessible: deps.keychainAccessible },
      );
    },
  };
}

/**
 * The app's in-memory copy. `load` reads the record ONCE per run (at launch;
 * later calls return the same read). A pick always switches
 * the look for this run, even when the write fails or is refused.
 */
export interface ThemeSettingsHolder {
  current(): ThemeSettings;
  load(): Promise<void>;
  /** Rejects when the pick was not saved (it is still published). */
  set(next: ThemeSettings): Promise<void>;
  subscribe(listener: (settings: ThemeSettings) => void): () => void;
}

export function createThemeSettingsHolder(store: ThemeSettingsStore): ThemeSettingsHolder {
  let current = DEFAULT_THEME_SETTINGS;
  let writable = true;
  let loading: Promise<void> | null = null;
  let picked = false;
  const listeners = new Set<(settings: ThemeSettings) => void>();
  const publish = (next: ThemeSettings) => {
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
      if (!writable) throw new ThemeSettingsPreserved();
      await store.write(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
