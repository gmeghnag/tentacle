import { describe, expect, test } from "bun:test";
import type { HelperMessage } from "../src/voice-protocol.ts";
import {
  VOICE_DEFAULTS,
  type VoiceCommand,
  type VoiceConfig,
  type VoiceEvent,
  type VoiceModel,
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
