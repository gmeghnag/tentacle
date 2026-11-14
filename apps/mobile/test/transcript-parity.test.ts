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
import {
  type DisplayState,
  applySessionEvent,
  initialState as tuiInitial,
} from "../../../packages/tui/src/state.ts";
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
});
