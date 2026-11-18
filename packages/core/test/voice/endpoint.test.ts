/**
 * `endpoint.ts` — the EDGE-NEUTRAL end-of-turn fold
 * (docs/feat/voice-conversation.md §3, C2 / T5).
 *
 * Two edges, one fold:
 * - **Mac** (`turnModel: true`): a candidate silence asks Smart Turn, and its
 *   `turnP ≥ threshold` verdict ends the turn. The comma traces and their
 *   numbers are V1's (`feat/voice-dictation`, `voice-endpoint.test.ts`), because
 *   that is the measurement the comma-safe floor came from.
 * - **Phone** (`turnModel: false`): `SFSpeechRecognizer` exposes no turn model,
 *   so the rule is "no new recognised text for the floor" — the person has
 *   stopped talking AND the recogniser has stopped producing words.
 *
 * Mutations this file must catch: a 200 ms floor (the comma traces stop early)
 * and dropping the `textGrew` rule (the phone traces stop early).
 */
import { describe, expect, test } from "bun:test";
import {
  ENDPOINT_EDGE_DEFAULTS,
  type EndpointConfig,
  type EndpointInput,
  foldEndpoint,
} from "../../src/voice/index.ts";

const WINDOW_MS = 32;

/**
 * The comma-safe floor this test PINS as a literal: the longest comma pause
 * measured on V1's set (224 ms) plus margin. Read back from the defaults it
 * would pass at any value, and would not catch the floor being lowered.
 */
const COMMA_SAFE_FLOOR_MS = 500;

/** A Mac trace: V1's fixtures (per 32 ms window, speech probability + one turnP verdict). */
interface MacTrace {
  readonly id: string;
  readonly comma: boolean;
  readonly p: readonly number[];
  readonly st: number;
}

function macTrace(
  id: string,
  comma: boolean,
  spans: readonly (readonly [number, number])[],
  totalMs: number,
  st = 0.9,
): MacTrace {
  const n = Math.ceil(totalMs / WINDOW_MS);
  const p = new Array<number>(n).fill(0.02);
  for (const [from, to] of spans) {
    for (let i = Math.floor(from / WINDOW_MS); i < Math.ceil(to / WINDOW_MS) && i < n; i++) {
      p[i] = 0.95;
    }
  }
  return { id, comma, p, st };
}

/** V1's four comma cases: each has an internal pause of 96–224 ms. */
const MAC_COMMA: readonly MacTrace[] = [
  macTrace(
    "e04",
    true,
    [
      [0, 1600],
      [1792, 3200],
    ],
    3600,
    0.878,
  ),
  macTrace(
    "e08",
    true,
    [
      [0, 1500],
      [1724, 3000],
    ],
    3400,
    0.977,
  ),
  macTrace(
    "e14",
    true,
    [
      [0, 1400],
      [1592, 2900],
    ],
    3300,
    0.86,
  ),
  macTrace(
    "e15",
    true,
    [
      [0, 1700],
      [1892, 3100],
    ],
    3500,
    0.984,
  ),
];

/** Controls: whole sentences with no internal pause worth the name. */
const MAC_CONTROL: readonly MacTrace[] = [
  macTrace("e03", false, [[0, 2100]], 3000, 0.95),
  macTrace("e17", false, [[0, 3300]], 4200, 0.987),
  macTrace("e25", false, [[0, 2900]], 3800, 0.977),
];

interface RunResult {
  readonly action: "none" | "askTurn" | "stop";
  readonly atMs: number | null;
  readonly asked: number;
}

/** Fold a Mac trace: a window, and the Smart Turn answer whenever one is asked. */
function runMac(trace: MacTrace, config: EndpointConfig): RunResult {
  let state = foldEndpoint.init();
  let action: "none" | "askTurn" | "stop" = "none";
  let atMs: number | null = null;
  let asked = 0;
  for (let i = 0; i < trace.p.length; i++) {
    const input: EndpointInput = {
      kind: "window",
      ms: WINDOW_MS,
      speech: (trace.p[i] ?? 0) >= 0.5,
    };
    const step = foldEndpoint.step(state, input, config);
    state = step.state;
    if (step.action === "askTurn") {
      asked += 1;
      const answered = foldEndpoint.step(state, { kind: "turnp", p: trace.st }, config);
      state = answered.state;
      if (answered.action === "stop") {
        action = "stop";
        atMs = (i + 1) * WINDOW_MS;
        break;
      }
    }
    if (step.action === "stop") {
      action = "stop";
      atMs = (i + 1) * WINDOW_MS;
      break;
    }
  }
  return { action, atMs, asked };
}

