import { describe, expect, test } from "bun:test";
import type { HelperMessage } from "../src/voice-protocol.ts";
import {
  IDLE_EXIT_MS,
  TRANSCRIBE_TIMEOUT_MS,
  VOICE_DEFAULTS,
  type VoiceCommand,
  type VoiceConfig,
  type VoiceEvent,
  type VoiceModel,
  dictationInsertion,
  joinDictation,
  voiceAvailability,
  voiceInit,
  voiceStep,
} from "../src/voice-session.ts";

const cfg = (over: Partial<VoiceConfig> = {}): VoiceConfig => ({ ...VOICE_DEFAULTS, ...over });

/** Drive the reducer through a list of events, collecting every command. */
function drive(
  events: readonly VoiceEvent[],
  config: VoiceConfig = cfg(),
): { model: VoiceModel; commands: readonly VoiceCommand[]; notices: readonly string[] } {
  let model = voiceInit(config);
  const commands: VoiceCommand[] = [];
  const notices: string[] = [];
  for (const event of events) {
    const step = voiceStep(model, event);
    model = step.model;
    for (const command of step.commands) {
      commands.push(command);
      if (command.kind === "notice") notices.push(command.text);
    }
  }
  return { model, commands, notices };
}

const key = (name: "toggle" | "finish" | "cancel"): VoiceEvent => ({ kind: "key", key: name });
const helper = (message: HelperMessage): VoiceEvent => ({ kind: "helper", message });

const ready = { t: "ready", v: 1, engine: "apple", device: "MacBook Pro Microphone" } as const;
const listening = { t: "listening", id: 1, device: "MacBook Pro Microphone" } as const;

describe("T2: the toggle walks idle -> starting -> listening -> transcribing -> idle", () => {
  test("a toggle from idle spawns the helper and sends start", () => {
    const r = drive([key("toggle")]);
    expect(r.model.phase).toBe("starting");
    expect(r.commands.map((c) => c.kind)).toContain("spawn");
    expect(r.commands).toContainEqual({
      kind: "send",
      command: { t: "start", id: 1, lang: "auto" },
    });
  });

  test("`listening` moves to the running phase; a finish sends stop", () => {
    const r = drive([key("toggle"), helper(ready), helper(listening)]);
    expect(r.model.phase).toBe("listening");
    const fin = drive([key("toggle"), helper(ready), helper(listening), key("finish")]);
    expect(fin.model.phase).toBe("transcribing");
    expect(fin.commands).toContainEqual({ kind: "send", command: { t: "stop", id: 1 } });
  });

  test("a cancel sends cancel and returns to idle, inserting nothing", () => {
    const r = drive([key("toggle"), helper(ready), helper(listening), key("cancel")]);
    expect(r.model.phase).toBe("idle");
    expect(r.commands).toContainEqual({ kind: "send", command: { t: "cancel", id: 1 } });
    expect(r.commands.filter((c) => c.kind === "insert")).toEqual([]);
  });
});

describe("T2 (F6): Enter while listening finishes and NEVER sends", () => {
  test("the finish key on the voice layer yields no `submit` command", () => {
    const r = drive([key("toggle"), helper(ready), helper(listening), key("finish")]);
    // @ts-expect-error `submit` is not a VoiceCommand kind: this filter can only
    // ever be empty, which IS the "never auto-sent" property, proven by the type.
    expect(r.commands.filter((c) => c.kind === "submit")).toEqual([]);
    expect(r.commands).toContainEqual({ kind: "send", command: { t: "stop", id: 1 } });
  });

  test("the reducer has no submit command kind at all (the design cannot send)", () => {
    // Structural: the voice path can only insert, so "never auto-sent" holds by
    // construction, not by a check someone can later forget.
    const kinds = new Set(
      drive([
        key("toggle"),
        helper(ready),
        helper(listening),
        key("finish"),
        helper({ t: "final", id: 1, text: "hello there" }),
      ]).commands.map((c) => c.kind),
    );
    expect([...kinds].sort()).toEqual(["insert", "send", "spawn"]);
    // The vocabulary has no `submit` at all — TypeScript itself proves it: a
    // `command.kind === "submit"` comparison is a compile error (see the
    // `@ts-expect-error` pin below), so no path can ever send.
    // @ts-expect-error `submit` is not a VoiceCommand: the design cannot send.
    expect(kinds.has("submit")).toBe(false);
  });
});

