/**
 * `read-aloud.ts` — the read-aloud reducer, offered rule, auto-read gates and
 * the spoken permission ask (docs/feat/mobile-voice.md Design §3, Tests).
 */
import { describe, expect, test } from "bun:test";
import {
  type AutoReadGates,
  READ_ALOUD_IDLE,
  type ReadAloudEvent,
  type ReadAloudState,
  type SpeechRequest,
  autoReadRow,
  readAloudOffered,
  readAloudReduce,
  speakingRowKey,
  speechRequest,
  spokenAsk,
  streamingRowKey,
} from "../src/read-aloud.ts";

const req = (utterances: string[] = ["hello"]): SpeechRequest => ({
  utterances,
  voiceId: "v1",
  lang: "en",
  rate: "normal",
});

function run(events: ReadAloudEvent[], from: ReadAloudState = READ_ALOUD_IDLE) {
  let state = from;
  const effects: unknown[] = [];
  for (const event of events) {
    const step = readAloudReduce(state, event);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

describe("tap / stop / switch", () => {
  test("tap on an idle row speaks it", () => {
    const { state, effects } = run([{ type: "tap", rowKey: "a", request: req(["x", "y"]) }]);
    expect(effects).toEqual([
      { type: "speak", id: 1, utterances: ["x", "y"], voiceId: "v1", lang: "en", rate: "normal" },
    ]);
    expect(state).toMatchObject({ kind: "speaking", rowKey: "a", index: 0, total: 2 });
    expect(speakingRowKey(state)).toBe("a");
  });

  test("tap on the speaking row stops it", () => {
    const { state, effects } = run([
      { type: "tap", rowKey: "a", request: req() },
      { type: "tap", rowKey: "a", request: req() },
    ]);
    expect(effects.at(-1)).toEqual({ type: "stopSpeaking" });
    expect(state.kind).toBe("idle");
  });

  test("tap on another row stops, then speaks the other", () => {
    const { state, effects } = run([
      { type: "tap", rowKey: "a", request: req() },
      { type: "tap", rowKey: "b", request: req(["b1"]) },
    ]);
    expect(effects.slice(1)).toEqual([
      { type: "stopSpeaking" },
      { type: "speak", id: 2, utterances: ["b1"], voiceId: "v1", lang: "en", rate: "normal" },
    ]);
    expect(speakingRowKey(state)).toBe("b");
  });

  test("the old speech's late 'stopped' does not idle the new one", () => {
    const { state } = run([
      { type: "tap", rowKey: "a", request: req() },
      { type: "tap", rowKey: "b", request: req() },
      { type: "speech", id: 1, state: "stopped" },
    ]);
    expect(speakingRowKey(state)).toBe("b");
  });

  test("nothing speakable → no speak effect (F10)", () => {
    const { state, effects } = run([{ type: "tap", rowKey: "a", request: req([]) }]);
    expect(effects).toEqual([]);
    expect(state.kind).toBe("idle");
  });
});

describe("native events and app state", () => {
  const speaking = run([{ type: "tap", rowKey: "a", request: req(["1", "2", "3"]) }]).state;

  test("utterance progress updates the index", () => {
    const { state } = run([{ type: "speech", id: 1, state: "utterance", index: 2 }], speaking);
    expect(state).toMatchObject({ kind: "speaking", index: 2 });
  });

  for (const s of ["finished", "stopped", "interrupted"] as const) {
    test(`${s} → idle, no effect`, () => {
      const { state, effects } = run([{ type: "speech", id: 1, state: s }], speaking);
      expect(state.kind).toBe("idle");
      expect(effects).toEqual([]);
    });
  }

  test("background and inactive stop speaking; active does not", () => {
    for (const s of ["background", "inactive"] as const) {
      const { state, effects } = run([{ type: "appState", state: s }], speaking);
      expect(effects).toEqual([{ type: "stopSpeaking" }]);
      expect(state.kind).toBe("idle");
    }
    expect(run([{ type: "appState", state: "active" }], speaking).effects).toEqual([]);
  });

  test("dictation starting stops speaking (F11)", () => {
    expect(run([{ type: "dictationStarting" }], speaking).effects).toEqual([
      { type: "stopSpeaking" },
    ]);
  });

  test("dispose stops speaking; idle dispose does nothing (F13)", () => {
    expect(run([{ type: "dispose" }], speaking).effects).toEqual([{ type: "stopSpeaking" }]);
    expect(run([{ type: "dispose" }]).effects).toEqual([]);
  });
});

describe("offered", () => {
  test("not on the streaming row, not on an empty reply", () => {
    const rows = [
      { kind: "user", key: "u" },
      { kind: "assistant", key: "a" },
    ];
    const streaming = streamingRowKey(rows, true);
    expect(streaming).toBe("a");
    expect(readAloudOffered({ key: "a", text: "hi" }, streaming)).toBe(false);
    expect(readAloudOffered({ key: "a", text: "hi" }, streamingRowKey(rows, false))).toBe(true);
    expect(readAloudOffered({ key: "b", text: "  " }, undefined)).toBe(false);
  });

  test("an assistant row followed by a tool row is finished", () => {
    const rows = [
      { kind: "assistant", key: "a" },
      { kind: "tool", key: "t" },
    ];
    expect(streamingRowKey(rows, true)).toBeUndefined();
  });
});

describe("auto-read gates (one per gate)", () => {
  const all: AutoReadGates = {
    enabled: true,
    focused: true,
    appActive: true,
    dictationIdle: true,
    ownTurn: true,
  };
  const rows = [
    { kind: "user", key: "u", text: "q" },
    { kind: "assistant", key: "a1", text: "first" },
    { kind: "tool", key: "t" },
    { kind: "assistant", key: "a2", text: "answer" },
  ];

  test("all gates open → the last assistant row of the turn", () => {
    expect(autoReadRow(all, rows)).toBe("a2");
  });

  for (const gate of ["enabled", "focused", "appActive", "dictationIdle", "ownTurn"] as const) {
    test(`${gate} false → silent`, () => {
      expect(autoReadRow({ ...all, [gate]: false }, rows)).toBeUndefined();
    });
  }

  test("a turn with no assistant text after the prompt → silent", () => {
    expect(
      autoReadRow(all, [
        { kind: "assistant", key: "old", text: "previous turn" },
        { kind: "user", key: "u", text: "q" },
        { kind: "tool", key: "t" },
      ]),
    ).toBeUndefined();
  });
});

describe("spoken permission ask", () => {
  const request = {
    title: "Run a shell command",
    detail: "rm -rf /secret-path",
    input: { command: "rm -rf /secret-path" },
  };

  test("contains the title, never the detail or input", () => {
    const en = spokenAsk(request, "en");
    expect(en).toBe("Permission needed: Run a shell command. Answer on screen.");
    expect(en).not.toContain("secret-path");
    expect(spokenAsk(request, "it")).toBe(
      "Serve un permesso: Run a shell command. Rispondi sullo schermo.",
    );
  });

  test("a long title is capped", () => {
    const out = spokenAsk({ title: "x".repeat(500) }, "en");
    expect(out.length).toBeLessThan(140);
  });
});

describe("speechRequest", () => {
  test("detects the language and picks its voice", () => {
    const voices = [
      { id: "it", language: "it-IT", name: "A", quality: "enhanced" as const, novelty: false },
      { id: "en", language: "en-US", name: "B", quality: "enhanced" as const, novelty: false },
    ];
    const r = speechRequest("Il file non è nella cartella del progetto.", {
      fallback: "en",
      voices,
      rate: "fast",
    });
    expect(r).toMatchObject({ lang: "it", voiceId: "it", rate: "fast" });
    expect(r.utterances).toEqual(["Il file non è nella cartella del progetto."]);
  });
});