/**
 * A phone trace: speech spans, plus `textGrew` on the windows where the
 * recogniser produced new words (never after the speech really ended).
 */
interface PhoneTrace {
  readonly id: string;
  readonly comma: boolean;
  readonly speech: readonly boolean[];
  readonly grew: readonly boolean[];
}

function phoneTrace(
  id: string,
  comma: boolean,
  spans: readonly (readonly [number, number])[],
  totalMs: number,
): PhoneTrace {
  const n = Math.ceil(totalMs / WINDOW_MS);
  const speech = new Array<boolean>(n).fill(false);
  for (const [from, to] of spans) {
    for (let i = Math.floor(from / WINDOW_MS); i < Math.ceil(to / WINDOW_MS) && i < n; i++) {
      speech[i] = true;
    }
  }
  // The recogniser grows its transcript at the END of each speech span.
  const grew = new Array<boolean>(n).fill(false);
  for (const [, to] of spans) {
    const i = Math.min(n - 1, Math.floor(to / WINDOW_MS));
    grew[i] = true;
  }
  return { id, comma, speech, grew };
}

const PHONE_COMMA: readonly PhoneTrace[] = [
  phoneTrace(
    "p04",
    true,
    [
      [0, 1600],
      [1792, 3200],
    ],
    3600,
  ),
  phoneTrace(
    "p08",
    true,
    [
      [0, 1500],
      [1724, 3000],
    ],
    3400,
  ),
  phoneTrace(
    "p14",
    true,
    [
      [0, 1400],
      [1592, 2900],
    ],
    3300,
  ),
  phoneTrace(
    "p15",
    true,
    [
      [0, 1700],
      [1892, 3100],
    ],
    3500,
  ),
];

const PHONE_CONTROL: readonly PhoneTrace[] = [
  phoneTrace("p03", false, [[0, 2100]], 3000),
  phoneTrace("p17", false, [[0, 3300]], 4200),
  phoneTrace("p25", false, [[0, 2900]], 3800),
];

function runPhone(trace: PhoneTrace, config: EndpointConfig): RunResult {
  let state = foldEndpoint.init();
  for (let i = 0; i < trace.speech.length; i++) {
    const step = foldEndpoint.step(
      state,
      {
        kind: "window",
        ms: WINDOW_MS,
        speech: trace.speech[i] ?? false,
        textGrew: trace.grew[i] ?? false,
      },
      config,
    );
    state = step.state;
    if (step.action === "stop") {
      return { action: "stop", atMs: (i + 1) * WINDOW_MS, asked: 0 };
    }
  }
  return { action: "none", atMs: null, asked: 0 };
}

/** The last window that still had speech: where the utterance really ends. */
function trueEnd(p: readonly number[]): number {
  let last = 0;
  for (let i = 0; i < p.length; i++) if ((p[i] ?? 0) >= 0.5) last = (i + 1) * WINDOW_MS;
  return last;
}

const MAC: EndpointConfig = { ...ENDPOINT_EDGE_DEFAULTS.mac, floorMs: COMMA_SAFE_FLOOR_MS };
const PHONE: EndpointConfig = { ...ENDPOINT_EDGE_DEFAULTS.phone, floorMs: COMMA_SAFE_FLOOR_MS };

describe("T5: the per-edge defaults", () => {
  test("the shipped floors are at least the comma-safe floor", () => {
    expect(ENDPOINT_EDGE_DEFAULTS.mac.floorMs).toBeGreaterThanOrEqual(COMMA_SAFE_FLOOR_MS);
    expect(ENDPOINT_EDGE_DEFAULTS.phone.floorMs).toBeGreaterThanOrEqual(COMMA_SAFE_FLOOR_MS);
  });

  test("only the Mac has a turn model; both hard-stop at 3 s", () => {
    expect(ENDPOINT_EDGE_DEFAULTS.mac.turnModel).toBe(true);
    expect(ENDPOINT_EDGE_DEFAULTS.phone.turnModel).toBe(false);
    expect(ENDPOINT_EDGE_DEFAULTS.mac.hardStopMs).toBe(3000);
    expect(ENDPOINT_EDGE_DEFAULTS.phone.hardStopMs).toBe(3000);
  });

  test("conversation mode auto-sends on both edges", () => {
    expect(ENDPOINT_EDGE_DEFAULTS.mac.autoStop).toBe(true);
    expect(ENDPOINT_EDGE_DEFAULTS.phone.autoStop).toBe(true);
  });
});

