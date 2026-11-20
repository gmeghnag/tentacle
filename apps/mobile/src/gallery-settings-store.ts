/**
 * The gallery's look, remembered on this device (docs/feat/mobile-gallery-polish.md):
 * a versioned record `{v:1, layout}` behind the `SecureKV` port — the
 * `chart-settings-store.ts` shape and fail-safe rules, so this module has no
 * native import (`gallery-settings-expo.ts` is the wiring).
 *
 * Its OWN record (`tentacle.gallery`): a view preference has nothing to do with
 * the Charts setting, and a build that ships one must not have to read the other.
 *
 * - an unreadable, missing or unknown-version record reads the DEFAULT (list);
 * - an unknown `v` (or bytes that are not the record) is left untouched: a write
 *   over it is refused (`GallerySettingsPreserved`), the toggle still switches
 *   the look for this run;
 * - a write failure rejects — the holder keeps the pick in memory for this run.
 */
import type { SecureKV } from "./computer-store.ts";
import { DEFAULT_GALLERY_LAYOUT, type GalleryLayout } from "./gallery-layout.ts";

export const GALLERY_SETTINGS_KEY = "tentacle.gallery";
export const GALLERY_SETTINGS_VERSION = 1;

export interface GallerySettings {
  readonly layout: GalleryLayout;
}

export const DEFAULT_GALLERY_SETTINGS: GallerySettings = { layout: DEFAULT_GALLERY_LAYOUT };

export interface GallerySettingsRead {
  readonly settings: GallerySettings;
  /** `false`: a record this build cannot read — never written over. */
  readonly writable: boolean;
}

export class GallerySettingsPreserved extends Error {
  constructor() {
    super("a newer build's gallery setting is on this phone — left untouched");
    this.name = "GallerySettingsPreserved";
  }
}

function parse(raw: string | null): GallerySettingsRead {
  if (raw === null) return { settings: DEFAULT_GALLERY_SETTINGS, writable: true };
  const unreadable = { settings: DEFAULT_GALLERY_SETTINGS, writable: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unreadable;
  }
  if (typeof parsed !== "object" || parsed === null) return unreadable;
  const r = parsed as { v?: unknown; layout?: unknown };
  if (r.v !== GALLERY_SETTINGS_VERSION || (r.layout !== "list" && r.layout !== "grid")) {
    return unreadable;
  }
  return { settings: { layout: r.layout }, writable: true };
}

export interface GallerySettingsStore {
  /** Never rejects: a read error reads the default (and refuses later writes). */
  read(): Promise<GallerySettingsRead>;
  /** Rejects on a write error, or with `GallerySettingsPreserved` over an unreadable record. */
  write(settings: GallerySettings): Promise<void>;
}

export function createGallerySettingsStore(deps: {
  readonly kv: SecureKV;
  readonly keychainAccessible: number;
}): GallerySettingsStore {
  let preserved = false;
  return {
    async read() {
      let raw: string | null;
      try {
        raw = await deps.kv.get(GALLERY_SETTINGS_KEY);
      } catch {
        preserved = true;
        return { settings: DEFAULT_GALLERY_SETTINGS, writable: false };
      }
      const read = parse(raw);
      preserved = !read.writable;
      return read;
    },
    async write(settings) {
      if (preserved) throw new GallerySettingsPreserved();
      await deps.kv.set(
        GALLERY_SETTINGS_KEY,
        JSON.stringify({ v: GALLERY_SETTINGS_VERSION, ...settings }),
        { keychainAccessible: deps.keychainAccessible },
      );
    },
  };
}

/**
 * The app's in-memory copy. `load` reads the record ONCE per run (the gallery
 * asks on every open; later calls return the same read). A pick always switches
 * the look for this run, even when the write fails or is refused.
 */
export interface GallerySettingsHolder {
  current(): GallerySettings;
  load(): Promise<void>;
  /** Rejects when the pick was not saved (it is still published). */
  set(next: GallerySettings): Promise<void>;
  subscribe(listener: (settings: GallerySettings) => void): () => void;
}

export function createGallerySettingsHolder(store: GallerySettingsStore): GallerySettingsHolder {
  let current = DEFAULT_GALLERY_SETTINGS;
  let writable = true;
  let loading: Promise<void> | null = null;
  let picked = false;
  const listeners = new Set<(settings: GallerySettings) => void>();
  const publish = (next: GallerySettings) => {
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
      if (!writable) throw new GallerySettingsPreserved();
      await store.write(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