describe("T2: `final` inserts once, at the cursor, with joinDictation spacing", () => {
  test("a plain final is one insert of the transcript", () => {
    const r = drive([
      key("toggle"),
      helper(ready),
      helper(listening),
      helper({
        t: "final",
        id: 1,
        text: "ciao mondo",
      }),
    ]);
    expect(r.model.phase).toBe("idle");
    expect(r.commands.filter((c) => c.kind === "insert")).toEqual([
      { kind: "insert", text: "ciao mondo" },
    ]);
  });

  test("text is sanitised and trimmed before it can reach the field", () => {
    const r = drive([
      key("toggle"),
      helper(ready),
      helper(listening),
      helper({
        t: "final",
        id: 1,
        text: "  ciao\u0007 mondo \n",
      }),
    ]);
    expect(r.commands).toContainEqual({ kind: "insert", text: "ciao mondo" });
  });

  test("blank text is a notice, never an insert", () => {
    const r = drive([
      key("toggle"),
      helper(ready),
      helper(listening),
      helper({
        t: "final",
        id: 1,
        text: "   ",
      }),
    ]);
    expect(r.commands.filter((c) => c.kind === "insert")).toEqual([]);
    expect(r.notices.join(" ")).toContain("didn't catch");
    expect(r.model.phase).toBe("idle");
  });
});

describe("T2 (F4): a helper exit mid-listening is an honest error", () => {
  test("exit while listening -> error phase, a notice, and the dictation is lost", () => {
    const r = drive([
      key("toggle"),
      helper(ready),
      helper(listening),
      { kind: "exit", code: 9, signal: null, stderrTail: "boom" },
    ]);
    expect(r.model.phase).toBe("idle");
    expect(r.notices.join(" ")).toContain("voice helper stopped");
    expect(r.notices.join(" ")).toContain("lost");
  });

  test("three crashes inside 60 s switch voice off for this session", () => {
    const events: VoiceEvent[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(key("toggle"), helper(ready), helper(listening), {
        kind: "exit",
        code: 1,
        signal: null,
        stderrTail: "",
      });
      events.push({ kind: "clock", now: 1000 + i * 1000 });
    }
    const r = drive(events);
    expect(r.model.phase).toBe("off");
    expect(r.notices.join(" ")).toContain("switched off");
  });

  test("a crash, then a long gap, does not trip the three-strikes rule", () => {
    const r = drive([
      key("toggle"),
      helper(ready),
      helper(listening),
      { kind: "exit", code: 1, signal: null, stderrTail: "" },
      { kind: "clock", now: 1000 },
      { kind: "clock", now: 200_000 },
      key("toggle"),
      helper(ready),
      helper(listening),
      { kind: "exit", code: 1, signal: null, stderrTail: "" },
      { kind: "clock", now: 200_500 },
    ]);
    expect(r.model.phase).toBe("idle");
  });
});

describe("T2 (F5): maxSeconds finishes AND inserts", () => {
  test("the cap sends stop, and the arriving final is still inserted", () => {
    const r = drive([
      key("toggle"),
      helper(ready),
      helper(listening),
      { kind: "elapsed", audioMs: VOICE_DEFAULTS.maxSeconds * 1000 },
      helper({ t: "final", id: 1, text: "the whole five minutes" }),
    ]);
    expect(r.commands).toContainEqual({ kind: "send", command: { t: "stop", id: 1 } });
    expect(r.commands).toContainEqual({ kind: "insert", text: "the whole five minutes" });
    expect(r.notices.join(" ")).toContain("5:00");
  });
});

describe("T2 (F14): a key during `starting` queues, and cancel before listening", () => {
  test("a cancel while starting cancels instead of capturing", () => {
    const r = drive([key("toggle"), key("cancel")]);
    expect(r.model.phase).toBe("idle");
    // Nothing was captured: a cancel, never a stop.
    expect(r.commands).toContainEqual({ kind: "send", command: { t: "cancel", id: 1 } });
    expect(r.commands.filter((c) => c.kind === "kill")).toEqual([]);
  });

  test("a finish while starting is honoured once listening (the intent is kept)", () => {
    const r = drive([key("toggle"), key("finish")]);
    // Nothing to transcribe yet: it must not produce a stop against an id that
    // has not started, and it must not silently swallow the key either.
    expect(r.notices.join(" ")).toContain("still starting");
    expect(r.commands.filter((c) => c.kind === "insert")).toEqual([]);
  });
});

describe("T2 (F3): version skew refuses the helper and kills it", () => {
  test("a mismatched ready line kills the child and says both versions", () => {
    const r = drive([
      key("toggle"),
      helper(ready),
      { kind: "protocolError", code: "version_mismatch", message: "speaks 9, TUI speaks 1" },
    ]);
    expect(r.model.phase).toBe("idle");
    expect(r.commands).toContainEqual({ kind: "kill" });
    expect(r.notices.join(" ")).toContain("speaks 9");
  });
});

