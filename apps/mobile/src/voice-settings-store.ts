/**
 * The voice settings, on disk (docs/feat/mobile-voice.md Design §3): a versioned
 * record `{v:2, dictation, readAloud, readAloudButton, language, rate}` behind the
 * `SecureKV` port — the `lock-settings-store.ts` pattern, so this module has no
 * native import.
 *
 * Four fail-safe rules, each pinned by a test:
 * - an unreadable, missing or unknown-version record reads the DEFAULTS
 *   (`dictation: false`, `readAloud: false`, `readAloudButton: false`, `auto`,
 *   `normal`) — no voice feature is ever switched on by a broken store;
 * - the Beta switches (docs/feat/mobile-voice-hidden.md) are what turn the voice
 *   UI on: off, nothing voice-related renders and the mic permission is never
 *   asked (it is asked only when a dictation starts);
 * - a **v1** record is MIGRATED on read: `readAloud`/`language`/`rate` kept,
 *   both Beta switches OFF, and writable — an upgrade never loses a choice;
 * - an unknown `v` (or bytes that are not the record) is left untouched: a
 *   write over it is refused (`VoiceSettingsPreserved`);
 * - a write failure rejects, so Settings says "didn't save".
 */
import type { SecureKV } from "./computer-store.ts";
import type { SpeechRate } from "./read-aloud.ts";
import type { LanguageSetting } from "./speech-locale.ts";

export const VOICE_SETTINGS_KEY = "tentacle.voice";
export const VOICE_SETTINGS_VERSION = 2;
/** The version this build MIGRATES on read: its choices are kept, the Beta switches off. */
export const VOICE_SETTINGS_VERSION_V1 = 1;

export interface VoiceSettings {
  /** Settings → Beta: the composer's mic button (off by default). */
  readonly dictation: boolean;
  /** Settings → Beta: the speaker button on assistant rows (off by default). */
  readonly readAloudButton: boolean;
  readonly readAloud: boolean;
  readonly language: LanguageSetting;
  readonly rate: SpeechRate;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  dictation: false,
  readAloud: false,
  readAloudButton: false,
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
  const r = parsed as {
    v?: unknown;
    dictation?: unknown;
    readAloud?: unknown;
    readAloudButton?: unknown;
    language?: unknown;
    rate?: unknown;
  };
  if (typeof r.language !== "string" || !LANGUAGES.includes(r.language)) {
    return unreadable;
  }
  if (typeof r.rate !== "string" || !RATES.includes(r.rate)) {
    return unreadable;
  }
  if (r.v === VOICE_SETTINGS_VERSION_V1) {
    // The owner's phone today: v1 knows read-aloud but not the Beta switches, so
    // both start OFF and the record becomes writable (a migration, not a loss).
    if (typeof r.readAloud !== "boolean") {
      return unreadable;
    }
    return {
      settings: {
        dictation: false,
        readAloud: r.readAloud,
        readAloudButton: false,
        language: r.language as LanguageSetting,
        rate: r.rate as SpeechRate,
      },
      writable: true,
    };
  }
  if (
    r.v !== VOICE_SETTINGS_VERSION ||
    typeof r.dictation !== "boolean" ||
    typeof r.readAloudButton !== "boolean" ||
    typeof r.readAloud !== "boolean"
  ) {
    return unreadable;
  }
  return {
    settings: {
      dictation: r.dictation,
      readAloud: r.readAloud,
      readAloudButton: r.readAloudButton,
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
