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
  startAttempts: number[] = [];
  startDictation = async (o: { engine: Engine; locale: string; attempt: number }) => {
    this.calls.push(`start:${o.engine}:${o.locale}`);
    this.startAttempts.push(o.attempt);
  };
  stopDictation = () => {
    this.calls.push("stop");
  };
  cancelDictation = (attempt: number) => {
    this.calls.push(`cancel:${attempt}`);
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
  let attempt = 0; // per-setup ids keep the assertions below absolute
  const voice = createVoiceController({
    nextAttempt: () => {
      attempt += 1;
      return attempt;
    },
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

  test("a tap while the native start is pending, then the start resolves → that attempt is cancelled (review r1 #1)", async () => {
    const s = setup();
    let resolveStart: () => void = () => {};
    s.port.startDictation = (o) => {
      s.port.calls.push(`start:${o.engine}:${o.locale}`);
      s.port.startAttempts.push(o.attempt);
      return new Promise<void>((r) => {
        resolveStart = r;
      });
    };
    s.voice.tapMic();
    await flush();
    expect(s.port.startAttempts).toEqual([1]);
    s.voice.tapMic(); // cancel while start() is pending
    expect(s.port.calls.at(-1)).toBe("cancel:1");
    resolveStart(); // the native start lands after the cancel: a live mic nobody listens to
    await flush();
    expect(s.voice.state().dictation.kind).toBe("idle");
    expect(s.port.calls.filter((c) => c === "cancel:1").length).toBe(2);
    expect(s.port.calls).not.toContain("haptic:start");
    expect(s.timers.length).toBe(0);
  });

  test("a stale ended from an older attempt does not end the current dictation", async () => {
    const s = setup();
    await listening(s);
    s.port.fire({ type: "ended", reason: "cancelled", attempt: 0 });
    expect(s.voice.state().dictation.kind).toBe("listening");
    s.port.fire({ type: "ended", reason: "stopped", attempt: 1 });
    expect(s.voice.state().dictation.kind).toBe("idle");
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

    const on = setup({ readAloud: true, readAloudButton: true });
    await on.voice.turnEnded({ ownTurn: true, focused: true, rows });
    expect(on.port.spoken[0]?.utterances).toEqual(["Done, the file is saved."]);
    on.voice.permissionAsked({ title: "Run a shell command" }, 7, true);
    expect(on.port.spoken.at(-1)?.utterances).toEqual([
      "Permission needed: Run a shell command. Answer on screen.",
    ]);
  });

  test("'Read replies aloud' on but the Beta switch OFF speaks nothing (docs/feat/mobile-voice-hidden.md)", async () => {
    const rows = [
      { kind: "user", key: "u", text: "q" },
      { kind: "assistant", key: "a", text: "Done, the file is saved." },
    ];
    const s = setup({ readAloud: true, readAloudButton: false });
    await s.voice.turnEnded({ ownTurn: true, focused: true, rows });
    s.voice.permissionAsked({ title: "Run a shell command" }, 2, true);
    expect(s.port.spoken).toEqual([]);
    expect(s.port.calls).not.toContain("stopSpeaking");
  });
});

describe("the Beta switches going OFF stop what they were running (docs/feat/mobile-voice-hidden.md)", () => {
  test("Dictation off while listening ends the dictation: no stuck 'listening', nothing sent", async () => {
    const s = setup({ dictation: true });
    await listening(s);
    s.port.fire({ type: "dictation", finalDelta: "ciao", volatile: "" });
    expect(s.drafts.at(-1)).toBe("typed ciao");
    // Settings → Beta → Dictation went off (App calls this on every change).
    s.voice.settingsChanged({ ...DEFAULT_VOICE_SETTINGS, dictation: true }, DEFAULT_VOICE_SETTINGS);
    expect(s.voice.state().dictation.kind).not.toBe("listening");
    expect(s.port.calls.at(-1)).toBe("stop");
    s.port.fire({ type: "ended", reason: "stopped" });
    expect(s.voice.state().dictation.kind).toBe("idle");
    // Ending a dictation this way must never send the transcript.
    expect(s.sends).toEqual([]);
    expect(s.timers.length).toBe(0);
  });

  test("Read aloud off while speaking stops the speech", async () => {
    const s = setup({ readAloud: true, readAloudButton: true });
    await s.voice.tapSpeak({ key: "a", text: "hello there" });
    expect(s.voice.state().readAloud.kind).toBe("speaking");
    s.voice.settingsChanged(
      { ...DEFAULT_VOICE_SETTINGS, readAloud: true, readAloudButton: true },
      { ...DEFAULT_VOICE_SETTINGS, readAloud: true, readAloudButton: false },
    );
    expect(s.voice.state().readAloud.kind).toBe("idle");
    expect(s.port.calls.at(-1)).toBe("stopSpeaking");
  });

  test("Dictation off while an on-device model downloads: never starts behind the hidden mic", async () => {
    // Review round 1, finding 1, end to end: `preparing{downloading}` is the slow
    // state (a model download), and the switch can go off during it.
    const s = setup({ dictation: true });
    s.port.caps = {
      os: 26,
      analyzer: { transcriber: true, dictation: true, assets: { "en-US": "supported" } },
      recognizer: { "en-US": { supported: true, onDevice: true } },
      permissions: CAPS.permissions,
    };
    let finishInstall: () => void = () => {};
    s.port.installAsset = (engine, locale) => {
      s.port.calls.push(`installAsset:${engine}:${locale}`);
      return new Promise<void>((r) => {
        finishInstall = r;
      });
    };
    s.voice.tapMic();
    await flush();
    await flush();
    expect(s.voice.state().dictation).toMatchObject({ kind: "preparing", phase: "downloading" });
    s.voice.settingsChanged({ ...DEFAULT_VOICE_SETTINGS, dictation: true }, DEFAULT_VOICE_SETTINGS);
    expect(s.voice.state().dictation.kind).toBe("idle");
    expect(s.port.calls).toContain("cancel:1");
    // The download finishing late must not start a recognizer nobody can see.
    finishInstall();
    await flush();
    await flush();
    expect(s.voice.state().dictation.kind).toBe("idle");
    expect(s.port.calls.filter((c) => c.startsWith("start:"))).toEqual([]);
    expect(s.timers.length).toBe(0);
  });

  test("a change that turns nothing off leaves a running dictation alone", async () => {
    const s = setup({ dictation: true });
    await listening(s);
    const before = s.port.calls.length;
    s.voice.settingsChanged(
      { ...DEFAULT_VOICE_SETTINGS, dictation: true },
      { ...DEFAULT_VOICE_SETTINGS, dictation: true, rate: "fast" },
    );
    expect(s.voice.state().dictation.kind).toBe("listening");
    expect(s.port.calls.length).toBe(before);
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
    expect(s.port.calls.slice(-1)).toEqual(["cancel:1"]);
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

describe("attempt ids across screens (review r2: remount regression)", () => {
  /** Models `SpeechCore.swift`: ONE per process, its guards never reset. */
  class NativeGuardPort extends FakeSpeechPort {
    cancelledThrough = 0;
    newestStart = 0;
    override startDictation = async (o: { engine: Engine; locale: string; attempt: number }) => {
      this.startAttempts.push(o.attempt);
      if (o.attempt <= this.cancelledThrough || o.attempt <= this.newestStart) {
        throw Object.assign(new Error("cancelled"), { code: "cancelled" });
      }
      this.newestStart = o.attempt;
    };
    override cancelDictation = (attempt: number) => {
      this.calls.push(`cancel:${attempt}`);
      this.cancelledThrough = Math.max(this.cancelledThrough, attempt);
    };
  }

  const screen = (port: SpeechPort) =>
    createVoiceController({
      port,
      now: () => 0,
      draft: () => "",
      setDraft: () => {},
      send: () => {},
      settings: () => DEFAULT_VOICE_SETTINGS,
      deviceLocales: () => ["en-US"],
      every: () => ({ cancel: () => {} }),
    });

  test("a second session screen's first tap still starts dictation (process-unique ids)", async () => {
    const port = new NativeGuardPort();
    const first = screen(port);
    first.tapMic();
    await flush();
    await flush();
    expect(first.state().dictation.kind).toBe("listening");
    first.dispose(); // leaves the screen: cancels its attempt natively
    const second = screen(port);
    second.tapMic();
    await flush();
    await flush();
    expect(second.state().dictation.kind).toBe("listening");
    const [a, b] = port.startAttempts;
    expect(port.startAttempts.length).toBe(2);
    expect(a !== undefined && b !== undefined && b > a).toBe(true);
  });
});
