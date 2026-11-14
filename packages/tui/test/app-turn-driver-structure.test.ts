/**
 * docs/feat/app-decomposition.md S9a — the STRUCTURAL contract of the move, in
 * the S6/S8 style: source-level properties a rendering assertion cannot see.
 *
 * The plan's payload is "`useTurnDriver.ts` — `streamTurn`, `run`,
 * `commitHistory`, `settleSendNow`, `sendNow`, `submit` (plus `/compact`'s
 * `startCompaction`, plan M5)" leaving `App.tsx`. What must hold afterwards:
 *   - the DECISIONS stay the pure modules' — `planTurnStart`/`planSendNow`/
 *     `planRefusal`/`afterOldTurn`/`onCompactionSettled`/`onSuccessorError`
 *     (`send-now.ts`), `submitPlan`/`enterConvertsToChips`/`imageRowText`
 *     (`attach-draft.ts`), `switchingRefusal` (`sessions-panel.ts`), the queue's
 *     (`queued.ts`), `turn-feed.ts`'s, `state.ts`'s — they are CALLED by the
 *     hook, never re-implemented in `App.tsx`;
 *   - the hook owns NO effect (H1: App's 20 effects keep their order and index)
 *     and creates ONLY the refs nothing outside it writes (M1/H3);
 *   - the frozen identifiers survive (`run`, `commitHistory`, `streamTurn`,
 *     `sendNow`, `submit`, `startCompaction`, `drainHeld`), so no use site in
 *     `App.tsx` changed;
 *   - `runRef` and `streamTurnRef` keep their late binding (the plan's
 *     "cycle breakage" failure mode).
 *
 * Each assertion is red under the mutation named beside it (the slice's mutation
 * table), so none is decoration.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const readSrc = (name: string): string => readFileSync(join(SRC, name), "utf8");
const countOf = (src: string, needle: string): number => src.split(needle).length - 1;

/** The member names a module's named imports bring in from `from`. */
const importSpecs = (src: string, from: string): string[] => {
  const specs: string[] = [];
  for (const m of src.matchAll(/import \{([^{}]*)\} from "(\.\/[^"]*|@tentacle\/[^"]*)";/gs)) {
    if (m[2] !== from) {
      continue;
    }
    for (const raw of (m[1] ?? "").split(",")) {
      const name =
        raw
          .trim()
          .replace(/^type /, "")
          .split(" as ")[0]
          ?.trim() ?? "";
      if (name !== "") {
        specs.push(name);
      }
    }
  }
  return specs;
};