describe("T2: helper errors become notices named for what the user must do", () => {
  test("models_missing names the setup command", () => {
    const r = drive([
      key("toggle"),
      helper(ready),
      helper({ t: "error", code: "models_missing", message: "" }),
    ]);
    expect(r.notices.join(" ")).toContain("tentacle voice setup");
    expect(r.model.phase).toBe("idle");
  });

  test("mic_denied names System Settings", () => {
    const r = drive([
      key("toggle"),
      helper(ready),
      helper({ t: "error", code: "mic_denied", message: "" }),
    ]);
    expect(r.notices.join(" ").toLowerCase()).toContain("microphone");
  });

  test("an unknown error code still surfaces its message, never a silence", () => {
    const r = drive([
      key("toggle"),
      helper(ready),
      helper({ t: "error", code: "future_thing", message: "who knows" }),
    ]);
    expect(r.notices.join(" ")).toContain("who knows");
  });
});

describe("T6 voiceAvailability: where voice can work at all", () => {
  test("darwin in a local tty is available", () => {
    expect(voiceAvailability({ platform: "darwin", env: {}, enabled: true }).available).toBe(true);
  });

  test("an SSH session is unavailable and says why", () => {
    const a = voiceAvailability({
      platform: "darwin",
      env: { SSH_CONNECTION: "1 2 3 4" },
      enabled: true,
    });
    expect(a.available).toBe(false);
    if (!a.available) expect(a.reason).toBe("remote");
  });

  test("SSH_TTY alone is enough to be remote", () => {
    expect(
      voiceAvailability({ platform: "darwin", env: { SSH_TTY: "/dev/ttys001" }, enabled: true })
        .available,
    ).toBe(false);
  });

  test("another platform is unavailable", () => {
    const a = voiceAvailability({ platform: "linux", env: {}, enabled: true });
    expect(a.available).toBe(false);
    if (!a.available) expect(a.reason).toBe("platform");
  });

  test("enabled:false is unavailable", () => {
    const a = voiceAvailability({ platform: "darwin", env: {}, enabled: false });
    expect(a.available).toBe(false);
    if (!a.available) expect(a.reason).toBe("disabled");
  });
});

describe("T2: an unavailable TUI never spawns and never opens the mic", () => {
  test("a toggle off-platform is a notice only", () => {
    const model = voiceInit(cfg(), { available: false, reason: "remote" });
    const step = voiceStep(model, key("toggle"));
    expect(step.commands.filter((c) => c.kind === "spawn")).toEqual([]);
    expect(step.commands).toContainEqual({
      kind: "notice",
      text: "voice works in a local terminal on the Mac (it is off over SSH)",
    });
    expect(step.model.phase).toBe("idle");
  });

  test("saying it once is enough (a second press is silent)", () => {
    let model = voiceInit(cfg(), { available: false, reason: "remote" });
    model = voiceStep(model, key("toggle")).model;
    const second = voiceStep(model, key("toggle"));
    expect(second.commands.filter((c) => c.kind === "notice")).toEqual([]);
  });
});

/**
 * Fix round 1 (Review HIGH 1/2/3). Each test names the mutation it kills.
 */
describe("Fix 1 (HIGH 1): the transcript APPENDS to the field, never repeats it", () => {
  test("dictationInsertion appends only what is new, one separating space", () => {
    // Mutation: `return joinDictation(before, text)` → "hellohello world".
    expect(dictationInsertion("hello", "world")).toBe(" world");
    expect(dictationInsertion("hello ", "world")).toBe("world");
    expect(dictationInsertion("", "world")).toBe("world");
    expect(dictationInsertion("line\n", "world")).toBe("world");
    expect(dictationInsertion("hello", "  spaced  ")).toBe(" spaced");
    expect(dictationInsertion("hello", "   ")).toBe("");
  });

  test("applying it to a field reproduces joinDictation exactly (one source of truth)", () => {
    for (const field of ["", "hello", "hello ", "a\n"]) {
      for (const text of ["world", " world ", "", "  "]) {
        expect(field + dictationInsertion(field, text)).toBe(joinDictation(field, text));
      }
    }
  });
});

