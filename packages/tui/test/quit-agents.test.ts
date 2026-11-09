/**
 * 6a-2 TUI: quitting a session that would lose running background sub-agents
 * asks first (docs/feat/subagent-background-ui.md Design 6, T48).
 */
import { describe, expect, test } from "bun:test";
import {
  type QuitCommandInput,
  ctrlCQuitStep,
  quitCommandStep,
  quitConfirmText,
} from "../src/commands.ts";

const base: QuitCommandInput = {
  running: false,
  exitPending: false,
  foreign: false,
  detaches: false,
  endsSession: true,
  others: 0,
  confirmed: false,
  agents: 0,
};

describe("T48: /quit asks when children would be lost", () => {
  test("children running: confirm; confirmed or none: the old decision", () => {
    expect(quitCommandStep({ ...base, agents: 2 })).toBe("confirm");
    expect(quitCommandStep({ ...base, agents: 2, confirmed: true })).toBe("exit");
    expect(quitCommandStep({ ...base, agents: 0 })).toBe("exit");
  });

  test("connect: quitting only detaches, so no confirm (mutation: drop `detaches`)", () => {
    // The session lives on and so do its children; asking would be a lie.
    expect(quitCommandStep({ ...base, detaches: true, agents: 2 })).toBe("exit");
  });

  test("a second request never traps the user: exitPending wins", () => {
    expect(quitCommandStep({ ...base, agents: 2, exitPending: true })).toBe("exit");
  });

  test("mid-turn with children: the ask comes first, then the turn stops (the save)", () => {
    // The order is the plan's: ask, then `endsSession`'s stop-then-exit — nothing
    // is stopped before the user answers.
    expect(quitCommandStep({ ...base, running: true, agents: 1 })).toBe("confirm");
    expect(quitCommandStep({ ...base, running: true, agents: 1, confirmed: true })).toBe(
      "stop-then-exit",
    );
  });

  test("`connect` mid-turn with children: still a plain exit (only detaches)", () => {
    // Nothing is lost: the session, its turn and its children live on. A
    // `connect` runtime is never `endsSession` (only a run's TUI is).
    expect(
      quitCommandStep({ ...base, running: true, detaches: true, endsSession: false, agents: 1 }),
    ).toBe("exit");
  });
});

describe("T48: the confirmation text", () => {
  test("children alone: the count and their ids, and what is lost", () => {
    expect(quitConfirmText({ others: 0, agents: 2, names: ["sa-1", "sa-2"] })).toBe(
      "2 background sub-agents (sa-1, sa-2) will be lost — quit? (y/N)",
    );
    expect(quitConfirmText({ others: 0, agents: 1, names: ["sa-3"] })).toBe(
      "1 background sub-agent (sa-3) will be lost — quit? (y/N)",
    );
  });

  test("others too: one line naming both, closing the session for all", () => {
    expect(quitConfirmText({ others: 1, agents: 2, names: ["sa-1", "sa-2"] })).toBe(
      "1 other terminal attached · 2 sub-agents running — close the session for all? (y/N)",
    );
    expect(quitConfirmText({ others: 3, agents: 1, names: ["sa-1"] })).toBe(
      "3 other terminals attached · 1 sub-agent running — close the session for all? (y/N)",
    );
  });

  test("others alone keeps today's text byte for byte", () => {
    expect(quitConfirmText({ others: 2, agents: 0, names: [] })).toBe(
      "2 other terminals attached — close the session for all? (y/N)",
    );
  });

  test("one row at 80 columns: at most 3 ids, each short, then a count", () => {
    // LOW-2: a hostile pod can send 32 ids of 200 chars (they pass the client's
    // bound), and joining them all rendered 98 rows in a 3-row box. The bound
    // here keeps the text small; `wrap="truncate-end"` keeps it ONE row.
    const many = Array.from({ length: 32 }, (_, i) => `${i}`.repeat(200));
    const text = quitConfirmText({ others: 0, agents: 32, names: many });
    expect(text).toBe(
      `32 background sub-agents (${many
        .slice(0, 3)
        .map((n) => n.slice(0, 12))
        .join(", ")} +29) will be lost — quit? (y/N)`,
    );
    // Unbounded it was 10 820 chars; bounded it is one short line.
    expect(text.length).toBeLessThan(100);
    // Three or fewer: all of them, no count.
    expect(quitConfirmText({ others: 0, agents: 2, names: ["sa-1", "sa-2"] })).toBe(
      "2 background sub-agents (sa-1, sa-2) will be lost — quit? (y/N)",
    );
    // A long id is cut, and the count still says how many are there.
    expect(quitConfirmText({ others: 0, agents: 4, names: ["x".repeat(200), "b", "c", "d"] })).toBe(
      "4 background sub-agents (xxxxxxxxxxxx, b, c +1) will be lost — quit? (y/N)",
    );
  });
});

describe("T48: Ctrl+C idle asks too", () => {
  test("idle Ctrl+C with children asks; with none it exits, as today", () => {
    expect(
      ctrlCQuitStep({ running: false, exitPending: false, detaches: false, others: 0, agents: 2 }),
    ).toBe("confirm");
    expect(
      ctrlCQuitStep({ running: false, exitPending: false, detaches: false, others: 0, agents: 0 }),
    ).toBe("exit");
  });

  test("with another terminal attached it never asks: a Ctrl+C only detaches (HIGH-2)", () => {
    // Nothing is lost, so "will be lost — quit?" would be a lie, and its `y`
    // would have to close a session that is not this TUI's to close.
    expect(
      ctrlCQuitStep({ running: false, exitPending: false, detaches: false, others: 1, agents: 2 }),
    ).toBe("exit");
    expect(
      ctrlCQuitStep({ running: true, exitPending: false, detaches: false, others: 1, agents: 2 }),
    ).toBe("stop");
  });

  test("mid-turn Ctrl+C still only stops the turn: no dialog over a running turn", () => {
    expect(
      ctrlCQuitStep({ running: true, exitPending: false, detaches: false, others: 0, agents: 2 }),
    ).toBe("stop");
  });

  test("connect detaches, a second press exits, a confirmed one exits", () => {
    expect(
      ctrlCQuitStep({ running: false, exitPending: false, detaches: true, others: 0, agents: 2 }),
    ).toBe("exit");
    expect(
      ctrlCQuitStep({ running: false, exitPending: true, detaches: false, others: 0, agents: 2 }),
    ).toBe("exit");
    expect(
      ctrlCQuitStep({
        running: false,
        exitPending: false,
        detaches: false,
        others: 0,
        agents: 2,
        confirmed: true,
      }),
    ).toBe("exit");
  });
});