describe("S9a: the turn driver leaves App.tsx", () => {
  // M7: a decision body re-inlined in App.tsx (the executor is back in the
  // component). Checked as an IMPORT plus a CALL, so the comments that name these
  // modules (which rightly stay) are not mistaken for a use.
  test("no turn decision is imported or called in App.tsx any more", () => {
    const app = readSrc("App.tsx");
    const gone: readonly [string, string][] = [
      ["planSendNow", "./send-now.ts"],
      ["planRefusal", "./send-now.ts"],
      ["afterOldTurn", "./send-now.ts"],
      ["onCompactionSettled", "./send-now.ts"],
      ["planTurnStart", "./send-now.ts"],
      ["submitPlan", "./attach-draft.ts"],
      ["enterConvertsToChips", "./attach-draft.ts"],
      ["imageRowText", "./attach-draft.ts"],
      ["pushHistory", "./history.ts"],
      ["handOff", "./queued.ts"],
      ["onTurnEnd", "./queued.ts"],
    ];
    for (const [name, from] of gone) {
      expect(importSpecs(app, from)).not.toContain(name);
      // The call, not the word: a comment cannot produce `name(`.
      expect(app).not.toContain(`${name}(`);
    }
  });

  test("the hook itself calls those decisions (they moved, they were not dropped)", () => {
    const hook = readSrc("useTurnDriver.ts");
    for (const name of [
      "planSendNow",
      "planRefusal",
      "afterOldTurn",
      "onCompactionSettled",
      "planTurnStart",
      "submitPlan",
      "enterConvertsToChips",
      "imageRowText",
      "pushHistory",
    ]) {
      expect(hook).toContain(`${name}(`);
    }
    expect(importSpecs(hook, "./send-now.ts")).toContain("planSendNow");
    expect(importSpecs(hook, "./attach-draft.ts")).toContain("submitPlan");
    expect(importSpecs(hook, "./history.ts")).toEqual(["pushHistory"]);
    // IMPORTED, not re-implemented here: a local stand-in of the same name would
    // still be "called by the hook" while quietly re-deciding in the driver.
    for (const [from, name] of [
      ["./send-now.ts", "planSendNow"],
      ["./send-now.ts", "planRefusal"],
      ["./send-now.ts", "afterOldTurn"],
      ["./send-now.ts", "onCompactionSettled"],
      ["./attach-draft.ts", "submitPlan"],
      ["./history.ts", "pushHistory"],
      ["./queued.ts", "handOff"],
      ["./sessions-panel.ts", "switchingRefusal"],
    ] as const) {
      expect(importSpecs(hook, from)).toContain(name);
      // …and not redeclared: the import is the only binding of that name.
      expect(hook).not.toMatch(new RegExp(`^const ${name} =`, "m"));
    }
  });

  // M8: the hook called twice (two drivers over one set of refs) — or not at
  // all, with the bodies left behind.
  test("exactly ONE useTurnDriver call, and it destructures the seven frozen identifiers", () => {
    const app = readSrc("App.tsx");
    expect(countOf(app, "useTurnDriver(")).toBe(1);
    expect(app).toMatch(
      /const \{ run, commitHistory, streamTurn, sendNow, submit, startCompaction, drainHeld \} =\s*\n?\s*useTurnDriver\(\{/,
    );
    // The identifiers are still read at their call sites, unchanged. Since S9b
    // moved `onActivity` (their only caller here) into `useSessionLink.ts`, the
    // locator follows the code: the CALLS are there, and App still hands the
    // same three to that hook by name. Same property, new location — the plan's
    // Preconditions rule for a source-locator.
    expect(app).toContain("runRef.current = run;");
    const link = readSrc("useSessionLink.ts");
    expect(countOf(link, "streamTurn(")).toBeGreaterThanOrEqual(1);
    expect(countOf(link, "commitHistory(")).toBeGreaterThanOrEqual(1);
    expect(countOf(link, "drainHeld(")).toBeGreaterThanOrEqual(1);
    expect(app).toContain("streamTurn,\n");
    expect(app).toContain("commitHistory,\n");
    expect(app).toContain("drainHeld,\n");
  });

  // H1: no hook owns an effect here, so an effect's index cannot shift.
  test("App still declares its 20 effects, and the hook declares none", () => {
    expect(countOf(readSrc("App.tsx"), "\n  useEffect(")).toBe(20);
    // A real use, not the word: the hook's header explains WHY there is none.
    const hook = readSrc("useTurnDriver.ts");
    expect(hook).not.toMatch(/^\s*useEffect(\(|<)/m);
    const react = hook.match(/import \{([^{}]*)\} from "react";/)?.[1] ?? "";
    expect(react).not.toContain("useEffect");
  });

  // M2 (the port trap): a callback closing over `host` would make Biome's
  // exhaustive-deps blind to every field, and a re-created ref field would break
  // the freshness rule. Destructured fields, named in deps — never the port.
  test("the hook destructures its port and its deps name fields, never `host`", () => {
    const hook = readSrc("useTurnDriver.ts");
    expect(hook).toContain("} = host;");
    expect(countOf(hook, "host.")).toBe(0);
    expect(hook).not.toMatch(/\[[^\]]*\bhost\b[^\]]*\]/);
    // …and no ALIAS of the port survives either (`const wholePort = host`): a
    // callback reading `wholePort.x` would be just as blind to the linter.
    // Comments are stripped first — the header explains why `host` stays unused.
    const code = hook.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(countOf(code, "host")).toBe(2); // the parameter, and `} = host;`
  });

  // M10: a ref re-created here that a driver OUTSIDE the hook also writes — a
  // second latch decoupled from its writer (the S8/M10 class). The three refs
  // created here are the ones nothing outside touches, and they are named.
  test("the only refs created are the driver's own, and each is declared once", () => {
    const hook = readSrc("useTurnDriver.ts");
    const created = [...hook.matchAll(/const ([A-Za-z_$][\w$]*Ref) = useRef[(<]/g)].map(
      (m) => m[1],
    );
    expect(created.sort()).toEqual(["compactionOwnedRef", "ownedIdsRef", "streamTurnRef"]);
    // …and the hook does not take any of them as a port field (that would be two).
    for (const name of created) {
      expect(hook).not.toMatch(new RegExp(`readonly ${name}:\\s*MutableRefObject`));
    }
    // No hand-rolled `{ current }` ref either (it would walk past `useRef(`).
    expect(hook).not.toMatch(/=\s*\{\s*current:/);
  });

  // The plan's "cycle breakage" failure mode: these two MUST stay late-bound.
  test("runRef and streamTurnRef keep their forward-reference binding", () => {
    const hook = readSrc("useTurnDriver.ts");
    const app = readSrc("App.tsx");
    expect(hook).toContain("streamTurnRef.current = streamTurn;");
    expect(hook).toContain(
      "void streamTurnRef.current?.(() => events, p.next, { successor: true });",
    );
    // `run` is installed by the hook into the App's own ref, and the App's three
    // late readers (the jobs subscription, the initial prompt, the wake) use it.
    expect(app).toContain("runRef.current = run;");
    expect(app).toContain("void runRef.current?.(initialPrompt);");
    expect(app).toContain('runRef.current?.("", { continuation: true });');
  });

  // The plan's "single broker" failure mode: the driver must not build its own
  // permission broker — it takes the App's (a second one would decouple the ask).
  test("the driver takes the broker as a field; it never creates one", () => {
    const hook = readSrc("useTurnDriver.ts");
    expect(hook).toContain("readonly permission: PermissionController;");
    expect(hook).not.toContain("usePermissionBroker");
    expect(countOf(readSrc("App.tsx"), "usePermissionBroker(")).toBe(1);
  });

  // M1 (frozen identifiers): the hook's returned names are exactly the App's,
  // so the command port, the key host and the frame keep their fields.
  test("the layer returns the seven frozen identifiers, and App wires the rest", () => {
    const hook = readSrc("useTurnDriver.ts");
    expect(hook).toContain(
      "return { run, commitHistory, streamTurn, sendNow, submit, startCompaction, drainHeld };",
    );
    const app = readSrc("App.tsx");
    // The key host still calls `sendNow` and `submit` by those names.
    expect(app).toContain("sendNow();");
    expect(app).toContain("submit(field.value);");
    // The command port still names `run` and `startCompaction`.
    expect(app).toContain("startCompaction,");
    expect(app).toContain("run,");
  });

  test("the module exists and is where the map says (one hook file, no second driver)", () => {
    expect(existsSync(join(SRC, "useTurnDriver.ts"))).toBe(true);
    const app = readSrc("App.tsx");
    // No `useCallback` for the moved bodies is left: a second `streamTurn` or
    // `sendNow` body would be a second driver over the same refs.
    for (const name of ["streamTurn", "sendNow", "commitHistory", "startCompaction"]) {
      expect(app).not.toContain(`const ${name} = useCallback`);
    }
  });
});