describe("T5: Mac traces — no comma cuts, controls stop in budget", () => {
  for (const trace of MAC_COMMA) {
    test(`${trace.id} is not cut at its comma`, () => {
      const r = runMac(trace, MAC);
      if (r.atMs !== null) expect(r.atMs).toBeGreaterThanOrEqual(trueEnd(trace.p));
    });
  }

  for (const trace of MAC_CONTROL) {
    test(`${trace.id} stops within floor + 2 windows + 100 ms`, () => {
      const r = runMac(trace, MAC);
      expect(r.atMs).not.toBeNull();
      if (r.atMs === null) return;
      const budget = COMMA_SAFE_FLOOR_MS + 2 * WINDOW_MS + 100;
      expect(r.atMs).toBeGreaterThanOrEqual(trueEnd(trace.p));
      expect(r.atMs - trueEnd(trace.p)).toBeLessThanOrEqual(budget);
    });
  }

  test("V0's cut-on-silence DOES truncate every comma trace (the bug, pinned)", () => {
    // V1 reproduced V0 with a 0 ms floor ("cut on silence") for a measured
    // reason: the four comma pauses are 192/224/192/192 ms, so a 200 ms floor
    // never even reaches them at a 32 ms window. The bug is real at any floor
    // BELOW the pause, and the shipped floor (≥ 500, pinned above) is what
    // protects it. If this ever passes clean, the fold stopped cutting on
    // silence at all and T5's floor claim needs re-reading.
    const cut = MAC_COMMA.filter((t) => {
      const r = runMac(t, { ...MAC, floorMs: 0 });
      return r.atMs !== null && r.atMs < trueEnd(t.p);
    }).map((t) => t.id);
    expect(cut).toEqual(["e04", "e08", "e14", "e15"]);
  });

  test("a floor AT the measured comma pause still cuts: it must be above it", () => {
    // e04's pause is 192 ms; a floor of exactly that cuts it at the comma.
    const r = runMac(MAC_COMMA[0] as MacTrace, { ...MAC, floorMs: 192 });
    expect(r.atMs).not.toBeNull();
    if (r.atMs !== null) expect(r.atMs).toBeLessThan(trueEnd((MAC_COMMA[0] as MacTrace).p));
  });
});

describe("T5: phone traces — the textGrew rule, not a turn model", () => {
  for (const trace of PHONE_COMMA) {
    test(`${trace.id} is not cut at its comma`, () => {
      const r = runPhone(trace, PHONE);
      if (r.atMs !== null) expect(r.atMs).toBeGreaterThanOrEqual(lastSpeech(trace));
    });
  }

  for (const trace of PHONE_CONTROL) {
    test(`${trace.id} stops within floor + 2 windows + 100 ms`, () => {
      const r = runPhone(trace, PHONE);
      expect(r.atMs).not.toBeNull();
      if (r.atMs === null) return;
      const budget = COMMA_SAFE_FLOOR_MS + 2 * WINDOW_MS + 100;
      expect(r.atMs).toBeGreaterThanOrEqual(lastSpeech(trace));
      expect(r.atMs - lastSpeech(trace)).toBeLessThanOrEqual(budget);
    });
  }

  test("a healthy silence is ended by the phone fold with no turn model at all", () => {
    expect(runPhone(PHONE_CONTROL[0] as PhoneTrace, PHONE).action).toBe("stop");
  });
});