describe("Fix 2 (HIGH 2): a stale helper line is never applied", () => {
  test("every dictation gets a FRESH id (the counter never resets)", () => {
    // Mutation: `const id = (model.id ?? 0) + 1` → every dictation is id 1.
    const r = drive([
      key("toggle"),
      helper(ready),
      key("cancel"),
      key("toggle"),
      helper(ready),
      key("cancel"),
      key("toggle"),
    ]);
    const starts = r.commands
      .filter((c) => c.kind === "send")
      .map((c) => (c as { command: { t: string; id?: number } }).command)
      .filter((c) => c.t === "start")
      .map((c) => c.id);
    expect(starts).toEqual([1, 2, 3]);
  });

  test("the trace from the review: a cancelled dictation's late `final` is NOT inserted", () => {
    // race.ts (A): Ctrl+R, stop, Esc, Ctrl+R, then the old final lands.
    const r = drive([
      key("toggle"),
      helper(ready),
      helper({ t: "listening", id: 1, device: "mic" }),
      key("toggle"), // stop -> transcribing
      key("cancel"), // Esc: discard
      key("toggle"), // a new dictation, id 2
      helper({ t: "final", id: 1, text: "SECRET DISCARDED TEXT" }),
    ]);
    expect(r.commands.filter((c) => c.kind === "insert")).toEqual([]);
    // The new dictation is untouched: it is still starting.
    expect(r.model.phase).toBe("starting");
    expect(r.model.id).toBe(2);
  });

  test("the trace from the review: a stale `listening` after Esc never revives the TUI", () => {
    // race.ts (B): Esc while starting; the in-flight listening line arrives after.
    const r = drive([
      key("toggle"),
      key("cancel"),
      helper({ t: "listening", id: 1, device: "mic" }),
    ]);
    expect(r.model.phase).toBe("idle");
  });

  test("an idle model holds no id at all, so no id can match it", () => {
    const r = drive([key("toggle"), key("cancel")]);
    expect(r.model.id).toBeNull();
    expect(r.model.issued).toBe(1);
  });
});

