import { describe, expect, test } from "bun:test";
import { NOTHING } from "../src/keys/contract.ts";
import { voiceKeyLayer } from "../src/keys/layer-voice.ts";
import { PURE_LAYERS } from "../src/keys/layers.ts";
import { routeKey } from "../src/keys/route.ts";
import type { KeySnapshot } from "../src/keys/snapshot.ts";
import { snap as baseSnap } from "./key-snapshot.ts";

/**
 * T5 — the voice layer's precedence (docs/feat/voice-dictation.md F6/F7).
 *
 * F7 is the dangerous one: Esc already means "abort the upload" (10) and "abort
 * the agent's turn" (11). While a dictation runs, Esc must cancel the DICTATION
 * and leave the turn alone. That is a purely positional property — this layer
 * must sit before both Esc layers — so it is pinned through the router's own
 * `stoppedAt`, never by reasoning about the walk.
 */

type VoicePhase = "idle" | "starting" | "listening" | "transcribing" | "off";

/** The canonical snapshot builder, with the voice facts a test sets. */
function snap(
  voice: { phase: VoicePhase },
  char = "",
  key: Partial<KeySnapshot["key"]> = {},
  over: Partial<KeySnapshot> = {},
): KeySnapshot {
  return baseSnap({ ...over, voice: () => voice.phase }, char, key);
}

const CTRL_R = { ctrl: true } as const;
const ESC = { escape: true } as const;
const ENTER = { return: true } as const;

describe("T5: the voice layer sits after `paste` and before the Esc pair", () => {
  test("PURE_LAYERS puts `voice` between paste and escUpload/escAbort", () => {
    const names = PURE_LAYERS.map((layer) => layer.name);
    const voice = names.indexOf("voice");
    expect(voice).toBeGreaterThan(names.indexOf("paste"));
    // F7: the whole point is that voice owns Esc BEFORE either Esc layer.
    expect(voice).toBeLessThan(names.indexOf("escUpload"));
    expect(voice).toBeLessThan(names.indexOf("escAbort"));
  });
});

describe("T5 (F7): Esc while dictating cancels the dictation, never the turn", () => {
  test("listening + Esc -> voiceCancel, and the turn is NOT aborted", () => {
    const r = routeKey(
      snap({ phase: "listening" }, "", ESC, { abortable: () => true, running: () => true }),
      PURE_LAYERS,
    );
    expect(r.stoppedAt).toBe("voice");
    expect(r.effects).toEqual([{ kind: "voiceCancel" }]);
    expect(r.effects).not.toContainEqual({ kind: "abortTurn" });
  });

  test("transcribing + Esc -> voiceCancel too", () => {
    const r = routeKey(snap({ phase: "transcribing" }, "", ESC), PURE_LAYERS);
    expect(r.stoppedAt).toBe("voice");
    expect(r.effects).toEqual([{ kind: "voiceCancel" }]);
  });

  test("starting + Esc -> voiceCancel (nothing captured yet)", () => {
    const r = routeKey(snap({ phase: "starting" }, "", ESC), PURE_LAYERS);
    expect(r.stoppedAt).toBe("voice");
    expect(r.effects).toEqual([{ kind: "voiceCancel" }]);
  });

  test("IDLE + Esc is untouched: the turn aborts exactly as before", () => {
    // The property that makes F7 a fix and not a regression.
    const r = routeKey(
      snap({ phase: "idle" }, "", ESC, { abortable: () => true, running: () => true }),
      PURE_LAYERS,
    );
    expect(r.stoppedAt).not.toBe("voice");
    expect(r.effects).toContainEqual({ kind: "abortTurn" });
  });
});

describe("T5: the voice key toggles, and Enter finishes without sending", () => {
  test("idle Ctrl+R -> voiceToggle", () => {
    const r = routeKey(snap({ phase: "idle" }, "r", CTRL_R), PURE_LAYERS);
    expect(r.stoppedAt).toBe("voice");
    expect(r.effects).toEqual([{ kind: "voiceToggle" }]);
  });

  test("listening Ctrl+R -> voiceToggle (the same key finishes)", () => {
    const r = routeKey(snap({ phase: "listening" }, "r", CTRL_R), PURE_LAYERS);
    expect(r.effects).toEqual([{ kind: "voiceToggle" }]);
  });

  test("Enter while listening -> voiceFinish, and NEVER a submit", () => {
    const r = routeKey(
      snap({ phase: "listening" }, "\r", ENTER, { fieldValue: "draft" }),
      PURE_LAYERS,
    );
    expect(r.stoppedAt).toBe("voice");
    expect(r.effects).toEqual([{ kind: "voiceFinish" }]);
    expect(r.effects).not.toContainEqual({ kind: "submit", text: "draft" });
  });

  test("idle Enter still reaches the line-editing tail (the layer passes it)", () => {
    // `submit` is produced by `resolveLineEffects`, not by a layer, so the
    // property to pin here is that the walk does NOT stop at `voice`.
    const r = routeKey(
      snap({ phase: "idle" }, "\r", ENTER, { fieldValue: "ship it" }),
      PURE_LAYERS,
    );
    expect(r.stoppedAt).not.toBe("voice");
    expect(voiceKeyLayer.step(snap({ phase: "idle" }, "\r", ENTER))).toEqual(NOTHING);
  });

  test("typing while listening passes through to the line editor", () => {
    const s = snap({ phase: "listening" }, "a");
    expect(voiceKeyLayer.step(s)).toEqual(NOTHING);
    expect(routeKey(s, PURE_LAYERS).stoppedAt).not.toBe("voice");
  });
});

describe("T5: behind an open panel or dialog the voice layer passes", () => {
  test("a permission dialog is not the voice layer's to take", () => {
    const s = snap({ phase: "idle" }, "r", CTRL_R, {
      permission: {
        pending: { id: 1 } as never,
        choices: [],
        selected: 0,
        mode: () => ({ mode: "menu" }),
        shownAt: () => 0,
      },
    });
    expect(voiceKeyLayer.step(s)).toEqual(NOTHING);
  });

  test("the palette is not either", () => {
    expect(voiceKeyLayer.step(snap({ phase: "idle" }, "r", CTRL_R, { paletteOpen: true }))).toEqual(
      NOTHING,
    );
  });

  test("a panel is not either", () => {
    expect(
      voiceKeyLayer.step(snap({ phase: "idle" }, "r", CTRL_R, { panel: "sessions" as never })),
    ).toEqual(NOTHING);
  });
});

describe("T5: a rebound key is honoured", () => {
  test("voice.key ctrl+k: Ctrl+K toggles and Ctrl+R is then free", () => {
    const bound = snap({ phase: "idle" }, "k", { ctrl: true }, { voiceKey: () => "ctrl+k" });
    expect(voiceKeyLayer.step(bound)).toEqual({
      effects: [{ kind: "voiceToggle" }],
      verdict: "consumed",
      carry: "",
    });
    const other = snap({ phase: "idle" }, "r", CTRL_R, { voiceKey: () => "ctrl+k" });
    expect(voiceKeyLayer.step(other)).toEqual(NOTHING);
  });
});

describe("T5: the `off` phase never takes a key", () => {
  test("off: Ctrl+R passes so the key is not silently eaten", () => {
    const r = routeKey(snap({ phase: "off" }, "r", CTRL_R), PURE_LAYERS);
    expect(r.stoppedAt).not.toBe("voice");
  });
});
