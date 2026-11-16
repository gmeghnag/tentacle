/**
 * The photo settings, on disk (fix/mobile-media-live item 5): a versioned
 * record `{v:1, sendOriginal}` behind the `SecureKV` port — the
 * `voice-settings-store.ts` pattern, so this module has no native import and
 * every rule is testable without a simulator.
 *
 * One decision, `sendOriginal`, and three fail-safe rules (each pinned by a
 * test):
 * - **absent, unreadable or unknown-version reads `sendOriginal: false`** — the
 *   downscale ON. A photo a person did not ask to send full-size is the smaller
 *   one: it is what makes the turn fast and the upload short, and the switch is
 *   the way out.
 * - **an unknown `v` is never overwritten**: a newer build's record is read as
 *   the default and left untouched (the repo's versioned-record discipline).
 * - **a write REJECTS on a store error**, so the caller keeps the decision in
 *   memory for this run instead of believing it landed.
 */
import type { SecureKV } from "./computer-store.ts";

/** The Keychain key the switch lives under (one item: this phone's decision). */
export const PHOTO_SETTINGS_KEY = "tentacle.photos";

/** The record version this build writes AND reads. */
export const PHOTO_SETTINGS_VERSION = 1;

export interface PhotoSettings {
  /** Settings → "Send photos at original size" (off by default). */
  readonly sendOriginal: boolean;
}

export const DEFAULT_PHOTO_SETTINGS: PhotoSettings = { sendOriginal: false };

/** What a read concluded: the settings to use, and whether the record is safe to overwrite. */
export interface PhotoSettingsRead {
  readonly settings: PhotoSettings;
  /**
   * `false` for a record this build cannot read (an unknown `v`, or bytes that
   * are not the record): the caller must NOT write over it.
   */
  readonly writable: boolean;
}

/** The stored record, or why it cannot be used. */
function parse(raw: string | null): PhotoSettingsRead {
  if (raw === null) {
    // Absent: a fresh install. Nothing to preserve, so writing is fine.
    return { settings: DEFAULT_PHOTO_SETTINGS, writable: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Garbage: not ours, so left untouched, like an unknown version (safe side).
    return { settings: DEFAULT_PHOTO_SETTINGS, writable: false };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { settings: DEFAULT_PHOTO_SETTINGS, writable: false };
  }
  const record = parsed as { v?: unknown; sendOriginal?: unknown };
  if (record.v !== PHOTO_SETTINGS_VERSION) {
    // Unknown version (older or newer): read the default, write nothing.
    return { settings: DEFAULT_PHOTO_SETTINGS, writable: false };
  }
  if (typeof record.sendOriginal !== "boolean") {
    return { settings: DEFAULT_PHOTO_SETTINGS, writable: false };
  }
  return { settings: { sendOriginal: record.sendOriginal }, writable: true };
}

export interface PhotoSettingsDeps {
  readonly kv: SecureKV;
  /** The Keychain accessibility class to write with (injected: no native import here). */
  readonly keychainAccessible: number;
}

/** The store, plus what this build learnt about the record it read. */
export interface PhotoSettingsStore {
  /** The stored settings (or the defaults). Never rejects: the row renders at launch. */
  read(): Promise<PhotoSettingsRead>;
  /** Persist a decision. Rejects on a write error (the caller keeps it in memory). */
  write(settings: PhotoSettings): Promise<void>;
}

export class PhotoSettingsPreserved extends Error {
  constructor() {
    super("a newer build's photo settings are on this phone — left untouched");
    this.name = "PhotoSettingsPreserved";
  }
}

/**
 * The store over one `SecureKV` item. A READ error resolves the defaults and
 * marks the record unwritable — a Keychain this build cannot read is no
 * evidence of a decision, and writing over it would destroy a newer build's.
 */
export function createPhotoSettingsStore(deps: PhotoSettingsDeps): PhotoSettingsStore {
  let preserved = false;
  return {
    async read() {
      let raw: string | null;
      try {
        raw = await deps.kv.get(PHOTO_SETTINGS_KEY);
      } catch {
        preserved = true;
        return { settings: DEFAULT_PHOTO_SETTINGS, writable: false };
      }
      const read = parse(raw);
      preserved = !read.writable;
      return read;
    },
    async write(settings) {
      if (preserved) {
        // A newer (or unreadable) record is still there: never overwritten.
        throw new PhotoSettingsPreserved();
      }
      await deps.kv.set(
        PHOTO_SETTINGS_KEY,
        JSON.stringify({ v: PHOTO_SETTINGS_VERSION, sendOriginal: settings.sendOriginal }),
        { keychainAccessible: deps.keychainAccessible },
      );
    },
  };
}

/**
 * The app's ONE in-memory copy, loaded at launch and read synchronously by the
 * photo port (a pick must not await a Keychain read) — the
 * `voice-settings-store.ts` holder's shape, minus the listeners: nothing
 * renders the value except Settings, which re-reads on mount.
 */
export interface PhotoSettingsHolder {
  current(): PhotoSettings;
  /** Load the stored value (a launch, or Settings' mount). Never rejects. */
  load(): Promise<void>;
  /** Persist a decision and adopt it; throws only for a write that did not stick. */
  set(settings: PhotoSettings): Promise<void>;
  /** Whether the record can be written at all (a newer build's is not). */
  writable(): boolean;
}

export function createPhotoSettingsHolder(store: PhotoSettingsStore): PhotoSettingsHolder {
  let current = DEFAULT_PHOTO_SETTINGS;
  let writable = true;
  return {
    current: () => current,
    writable: () => writable,
    async load() {
      const read = await store.read();
      current = read.settings;
      writable = read.writable;
    },
    async set(settings) {
      await store.write(settings);
      current = settings;
      writable = true;
    },
  };
}
