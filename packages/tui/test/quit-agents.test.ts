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
});

describe("T48: Ctrl+C idle asks too", () => {
  test("idle Ctrl+C with children asks; with none it exits, as today", () => {
    expect(ctrlCQuitStep({ running: false, exitPending: false, detaches: false, agents: 2 })).toBe(
      "confirm",
    );
    expect(ctrlCQuitStep({ running: false, exitPending: false, detaches: false, agents: 0 })).toBe(
      "exit",
    );
  });

  test("mid-turn Ctrl+C still only stops the turn: no dialog over a running turn", () => {
    expect(ctrlCQuitStep({ running: true, exitPending: false, detaches: false, agents: 2 })).toBe(
      "stop",
    );
  });

  test("connect detaches, a second press exits, a confirmed one exits", () => {
    expect(ctrlCQuitStep({ running: false, exitPending: false, detaches: true, agents: 2 })).toBe(
      "exit",
    );
    expect(ctrlCQuitStep({ running: false, exitPending: true, detaches: false, agents: 2 })).toBe(
      "exit",
    );
    expect(
      ctrlCQuitStep({
        running: false,
        exitPending: false,
        detaches: false,
        agents: 2,
        confirmed: true,
      }),
    ).toBe("exit");
  });
});
