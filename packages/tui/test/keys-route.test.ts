/**
 * The pure key router (docs/feat/app-decomposition.md S3): the ORDER of the
 * layer list, and the `{effects, verdict, carry}` walk that replaces 389 lines
 * of inline `if`s inside ONE `useInput`.
 *
 * These tests read the precedence as DATA — no Ink, no React, no frames. The
 * App-seam behaviour (the same decisions through the real components) is pinned
 * by the S0/S0b nets, which this slice must leave green and unedited.
 */
import { describe, expect, test } from "bun:test";
import type { DockState } from "../src/background-focus.ts";
import { LAYER_ORDER, PURE_LAYERS } from "../src/keys/layers.ts";
import { routeKey } from "../src/keys/route.ts";
import type { KeySnapshot } from "../src/keys/snapshot.ts";
import { NO_KEY, snap } from "./key-snapshot.ts";

const route = (s: KeySnapshot) => routeKey(s, PURE_LAYERS);

describe("the layer list", () => {
  test("is the documented 16, in the documented order, and the walk is its first 15", () => {
    // The order IS the safety property (AGENTS §7): a reordering must be red
    // here, not a subtle behaviour change in a frame diff.
    expect(LAYER_ORDER).toEqual([
      "shiftTab",
      "quitConfirm",
      // The artifact open confirm (model-artifacts S6b) answers right after the
      // quit dialog and BEFORE the chord and the permission prompt: its `y` can
      // never approve an ask that opened meanwhile.
      "artifactConfirm",
      "chord",
      "permission",
      "ctrlC",
      "paste",
      // `voice` sits after `paste` and BEFORE the Esc pair: while a dictation is
      // running Esc must cancel it, not abort the agent's turn
      // (docs/feat/voice-dictation.md F7). Moving it after `escAbort` is red here.
      "voice",
      "sessions",
      "tree",
      "dock",
      "escUpload",
      "escAbort",
      "expandAll",
      "palette",
      "mouse",
    ]);
    // The mouse layer is the router's CONTINUATION (it owns state), so the pure
    // walk is the same list minus its last entry — asserted, never assumed.
    expect(PURE_LAYERS.map((l) => l.name)).toEqual(LAYER_ORDER.slice(0, -1));
  });
});

