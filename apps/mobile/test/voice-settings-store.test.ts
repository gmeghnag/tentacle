/**
 * `voice-settings-store.ts` — round-trip and the three fail-safe rules
 * (docs/feat/mobile-voice.md Design §3), copied from `lock-settings-store.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import type { SecureKV } from "../src/computer-store.ts";
import {
  DEFAULT_VOICE_SETTINGS,
  VOICE_SETTINGS_KEY,
  type VoiceSettings,
  VoiceSettingsPreserved,
  createVoiceSettingsHolder,
  createVoiceSettingsStore,
} from "../src/voice-settings-store.ts";

function fake(initial: string | null = null, opts: { failGet?: boolean; failSet?: boolean } = {}) {
  const items = new Map<string, string>();
  if (initial !== null) {
    items.set(VOICE_SETTINGS_KEY, initial);
  }
  let writes = 0;
  const kv: SecureKV = {
    get: async (key) => {
      if (opts.failGet === true) throw new Error("keychain locked");
      return items.get(key) ?? null;
    },
    set: async (key, value) => {
      if (opts.failSet === true) throw new Error("disk full");
      writes += 1;
      items.set(key, value);
    },
    delete: async (key) => {
      items.delete(key);
    },
  };
  const store = createVoiceSettingsStore({ kv, keychainAccessible: 6 });
  return { store, items, writes: () => writes };
}

describe("round-trip", () => {
  test("a written record reads back", async () => {
    const f = fake();
    expect((await f.store.read()).settings).toEqual(DEFAULT_VOICE_SETTINGS);
    const s: VoiceSettings = {
      dictation: true,
      readAloud: true,
      readAloudButton: true,
      language: "it-IT",
      rate: "fast",
    };
    await f.store.write(s);
    expect(await f.store.read()).toEqual({ settings: s, writable: true });
    expect(JSON.parse(f.items.get(VOICE_SETTINGS_KEY) ?? "")).toEqual({ v: 2, ...s });
  });
});

/**
 * docs/feat/mobile-voice-hidden.md: the voice features are opt-in Beta switches,
 * OFF by default, and an install from before the Beta is MIGRATED (never lost).
 */
describe("the Beta switches", () => {
  test("both default OFF — nothing voice-related runs on a fresh install", async () => {
    expect(DEFAULT_VOICE_SETTINGS.dictation).toBe(false);
    expect(DEFAULT_VOICE_SETTINGS.readAloudButton).toBe(false);
    expect((await fake().store.read()).settings).toEqual({
      dictation: false,
      readAloud: false,
      readAloudButton: false,
      language: "auto",
      rate: "normal",
    });
  });

  test("a v1 record (the owner's phone) migrates: choices kept, both switches off, writable", async () => {
    const v1 = JSON.stringify({ v: 1, readAloud: true, language: "it-IT", rate: "fast" });
    const f = fake(v1);
    expect(await f.store.read()).toEqual({
      settings: {
        dictation: false,
        readAloud: true,
        readAloudButton: false,
        language: "it-IT",
        rate: "fast",
      },
      writable: true,
    });
    // The first write upgrades the record: v2, with the switches as real fields.
    await f.store.write({ ...DEFAULT_VOICE_SETTINGS, dictation: true });
    expect(JSON.parse(f.items.get(VOICE_SETTINGS_KEY) ?? "")).toEqual({
      v: 2,
      ...DEFAULT_VOICE_SETTINGS,
      dictation: true,
    });
  });

  test("a v1 record that is otherwise bogus is still refused, not migrated", async () => {
    const raw = JSON.stringify({ v: 1, readAloud: "yes", language: "auto", rate: "normal" });
    const f = fake(raw);
    expect(await f.store.read()).toEqual({ settings: DEFAULT_VOICE_SETTINGS, writable: false });
    expect(f.items.get(VOICE_SETTINGS_KEY)).toBe(raw);
  });
});

describe("fail-safe", () => {
  for (const [name, raw] of [
    ["garbage", "{not json"],
    [
      "unknown v (a newer build)",
      JSON.stringify({
        v: 3,
        dictation: true,
        readAloud: true,
        readAloudButton: true,
        language: "auto",
        rate: "fast",
      }),
    ],
    ["bad field", JSON.stringify({ v: 2, readAloud: "yes", language: "auto", rate: "normal" })],
    [
      "bad Beta field",
      JSON.stringify({ v: 2, dictation: "on", readAloud: false, language: "auto", rate: "fast" }),
    ],
    [
      "unknown language",
      JSON.stringify({ v: 1, readAloud: true, language: "fr-FR", rate: "normal" }),
    ],
  ] as const) {
    test(`${name} → defaults (read-aloud off), not writable, bytes untouched`, async () => {
      const f = fake(raw);
      expect(await f.store.read()).toEqual({ settings: DEFAULT_VOICE_SETTINGS, writable: false });
      await expect(f.store.write(DEFAULT_VOICE_SETTINGS)).rejects.toBeInstanceOf(
        VoiceSettingsPreserved,
      );
      expect(f.items.get(VOICE_SETTINGS_KEY)).toBe(raw);
      expect(f.writes()).toBe(0);
    });
  }

  test("a read error → defaults, never rejects", async () => {
    const f = fake(null, { failGet: true });
    expect(await f.store.read()).toEqual({ settings: DEFAULT_VOICE_SETTINGS, writable: false });
  });

  test("a write failure rejects (Settings says didn't save)", async () => {
    const f = fake(null, { failSet: true });
    await f.store.read();
    await expect(f.store.write(DEFAULT_VOICE_SETTINGS)).rejects.toThrow("disk full");
  });
});

describe("holder", () => {
  test("load publishes the stored record; set changes current only after the write lands", async () => {
    const stored = JSON.stringify({
      v: 2,
      dictation: true,
      readAloud: true,
      readAloudButton: true,
      language: "en-US",
      rate: "normal",
    });
    const ok = fake(stored);
    const holder = createVoiceSettingsHolder(ok.store);
    const seen: boolean[] = [];
    holder.subscribe((s) => seen.push(s.readAloud));
    expect(holder.current().readAloud).toBe(false);
    await holder.load();
    expect(holder.current()).toEqual({
      dictation: true,
      readAloud: true,
      readAloudButton: true,
      language: "en-US",
      rate: "normal",
    });
    await holder.set({ ...holder.current(), rate: "fast" });
    expect(holder.current().rate).toBe("fast");
    expect(seen).toEqual([true, true]);
  });

  test("a failed write rejects and leaves current unchanged", async () => {
    const bad = fake(null, { failSet: true });
    const holder = createVoiceSettingsHolder(bad.store);
    await holder.load();
    await expect(holder.set({ ...DEFAULT_VOICE_SETTINGS, readAloud: true })).rejects.toThrow();
    expect(holder.current().readAloud).toBe(false);
  });
});
