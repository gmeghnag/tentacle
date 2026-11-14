/**
 * docs/feat/app-decomposition.md S9b — the STRUCTURAL contract of the move, in
 * the S6/S8/S9a style: source-level properties a rendering assertion cannot see.
 *
 * The plan's payload is "`useSessionLink.ts` — `onActivity`, `watchSession`,
 * `swapSession`, `switchTo` (+ `drainHeld`, `askContext` and the wake/arm where
 * the code allows them: see Execution drift 1)" leaving `App.tsx`. What must
 * hold afterwards:
 *   - the DECISIONS stay the pure modules' — `nextStep`/`historyAction`/
 *     `closedNotice` (`turn-feed.ts`), `openFailedNotice`/`stayingNotice`/
 *     `switchRefusedNotice` (`sessions-panel.ts`), `handBackRows`/`takeAll`
 *     (`queued.ts`), `resetDock`/`noteSent` (`background-focus.ts`), the notice
 *     builders, `state.ts`'s and `wakeStep` — they are CALLED by the hook, never
 *     re-implemented in `App.tsx`;
 *   - the hook owns NO effect (H1: App's 20 effects keep their order and index)
 *     and creates ONLY the ref nothing outside it writes (M1/H3);
 *   - the frozen identifiers survive (`onActivity`, `watchSession`,
 *     `swapSession`, `switchTo`), so no use site changed;
 *   - `onActivityRef`/`swapRef` keep their late binding (the plan's "cycle
 *     breakage" failure mode), and the single broker stays App's.
 *
 * Each assertion is red under the mutation named beside it (the slice's mutation
 * table), so none is decoration.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const HOOK = "useSessionLink.ts";
const readSrc = (name: string): string => readFileSync(join(SRC, name), "utf8");
const countOf = (src: string, needle: string): number => src.split(needle).length - 1;

/** The member names a module's named imports bring in from `from`. */
const importSpecs = (src: string, from: string): string[] => {
  const specs: string[] = [];
  for (const m of src.matchAll(/import \{([^{}]*)\} from "([^"]+)";/gs)) {
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

describe("S9b: the session link leaves App.tsx", () => {
  // M1: a decision body re-inlined in App.tsx (the executor is back in the
  // component). Checked as an IMPORT plus a CALL, so the comments that name these
  // modules (which rightly stay) are not mistaken for a use.
  test("no session-link decision is imported or called in App.tsx any more", () => {
    const app = readSrc("App.tsx");
    const gone: readonly [string, string][] = [
      ["nextStep", "./turn-feed.ts"],
      ["historyAction", "./turn-feed.ts"],
      ["closedNotice", "./turn-feed.ts"],
      ["openFailedNotice", "./sessions-panel.ts"],
      ["stayingNotice", "./sessions-panel.ts"],
      ["switchRefusedNotice", "./sessions-panel.ts"],
      ["resetDock", "./background-focus.ts"],
      ["noteSent", "./background-focus.ts"],
      ["subagentNotifyNotice", "./subagent-notify.ts"],
      ["userToSubagentNotice", "./subagent-notify.ts"],
      ["appendHistory", "./state.ts"],
      ["resetHistory", "./state.ts"],
      ["forgetContextFill", "./state.ts"],
      ["startContinuation", "./state.ts"],
    ];
    for (const [name, from] of gone) {
      expect(importSpecs(app, from)).not.toContain(name);
      // The call, not the word: a comment cannot produce `name(`.
      expect(app).not.toContain(`${name}(`);
    }
  });

  // M2: the decisions dropped instead of moved (the hook re-implements them).
  test("the hook itself calls those decisions, imported not re-declared", () => {
    const hook = readSrc(HOOK);
    for (const name of [
      "nextStep",
      "historyAction",
      "closedNotice",
      "openFailedNotice",
      "stayingNotice",
      "switchRefusedNotice",
      "resetDock",
      "noteSent",
      "subagentNotifyNotice",
      "userToSubagentNotice",
      "appendHistory",
      "resetHistory",
      "forgetContextFill",
      "startContinuation",
    ]) {
      // Called, or taken as a value (`const apply = action === "append" ?
      // appendHistory : resetHistory`): either way the DECISION is the module's
      // and the only binding of that name is the import.
      expect(hook).toMatch(new RegExp(`\\b${name}\\b`));
      expect(hook).not.toMatch(new RegExp(`^const ${name} =`, "m"));
    }
    // One import per owning module, so a decision cannot migrate to the wrong one.
    expect(importSpecs(hook, "./turn-feed.ts")).toEqual(
      expect.arrayContaining(["nextStep", "historyAction", "closedNotice"]),
    );
    expect(importSpecs(hook, "./sessions-panel.ts")).toEqual(
      expect.arrayContaining(["openFailedNotice", "stayingNotice", "switchRefusedNotice"]),
    );
    expect(importSpecs(hook, "./queued.ts")).toContain("takeAll");
    expect(importSpecs(hook, "./background-focus.ts")).toEqual(
      expect.arrayContaining(["resetDock", "noteSent"]),
    );
  });

  // M3: the hook called twice (two session links over one set of refs) — or not
  // at all, with the bodies left behind.
  test("exactly ONE useSessionLink call, destructuring the four frozen identifiers", () => {
    const app = readSrc("App.tsx");
    expect(countOf(app, "useSessionLink(")).toBe(1);
    expect(app).toMatch(
      /const \{ onActivity, watchSession, swapSession, switchTo \} =\s*\n?\s*useSessionLink\(\{/,
    );
    // The identifiers are still read at their old call sites, unchanged.
    expect(app).toContain("watchSession(sessionRef.current);");
    expect(app).toContain("}, [watchSession]);");
    expect(app).toContain("switchTo,\n");
  });

  // H1 (M4): no hook owns an effect here, so an effect's index cannot shift.
  test("App still declares its 20 effects, and the hook declares none", () => {
    expect(countOf(readSrc("App.tsx"), "\n  useEffect(")).toBe(22);
    // A real use, not the word: the hook's header explains WHY there is none.
    const hook = readSrc(HOOK);
    expect(hook).not.toMatch(/^\s*useEffect(\(|<)/m);
    const react = hook.match(/import \{([^{}]*)\} from "react";/)?.[1] ?? "";
    expect(react).not.toContain("useEffect");
  });

  // M5 (the port trap): a callback closing over `host` would make Biome's
  // exhaustive-deps blind to every field, and a re-created ref field would break
  // the freshness rule. Destructured fields, named in deps — never the port.
  test("the hook destructures its port and its deps name fields, never `host`", () => {
    const hook = readSrc(HOOK);
    expect(hook).toContain("} = host;");
    expect(countOf(hook, "host.")).toBe(0);
    expect(hook).not.toMatch(/\[[^\]]*\bhost\b[^\]]*\]/);
    // …and no ALIAS of the port survives either (`const wholePort = host`): a
    // callback reading `wholePort.x` would be just as blind to the linter.
    // Comments are stripped first — the header explains why `host` stays unused.
    const code = hook.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(countOf(code, "host")).toBe(2); // the parameter, and `} = host;`
  });

  // M6: a ref re-created here that a driver OUTSIDE the hook also writes — a
  // second latch decoupled from its writer (the S8/M10 class). The ONE ref
  // created here is the cycle's, and it is named.
  test("the only ref created is the cycle's own, and it is not also a port field", () => {
    const hook = readSrc(HOOK);
    const created = [...hook.matchAll(/const ([A-Za-z_$][\w$]*Ref) = useRef[(<]/g)].map(
      (m) => m[1],
    );
    expect(created).toEqual(["swapRef"]);
    // …and the hook does not take it as a port field (that would be two).
    expect(hook).not.toMatch(/readonly swapRef:\s*MutableRefObject/);
    // `onActivityRef` is the OPPOSITE case and is pinned as such: it is a port
    // field, because the turn driver's drain resolves through it too.
    expect(hook).toMatch(/readonly onActivityRef:\s*MutableRefObject/);
    // No hand-rolled `{ current }` ref either (it would walk past `useRef(`).
    expect(hook).not.toMatch(/=\s*\{\s*current:/);
  });

  // M7: the cycle S9a pinned — the watch callback reaches the handler and the
  // handler reaches the swap — read through the refs at CALL time, never
  // captured by value at render time.
  test("onActivityRef and swapRef keep their late binding", () => {
    const hook = readSrc(HOOK);
    const app = readSrc("App.tsx");
    // The handler is installed into the App's own ref (the turn driver's port).
    expect(hook).toContain("onActivityRef.current = onActivity;");
    expect(app).toContain("onActivityRef.current = onActivity;");
    // `watch` resolves the handler late, and the handler resolves the swap late.
    expect(hook).toContain("onActivityRef.current?.(a)");
    expect(hook).toContain("swapRef.current?.(makeSession(), { keepTranscript: true });");
    expect(hook).toMatch(/const swapRef = useRef</);
    expect(hook).toContain("swapRef.current = swapSession;");
  });

  // The plan's "single broker" failure mode: a session link never builds its own
  // permission broker — a second one would decouple the ask (§7).
  test("the session link creates no broker, and App still creates exactly one", () => {
    const hook = readSrc(HOOK);
    expect(hook).not.toContain("usePermissionBroker");
    expect(hook).not.toContain("PermissionBroker");
    expect(countOf(readSrc("App.tsx"), "usePermissionBroker(")).toBe(1);
  });

  // M8: the bodies did not move — a second copy left behind in App.tsx.
  test("the module exists and no moved body is left in App.tsx", () => {
    expect(existsSync(join(SRC, HOOK))).toBe(true);
    const app = readSrc("App.tsx");
    for (const name of ["onActivity", "watchSession", "swapSession", "switchTo"]) {
      expect(app).not.toContain(`const ${name} = useCallback`);
    }
    // …but App still BINDS them from the hook, so no use site broke.
    expect(app).toContain("const { onActivity, watchSession, swapSession, switchTo }");
  });

  // M9: the returned names drift from the pre-slice ones (a rename would force a
  // use-site edit in App — the Fable M1 rule).
  test("the layer returns exactly the four frozen identifiers", () => {
    const hook = readSrc(HOOK);
    expect(hook).toContain("return { onActivity, watchSession, swapSession, switchTo };");
    // The App's own use sites, unchanged.
    const app = readSrc("App.tsx");
    for (const call of [
      "onActivityRef.current = onActivity;",
      "watchSession(sessionRef.current);",
      "switchTo,",
    ]) {
      expect(app).toContain(call);
    }
  });

  // M10 (the S9b-specific ordering rule): the hook may only be called where every
  // field it takes is already declared AND every effect that consumes its
  // identifiers still runs after it. Both halves are measured here, so a later
  // "tidy" that hoists the call is red.
  test("the call site sits after useTurnDriver and before the mount watch effect", () => {
    const app = readSrc("App.tsx");
    const turn = app.indexOf("} =\n    useTurnDriver({");
    const link = app.indexOf("= useSessionLink({");
    const mount = app.indexOf("watchSession(sessionRef.current);");
    expect(turn).toBeGreaterThan(0);
    expect(link).toBeGreaterThan(turn);
    expect(mount).toBeGreaterThan(link);
    // The four it does NOT own stay App's, each consumed before any legal site:
    // `armWake` by the jobs subscription, `watchReturned` by its own mount
    // effect, `wakeIfPending` by the mount wake, `askContext` by the turn driver.
    for (const name of ["armWake", "watchReturned", "wakeIfPending", "askContext"]) {
      expect(app).toContain(`const ${name} = useCallback`);
      expect(app).not.toContain(`readonly ${name}:`);
    }
  });
});
