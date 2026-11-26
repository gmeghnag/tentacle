/**
 * The Activity button setting, on disk (docs/feat/mobile-chrome.md Design 6,
 * S10): a versioned record `{v:1, mode, position?}` behind the `SecureKV` port —
 * the `voice-settings-store.ts` pattern, so this module has no native import.
 *
 * Fail-safe rules, each pinned by a test (F22):
 * - an unreadable, missing or unknown-version record reads the DEFAULTS
 *   ("floating" at 80 %, no position — docs/feat/mobile-hub-defaults.md; was
 *   "header" until 2026-11-18). A READABLE record keeps what it says: a phone
 *   that stored "header" stays on the header pill;
 * - an unknown `v` (or bytes that are not the record) is left untouched: a
 *   write over it is refused (`ActivitySettingsPreserved`), and Settings says
 *   this build cannot change it;
 * - a bad `position` inside our own v1 record drops the position only (the
 *   button goes back to its default spot; the mode is kept);
 * - a bad `opacity` (docs/feat/mobile-hub-opacity.md) drops the opacity only and
 *   a number snaps to the nearest of the 20 · 40 · 60 · 80 · 100 steps
 *   (`snapOpacity`): the button is never invisible.
 * - a bad `listEndAboveHub` (docs/feat/mobile-hub-center.md D2) drops that field
 *   only, so the setting reads ON — `listEndOn`, the one place its default is;
 * - a write failure rejects, so Settings says "didn't save" — the holder keeps
 *   the pick in memory for this run.
 */
import type { SecureKV } from "./computer-store.ts";
import type { ActivityButtonMode, FloatPosition } from "./floating-button.ts";
import { OPACITY_FIRST_RUN, snapOpacity } from "./hub-opacity.ts";

export const ACTIVITY_SETTINGS_KEY = "tentacle.activity-button";
export const ACTIVITY_SETTINGS_VERSION = 1;

export interface ActivitySettings {
  readonly mode: ActivityButtonMode;
  /** Where the floating button rests; absent → its default spot. */
  readonly position?: FloatPosition;
  /**
   * How see-through the floating button is at rest: one of the steps
   * 20 · 40 · 60 · 80 · 100; absent in a stored record → 100 (the look it had). ADDITIVE inside the same v1 record: an
   * older build ignores it and its next write drops it, which is safer than a
   * `v` bump, where every older build would refuse to write at all (rule 2).
   */
  readonly opacity?: number;
  /**
   * Whether the chat's end stops above a hub resting in the band's lower half
   * (owner 6, docs/feat/mobile-hub-center.md D6): absent → ON, today's
   * behaviour — the one place that default lives is `listEndOn` below. ADDITIVE
   * inside the same v1 record, the `opacity` precedent.
   */
  readonly listEndAboveHub?: boolean;
}

/**
 * A phone with NO readable record (owner 2026-11-18): the floating hub, at 80 %.
 * Only the absence of a choice gets it — a stored record, `"header"` included,
 * and a stored record without an opacity (→ 100) read as they always did.
 */
export const DEFAULT_ACTIVITY_SETTINGS: ActivitySettings = {
  mode: "floating",
  opacity: OPACITY_FIRST_RUN,
};

export interface ActivitySettingsRead {
  readonly settings: ActivitySettings;
  /** `false`: a record this build cannot read — never written over. */
  readonly writable: boolean;
}

export class ActivitySettingsPreserved extends Error {
  constructor() {
    super("a newer build's Activity button setting is on this phone — left untouched");
    this.name = "ActivitySettingsPreserved";
  }
}

function parsePosition(value: unknown): FloatPosition | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const p = value as { edge?: unknown; yFraction?: unknown };
  if (p.edge !== "left" && p.edge !== "center" && p.edge !== "right") {
    return undefined;
  }
  if (typeof p.yFraction !== "number" || !(p.yFraction >= 0 && p.yFraction <= 1)) {
    return undefined;
  }
  return { edge: p.edge, yFraction: p.yFraction };
}

/**
 * Whether the chat's end stops above the hub (owner 6): absent means ON, which
 * is the behaviour before this setting existed. Read through this, never the raw
 * field, so the default lives in ONE place.
 */
export function listEndOn(settings: ActivitySettings): boolean {
  return settings.listEndAboveHub ?? true;
}

function parseOpacity(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? snapOpacity(value) : undefined;
}

function parse(raw: string | null): ActivitySettingsRead {
  if (raw === null) {
    return { settings: DEFAULT_ACTIVITY_SETTINGS, writable: true };
  }
  const unreadable = { settings: DEFAULT_ACTIVITY_SETTINGS, writable: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unreadable;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return unreadable;
  }
  const r = parsed as {
    v?: unknown;
    mode?: unknown;
    position?: unknown;
    opacity?: unknown;
    listEndAboveHub?: unknown;
  };
  if (r.v !== ACTIVITY_SETTINGS_VERSION || (r.mode !== "header" && r.mode !== "floating")) {
    return unreadable;
  }
  const position = parsePosition(r.position);
  const opacity = parseOpacity(r.opacity);
  // A bad value drops THIS field only: the setting then reads ON (the default).
  const listEndAboveHub = typeof r.listEndAboveHub === "boolean" ? r.listEndAboveHub : undefined;
  return {
    settings: {
      mode: r.mode,
      ...(position === undefined ? {} : { position }),
      ...(opacity === undefined ? {} : { opacity }),
      ...(listEndAboveHub === undefined ? {} : { listEndAboveHub }),
    },
    writable: true,
  };
}

export interface ActivitySettingsStore {
  /** Never rejects: a read error reads the defaults (and refuses later writes). */
  read(): Promise<ActivitySettingsRead>;
  /** Rejects on a write error, or with `ActivitySettingsPreserved` over an unreadable record. */
  write(settings: ActivitySettings): Promise<void>;
}

export function createActivitySettingsStore(deps: {
  readonly kv: SecureKV;
  readonly keychainAccessible: number;
}): ActivitySettingsStore {
  let preserved = false;
  return {
    async read() {
      let raw: string | null;
      try {
        raw = await deps.kv.get(ACTIVITY_SETTINGS_KEY);
      } catch {
        preserved = true;
        return { settings: DEFAULT_ACTIVITY_SETTINGS, writable: false };
      }
      const read = parse(raw);
      preserved = !read.writable;
      return read;
    },
    async write(settings) {
      if (preserved) {
        throw new ActivitySettingsPreserved();
      }
      await deps.kv.set(
        ACTIVITY_SETTINGS_KEY,
        JSON.stringify({ v: ACTIVITY_SETTINGS_VERSION, ...settings }),
        { keychainAccessible: deps.keychainAccessible },
      );
    },
  };
}

/**
 * The app's in-memory copy (one per app). Unlike the voice holder, a write that
 * FAILS still publishes the pick (F22: "the mode in memory stays what the user
 * picked for this run"); only a preserved record refuses and changes nothing.
 */
export interface ActivitySettingsHolder {
  current(): ActivitySettings;
  /** False over a record this build cannot read (the Settings row is disabled). */
  writable(): boolean;
  load(): Promise<void>;
  set(next: ActivitySettings): Promise<void>;
  subscribe(listener: (settings: ActivitySettings) => void): () => void;
}

export function createActivitySettingsHolder(store: ActivitySettingsStore): ActivitySettingsHolder {
  let current = DEFAULT_ACTIVITY_SETTINGS;
  let writable = true;
  const listeners = new Set<(settings: ActivitySettings) => void>();
  const publish = (next: ActivitySettings) => {
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
        throw new ActivitySettingsPreserved();
      }
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