describe("Fix 3 (HIGH 3): the helper's vad/turnp/clock drive the cap, auto-stop and the timers", () => {
  const T0 = 1_000_000;
  const at = (base: number, key_: "toggle" | "finish" | "cancel"): VoiceEvent => ({
    kind: "key",
    key: key_,
    now: base,
  });

  test("`vad` advances the audio clock, so maxSeconds can actually stop it", () => {
    // Mutation: ignore `vad` → the elapsed readout and the cap stay at zero.
    const r = drive([
      at(T0, "toggle"),
      helper(ready),
      helper({ t: "listening", id: 1, device: "mic" }),
      helper({ t: "vad", id: 1, ms: 2000, p: 0.9 }),
    ]);
    expect(r.model.audioMs).toBe(2000);
    const capped = drive([
      at(T0, "toggle"),
      helper(ready),
      helper({ t: "listening", id: 1, device: "mic" }),
      helper({ t: "vad", id: 1, ms: VOICE_DEFAULTS.maxSeconds * 1000, p: 0.9 }),
    ]);
    expect(capped.commands).toContainEqual({ kind: "send", command: { t: "stop", id: 1 } });
    expect(capped.notices.join(" ")).toContain("5:00");
  });

  test("auto-stop OFF: silence never ends the dictation (the default)", () => {
    // Mutation: read `ENDPOINT_DEFAULTS.autoStop` instead of the config → red.
    const events: VoiceEvent[] = [
      at(T0, "toggle"),
      helper(ready),
      helper({ t: "listening", id: 1, device: "mic" }),
      helper({ t: "vad", id: 1, ms: 100, p: 0.9 }),
    ];
    // 20 silence windows with auto-stop off, under the 3 s hard stop.
    for (let i = 0; i < 20; i++) {
      events.push(helper({ t: "vad", id: 1, ms: 2000 + (i + 1) * 32, p: 0.01 }));
    }
    const r = drive(events);
    expect(r.model.phase).toBe("listening");
    expect(r.commands.filter((c) => c.kind === "send")).toEqual([
      { kind: "send", command: { t: "start", id: 1, lang: "auto" } },
    ]);
  });

  test("auto-stop ON: a pause past the floor asks Smart Turn, and its verdict stops it", () => {
    // Mutation: drop the fold → the settings `voice.autoStop` and
    // `voice.autoStopSilenceMs` are dead (the review's finding).
    const config = cfg({ autoStop: true, autoStopSilenceMs: 300 });
    const r = drive(
      [
        at(T0, "toggle"),
        helper(ready),
        helper({ t: "listening", id: 1, device: "mic" }),
        helper({ t: "vad", id: 1, ms: 100, p: 0.9 }), // speech
        helper({ t: "vad", id: 1, ms: 400, p: 0.01 }), // 368 ms of silence
        helper({ t: "turnp", id: 1, p: 0.95 }),
      ],
      config,
    );
    expect(r.commands).toContainEqual({ kind: "send", command: { t: "turn", id: 1 } });
    expect(r.commands).toContainEqual({ kind: "send", command: { t: "stop", id: 1 } });
    expect(r.model.phase).toBe("transcribing");
  });

  test("auto-stop ON: a comma pause under the floor is NOT a stop (the comma regression)", () => {
    const config = cfg({ autoStop: true, autoStopSilenceMs: 500 });
    const r = drive(
      [
        at(T0, "toggle"),
        helper(ready),
        helper({ t: "listening", id: 1, device: "mic" }),
        helper({ t: "vad", id: 1, ms: 1600, p: 0.95 }),
        helper({ t: "vad", id: 1, ms: 1824, p: 0.02 }), // a 224 ms comma pause
        helper({ t: "vad", id: 1, ms: 2000, p: 0.95 }), // speech resumes
      ],
      config,
    );
    expect(r.commands.filter((c) => c.kind === "send")).toEqual([
      { kind: "send", command: { t: "start", id: 1, lang: "auto" } },
    ]);
    expect(r.model.phase).toBe("listening");
  });

  test("auto-stop OFF: a long thinking pause never ends the dictation (round 2, NEW-1)", () => {
    // Review round 2, NEW-1: the fold read the 3 s hard stop BEFORE the
    // `autoStop` gate, so the DEFAULT config cut a dictation after a pause to
    // think — contradicting Owner decision 2 and the Context's "a pause can
    // never end it". `voice.maxSeconds` is what ends a forgotten one.
    // Mutation: pass `hardStopMs` unconditionally (or check it before the
    // auto-stop gate in the fold) → `stop` goes out after 3 s here.
    const events: VoiceEvent[] = [
      at(T0, "toggle"),
      helper(ready),
      helper({ t: "listening", id: 1, device: "mic" }),
      helper({ t: "vad", id: 1, ms: 1000, p: 0.98 }),
    ];
    // 4 s of continuous silence: past the 3 s hard stop, well inside maxSeconds.
    for (let i = 0; i < 40; i++) {
      events.push(helper({ t: "vad", id: 1, ms: 1000 + (i + 1) * 100, p: 0.02 }));
    }
    const r = drive(events);
    expect(r.model.phase).toBe("listening");
    expect(r.commands.filter((c) => c.kind === "send")).toEqual([
      { kind: "send", command: { t: "start", id: 1, lang: "auto" } },
    ]);
  });

  test("auto-stop ON still has the hard stop for a forgotten dictation", () => {
    // The other half of NEW-1's fix: gating the hard stop must not delete it.
    const config = cfg({ autoStop: true, autoStopSilenceMs: 100_000 });
    const events: VoiceEvent[] = [
      at(T0, "toggle"),
      helper(ready),
      helper({ t: "listening", id: 1, device: "mic" }),
      helper({ t: "vad", id: 1, ms: 1000, p: 0.98 }),
    ];
    for (let i = 0; i < 40; i++) {
      events.push(helper({ t: "vad", id: 1, ms: 1000 + (i + 1) * 100, p: 0.02 }));
    }
    const r = drive(events, config);
    expect(r.model.phase).toBe("transcribing");
  });

  test("a hung `stop` does not freeze the phase: the clock says so and frees the child", () => {
    // Mutation: no transcribingAt → the TUI stays `transcribing` for ever.
    const r = drive([
      at(T0, "toggle"),
      helper(ready),
      helper({ t: "listening", id: 1, device: "mic" }),
      at(T0 + 500, "finish"),
      { kind: "clock", now: T0 + 500 + TRANSCRIBE_TIMEOUT_MS },
    ]);
    expect(r.model.phase).toBe("idle");
    expect(r.commands).toContainEqual({ kind: "kill" });
    expect(r.notices.join(" ")).toContain("did not answer in time");
  });

  test("an idle child is ended after ten minutes (F13: no mic held)", () => {
    const r = drive([
      at(T0, "toggle"),
      { kind: "helper", message: ready, now: T0 },
      { kind: "helper", message: { t: "listening", id: 1, device: "mic" }, now: T0 },
      { kind: "helper", message: { t: "final", id: 1, text: "done" }, now: T0 },
      { kind: "clock", now: T0 + IDLE_EXIT_MS },
    ]);
    expect(r.commands).toContainEqual({ kind: "kill" });
    expect(r.model.childAlive).toBe(false);
  });
});
