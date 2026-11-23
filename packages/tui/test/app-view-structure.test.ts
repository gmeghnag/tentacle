/**
 * docs/feat/app-decomposition.md S10 — the STRUCTURAL contract of the move, in
 * the S6/S8/S9a/S9b style: source-level properties a rendering assertion cannot
 * see.
 *
 * The plan's payload is the LAST slice: the derived rows (the view-model) leave
 * `App.tsx` into a pure `app-layout.ts`, and the JSX tree leaves into a dumb
 * `AppView.tsx`. The plan's own constraint (M3) is that this is a **verbatim JSX
 * move** — "no prop re-plumbing". What must hold afterwards:
 *   - `app-layout.ts` is PURE: React-free, no `use*`, no effect, no ref, no
 *     `process.stdout` (AGENTS §7: decisions and computation here, presentation
 *     only in the component);
 *   - `AppView.tsx` is a DUMB RENDERER: it declares no `useState`/`useRef`/
 *     `useEffect`/`useCallback`, imports no decision module, and every value it
 *     paints is a field of the model it is handed (so the only branching it owns
 *     is "what it looks like");
 *   - the decisions stay the pure modules' (`statusTokens`, `panelView`,
 *     `backgroundListView`, `pillView`, `windowFor`, …): they are CALLED by
 *     `app-layout.ts`, never re-implemented in the component;
 *   - App's effect list is untouched (H1: no effect moved), and the ONE
 *     `useInput` stays in `App` (the Load-bearing assumption: S10 moves no key
 *     handling);
 *   - the blank-row rule survives (`row === "" ? " " : row`): an empty `<Text>`
 *     measures 0×0 in Ink and would collapse rows (AGENTS §6);
 *   - the frame is unchanged: `app-frames.test.tsx`'s 13 pinned frames and
 *     S0b's SGR/pill pins are the behavioural half, unedited.
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

/** A module's source with its comments stripped (prose must not satisfy a scan). */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

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

/** The module a layout import brings `name` in FROM (its single binding). */
const importOf = (src: string, name: string): string => {
  for (const m of src.matchAll(/import \{([^{}]*)\} from "(\.\/[^"]*)";/gs)) {
    for (const raw of (m[1] ?? "").split(",")) {
      if (
        raw
          .trim()
          .replace(/^type /, "")
          .split(" as ")[0]
          ?.trim() === name
      ) {
        return m[2] ?? "";
      }
    }
  }
  return "(not imported)";
};

/** The identifiers a module imports from ANY relative module. */
const relativeImports = (src: string): string[] => {
  const names: string[] = [];
  for (const m of src.matchAll(/import \{([^{}]*)\} from "\.\/[^"]*";/gs)) {
    for (const raw of (m[1] ?? "").split(",")) {
      const name =
        raw
          .trim()
          .replace(/^type /, "")
          .split(" as ")[0]
          ?.trim() ?? "";
      if (name !== "") {
        names.push(name);
      }
    }
  }
  return names;
};