describe("the walk", () => {
  test("a quiet key passes every layer and reaches line editing, with no effects", () => {
    const r = route(snap({}, "a"));
    expect(r.verdict).toBe("pass");
    expect(r.stoppedAt).toBeNull();
    expect(r.effects).toEqual([]);
    expect(r.carry).toBe("");
  });

  test("the FIRST claiming layer stops the walk: shift+tab never reaches the palette", () => {
    const r = route(
      snap({ paletteOpen: true, paletteNames: ["/help"] }, "", { tab: true, shift: true }),
    );
    expect(r.stoppedAt).toBe("shiftTab");
    expect(r.effects).toEqual([{ kind: "toggleAutoAccept" }]);
  });

  test("quit-confirm stops the walk before the permission dialog: `y` never answers an ask", () => {
    const r = route(
      snap(
        {
          quitConfirm: () => ({ others: 0, agents: 1, jobs: 0, names: ["sa-1"] }),
          permission: {
            // An ask arrived with no render between (S0b's no-render pin).
            pending: { id: "p1" } as never,
            choices: [],
            selected: 0,
            mode: () => ({ mode: "menu" }),
            shownAt: () => 0,
          },
        },
        "y",
      ),
    );
    expect(r.stoppedAt).toBe("quitConfirm");
    // The dialog drops, and the quit is confirmed — no `permissionAnswer`.
    expect(r.effects.map((e) => e.kind)).toEqual(["setQuitConfirm", "quit"]);
  });

  test("a passing layer's effects are kept AND the walk continues (the sessions disarm)", () => {
    const r = route(
      snap(
        {
          panel: {
            kind: "sessions",
            state: { cursor: 1, armed: "s2" },
            data: { sessions: [{ id: "s1" }, { id: "s2" }], more: false },
            now: 0,
          } as never,
          // A wheel report: `sessionsKey` claims nothing, so the layer disarms…
          panelGen: () => 0,
        },
        "\u001b[<64;5;5M",
      ),
    );
    // …and PASSES: the mouse layer is where a report is dispatched (S4).
    expect(r.stoppedAt).toBeNull();
    expect(r.verdict).toBe("pass");
    expect(r.effects).toEqual([{ kind: "setSessionsState", state: { cursor: 1, armed: null } }]);
  });

  test("the chord writes its state and still passes a key that breaks it", () => {
    // Ctrl+X arms (consumed), then `a` is typed: the state resets on `pass`.
    const armed = route(snap({ chord: () => ({ armedAt: Date.now() }) }, "a"));
    expect(armed.verdict).toBe("pass");
    expect(armed.effects).toContainEqual({ kind: "setChord", state: { armedAt: null } });
  });

  test("a dock-owned ctrl+x is not the chord's: the key goes on to the dock", () => {
    const dock = (): DockState => ({
      focus: { kind: "list", selected: "sa-1", armed: false, typing: false },
      drafts: {},
      sent: {},
    });
    const r = route(snap({ dock }, "x", { ctrl: true }));
    // The chord did NOT consume it — the dock's stop decision owns the key. With
    // the chord already idle there is nothing to reset, so no `setChord` is
    // emitted (a write of idle over idle is a no-op, not an effect).
    expect(r.effects.some((e) => e.kind === "setChord")).toBe(false);
    expect(r.stoppedAt).toBe("dock");
    // …and when the chord WAS half-armed, the dock's key really does drop it.
    const armed = route(
      snap({ dock, chord: () => ({ armedAt: Date.now() }) }, "x", { ctrl: true }),
    );
    expect(armed.effects[0]).toEqual({ kind: "setChord", state: { armedAt: null } });
    expect(armed.stoppedAt).toBe("dock");
  });

  test("effects accumulate in LAYER order, not in reverse", () => {
    // A paste chunk while a sessions panel is armed: the paste layer is ABOVE
    // the sessions layer, so its effects come first and the walk stops there.
    const r = route(
      snap(
        {
          panel: {
            kind: "sessions",
            state: { cursor: 0, armed: "s2" },
            data: { sessions: [{ id: "s1" }, { id: "s2" }], more: false },
            now: 0,
          } as never,
        },
        "\u001b[200~hi\u001b[201~",
      ),
    );
    expect(r.stoppedAt).toBe("paste");
    expect(r.effects.map((e) => e.kind)).toEqual(["setPasteBuffer", "clearPasteTimeout"]);
  });
});

describe("carry", () => {
  test("a pure layer carries nothing: carry is the mouse layer's (a restored `[`)", () => {
    const r = route(snap({}, "["));
    expect(r.carry).toBe("");
  });

  test("a passing layer's carry reaches the route", () => {
    // Built here rather than from `PURE_LAYERS`: the contract must carry text
    // from ANY passing layer, so a later carrier (a new layer) needs no change.
    const r = routeKey(snap({}, "["), [
      { name: "paste", step: () => ({ effects: [], verdict: "pass", carry: "[" }) },
    ]);
    expect(r.verdict).toBe("pass");
    expect(r.carry).toBe("[");
  });

  test("a consumed layer keeps the carry it had received", () => {
    const r = routeKey(snap({}, "["), [
      { name: "paste", step: () => ({ effects: [], verdict: "pass", carry: "[" }) },
      { name: "palette", step: () => ({ effects: [], verdict: "consumed", carry: "" }) },
    ]);
    expect(r.verdict).toBe("consumed");
    expect(r.stoppedAt).toBe("palette");
    expect(r.carry).toBe("[");
  });
});
