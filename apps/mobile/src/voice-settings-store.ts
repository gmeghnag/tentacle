/**
 * The voice settings, on disk (docs/feat/mobile-voice.md Design §3): a versioned
 * record `{v:1, readAloud, language, rate}` behind the `SecureKV` port — the
 * `lock-settings-store.ts` pattern, so this module has no native import.
 *
 * Three fail-safe rules, each pinned by a test:
 * - an unreadable, missing or unknown-version record reads the DEFAULTS
 *   (`readAloud: false`, `auto`, `normal`) — read-aloud is never switched on by
 *   a broken store;
 * - an unknown `v` (or bytes that are not the record) is left untouched: a
 *   write over it is refused (`VoiceSettingsPreserved`);
 * - a write failure rejects, so Settings says "didn't save".
 */
import type { SecureKV } from "./computer-store.ts";
import type { SpeechRate } from "./read-aloud.ts";
import type { LanguageSetting } from "./speech-locale.ts";

export const VOICE_SETTINGS_KEY = "tentacle.voice";
export const VOICE_SETTINGS_VERSION = 1;

export interface VoiceSettings {
  readonly readAloud: boolean;
  readonly language: LanguageSetting;
  readonly rate: SpeechRate;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  readAloud: false,
  language: "auto",
  rate: "normal",
};

export interface VoiceSettingsRead {
  readonly settings: VoiceSettings;
  /** `false`: a record this build cannot read — never written over. */
  readonly writable: boolean;
}

export class VoiceSettingsPreserved extends Error {
  constructor() {
    super("a newer build's voice settings are on this phone — left untouched");
    this.name = "VoiceSettingsPreserved";
  }
}

const LANGUAGES: readonly string[] = ["auto", "it-IT", "en-US"];
const RATES: readonly string[] = ["normal", "fast"];

function parse(raw: string | null): VoiceSettingsRead {
  if (raw === null) {
    return { settings: DEFAULT_VOICE_SETTINGS, writable: true };
  }
  const unreadable = { settings: DEFAULT_VOICE_SETTINGS, writable: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unreadable;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return unreadable;
  }
  const r = parsed as { v?: unknown; readAloud?: unknown; language?: unknown; rate?: unknown };
  if (
    r.v !== VOICE_SETTINGS_VERSION ||
    typeof r.readAloud !== "boolean" ||
    typeof r.language !== "string" ||
    !LANGUAGES.includes(r.language) ||
    typeof r.rate !== "string" ||
    !RATES.includes(r.rate)
  ) {
    return unreadable;
  }
  return {
    settings: {
      readAloud: r.readAloud,
      language: r.language as LanguageSetting,
      rate: r.rate as SpeechRate,
    },
    writable: true,
  };
}

export interface VoiceSettingsStore {
  /** Never rejects: a read error reads the defaults (and refuses later writes). */
  read(): Promise<VoiceSettingsRead>;
  /** Rejects on a write error, or with `VoiceSettingsPreserved` over an unreadable record. */
  write(settings: VoiceSettings): Promise<void>;
}

/**
 * The app's in-memory copy (one per app): screens read `current()` synchronously,
 * Settings writes through `set`, which changes `current` ONLY after the write
 * landed (a refused or failed write rejects and leaves it as it was).
 */
export interface VoiceSettingsHolder {
  current(): VoiceSettings;
  load(): Promise<void>;
  set(next: VoiceSettings): Promise<void>;
  subscribe(listener: (settings: VoiceSettings) => void): () => void;
}

export function createVoiceSettingsHolder(store: VoiceSettingsStore): VoiceSettingsHolder {
  let current = DEFAULT_VOICE_SETTINGS;
  const listeners = new Set<(settings: VoiceSettings) => void>();
  const publish = (next: VoiceSettings) => {
    current = next;
    for (const l of listeners) {
      l(next);
    }
  };
  return {
    current: () => current,
    async load() {
      publish((await store.read()).settings);
    },
    async set(next) {
      await store.write(next);
      publish(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function createVoiceSettingsStore(deps: {
  readonly kv: SecureKV;
  readonly keychainAccessible: number;
}): VoiceSettingsStore {
  let preserved = false;
  return {
    async read() {
      let raw: string | null;
      try {
        raw = await deps.kv.get(VOICE_SETTINGS_KEY);
      } catch {
        preserved = true;
        return { settings: DEFAULT_VOICE_SETTINGS, writable: false };
      }
      const read = parse(raw);
      preserved = !read.writable;
      return read;
    },
    async write(settings) {
      if (preserved) {
        throw new VoiceSettingsPreserved();
      }
      await deps.kv.set(
        VOICE_SETTINGS_KEY,
        JSON.stringify({ v: VOICE_SETTINGS_VERSION, ...settings }),
        { keychainAccessible: deps.keychainAccessible },
      );
    },
  };
}