describe("S10: the view-model and the tree leave App.tsx", () => {
  // M1: the modules are missing (the rows and the JSX never left).
  test("both modules exist, and App.tsx renders AppView", () => {
    expect(existsSync(join(SRC, "app-layout.ts"))).toBe(true);
    expect(existsSync(join(SRC, "AppView.tsx"))).toBe(true);
    const app = readSrc("App.tsx");
    expect(importSpecs(app, "./AppView.tsx")).toContain("AppView");
    expect(importSpecs(app, "./app-layout.ts")).toContain("frameLayout");
    // Exactly one render of it, and it takes ONE model.
    expect(countOf(app, "<AppView")).toBe(1);
    expect(countOf(app, "model={{")).toBe(1);
  });

  // M2: the derived rows were re-inlined in App.tsx (a second render tree, or a
  // second copy of the maths, which would drift from the module's).
  test("no derived row is computed in App.tsx any more", () => {
    const app = code(readSrc("App.tsx"));
    // The decisions the view-model executes: all gone from App, all called by
    // the module (M4 below). `statusTokens(`-style calls, not the words.
    for (const name of [
      "statusTokens",
      "contextShown",
      "matchCommands",
      "paletteWindow",
      "inputRowCount",
      "attachRowView",
      "attachRowRows",
      "panelView",
      "backgroundListView",
      "jobDrawerView",
      "drawerView",
      "dockRows",
      "pillView",
      "replyView",
      "permissionPromptRows",
      "panelHeight",
      "panelMaxBody",
    ]) {
      expect(app).not.toContain(`${name}(`);
      // …and not as a value either (a module may import it without calling it).
      expect(relativeImports(readSrc("App.tsx"))).not.toContain(name);
    }
    // The things that deliberately STAYED, and must stay: `layoutTranscript`,
    // `windowFor`, `sliceLaid` and `isScrolledUp` feed the transcript layout and
    // the scroll anchor, whose consumers are three `useEffect`s that may not move
    // (H1) — S10 moved the FRAME's rows, not the transcript's. `shownRows` is
    // likewise still read by two driver paths outside the frame. Pinned so a
    // later "tidy" that pulls them into the view-model is a visible decision.
    for (const stayed of ["layoutTranscript", "windowFor", "sliceLaid", "isScrolledUp"]) {
      expect(app).toContain(`${stayed}(`);
    }
    // The layout's own derived values are not redeclared here.
    for (const decl of [
      "const activeRows =",
      "const viewport =",
      "const panelBodyTop =",
      "const dockTop =",
      "const dockHeight =",
      "const runningRows =",
      "const inputBoxRows =",
      "const paletteRows =",
      "const listView =",
      "const pill =",
      "const drawer =",
    ]) {
      expect(app).not.toContain(decl);
    }
    // The transcript WINDOW stays App's: its parts feed the scroll-anchor, the
    // mouse snapshot and the hop's idle effect, all of which may not move (H1).
    for (const stays of ["const total =", "const win =", "const visible ="]) {
      expect(app).toContain(stays);
    }
  });

  // M3: the JSX stayed behind (the tree never moved), or was moved only partly.
  test("the JSX tree is AppView's, not App.tsx's", () => {
    const app = code(readSrc("App.tsx"));
    // A JSX tag, not a generic argument (`useState<QuitConfirmFacts | null>` is
    // a TYPE argument and must not count): the tag is followed by whitespace, a
    // self-closing `/` or the end of the line.
    for (const tag of [
      "StatusBar",
      "LineInput",
      "Thinking",
      "ListPanel",
      "CommandPalette",
      "PermissionPrompt",
      "QuitConfirm",
      "BackgroundList",
      "JobDrawer",
      "SubagentDrawer",
      "QueuedMessages",
    ]) {
      expect(app).not.toMatch(new RegExp(`<${tag}(?=[\\s/>])`));
    }
    // …and it really moved there (non-vacuity of the scan above).
    const view = readSrc("AppView.tsx");
    for (const tag of ["<StatusBar", "<LineInput", "<Thinking", "<ListPanel", "<QuitConfirm"]) {
      expect(view).toContain(tag);
    }
  });

  // M4: the decisions dropped, not moved (the module re-implements them).
  test("app-layout.ts calls those decisions, imported not re-declared", () => {
    const layout = readSrc("app-layout.ts");
    for (const name of [
      "statusTokens",
      "contextShown",
      "matchCommands",
      "paletteWindow",
      "inputRowCount",
      "attachRowView",
      "attachRowRows",
      "panelView",
      "shownRows",
      "backgroundListView",
      "jobDrawerView",
      "drawerView",
      "dockRows",
      "pillView",
      "replyView",
      "panelHeight",
      "panelMaxBody",
    ]) {
      // IMPORTED (so it is the module's binding, not a local re-implementation)
      // and CALLED.
      expect(importSpecs(layout, importOf(layout, name))).toContain(name);
      expect(layout).toContain(`${name}(`);
      expect(layout).not.toMatch(new RegExp(`^function ${name}\\b`, "m"));
      expect(layout).not.toMatch(new RegExp(`^const ${name} =`, "m"));
    }
  });

  // AGENTS §7: computation/branching in a pure module; the component renders.
  test("app-layout.ts is pure: React-free, no hook, no ref, no effect, no stdout", () => {
    const layout = readSrc("app-layout.ts");
    const body = code(layout);
    expect(body).not.toContain('from "react"');
    expect(body).not.toContain('from "ink"');
    expect(body).not.toMatch(/\buse[A-Z][A-Za-z]*\(/);
    expect(code(layout)).not.toContain("useEffect");
    expect(code(layout)).not.toContain("useRef");
    expect(body).not.toContain("process.stdout");
    // No component either: a `.ts` module that never renders an element, and no
    // ref of its own (a `{ current }` it wrote would be state outside React).
    expect(body).not.toContain("ReactElement");
    expect(body).not.toMatch(/^\s*<[A-Za-z]/m);
    expect(body).not.toMatch(/=\s*\{\s*current:/);
    // The refs it READS are its input's fields and are typed as such, which is
    // the freshness rule: the source does not change when the code moves.
    expect(body).toContain("subagentsRef.current");
    expect(body).toContain("jobRowsRef.current");
  });

  // AGENTS §7 + the plan's "component only renders": the view declares no state,
  // holds no ref, runs no effect, and DECIDES nothing — the geometry it paints is
  // the model's (`app-layout.ts`), never re-derived here.
  test("AppView.tsx is a dumb renderer: no state, no ref, no effect, no geometry", () => {
    const view = readSrc("AppView.tsx");
    const body = code(view);
    for (const hook of ["useState", "useRef", "useEffect", "useCallback", "useMemo", "useInput"]) {
      expect(body).not.toContain(hook);
    }
    expect(body).not.toContain(".current");
    // Not one DECISION module: the rows, the panel/dock/pill views and the
    // terminal maths are the model's fields, so none of their modules is imported.
    for (const from of [
      "./status-view.ts", // the tokens/context/pill views
      "./background-list.ts", // the dock's dropdown/drawer views
      "./panel.ts", // the list panel's view
      "./tree-panel.ts", // the panel's height
      "./scroll.ts", // the scroll maths
      "./permission-reply.ts", // the reply field's view
      "./attach-draft.ts", // the attach row's view
    ]) {
      expect(importSpecs(view, from)).toEqual([]);
    }
    // `SEND_NOW_HINT` is a static hint STRING the inline tree already passed to
    // `QueuedMessages` (like `INPUT_PLACEHOLDER`): presentation, not a decision.
    expect(importSpecs(view, "./send-now.ts")).toEqual(["SEND_NOW_HINT"]);
    // The layout module gives it exactly two things: the model's TYPE and the
    // input box's row cap. A function taken from it would be geometry re-entering
    // the component, which is the property this pins.
    expect(importSpecs(view, "./app-layout.ts").sort()).toEqual(["AppViewModel", "MAX_INPUT_ROWS"]);
    // It renders the model it is handed, and nothing else is its source.
    expect(view).toContain("{ model }");
  });

  // M5: the one behaviour the move could silently break — the blank-row rule that
  // keeps an empty row at height 1 (AGENTS §6: an empty `<Text>` is 0×0).
  test("the blank-row rule survives the move, in the module that paints rows", () => {
    expect(readSrc("AppView.tsx")).toContain('row === "" ? " " : row');
    // Both the painted text and the measured plain line get the space, or the
    // selection's cell range would be computed against a zero-width row.
    expect(countOf(readSrc("AppView.tsx"), '=== "" ? " " :')).toBeGreaterThanOrEqual(2);
  });

  // H1 (the plan's effect-order failure mode): S10 moves no effect, so nothing
  // can be reordered. Pinned as the frozen count the other slices use.
  test("App still declares its 22 effects, and neither new module declares one", () => {
    expect(countOf(readSrc("App.tsx"), "\n  useEffect(")).toBe(22);
    expect(code(readSrc("app-layout.ts"))).not.toContain("useEffect");
    expect(code(readSrc("AppView.tsx"))).not.toContain("useEffect");
  });

  // The Load-bearing assumption: Ink calls every active `useInput`, so the
  // handler must stay ONE, in App. S10 must not add a listener.
  test("the ONE useInput stays in App.tsx", () => {
    expect(countOf(readSrc("App.tsx"), "useInput(")).toBe(1);
    expect(code(readSrc("app-layout.ts"))).not.toContain("useInput");
    expect(code(readSrc("AppView.tsx"))).not.toContain("useInput");
  });

  // The status bar reports the row it painted on (`onPillRange`), and the App's
  // mouse layer reads it. The move must not lose the wiring: the view passes the
  // model's callback, which still writes the App's ref, and the row is still
  // derived from the parts the tree lays out.
  test("onPillRange is still wired: the view paints the bar, App owns the ref", () => {
    const view = readSrc("AppView.tsx");
    const app = readSrc("App.tsx");
    const layout = readSrc("app-layout.ts");
    // The PROP is passed to the bar (not merely destructured: M9 deletes the
    // attribute only, and a bare `toContain("onPillRange")` survives that).
    expect(view).toMatch(/<StatusBar[\s\S]*?onPillRange=\{onPillRange\}/);
    // The view does not DERIVE the row (it paints what it is given): the row
    // arithmetic lives in the pure module, once, over the parts the tree lays out.
    // The workflow rail (docs/feat/workflows-ui.md D3) is one of those parts: it
    // paints ABOVE the queued/slot block, so its reserved rows sit between the
    // spacer and the running rows — exactly as `activeRows`/`dockTop` count them.
    expect(layout).toContain("const statusRowY =");
    expect(layout).toMatch(
      /const statusRowY = viewport \+ 1 \+ workflowHeight \+ runningRows \+ dockHeight \+ inputBoxRows \+ 1;/,
    );
    // …and the view never re-derives it.
    expect(code(view)).not.toContain("statusRowY");
    // App owns the ref and pairs it with the module's row.
    expect(app).toContain("const statusRowRef = useRef<{");
    expect(app).toContain("statusRowRef.current = { y: frame.statusRowY, pill: range };");
  });
});
