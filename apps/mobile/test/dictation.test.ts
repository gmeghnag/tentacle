/**
 * `dictation.ts` — the dictation state machine (docs/feat/mobile-voice.md
 * Design §2 rules, F1/F2/F5–F9/F11/F13). The clock is injected: every timed
 * event carries `now`.
 */
import { describe, expect, test } from "bun:test";
import {
  CAP_NOTICE,
  DICTATION_IDLE,
  type DictationEffect,
  type DictationEvent,
  type DictationState,
  FINALIZE_TIMEOUT_MS,
  HARD_CAP_MS,
  INTERRUPTED_NOTICE,
  ROUTE_NOTICE,
  SILENCE_NOTICE,
  SILENCE_STOP_MS,
  capturesSend,
  dictationReduce,
  downloadLine,
  draftOf,
  join,
  micButtonOf,
} from "../src/dictation.ts";
import type { Capabilities } from "../src/speech-native.ts";

const L = "it-IT";
const GRANTED = { mic: "granted", speech: "authorized" } as const;
const iOS18: Capabilities = {
  os: 18,
  recognizer: { [L]: { supported: true, onDevice: true } },
  permissions: GRANTED,
};

function run(events: DictationEvent[], from: DictationState = DICTATION_IDLE) {
  let state = from;
  const effects: DictationEffect[] = [];
  for (const event of events) {
    const step = dictationReduce(state, event);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

const types = (effects: readonly DictationEffect[]) => effects.map((e) => e.type);
const drafts = (effects: readonly DictationEffect[]) =>
  effects.flatMap((e) => (e.type === "setDraft" ? [e.text] : []));

/** tap → probe → start → started, from `draft`, at t=0. */
function listening(draft = "", caps: Capabilities = iOS18) {
  return run([
    { type: "tap", draft, locale: L, now: 0, attempt: 1 },
    { type: "probed", caps },
    { type: "started", now: 0, attempt: 1 },
  ]);
}

describe("draftOf separator rules", () => {
  test("a single space only when both sides are non-empty and no whitespace at the seam", () => {
    expect(join("", "b")).toBe("b");
    expect(join("a", "")).toBe("a");
    expect(join("a", "b")).toBe("a b");
    expect(join("a ", "b")).toBe("a b");
    expect(join("a\n", "b")).toBe("a\nb");
    expect(join("a", " b")).toBe("a b");
    expect(draftOf({ base: "Ciao", finals: "come stai", volatile: "oggi" })).toBe(
      "Ciao come stai oggi",
    );
    expect(draftOf({ base: "", finals: "", volatile: "" })).toBe("");
  });
});

describe("start path", () => {
  test("tap: haptic AT the tap, probes; granted + on-device recognizer → stopSpeaking, start, listening (no second haptic)", () => {
    const { state, effects } = listening();
    expect(effects).toEqual([
      { type: "haptic", kind: "start" },
      { type: "probe", locale: L },
      { type: "stopSpeaking" },
      { type: "start", engine: "recognizer", locale: L, attempt: 1 },
    ]);
    expect(state.kind).toBe("listening");
    expect(micButtonOf(state, true)).toBe("listening");
  });

  test("TTS is stopped BEFORE the mic starts (F11)", () => {
    const t = types(listening().effects);
    expect(t.indexOf("stopSpeaking")).toBeLessThan(t.indexOf("start"));
  });

  test("undetermined → requestPermissions; the grant then starts (one tap)", () => {
    const { state, effects } = run([
      { type: "tap", draft: "", locale: L, now: 0, attempt: 1 },
      {
        type: "probed",
        caps: { ...iOS18, permissions: { mic: "undetermined", speech: "notDetermined" } },
      },
      { type: "permissions", permissions: GRANTED },
    ]);
    expect(types(effects)).toEqual([
      "haptic",
      "probe",
      "requestPermissions",
      "stopSpeaking",
      "start",
    ]);
    expect(state.kind).toBe("preparing");
  });

  test("a denial mid-request never stays at asking: the card (F2)", () => {
    const { state } = run([
      { type: "tap", draft: "", locale: L, now: 0, attempt: 1 },
      {
        type: "probed",
        caps: { ...iOS18, permissions: { mic: "undetermined", speech: "notDetermined" } },
      },
      { type: "permissions", permissions: { mic: "denied", speech: "notDetermined" } },
    ]);
    expect(state).toMatchObject({ kind: "failed", view: { card: "denied-mic", settings: true } });
  });

  test("F1: supported but not on device → unavailable card, NO start effect", () => {
    const { state, effects } = run([
      { type: "tap", draft: "", locale: L, now: 0, attempt: 1 },
      {
        type: "probed",
        caps: { ...iOS18, recognizer: { [L]: { supported: true, onDevice: false } } },
      },
    ]);
    expect(types(effects)).not.toContain("start");
    expect(state).toMatchObject({ kind: "failed", view: { card: "unavailable" } });
  });

  test("F1: Swift's own not-on-device refusal → the unavailable card", () => {
    const { state } = run([
      { type: "tap", draft: "", locale: L, now: 0, attempt: 1 },
      { type: "probed", caps: iOS18 },
      { type: "ended", reason: "error", code: "not-on-device" },
    ]);
    expect(state).toMatchObject({ kind: "failed", view: { card: "unavailable" } });
    if (state.kind === "failed") {
      expect(state.view.message).toContain("Turn on Dictation");
    }
  });

  test("a failed capabilities read never leaves us at asking", () => {
    const { state, effects } = run([
      { type: "tap", draft: "", locale: L, now: 0, attempt: 1 },
      { type: "startFailed" },
    ]);
    expect(state.kind).toBe("failed");
    expect(effects.at(-1)).toEqual({ type: "haptic", kind: "error" });
  });

  test("returning to the app clears a card (a Settings grant is picked up, F2)", () => {
    const denied = run([
      { type: "tap", draft: "", locale: L, now: 0, attempt: 1 },
      { type: "probed", caps: { ...iOS18, permissions: { mic: "denied", speech: "authorized" } } },
    ]).state;
    expect(denied.kind).toBe("failed");
    expect(run([{ type: "appState", state: "active" }], denied).state.kind).toBe("idle");
  });
});

describe("iOS 26: reserve and download (F5)", () => {
  const ios26 = (asset: "installed" | "supported"): Capabilities => ({
    os: 26,
    analyzer: { transcriber: true, dictation: true, assets: { [L]: asset } },
    recognizer: { [L]: { supported: true, onDevice: true } },
    permissions: GRANTED,
  });

  test("installed → reserve → start transcriber", () => {
    const { effects } = run([
      { type: "tap", draft: "", locale: L, now: 0, attempt: 1 },
      { type: "probed", caps: ios26("installed") },
      { type: "reserved", ok: true },
    ]);
    expect(effects.slice(2)).toEqual([
      { type: "reserve", locale: L },
      { type: "stopSpeaking" },
      { type: "start", engine: "transcriber", locale: L, attempt: 1 },
    ]);
  });

  test("download: progress line, then start on install", () => {
    const mid = run([
      { type: "tap", draft: "", locale: L, now: 0, attempt: 1 },
      { type: "probed", caps: ios26("supported") },
      { type: "reserved", ok: true },
      { type: "assetProgress", fraction: 0.42 },
    ]);
    expect(types(mid.effects)).toContain("installAsset");
    expect(downloadLine(mid.state)).toBe("Downloading Italian speech model… 42 %");
    const done = run([{ type: "assetInstalled" }], mid.state);
    expect(types(done.effects)).toEqual(["stopSpeaking", "start"]);
  });

  test("download failure → failed card; the next tap retries", () => {
    const { state } = run([
      { type: "tap", draft: "", locale: L, now: 0, attempt: 1 },
      { type: "probed", caps: ios26("supported") },
      { type: "reserved", ok: true },
      { type: "assetFailed" },
    ]);
    expect(state.kind).toBe("failed");
    expect(
      types(run([{ type: "tap", draft: "", locale: L, now: 1, attempt: 1 }], state).effects),
    ).toEqual(["haptic", "probe"]);
  });

  test("reserve refused → falls back to the on-device recognizer", () => {
    const { effects } = run([
      { type: "tap", draft: "", locale: L, now: 0, attempt: 1 },
      { type: "probed", caps: ios26("installed") },
      { type: "reserved", ok: false },
    ]);
    expect(effects.at(-1)).toEqual({ type: "start", engine: "recognizer", locale: L, attempt: 1 });
  });

  test("a tap while preparing cancels", () => {
    const { state, effects } = run([
      { type: "tap", draft: "", locale: L, now: 0, attempt: 1 },
      { type: "probed", caps: ios26("supported") },
      { type: "reserved", ok: true },
      { type: "tap", draft: "", locale: L, now: 1, attempt: 1 },
    ]);
    expect(effects.at(-1)).toEqual({ type: "cancel", attempt: 1 });
    expect(state.kind).toBe("idle");
  });
});

describe("text while listening", () => {
  test("base is the draft at start: dictation appends to typed text", () => {
    const { effects } = run(
      [{ type: "dictation", finalDelta: "", volatile: "come", now: 1 }],
      listening("Ciao").state,
    );
    expect(drafts(effects)).toEqual(["Ciao come"]);
  });

  test("volatile is replaced, not appended; finals accumulate", () => {
    const { state, effects } = run(
      [
        { type: "dictation", finalDelta: "", volatile: "co", now: 1 },
        { type: "dictation", finalDelta: "", volatile: "come sta", now: 2 },
        { type: "dictation", finalDelta: "come stai", volatile: "", now: 3 },
        { type: "dictation", finalDelta: "", volatile: "oggi", now: 4 },
      ],
      listening().state,
    );
    expect(drafts(effects)).toEqual(["co", "come sta", "come stai", "come stai oggi"]);
    expect(state).toMatchObject({ finals: "come stai", volatile: "oggi" });
  });

  test("userEdit (the person typed) → cancel; the volatile is never re-appended (F8)", () => {
    const l = run(
      [{ type: "dictation", finalDelta: "hello", volatile: " wor", now: 1 }],
      listening().state,
    );
    const { state, effects } = run(
      [
        { type: "userEdit", text: "hello!" },
        { type: "dictation", finalDelta: "", volatile: "world", now: 2 },
        { type: "ended", reason: "cancelled" },
      ],
      l.state,
    );
    expect(effects).toEqual([{ type: "cancel", attempt: 1 }]);
    expect(state.kind).toBe("idle");
  });

  test("our own setDraft echoing through the field is not an edit", () => {
    const l = run(
      [{ type: "dictation", finalDelta: "hi", volatile: "", now: 1 }],
      listening().state,
    );
    expect(run([{ type: "userEdit", text: "hi" }], l.state).effects).toEqual([]);
  });
});

describe("stop and send", () => {
  const withText = () =>
    run([{ type: "dictation", finalDelta: "send", volatile: "this", now: 1 }], listening("x").state)
      .state;

  test("tap while listening → haptic at the tap, stop; ended promotes volatile to final (no second haptic)", () => {
    const { state, effects } = run(
      [
        { type: "tap", draft: "", locale: L, now: 2, attempt: 1 },
        { type: "ended", reason: "stopped" },
      ],
      withText(),
    );
    expect(effects).toEqual([
      { type: "haptic", kind: "stop" },
      { type: "stop" },
      { type: "setDraft", text: "x send this" },
    ]);
    expect(state).toEqual(DICTATION_IDLE);
  });

  test("Return while listening → finalize, then send (after ended)", () => {
    const s = withText();
    expect(capturesSend(s)).toBe(true);
    const { state, effects } = run(
      [
        { type: "send", via: "return", now: 2 },
        { type: "ended", reason: "stopped" },
      ],
      s,
    );
    // The Send press plays its own haptic (`pressHaptic`): dictation adds none.
    expect(types(effects)).toEqual(["stop", "setDraft", "send"]);
    expect(effects.at(-1)).toEqual({ type: "send", via: "return" });
    expect(state.kind).toBe("idle");
    expect(capturesSend(state)).toBe(false);
  });

  test("Send while listening: no ended within 1.5 s → finalize anyway, cancel, send", () => {
    const f = run([{ type: "send", via: "press", now: 10 }], withText()).state;
    expect(run([{ type: "tick", now: 10 + FINALIZE_TIMEOUT_MS - 1 }], f).effects).toEqual([]);
    const { effects } = run([{ type: "tick", now: 10 + FINALIZE_TIMEOUT_MS }], f);
    expect(types(effects)).toEqual(["cancel", "setDraft", "send"]);
    expect(drafts(effects)).toEqual(["x send this"]);
  });

  // fix/mobile-mic-send (owner 2026-11-20): "I stop and send, nothing happens".
  // Once the person asked to stop (a mic tap or Send), the engine's ending is the
  // END of that stop: an `error` / `cancelled` there must keep everything shown
  // and honour the pending Send — on the iOS 26 analyzer path the whole short
  // utterance is still volatile at the stop, so `finalsOnly` emptied the field.
  test("tap stop, then an engine ERROR while finalizing keeps everything shown (no card)", () => {
    const { state, effects } = run(
      [
        { type: "tap", draft: "", locale: L, now: 2, attempt: 1 },
        { type: "ended", reason: "error", attempt: 1 },
      ],
      withText(),
    );
    expect(drafts(effects)).toEqual(["x send this"]);
    expect(state).toEqual(DICTATION_IDLE);
  });

  test("Send pressed, then an engine ERROR or CANCELLED while finalizing: it still sends what was shown", () => {
    for (const reason of ["error", "cancelled"] as const) {
      const f = run([{ type: "send", via: "press", now: 2 }], withText()).state;
      const { state, effects } = run([{ type: "ended", reason, attempt: 1 }], f);
      expect(drafts(effects)).toEqual(["x send this"]);
      expect(effects.at(-1)).toEqual({ type: "send", via: "press" });
      expect(state).toEqual(DICTATION_IDLE);
    }
  });

  test("tap stop, Send while finalizing, then an ERROR: the Send is not dropped", () => {
    const { effects } = run(
      [
        { type: "tap", draft: "", locale: L, now: 2, attempt: 1 },
        { type: "send", via: "press", now: 3 },
        { type: "ended", reason: "error", attempt: 1 },
      ],
      withText(),
    );
    expect(drafts(effects)).toEqual(["x send this"]);
    expect(effects.at(-1)).toEqual({ type: "send", via: "press" });
  });

  test("F9: stop with no speech → draft stays the base, no send, no notice", () => {
    const { state, effects } = run(
      [
        { type: "tap", draft: "", locale: L, now: 1, attempt: 1 },
        { type: "ended", reason: "stopped" },
      ],
      listening("typed").state,
    );
    expect(drafts(effects)).toEqual(["typed"]);
    expect(types(effects)).not.toContain("send");
    expect(state).toEqual(DICTATION_IDLE);
  });
});

describe("timers (injected clock)", () => {
  test("20 s with no new text → stop with the silence notice", () => {
    const l = run(
      [{ type: "dictation", finalDelta: "", volatile: "hi", now: 5_000 }],
      listening().state,
    ).state;
    expect(run([{ type: "tick", now: 5_000 + SILENCE_STOP_MS - 1 }], l).effects).toEqual([]);
    const { state, effects } = run(
      [
        { type: "tick", now: 5_000 + SILENCE_STOP_MS },
        { type: "ended", reason: "stopped" },
      ],
      l,
    );
    expect(effects[0]).toEqual({ type: "stop" });
    expect(state).toEqual({ kind: "idle", notice: SILENCE_NOTICE });
  });

  test("10 min hard cap even while text keeps coming", () => {
    let s = listening().state;
    for (let t = 15_000; t < HARD_CAP_MS; t += 15_000) {
      s = run(
        [
          { type: "dictation", finalDelta: "w", volatile: "", now: t },
          { type: "tick", now: t },
        ],
        s,
      ).state;
      expect(s.kind).toBe("listening");
    }
    const { state } = run(
      [
        { type: "tick", now: HARD_CAP_MS },
        { type: "ended", reason: "stopped" },
      ],
      s,
    );
    expect(state).toEqual({ kind: "idle", notice: CAP_NOTICE });
  });
});

describe("interruptions, background, dispose", () => {
  const withText = () =>
    run([{ type: "dictation", finalDelta: "kept", volatile: "shown", now: 1 }], listening().state)
      .state;

  test("interrupted / route keep the text, notice, never send (F4)", () => {
    for (const [reason, notice] of [
      ["interrupted", INTERRUPTED_NOTICE],
      ["route", ROUTE_NOTICE],
    ] as const) {
      const { state, effects } = run([{ type: "ended", reason }], withText());
      expect(drafts(effects)).toEqual(["kept shown"]);
      expect(types(effects)).not.toContain("send");
      expect(state).toEqual({ kind: "idle", notice });
    }
  });

  test("an interruption while finalizing a send does not send", () => {
    const f = run([{ type: "send", via: "press", now: 2 }], withText()).state;
    expect(types(run([{ type: "ended", reason: "interrupted" }], f).effects)).not.toContain("send");
  });

  test("error keeps the finals, drops the volatile, shows a card", () => {
    const { state, effects } = run([{ type: "ended", reason: "error" }], withText());
    expect(drafts(effects)).toEqual(["kept"]);
    expect(state.kind).toBe("failed");
  });

  test("background → stop, text kept, idle (F6)", () => {
    for (const s of ["background", "inactive"] as const) {
      const { state, effects } = run([{ type: "appState", state: s }], withText());
      expect(effects[0]).toEqual({ type: "stop" });
      expect(drafts(effects)).toEqual(["kept shown"]);
      expect(state.kind).toBe("idle");
    }
  });

  test("read-aloud starting while listening stops dictation (F11)", () => {
    expect(run([{ type: "ttsStarting", now: 3 }], withText()).effects).toEqual([{ type: "stop" }]);
  });

  test("dispose → cancel; a late native event after dispose changes nothing (F13)", () => {
    const { state, effects } = run(
      [{ type: "dispose" }, { type: "dictation", finalDelta: "late", volatile: "", now: 9 }],
      withText(),
    );
    expect(effects).toEqual([{ type: "cancel", attempt: 1 }]);
    expect(state).toEqual(DICTATION_IDLE);
  });
});

/**
 * Review round 1, finding 1: a cancel while the native start is pending must
 * never leave the mic running. Every attempt carries an id (from `tap`); a
 * `started` that is not the current `preparing{starting}` is answered with a
 * `cancel` for ITS attempt, and a stale `ended` / `startFailed` is ignored.
 */
describe("start/cancel race (attempt ids)", () => {
  const starting = (attempt: number, from: DictationState = DICTATION_IDLE) =>
    run(
      [
        { type: "tap", draft: "", locale: L, now: 0, attempt },
        { type: "probed", caps: iOS18 },
      ],
      from,
    );
  const tapAgain = (state: DictationState, attempt: number) =>
    run([{ type: "tap", draft: "", locale: L, now: 1, attempt }], state);

  test("the start and cancel effects carry the attempt id", () => {
    const first = starting(1);
    expect(first.effects.at(-1)).toEqual({
      type: "start",
      engine: "recognizer",
      locale: L,
      attempt: 1,
    });
    expect(tapAgain(first.state, 2).effects).toEqual([
      { type: "haptic", kind: "stop" },
      { type: "cancel", attempt: 1 },
    ]);
  });

  test("a late started after a cancel (idle) → cancel that attempt", () => {
    const idle = tapAgain(starting(1).state, 2);
    expect(idle.state.kind).toBe("idle");
    const late = dictationReduce(idle.state, { type: "started", now: 2, attempt: 1 });
    expect(late.state.kind).toBe("idle");
    expect(late.effects).toEqual([{ type: "cancel", attempt: 1 }]);
  });

  test("a late started after backgrounding → cancel that attempt", () => {
    const gone = run([{ type: "appState", state: "background" }], starting(1).state);
    const late = dictationReduce(gone.state, { type: "started", now: 2, attempt: 1 });
    expect(late.effects).toEqual([{ type: "cancel", attempt: 1 }]);
  });

  test("a late started in failed → cancel that attempt; the card stays", () => {
    const failedState: DictationState = {
      kind: "failed",
      view: { action: "none", card: "unavailable", settings: false, message: "x" },
    };
    const late = dictationReduce(failedState, { type: "started", now: 2, attempt: 1 });
    expect(late.state).toEqual(failedState);
    expect(late.effects).toEqual([{ type: "cancel", attempt: 1 }]);
  });

  test("a stale started while the NEXT attempt is starting → cancel the stale one only", () => {
    const second = starting(3, tapAgain(starting(1).state, 2).state);
    const late = dictationReduce(second.state, { type: "started", now: 2, attempt: 1 });
    expect(late.state).toEqual(second.state);
    expect(late.effects).toEqual([{ type: "cancel", attempt: 1 }]);
    const own = dictationReduce(late.state, { type: "started", now: 3, attempt: 3 });
    expect(own.state.kind).toBe("listening");
  });

  test("a stale started while listening to the next attempt → cancel it, keep listening", () => {
    const live = run([{ type: "started", now: 0, attempt: 2 }], starting(2).state).state;
    const late = dictationReduce(live, { type: "started", now: 1, attempt: 1 });
    expect(late.state).toEqual(live);
    expect(late.effects).toEqual([{ type: "cancel", attempt: 1 }]);
  });

  test("a stale ended / startFailed does not end the current attempt", () => {
    const second = starting(2);
    const stale: DictationEvent[] = [
      { type: "ended", reason: "cancelled", attempt: 1 },
      { type: "ended", reason: "error", attempt: 1 },
      { type: "startFailed", attempt: 1 },
    ];
    for (const event of stale) {
      expect(dictationReduce(second.state, event).state).toEqual(second.state);
    }
    const live = run([{ type: "started", now: 0, attempt: 2 }], second.state).state;
    const ended = dictationReduce(live, { type: "ended", reason: "stopped", attempt: 1 });
    expect(ended.state).toEqual(live);
  });
});

/**
 * Review round 1, finding 1: Settings → Beta → Dictation going OFF sends
 * `stopRequested` (`voice-controller.ts:363`). It must end the attempt in EVERY
 * non-idle state — a slow on-device download, or a pending permission ask, must
 * not reach `started` behind a mic that is now hidden (the plan's "hidden mic
 * still listening" failure). The `preparing`/`asking` cases are the ones a
 * `default: return none` would silently swallow.
 */
describe("stopRequested in every pending state (switch turned OFF)", () => {
  const ios26Downloading: Capabilities = {
    os: 26,
    analyzer: { transcriber: true, dictation: true, assets: { [L]: "supported" } },
    recognizer: { [L]: { supported: true, onDevice: true } },
    permissions: GRANTED,
  };
  const asking = () => run([{ type: "tap", draft: "typed", locale: L, now: 0, attempt: 1 }]).state;
  const preparing = () => run([{ type: "probed", caps: iOS18 }], asking()).state;
  const downloading = () =>
    run(
      [
        { type: "probed", caps: ios26Downloading },
        { type: "reserved", ok: true },
        { type: "assetProgress", fraction: 0.1 },
      ],
      asking(),
    ).state;

  test("the fixtures really are in those states", () => {
    expect(asking().kind).toBe("asking");
    expect(preparing()).toMatchObject({ kind: "preparing", phase: "starting" });
    expect(downloading()).toMatchObject({ kind: "preparing", phase: "downloading" });
  });

  test("in asking → idle, nothing native was started to cancel", () => {
    const { state, effects } = run([{ type: "stopRequested", now: 1 }], asking());
    expect(state).toEqual(DICTATION_IDLE);
    expect(effects).toEqual([]);
  });

  test("in preparing{starting} → idle + cancel of THIS attempt", () => {
    const { state, effects } = run([{ type: "stopRequested", now: 1 }], preparing());
    expect(state).toEqual(DICTATION_IDLE);
    expect(effects).toEqual([{ type: "cancel", attempt: 1 }]);
  });

  test("in preparing{downloading} → idle + cancel (a slow download is not listening)", () => {
    const { state, effects } = run([{ type: "stopRequested", now: 1 }], downloading());
    expect(state).toEqual(DICTATION_IDLE);
    expect(effects).toEqual([{ type: "cancel", attempt: 1 }]);
  });

  test("a `started` arriving after the switch went off never reaches listening", () => {
    const after = run([{ type: "stopRequested", now: 1 }], preparing()).state;
    const late = dictationReduce(after, { type: "started", now: 2, attempt: 1 });
    expect(late.state.kind).toBe("idle");
    expect(late.effects).toEqual([{ type: "cancel", attempt: 1 }]);
  });
});

describe("mic haptics: one light tap per mic tap, never on a programmatic stop (fix/mobile-mic-send)", () => {
  const withText = () =>
    run([{ type: "dictation", finalDelta: "a", volatile: "b", now: 1 }], listening().state).state;
  const haptics = (effects: readonly DictationEffect[]) =>
    effects.flatMap((e) => (e.type === "haptic" ? [e.kind] : []));

  test("the start haptic is the tap's FIRST effect (before the mic opens: iOS mutes haptics while recording)", () => {
    const { effects } = run([{ type: "tap", draft: "", locale: L, now: 0, attempt: 1 }]);
    expect(effects[0]).toEqual({ type: "haptic", kind: "start" });
    // The native start resolving plays nothing more.
    expect(haptics(listening().effects)).toEqual(["start"]);
  });

  test("a tap that stops plays exactly one haptic, whatever the engine's ending", () => {
    for (const reason of ["stopped", "error", "cancelled"] as const) {
      const { effects } = run(
        [
          { type: "tap", draft: "", locale: L, now: 2, attempt: 1 },
          { type: "ended", reason, attempt: 1 },
        ],
        withText(),
      );
      expect(haptics(effects)).toEqual(["stop"]);
    }
  });

  test("a tap while preparing (it cancels) plays the stop haptic", () => {
    const preparing = run([
      { type: "tap", draft: "", locale: L, now: 0, attempt: 1 },
      { type: "probed", caps: iOS18 },
    ]).state;
    expect(preparing.kind).toBe("preparing");
    const { effects } = run([{ type: "tap", draft: "", locale: L, now: 1, attempt: 2 }], preparing);
    expect(haptics(effects)).toEqual(["stop"]);
  });

  test("a second tap while finalizing does nothing, so it plays nothing", () => {
    const f = run([{ type: "tap", draft: "", locale: L, now: 2, attempt: 1 }], withText()).state;
    expect(run([{ type: "tap", draft: "", locale: L, now: 3, attempt: 2 }], f).effects).toEqual([]);
  });

  test("programmatic stops are silent: silence, cap, Beta switch off, read-aloud, Send, interruption", () => {
    const cases: DictationEvent[][] = [
      [{ type: "tick", now: SILENCE_STOP_MS + 1 }],
      [{ type: "tick", now: HARD_CAP_MS }],
      [{ type: "stopRequested", now: 2 }],
      [{ type: "ttsStarting", now: 2 }],
      [{ type: "send", via: "press", now: 2 }],
      [{ type: "appState", state: "background" }],
    ];
    for (const events of cases) {
      const { effects } = run(
        [...events, { type: "ended", reason: "stopped", attempt: 1 }],
        withText(),
      );
      expect(haptics(effects)).toEqual([]);
    }
    expect(haptics(run([{ type: "ended", reason: "interrupted" }], withText()).effects)).toEqual(
      [],
    );
  });

  test("an error that is not the end of a stop still plays the error haptic", () => {
    expect(haptics(run([{ type: "ended", reason: "error" }], withText()).effects)).toEqual([
      "error",
    ]);
  });
});

/**
 * docs/feat/mobile-composer-buttons.md: the mic shows recording and transcribing
 * as two different faces, so `finalizing` is its own button state.
 */
describe("micButtonOf: finalizing is not listening", () => {
  test("listening → listening; a tap stop → finalizing; the native end → idle", () => {
    const { state } = listening();
    expect(micButtonOf(state, true)).toBe("listening");
    const f = run([{ type: "tap", draft: "", locale: L, now: 2, attempt: 1 }], state).state;
    expect(f.kind).toBe("finalizing");
    expect(micButtonOf(f, true)).toBe("finalizing");
    const done = run([{ type: "ended", reason: "stopped", attempt: 1 }], f).state;
    expect(micButtonOf(done, true)).toBe("idle");
  });

  test("unsupported hides every state, finalizing included", () => {
    const f = run(
      [{ type: "tap", draft: "", locale: L, now: 2, attempt: 1 }],
      listening().state,
    ).state;
    expect(micButtonOf(f, false)).toBe("hidden");
  });
});
