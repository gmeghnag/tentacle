import { describe, expect, test } from "bun:test";
import { ENDPOINT_DEFAULTS, type EndpointInput, foldEndpoint } from "../src/voice-endpoint.ts";

/**
 * T3 — the comma regression (docs/feat/voice-dictation.md, V0 `:718-735`).
 *
 * The fixture holds, per utterance, the Silero window probabilities at 32 ms
 * (the V0 model) and the Smart Turn probability of each candidate segment. The
 * numbers come from `.tentacle/tmp/voice-dictation/sweep.json` + the V0 run:
 * the four comma cases (e04, e08, e14, e15) carry an internal pause of 96–224 ms
 * and Smart Turn rates the cut half as complete as a whole sentence.
 */

const WINDOW_MS = 32;

interface Trace {
  readonly id: string;
  /** True when the utterance has a comma in the middle (the bug's trigger). */
  readonly comma: boolean;
  /** Per 32 ms window: the Silero speech probability. */
  readonly p: readonly number[];
  /** Smart Turn's verdict for a candidate segment ending at that window. */
  readonly st: number;
}

/** Build a trace from speech spans, the way the helper's `vad`/`turnp` lines arrive. */
function traceFromSpans(
  id: string,
  comma: boolean,
  spans: readonly (readonly [number, number])[],
  totalMs: number,
  st = 0.9,
): Trace {
  const n = Math.ceil(totalMs / WINDOW_MS);
  const p = new Array<number>(n).fill(0.02);
  for (const [from, to] of spans) {
    for (let i = Math.floor(from / WINDOW_MS); i < Math.ceil(to / WINDOW_MS) && i < n; i++) {
      p[i] = 0.95;
    }
  }
  return { id, comma, p, st };
}

