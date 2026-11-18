/**
 * Parity with the TUI's fold (docs/feat/mobile-session-view.md 12b, Owner Q5):
 * the SAME event fixtures through `packages/tui/src/state.ts`'s
 * `applySessionEvent` and through the app's `transcript.ts` must produce the
 * same sequence of (kind, text, tool status).
 *
 * The TUI import is TEST-ONLY and relative (the app bundle never carries it —
 * plan P8: `state.ts`'s `resume.ts` pulls `@tentacle/agent`, and `apps/mobile`
 * does not depend on `@tentacle/tui`). This file is the pin: if the app's fold
 * drifts from the rule the TUI already implements, this fails.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DomainErrorCode } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import {
  harnessLevel,
  isHarness,
  joinsPrevious,
  showsGlyph,
} from "../../../packages/tui/src/harness-group.ts";
import { onCompactionSettled } from "../../../packages/tui/src/send-now.ts";
import {
  type DisplayState,
  applySessionEvent,
  initialState as tuiInitial,
} from "../../../packages/tui/src/state.ts";
import { COMPACT_FAILED_PREFIX, compactOutcome } from "../src/compact-slot.ts";
import { noticeLooks } from "../src/notice-group.ts";
import { type State, apply, imageRowText, initialState } from "../src/transcript.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "transcript");

interface Fixture {
  readonly name: string;
  readonly events: readonly Record<string, unknown>[];
}

function load(): readonly Fixture[] {
  return readdirSync(FIXTURES)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as Fixture);
}

/** What one row/notice says, for comparison (the same shape on both sides). */
interface Shape {
  readonly kind: string;
  readonly text: string;
  readonly tool?: string;
  /** The image labels a user row carries. */
  readonly images?: readonly string[];
}

/**
 * The app's rows as shapes. One normalization, about the one row kind the TUI has
 * no item for: `reasoning` is a spinner FLAG there and a tap-to-expand ROW here,
 * so reasoning rows are left out — and two assistant rows the app split AT a
 * reasoning row are joined, because the TUI appends nothing there and continues
 * the same answer item. A split anywhere else is NOT joined (it would hide a real
 * divergence), which is what keeps this test able to fail.
 */
function appShapes(state: State): readonly Shape[] {
  const shapes: Shape[] = [];
  let sawReasoning = false;
  for (const row of state.rows) {
    if (row.kind === "reasoning") {
      sawReasoning = true;
      continue;
    }
    const shape: Shape =
      row.kind === "user"
        ? { kind: "user", text: row.text, images: row.images.map(imageRowText) }
        : row.kind === "assistant"
          ? { kind: "assistant", text: row.text }
          : row.kind === "notice"
            ? { kind: "notice", text: row.text }
            : { kind: "tool", text: row.output ?? "", tool: `${row.label}:${row.status}` };
    const prev = shapes[shapes.length - 1];
    if (sawReasoning && shape.kind === "assistant" && prev?.kind === "assistant") {
      shapes[shapes.length - 1] = { kind: "assistant", text: prev.text + shape.text };
      sawReasoning = false;
      continue;
    }
    shapes.push(shape);
    sawReasoning = false;
  }
  return shapes;
}

/** The TUI's items as the same shapes. */
function tuiShapes(state: DisplayState): readonly Shape[] {
  return state.items.map((item): Shape => {
    switch (item.kind) {
      case "user":
        return { kind: "user", text: item.text, images: item.images ?? [] };
      case "assistant":
        return { kind: "assistant", text: item.text };
      case "notice":
        return { kind: "notice", text: item.text };
      case "tool":
        return {
          kind: "tool",
          text: item.resultText ?? "",
          tool: `${itemLabel(item.name)}:${item.status === "ok" ? "ok" : item.status}`,
        };
      default:
        return { kind: "unknown", text: "" };
    }
  });
}

/** The TUI renders a tool's DISPLAY label at draw time; this is that mapping. */
function itemLabel(name: string): string {
  const labels: Readonly<Record<string, string>> = {
    shell: "Bash",
    shell_output: "BashOutput",
    shell_kill: "BashKill",
    fs_read: "Read",
    fs_write: "Write",
    fs_edit: "Edit",
    fs_multi_edit: "MultiEdit",
    search: "Search",
    agent_task: "Agent",
    skill: "Skill",
  };
  return labels[name] ?? name;
}

