/**
 * `voice-controller.ts` with a `FakeSpeechPort` (docs/feat/mobile-voice.md
 * Design §4, Tests): effects reach the port in order, `setDraft` reaches the
 * compose seam, dispose removes the listener (F13).
 */
import { describe, expect, test } from "bun:test";
import type { SendVia } from "../src/dictation.ts";
import type {
  Capabilities,
  Engine,
  Permissions,
  SpeechPort,
  SpeechPortEvent,
} from "../src/speech-native.ts";
import { createVoiceController } from "../src/voice-controller.ts";
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from "../src/voice-settings-store.ts";

const CAPS: Capabilities = {
  os: 18,
  recognizer: {
    "en-US": { supported: true, onDevice: true },
    "it-IT": { supported: true, onDevice: true },
  },
  permissions: { mic: "granted", speech: "authorized" },
};

class FakeSpeechPort implements SpeechPort {
  calls: string[] = [];
  spoken: { id: number; utterances: readonly string[] }[] = [];
  listeners = new Set<(e: SpeechPortEvent) => void>();
  caps: Capabilities = CAPS;
  capabilities = async (locales: readonly string[]) => {
    this.calls.push(`capabilities:${locales.join(",")}`);
    return this.caps;
  };
  requestPermissions = async (): Promise<Permissions> => {
    this.calls.push("requestPermissions");
    return CAPS.permissions;
  };
  installAsset = async (engine: Engine, locale: string) => {
    this.calls.push(`installAsset:${engine}:${locale}`);
  };
  reserveLocale = async (locale: string) => {
    this.calls.push(`reserve:${locale}`);
    return true;
  };
  startDictation = async (o: { engine: Engine; locale: string }) => {
    this.calls.push(`start:${o.engine}:${o.locale}`);
  };
  stopDictation = () => {
    this.calls.push("stop");
  };
  cancelDictation = () => {
    this.calls.push("cancel");
  };
  voices = async () => [
    { id: "alice", language: "it-IT", name: "Alice", quality: "enhanced" as const, novelty: false },
    { id: "ava", language: "en-US", name: "Ava", quality: "premium" as const, novelty: false },
  ];
  speak = (o: { id: number; utterances: readonly string[] }) => {
    this.calls.push(`speak:${o.id}`);
    this.spoken.push({ id: o.id, utterances: o.utterances });
  };
  stopSpeaking = () => {
    this.calls.push("stopSpeaking");
  };
  haptic = (kind: string) => {
    this.calls.push(`haptic:${kind}`);
  };
  addListener(listener: (e: SpeechPortEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  fire(event: SpeechPortEvent) {
    for (const l of [...this.listeners]) l(event);
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(settings: Partial<VoiceSettings> = {}) {
  const port = new FakeSpeechPort();
  let draft = "typed";
  const drafts: string[] = [];
  const sends: SendVia[] = [];
  let clock = 0;
  const timers: (() => void)[] = [];
  const voice = createVoiceController({
    port,
    now: () => clock,
    draft: () => draft,
    setDraft: (t) => {
      draft = t;
      drafts.push(t);
    },
    send: (via) => sends.push(via),
    settings: () => ({ ...DEFAULT_VOICE_SETTINGS, ...settings }),
    deviceLocales: () => ["en-US"],
    every: (fn) => {
      timers.push(fn);
      return { cancel: () => timers.splice(timers.indexOf(fn), 1) };
    },
  });
  return {
    port,
    voice,
    drafts,
    sends,
    timers,
    advance(ms: number) {
      clock += ms;
      for (const t of [...timers]) t();
    },
  };
}

async function listening(s: ReturnType<typeof setup>) {
  s.voice.tapMic();
  await flush();
  await flush();
  expect(s.voice.state().dictation.kind).toBe("listening");
}

describe("dictation through the port", () => {
  test("tap → capabilities → stopSpeaking? no (idle) → start, haptic; text reaches setDraft", async () => {
    const s = setup();
    await listening(s);
    expect(s.port.calls).toEqual([
      "capabilities:en-US,it-IT",
      "start:recognizer:en-US",
      "haptic:start",
    ]);
    s.port.fire({ type: "dictation", finalDelta: "", volatile: "hello" });
    s.port.fire({ type: "dictation", finalDelta: "hello world", volatile: "" });
    expect(s.drafts).toEqual(["typed hello", "typed hello world"]);
  });

  test("Send while listening is captured; the compose send runs after ended", async () => {
    const s = setup();
    expect(s.voice.send("press")).toBe(false);
    await listening(s);
    expect(s.voice.send("return")).toBe(true);
    expect(s.port.calls.at(-1)).toBe("stop");
    expect(s.sends).toEqual([]);
    s.port.fire({ type: "ended", reason: "stopped" });
    expect(s.sends).toEqual(["return"]);
    expect(s.timers.length).toBe(0);
  });

  test("the injected ticker auto-stops after 20 s of silence", async () => {
    const s = setup();
    await listening(s);
    expect(s.timers.length).toBe(1);
    s.advance(19_999);
    expect(s.port.calls).not.toContain("stop");
    s.advance(1);
    expect(s.port.calls.at(-1)).toBe("stop");
  });

  test("a start failure surfaces as a card, never stuck preparing", async () => {
    const s = setup();
    s.port.startDictation = async () => {
      throw Object.assign(new Error("x"), { code: "not-on-device" });
    };
    s.voice.tapMic();
    await flush();
    await flush();
    const d = s.voice.state().dictation;
    expect(d.kind).toBe("failed");
    expect(s.port.calls.at(-1)).toBe("haptic:error");
  });
});

describe("read-aloud through the port", () => {
  test("tap speaks with the detected language's voice; tap again stops", async () => {
    const s = setup();
    await s.voice.tapSpeak({ key: "a", text: "The tests pass and the build is green." });
    expect(s.port.spoken).toEqual([
      { id: 1, utterances: ["The tests pass and the build is green."] },
    ]);
    await s.voice.tapSpeak({ key: "a", text: "x" });
    expect(s.port.calls.at(-1)).toBe("stopSpeaking");
  });

  test("starting dictation stops speech BEFORE the mic starts (F11)", async () => {
    const s = setup();
    await s.voice.tapSpeak({ key: "a", text: "hello there" });
    await listening(s);
    const c = s.port.calls;
    expect(c.indexOf("stopSpeaking")).toBeGreaterThan(-1);
    expect(c.indexOf("stopSpeaking")).toBeLessThan(c.indexOf("start:recognizer:en-US"));
  });

  test("auto-read: on only with the setting; the spoken ask has the title only", async () => {
    const rows = [
      { kind: "user", key: "u", text: "q" },
      { kind: "assistant", key: "a", text: "Done, the file is saved." },
    ];
    const off = setup();
    await off.voice.turnEnded({ ownTurn: true, focused: true, rows });
    off.voice.permissionAsked({ title: "Run a shell command" }, 1, true);
    expect(off.port.spoken).toEqual([]);

    const on = setup({ readAloud: true });
    await on.voice.turnEnded({ ownTurn: true, focused: true, rows });
    expect(on.port.spoken[0]?.utterances).toEqual(["Done, the file is saved."]);
    on.voice.permissionAsked({ title: "Run a shell command" }, 7, true);
    expect(on.port.spoken.at(-1)?.utterances).toEqual([
      "Permission needed: Run a shell command. Answer on screen.",
    ]);
  });
});

describe("dispose (F13)", () => {
  test("removes the port listener, cancels, stops; late events are ignored", async () => {
    const s = setup();
    await s.voice.tapSpeak({ key: "a", text: "hello there" });
    await listening(s);
    const before = s.drafts.length;
    s.voice.dispose();
    expect(s.port.listeners.size).toBe(0);
    expect(s.port.calls.slice(-1)).toEqual(["cancel"]);
    expect(s.timers.length).toBe(0);
    s.port.fire({ type: "dictation", finalDelta: "late", volatile: "" });
    expect(s.drafts.length).toBe(before);
  });

  test("dispose while speaking stops the speech", async () => {
    const s = setup();
    await s.voice.tapSpeak({ key: "a", text: "hello there" });
    s.voice.dispose();
    expect(s.port.calls.at(-1)).toBe("stopSpeaking");
  });
});
