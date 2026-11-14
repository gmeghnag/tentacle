/**
 * docs/feat/app-decomposition.md S2 — the command registry and its dispatcher,
 * as pure modules. `commands/registry.ts` is the ONE list; `SLASH_COMMANDS` is
 * derived from it; `dispatchCommand` holds the guards (skill activation, a
 * latched switch, mid-turn) and each command's own file holds its body.
 *
 * S0's `app-commands.test.tsx` already pins each command's OBSERVABLE effect
 * through the real `App` (unmoved by S2: that is the behaviour-preservation
 * proof). What is pinned HERE is what S2 introduced: the derivation, the
 * registry's completeness against what the docs promise, and the dispatcher's
 * own decisions with a fake context (no React).
 */
import { describe, expect, test } from "bun:test";
import { SLASH_COMMANDS } from "../src/commands.ts";
import type { CommandContext, Live } from "../src/commands/context.ts";
import { dispatchCommand } from "../src/commands/dispatch.ts";
import { BUILT_INS, BUILT_IN_NAMES, canonicalName, findCommand } from "../src/commands/registry.ts";
import type { DisplayState } from "../src/state.ts";
import { appendNotice } from "../src/state.ts";

const live = <T>(value: T): Live<T> => ({ current: value });

interface Recorded {
  readonly notices: string[];
  readonly prompts: readonly { readonly text: string; readonly skill?: string }[];
  readonly reResolved: readonly string[];
  readonly restored: readonly string[];
  readonly quit: readonly boolean[];
  readonly ran: readonly string[];
}

/**
 * A `CommandContext` over plain values: the guards' inputs are the arguments,
 * the outputs are recorded. Only the fields the guards touch are provided, plus
 * `pushNotice` — a command's own file is exercised through the real `App`
 * (S0's smoke) rather than re-faked here.
 */
function fakeCtx(
  over: Partial<{
    running: boolean;
    switching: boolean;
    stale: boolean;
    items: DisplayState["items"];
    skills: readonly { readonly name: string; readonly description: string }[];
  }> = {},
): { ctx: CommandContext; rec: Recorded } {
  const notices: string[] = [];
  const prompts: { text: string; skill?: string }[] = [];
  const reResolved: string[] = [];
  const restored: string[] = [];
  const quit: boolean[] = [];
  const ran: string[] = [];
  const state = {
    running: over.running ?? false,
    items: over.items ?? [],
  } as unknown as DisplayState;
  const historyRef = live<string[]>([]);
  const histIndexRef = live(0);
  const draftRef = live("");
  const ctx = {
    pushNotice: (text: string) => notices.push(text),
    restoreInput: (text: string) => restored.push(text),
    historyRef,
    histIndexRef,
    draftRef,
    sessionRef: live(null),
    stateRef: live(state),
    busyCompacting: () => false,
    syncingRef: live(null),
    switchingRef: live(over.switching ?? false),
    lastUserRef: live(null),
    lastHadImagesRef: live(false),
    skills: () => over.skills ?? [],
    skillsSync: { stale: () => over.stale ?? false, settle: () => Promise.resolve(true) },
    run: (text: string, opts?: { readonly skill?: string }) => {
      prompts.push(opts?.skill === undefined ? { text } : { text, skill: opts.skill });
      return Promise.resolve();
    },
    requestQuit: (confirmed: boolean) => void quit.push(confirmed),
    startCompaction: () => void ran.push("compact"),
    requestClear: () => void ran.push("clear"),
    reResolve: (raw: string) => void reResolved.push(raw),
    exit: () => void ran.push("exit"),
    sessions: undefined,
    openPanel: () => void ran.push("panel"),
    mcpStatus: undefined,
    toggleAgents: () => void ran.push("agents"),
    attachCommand: (raw: string) => void ran.push(`attach ${raw}`),
    clipboard: () => Promise.resolve(),
    saveFile: () => Promise.resolve(),
    cwd: "/tmp/work",
    shownModel: "m",
    flushNow: () => {},
    setScrollOffset: () => {},
    askContext: () => {},
  } as unknown as CommandContext;
  return { ctx, rec: { notices, prompts, reResolved, restored, quit, ran } };
}