/**
 * The events a `SessionEvent` stream can carry. The fixture's app-only members
 * (`turn_started`, `turn_ended`, image-only `user_message`) are translated, so
 * both folds see the same session: a started turn is the TUI's `startTurn`, an
 * ended one its `turn_end`.
 */
function toTui(events: readonly Record<string, unknown>[], text: string): readonly unknown[] {
  const out: unknown[] = [];
  for (const event of events) {
    switch (event.type) {
      case "turn_started":
        // The TUI marks the turn running when its prompt is sent; its own
        // `startTurn` would append the user bubble, which the daemon's
        // `user_message` draws here instead. So a start is a no-op for parity.
        break;
      case "turn_ended":
        out.push({
          type: "turn_end",
          reason: event.outcome === "cancelled" ? "cancelled" : "end_turn",
        });
        break;
      case "turn": {
        // A foreign turn's bracket: nothing to fold (its `user_message` draws it).
        break;
      }
      case "user_message":
        out.push({
          type: "user_message",
          text: event.text,
          ...(event.attachments === undefined ? {} : { attachments: event.attachments }),
        });
        break;
      default:
        out.push(event);
    }
  }
  void text;
  return out;
}

describe("the app's fold agrees with the TUI's on shared fixtures", () => {
  for (const fixture of load()) {
    test(fixture.name, () => {
      let app = initialState;
      for (const event of fixture.events) {
        app = apply(app, event as never);
      }
      let tui = tuiInitial;
      let now = 0;
      for (const event of toTui(fixture.events, fixture.name)) {
        now += 1;
        tui = applySessionEvent(tui, event as never, now);
      }
      expect(appShapes(app)).toEqual(tuiShapes(tui));
    });
  }

  test("the context-reset header this build copies matches the agent's own", async () => {
    // The ONE format string duplicated in `transcript-history.ts` (the app bundle
    // must not pull `@tentacle/agent`, which `resume.ts` does — plan P8).
    const { restartPromptOf: real } = await import("../../../packages/agent/src/context-reset.ts");
    const { restartPromptOf: copy } = await import("../src/transcript-history.ts");
    const content = `${(await import("../src/transcript-history.ts")).CONTEXT_RESET_HEADER}\n<restart_prompt>\ncarry on\n</restart_prompt>\nand a note`;
    expect(copy(content)).toBe(real(content));
    expect(copy("not a restart")).toBe(real("not a restart"));
  });

  test("an image prompt's label matches the TUI's `imageRowText`", async () => {
    const { imageRowText: tuiImageRowText } = await import(
      "../../../packages/tui/src/attach-draft.ts"
    );
    expect(imageRowText({ mimeType: "image/png", name: "shot.png" })).toBe(
      tuiImageRowText({ mimeType: "image/png", name: "shot.png" }),
    );
    expect(imageRowText({ mimeType: "image/png" })).toBe(
      tuiImageRowText({ mimeType: "image/png" }),
    );
  });

  test("a sub-agent's progress: the same counts as the TUI's fold (item 10)", () => {
    // `packages/tui/test/state.test.ts`'s sequence, plus usage and a background move.
    const events = [
      { type: "tool_start", id: "t1", name: "agent_task", arguments: '{"description":"d"}' },
      { type: "subagent_start", id: "t1", agentType: "explore", description: "find it" },
      { type: "subagent_tool", id: "t1", label: "Read a.ts" },
      { type: "subagent_usage", id: "t1", promptTokens: 900, completionTokens: 40 },
      { type: "subagent_tool", id: "t1", label: "Read b.ts" },
      { type: "subagent_end", id: "t1", toolUses: 2, stopReason: "background", agentId: "sa-1" },
    ];
    let app = initialState;
    let tui = tuiInitial;
    for (const event of events) {
      app = apply(app, event as never);
      tui = applySessionEvent(tui, event as never, 1);
    }
    const appSub = app.rows.flatMap((r) => (r.kind === "tool" && r.sub ? [r.sub] : []))[0];
    const tuiSub = tui.items.flatMap((i) => (i.kind === "tool" && i.sub ? [i.sub] : []))[0];
    expect(appSub).toBeDefined();
    expect({
      toolUses: appSub?.toolUses,
      tokens: appSub?.tokens,
      done: appSub?.done,
      stopReason: appSub?.stopReason,
      movedTo: appSub?.movedTo,
      last: appSub?.activities.at(-1),
    }).toEqual({
      toolUses: tuiSub?.toolUses,
      tokens: tuiSub?.tokens,
      done: tuiSub?.done,
      stopReason: tuiSub?.stopReason,
      movedTo: tuiSub?.movedTo,
      last: tuiSub?.activities.at(-1),
    });
  });
});