describe("T5: the textGrew rule is what keeps the phone from cutting", () => {
  test("silence past the floor with fresh recognised text does NOT stop", () => {
    // A slow recogniser: the audio went quiet before the words arrived. Stopping
    // here would send half an utterance (F2). Mutation: drop the textGrew rule
    // and this stops at once — red.
    let state = foldEndpoint.init();
    const config: EndpointConfig = { ...PHONE, floorMs: 400 };
    let stoppedAt: number | null = null;
    const windows: EndpointInput[] = [
      { kind: "window", ms: WINDOW_MS, speech: true, textGrew: false },
      // 600 ms of quiet, with the transcript still growing in the middle of it.
      ...Array.from({ length: 19 }, (_, i): EndpointInput => {
        const at = (i + 1) * WINDOW_MS;
        return { kind: "window", ms: WINDOW_MS, speech: false, textGrew: at === 288 };
      }),
    ];
    for (let i = 0; i < windows.length; i++) {
      const input = windows[i];
      if (input === undefined) continue;
      const step = foldEndpoint.step(state, input, config);
      state = step.state;
      if (step.action === "stop" && stoppedAt === null) {
        stoppedAt = (i + 1) * WINDOW_MS;
        // The floor was reached before the growth: a fold that ignores `textGrew`
        // would have stopped by now.
      }
    }
    if (stoppedAt !== null) expect(stoppedAt).toBeGreaterThan(288 + 400);
  });

  test("with no growth at all, the same silence DOES stop", () => {
    let state = foldEndpoint.init();
    const config: EndpointConfig = { ...PHONE, floorMs: 400 };
    let stoppedAt: number | null = null;
    const windows: EndpointInput[] = [
      { kind: "window", ms: WINDOW_MS, speech: true, textGrew: true },
      ...Array.from(
        { length: 19 },
        (): EndpointInput => ({
          kind: "window",
          ms: WINDOW_MS,
          speech: false,
          textGrew: false,
        }),
      ),
    ];
    for (let i = 0; i < windows.length; i++) {
      const input = windows[i];
      if (input === undefined) continue;
      const step = foldEndpoint.step(state, input, config);
      state = step.state;
      if (step.action === "stop" && stoppedAt === null) stoppedAt = (i + 1) * WINDOW_MS;
    }
    expect(stoppedAt).not.toBeNull();
    if (stoppedAt !== null) {
      expect(stoppedAt).toBeGreaterThanOrEqual(WINDOW_MS + 400);
      expect(stoppedAt).toBeLessThanOrEqual(WINDOW_MS + 400 + 2 * WINDOW_MS);
    }
  });
});

describe("T5: autoStop off never stops, on either edge", () => {
  test("no Mac trace stops, and the hard stop is inert too", () => {
    for (const trace of [...MAC_COMMA, ...MAC_CONTROL]) {
      const r = runMac(trace, { ...MAC, autoStop: false });
      expect(r.action).toBe("none");
    }
    // 4 s of trailing silence: the V1 round-2 regression, kept (NEW-1).
    const pause = macTrace("pause", false, [[0, 400]], 5000, 0.9);
    expect(runMac(pause, { ...MAC, autoStop: false }).action).toBe("none");
  });

  test("no phone trace stops", () => {
    for (const trace of [...PHONE_COMMA, ...PHONE_CONTROL]) {
      expect(runPhone(trace, { ...PHONE, autoStop: false }).action).toBe("none");
    }
  });
});

describe("T5: the hard stop ends a forgotten turn", () => {
  test("continuous silence for hardStopMs stops, even with an unreachable floor", () => {
    const trace = macTrace("long", false, [[0, 400]], 7000, 0.9);
    const r = runMac(trace, { ...MAC, floorMs: 100_000 });
    const end = trueEnd(trace.p);
    expect(r.atMs).not.toBeNull();
    if (r.atMs !== null) {
      expect(r.atMs).toBeGreaterThanOrEqual(end + 3000);
      expect(r.atMs).toBeLessThanOrEqual(end + 3000 + 2 * WINDOW_MS);
    }
  });

  test("and on the phone", () => {
    const trace = phoneTrace("plong", false, [[0, 400]], 7000);
    const r = runPhone(trace, { ...PHONE, floorMs: 100_000 });
    expect(r.action).toBe("stop");
    if (r.atMs !== null) expect(r.atMs).toBeGreaterThanOrEqual(400 + 3000);
  });
});

describe("T5: the fold is deterministic in audio time", () => {
  test("the same trace gives the same verdict twice", () => {
    const a = runMac(MAC_COMMA[1] as MacTrace, MAC);
    const b = runMac(MAC_COMMA[1] as MacTrace, MAC);
    expect(a).toEqual(b);
  });

  test("a stop is terminal: later windows change nothing", () => {
    let state = foldEndpoint.init();
    let stopped = false;
    const config: EndpointConfig = { ...PHONE, floorMs: 100 };
    const inputs: EndpointInput[] = [
      { kind: "window", ms: WINDOW_MS, speech: true, textGrew: true },
      { kind: "window", ms: WINDOW_MS, speech: false, textGrew: false },
      { kind: "window", ms: 500, speech: false, textGrew: false },
      { kind: "window", ms: 500, speech: true, textGrew: false },
    ];
    for (const input of inputs) {
      const step = foldEndpoint.step(state, input, config);
      state = step.state;
      if (step.action === "stop") stopped = true;
      if (stopped) expect(step.action).not.toBe("askTurn");
    }
    expect(stopped).toBe(true);
  });
});

/** The last speech-positive window of a phone trace, in audio ms. */
function lastSpeech(trace: PhoneTrace): number {
  let last = 0;
  for (let i = 0; i < trace.speech.length; i++) {
    if (trace.speech[i] === true) last = (i + 1) * WINDOW_MS;
  }
  return last;
}