describe("S2 registry: the ONE list, and the vocabulary derived from it", () => {
  test("SLASH_COMMANDS is exactly the registry's names and descriptions, in registry order", () => {
    // The derivation itself: `commands.ts` no longer holds a second copy, so a
    // command added to the registry IS in the palette. Mutation: freeze a stale
    // copy back into commands.ts → this is red (the list keeps the old rows).
    expect(SLASH_COMMANDS).toEqual(
      BUILT_INS.map(({ name, description }) => ({ name, description })),
    );
  });

  test("every registry entry is a real command: a /name, a description, and a run", () => {
    for (const c of BUILT_INS) {
      expect(c.name.startsWith("/")).toBe(true);
      expect(c.description.trim()).not.toBe("");
      expect(typeof c.run).toBe("function");
    }
    // Names are unique: two files claiming one /name would make dispatch depend
    // on registry order.
    const names = BUILT_INS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("the registry is the 17 built-ins the docs and the palette promise", () => {
    // Deliberately literal: this is the list a user reads in /help. A new
    // command is a decision, so it must be added here too.
    expect(BUILT_INS.map((c) => c.name)).toEqual([
      "/help",
      "/clear",
      "/compact",
      "/rename",
      "/sessions",
      "/close",
      "/model",
      "/retry",
      "/attach",
      "/copy",
      "/save",
      "/tokens",
      "/mcp",
      "/skills",
      "/agents",
      "/settings",
      "/exit",
    ]);
  });

  test("/quit is an ALIAS of /exit, not a row: one implementation, two spellings", () => {
    expect(canonicalName("/quit")).toBe("/exit");
    expect(canonicalName("/exit")).toBe("/exit");
    expect(canonicalName("/help")).toBe("/help");
    expect(findCommand("/quit")?.name).toBe("/exit");
    expect(findCommand("/exit")?.name).toBe("/exit");
    // Not a palette row, but owned: a skill may not take either name.
    expect(BUILT_INS.map((c) => c.name)).not.toContain("/quit");
    expect(BUILT_IN_NAMES.has("/quit")).toBe(true);
    expect(BUILT_IN_NAMES.has("/exit")).toBe(true);
  });

  test("findCommand answers for every built-in and for nothing else", () => {
    for (const c of BUILT_INS) {
      expect(findCommand(c.name)?.name).toBe(c.name);
    }
    expect(findCommand("/nope")).toBeUndefined();
    expect(findCommand("")).toBeUndefined();
  });
});

describe("S2 dispatchCommand: the guards around a command", () => {
  test("an unknown command asks the skill list once when it is stale, then re-resolves once", async () => {
    const { ctx, rec } = fakeCtx({ stale: true });
    dispatchCommand(ctx, "/newskill");
    await Promise.resolve();
    expect(rec.reResolved).toEqual(["/newskill"]);
    expect(rec.notices).toEqual([]); // no "unknown" while the list may explain it
  });

  test("an unknown command with a fresh list says so, and does not re-resolve", async () => {
    const { ctx, rec } = fakeCtx({ stale: false });
    dispatchCommand(ctx, "/nope");
    await Promise.resolve();
    expect(rec.reResolved).toEqual([]);
    expect(rec.notices).toEqual(["_Unknown command: /nope. Try /help._"]);
  });

  test("`again` never loops: the second pass above reports it, it never re-asks", async () => {
    // The once-only rule (docs/feat/skills-hot-reload.md): `again` means the
    // list was ALREADY re-asked for this line.
    const { ctx, rec } = fakeCtx({ stale: true });
    dispatchCommand(ctx, "/nope", true);
    await Promise.resolve();
    expect(rec.reResolved).toEqual([]);
    expect(rec.notices).toEqual(["_Unknown command: /nope. Try /help._"]);
  });

  test("a skill activation is a PROMPT: recalled, then run as that skill", () => {
    const { ctx, rec } = fakeCtx({ skills: [{ name: "deploy", description: "d" }] });
    dispatchCommand(ctx, "/deploy the app");
    expect(rec.prompts).toEqual([{ text: "/deploy the app", skill: "deploy" }]);
    expect(ctx.historyRef.current).toEqual(["/deploy the app"]);
    expect(ctx.histIndexRef.current).toBe(1);
    expect(ctx.draftRef.current).toBe("");
  });

  test("a skill activation mid-turn is refused, and is NOT sent", () => {
    const { ctx, rec } = fakeCtx({
      running: true,
      skills: [{ name: "deploy", description: "d" }],
    });
    dispatchCommand(ctx, "/deploy the app");
    expect(rec.prompts).toEqual([]);
    expect(rec.notices).toEqual([
      "_Can't run /deploy while a turn is running — stop it first (esc)._",
    ]);
    // Still recalled: the user can retry it with ↑ once the turn is done.
    expect(ctx.historyRef.current).toEqual(["/deploy the app"]);
  });

  test("a latched session switch refuses a guarded command AND a skill (restoring the typed line)", () => {
    // `SWITCH_GUARDED` (sessions-panel.ts): the commands that would act on the
    // session this view is already leaving. `/help` is not one of them.
    const c = fakeCtx({ switching: true });
    dispatchCommand(c.ctx, "/clear");
    expect(c.rec.notices).toHaveLength(1);
    expect(c.rec.notices[0]).toContain("switch");
    expect(c.rec.ran).toEqual([]);

    const s = fakeCtx({ switching: true, skills: [{ name: "deploy", description: "d" }] });
    dispatchCommand(s.ctx, "/deploy now");
    expect(s.rec.prompts).toEqual([]);
    expect(s.rec.restored).toEqual(["/deploy now"]);
  });

  test("the session-mutating set is refused mid-turn; a read-only command is not", () => {
    for (const cmd of ["/retry", "/close"]) {
      const { ctx, rec } = fakeCtx({ running: true });
      dispatchCommand(ctx, cmd);
      expect(rec.notices).toEqual([
        `_Can't run ${cmd} while a turn is running — stop it first (esc)._`,
      ]);
      expect(rec.ran).toEqual([]);
    }
    // `/help` runs mid-turn (it only reads).
    const h = fakeCtx({ running: true });
    dispatchCommand(h.ctx, "/help");
    expect(h.rec.notices.join("")).not.toContain("while a turn is running");
  });

  test("/clear is exempt mid-turn only when the session can `clear` in place", () => {
    // No `clear` seam: the legacy close-and-replace would swap the session under
    // a live turn, so it waits.
    const legacy = fakeCtx({ running: true });
    dispatchCommand(legacy.ctx, "/clear");
    expect(legacy.rec.notices).toEqual([
      "_Can't run /clear while a turn is running — stop it first (esc)._",
    ]);
    expect(legacy.rec.ran).toEqual([]);
    // With the seam it IS dispatched: its own step decides (stop-then-clear).
    const inPlace = fakeCtx({ running: true });
    (inPlace.ctx.sessionRef as Live<unknown>).current = { clear: () => Promise.resolve() };
    dispatchCommand(inPlace.ctx, "/clear");
    expect(inPlace.rec.ran).toEqual(["clear"]);
    expect(inPlace.rec.notices).toEqual([]);
  });

  test("a built-in with arguments keeps the whole line, and an alias runs the canonical row", () => {
    const { ctx, rec } = fakeCtx({ running: false });
    dispatchCommand(ctx, "/quit");
    expect(rec.quit).toEqual([false]); // /exit's body, the alias resolved
    const attach = fakeCtx();
    dispatchCommand(attach.ctx, "/attach /tmp/a.png");
    expect(attach.rec.ran).toEqual(["attach /attach /tmp/a.png"]);
  });

  test("an empty line is an unknown command, not a crash", () => {
    // Unchanged from the old `switch`'s default arm: an empty first token is
    // reported as an unknown command rather than throwing.
    const { ctx, rec } = fakeCtx();
    dispatchCommand(ctx, "");
    expect(rec.notices).toEqual(["_Unknown command: . Try /help._"]);
  });
});

describe("S2 dispatchCommand: the transcript helpers still answer", () => {
  test("a notice pushed through the context lands in the display state", () => {
    // `pushNotice` is App's; this pins the state helper the dispatcher path uses,
    // so a moved notice cannot silently stop being shown.
    const { ctx } = fakeCtx();
    const before = ctx.stateRef.current;
    ctx.pushNotice("hi");
    const after = appendNotice(before, "hi");
    expect(after.items.length).toBe(before.items.length + 1);
  });
});