/** The four comma traces: the pause each one really has, from the V0 measurement. */
const COMMA: readonly Trace[] = [
  traceFromSpans(
    "e04",
    true,
    [
      [0, 1600],
      [1792, 3200],
    ],
    3600,
    0.878,
  ),
  traceFromSpans(
    "e08",
    true,
    [
      [0, 1500],
      [1724, 3000],
    ],
    3400,
    0.977,
  ),
  traceFromSpans(
    "e14",
    true,
    [
      [0, 1400],
      [1592, 2900],
    ],
    3300,
    0.86,
  ),
  traceFromSpans(
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
const CONTROL: readonly Trace[] = [
  traceFromSpans("e03", false, [[0, 2100]], 3000, 0.95),
  traceFromSpans("e17", false, [[0, 3300]], 4200, 0.987),
  traceFromSpans("e25", false, [[0, 2900]], 3800, 0.977),
];

/** Feed a trace through the fold at 32 ms of audio time per window. */
function run(
  trace: Trace,
  opts: { autoStop: boolean; floorMs: number; threshold?: number; hardStopMs?: number },
): { action: "none" | "askTurn" | "stop"; atMs: number | null; turnpAsked: boolean } {
  let state = foldEndpoint.init();
  let turnpAsked = false;
  let stopAt: number | null = null;
  let action: "none" | "askTurn" | "stop" = "none";
  for (let i = 0; i < trace.p.length; i++) {
    const input: EndpointInput = {
      kind: "window",
      ms: WINDOW_MS,
      p: trace.p[i] ?? 0,
      autoStop: opts.autoStop,
      floorMs: opts.floorMs,
      threshold: opts.threshold ?? 0.5,
      ...(opts.hardStopMs === undefined ? {} : { hardStopMs: opts.hardStopMs }),
    };
    const step = foldEndpoint.step(state, input);
    state = step.state;
    if (step.action === "askTurn") {
      turnpAsked = true;
      const answered = foldEndpoint.step(state, {
        kind: "turnp",
        p: trace.st,
        threshold: opts.threshold ?? 0.5,
      });
      state = answered.state;
      if (answered.action === "stop") {
        stopAt = (i + 1) * WINDOW_MS;
        action = "stop";
      }
    }
    if (step.action === "stop") {
      stopAt = (i + 1) * WINDOW_MS;
      action = "stop";
    }
  }
  return { action, atMs: stopAt, turnpAsked };
}

/** The last window that still had speech: where the utterance really ends. */
function trueEndMs(trace: Trace): number {
  let last = 0;
  for (let i = 0; i < trace.p.length; i++) if ((trace.p[i] ?? 0) >= 0.5) last = (i + 1) * WINDOW_MS;
  return last;
}

/**
 * The comma-safe floor this test PINS: the longest comma pause measured on the
 * V0 set (e08, 224 ms) plus margin. Written as a literal on purpose — a test
 * that read it back from `ENDPOINT_DEFAULTS` would pass at any value, and would
 * not catch the module's default being lowered back to V0's 200 ms.
 */
const COMMA_SAFE_FLOOR_MS = 500;

/**
 * V0's own constants, for the reproduction below: a 200 ms floor. The fold
 * REFUSES a floor under 300 ms (that is its comma guard), so `v0Run` asks it to
 * fold a 0 ms floor ("cut on silence") — which is exactly V0's behaviour — to
 * reproduce the truncation the fix exists for.
 */
function v0Run(trace: Trace, threshold: number) {
  return run(trace, { autoStop: true, floorMs: 0, threshold, hardStopMs: 3000 });
}

/**
 * T3 (a) — the regression itself, and its RED evidence.
 *
 * V0's endpointing cut on a short silence with no Smart Turn gate worth the
 * name, which lost the second clause at a comma on 5 of its 30 utterances. This
 * is that bug, asserted as the permanent record, so the pair of tests below show
 * the fix is what stops it.
 */
describe("T3 (a): V0's cut-on-silence DOES truncate the comma traces (the bug, pinned)", () => {
  for (const trace of COMMA) {
    test(`${trace.id} is truncated at its comma by a cut-on-silence fold`, () => {
      const at = v0Run(trace, 0.5).atMs;
      expect(at).not.toBeNull();
      // It stopped BEFORE the speech really ended: the second clause was lost.
      if (at !== null) expect(at).toBeLessThan(trueEndMs(trace));
    });
  }

  test("a threshold cannot rescue it: cut-on-silence + 0.95 still cuts e08 and e15", () => {
    const cut = COMMA.filter((t) => {
      const at = v0Run(t, 0.95).atMs;
      return at !== null && at < trueEndMs(t);
    }).map((t) => t.id);
    expect(cut).toEqual(["e08", "e15"]);
  });
});

describe("T3 (a): with the SHIPPED floor no comma trace stops before its true end", () => {
  test("the shipped default is at least the comma-safe floor", () => {
    // The mutation this catches: lowering `ENDPOINT_DEFAULTS.autoStopSilenceMs`
    // back to V0's 200 ms.
    expect(ENDPOINT_DEFAULTS.autoStopSilenceMs).toBeGreaterThanOrEqual(COMMA_SAFE_FLOOR_MS);
  });

  for (const trace of COMMA) {
    test(`${trace.id} is not cut at its comma`, () => {
      const at = run(trace, {
        autoStop: true,
        floorMs: COMMA_SAFE_FLOOR_MS,
        threshold: 0.5,
        hardStopMs: 3000,
      }).atMs;
      if (at !== null) expect(at).toBeGreaterThanOrEqual(trueEndMs(trace));
    });
  }

  test("no comma trace is cut with the comma-safe floor, at any threshold", () => {
    // The V0 finding, pinned: a THRESHOLD cannot fix it, a floor can.
    for (const threshold of [0.3, 0.5, 0.7, 0.9, 0.95, 0.99]) {
      for (const trace of COMMA) {
        const at = run(trace, {
          autoStop: true,
          floorMs: COMMA_SAFE_FLOOR_MS,
          threshold,
          hardStopMs: 3000,
        }).atMs;
        if (at !== null) expect(at).toBeGreaterThanOrEqual(trueEndMs(trace));
      }
    }
  });
});

describe("T3 (b): every control stops near its true end", () => {
  for (const trace of CONTROL) {
    test(`${trace.id} stops within floor + 2 windows + 100 ms of the end`, () => {
      const floorMs = COMMA_SAFE_FLOOR_MS;
      const at = run(trace, { autoStop: true, floorMs, threshold: 0.5 }).atMs;
      expect(at).not.toBeNull();
      if (at === null) return;
      const budget = floorMs + 2 * WINDOW_MS + 100;
      expect(at).toBeGreaterThanOrEqual(trueEndMs(trace));
      expect(at - trueEndMs(trace)).toBeLessThanOrEqual(budget);
    });
  }
});

describe("T3 (c): with autoStop off the fold never emits stop", () => {
  test("no trace, comma or control, stops unasked", () => {
    for (const trace of [...COMMA, ...CONTROL]) {
      const r = run(trace, { autoStop: false, floorMs: 500, threshold: 0.5, hardStopMs: 3000 });
      expect(r.action).toBe("none");
    }
  });
});

describe("T3: the hard stop is a floor, never a cut before the speech ends", () => {
  test("continuous silence for hardStopMs ends a forgotten dictation", () => {
    const trace = traceFromSpans("long", false, [[0, 400]], 7000, 0.9);
    const at = run(trace, {
      autoStop: true,
      floorMs: 100_000,
      threshold: 0.5,
      hardStopMs: 3000,
    }).atMs;
    // Speech's last window ends at 416 ms; the hard stop lands ~3 s of silence later.
    const speechEnd = trueEndMs(trace);
    expect(at).not.toBeNull();
    if (at !== null) {
      expect(at).toBeGreaterThanOrEqual(speechEnd + 3000);
      expect(at).toBeLessThanOrEqual(speechEnd + 3000 + WINDOW_MS);
    }
  });
});

describe("T3: the fold is deterministic in AUDIO time, not wall time", () => {
  test("the same trace gives the same verdict twice (no clock is read)", () => {
    const a = run(COMMA[1] as Trace, { autoStop: true, floorMs: 500, threshold: 0.5 });
    const b = run(COMMA[1] as Trace, { autoStop: true, floorMs: 500, threshold: 0.5 });
    expect(a).toEqual(b);
  });
});