describe("harness looks: the phone groups exactly as the TUI does (S1)", () => {
  /**
   * One row's `(text, level, glyph-shown, joined)` as BOTH sides see it. The app
   * gives the look directly (`noticeLooks`); the TUI's is its own four functions
   * over the items — so a divergence in either the level table or the grouping
   * rule shows up here, not in a screenshot.
   */
  interface Look {
    readonly text: string;
    readonly level: "info" | "warn";
    readonly glyph: boolean;
    readonly joined: boolean;
  }

  function appLooks(state: State): readonly Look[] {
    const looks = noticeLooks(state.rows);
    return state.rows.flatMap((row): Look[] => {
      const look = looks.get(row.key);
      if (look === undefined || row.kind !== "notice") {
        return [];
      }
      // A `null` glyph from the projection IS "no glyph shown".
      return [
        {
          text: row.text,
          level: harnessLevel(row),
          glyph: look.glyph !== null,
          joined: look.joined,
        },
      ];
    });
  }

  function tuiLooks(state: DisplayState): readonly Look[] {
    const out: Look[] = [];
    let prev: DisplayState["items"][number] | undefined;
    for (const item of state.items) {
      if (isHarness(item)) {
        out.push({
          text: item.text,
          level: harnessLevel(item),
          glyph: showsGlyph(prev, item),
          joined: joinsPrevious(prev, item),
        });
      }
      prev = item;
    }
    return out;
  }

  for (const fixture of load()) {
    test(fixture.name, () => {
      let app = initialState;
      for (const event of fixture.events) {
        app = apply(app, event as never);
      }
      let tui = tuiInitial;
      let now = 0;
      for (const event of toTui(fixture.events, fixture.name)) {
        now += 1;
        tui = applySessionEvent(tui, event as never, now);
      }
      // Not vacuous: every fixture here says something (a cut, a repair, an empty
      // turn), so an empty sequence on both sides would hide a lost notice.
      expect(appLooks(app).length).toBeGreaterThan(0);
      expect(appLooks(app)).toEqual(tuiLooks(tui));
    });
  }

  test("the fixture set really does exercise a warn, an info and a block", () => {
    // Guards the loop above from passing on an empty or info-only set (AGENTS §9
    // non-vacuity): a level change AND a continuation must both occur.
    const all = load().flatMap((fixture) => {
      let tui = tuiInitial;
      let now = 0;
      for (const event of toTui(fixture.events, fixture.name)) {
        now += 1;
        tui = applySessionEvent(tui, event as never, now);
      }
      return tuiLooks(tui);
    });
    expect(all.some((look) => look.level === "warn")).toBe(true);
    expect(all.some((look) => look.level === "info")).toBe(true);
    expect(all.some((look) => look.joined)).toBe(true);
    expect(all.some((look) => look.glyph)).toBe(true);
  });
});

describe("compaction outcome wording (mobile-hub-commands C2, harness-notices Q4)", () => {
  // The TUI writes `_Compact failed: ${String(error)}_` (send-now.ts); the phone
  // writes the daemon's message after the SAME prefix (no `RpcError:` class
  // name, no markdown) — pinned here so the two never drift apart.
  test("a failure: the same prefix and the daemon's words, the same ▲ level", () => {
    const error = new RpcError(DomainErrorCode.TurnInProgress, "a turn is already running");
    const tui = onCompactionSettled({
      result: { ok: false, error },
      rows: [],
      sendNowOwns: false,
      turnRunning: false,
    });
    const phone = compactOutcome({ ok: false, error });
    const tuiText = (tui.notice ?? "").replace(/^_|_$/g, "");
    expect(tuiText.startsWith(COMPACT_FAILED_PREFIX)).toBe(true);
    expect(phone?.text.startsWith(COMPACT_FAILED_PREFIX)).toBe(true);
    expect(tuiText.endsWith(error.message)).toBe(true);
    expect(phone?.text.endsWith(error.message)).toBe(true);
    expect(tui.level).toBe("warn");
    expect(phone?.level).toBe("warn");
  });
  test("a success: neither writes a line (the slot and the separator say it)", () => {
    const tui = onCompactionSettled({
      result: { ok: true, before: 3, after: 2 },
      rows: [],
      sendNowOwns: false,
      turnRunning: false,
    });
    expect(tui.notice).toBeNull();
    expect(compactOutcome({ ok: true })).toBeNull();
  });
});
