/**
 * docs/feat/app-decomposition.md S11 (`feat/app-decomp-11-hop`) — the hop's
 * executor leaves `App.tsx`, and the turn boundary becomes ONE rule.
 *
 * `useHop` is a HOOK whose every DECISION is already a pure module's
 * (`parseHopCommand`, `hopStep`, `hopReady`, `hopStatusRow`, `hopMovedNotice`,
 * `hopFailureText`), each with its own test. So what is new here is only what
 * the MOVE could break — and there are four things:
 *
 * 1. **No effect moved (Fable H1 / owner Q7 (a)).** App keeps its 22 effects in
 *    today's order, and the queued-hop idle effect (1-based #20, 0-based 19) is
 *    still App's own: it is the only trigger that starts a hop at the first TRUE
 *    idle, and its deps are App's render values (`hopQueued`, `st.running`,
 *    `shown.length`). A hook that moved the effect, or a hook call below it,
 *    would silently change mount order — the class S0b's order test catches and
 *    nothing else pins per file.
 * 2. **The three drivers live in one place.** A half-move (a copy left behind in
 *    App, or a callback that never left) is invisible to every render test until
 *    someone edits the wrong copy.
 * 3. **The boundary is ONE pure rule.** `hopStep` (which decides
 *    start-vs-queue for a typed `/move`) and `hopIfQueued` (which re-checks it at
 *    the idle) wrote the same `running || queued > 0` out twice — the review's
 *    own words: "its busy check repeats `hopStep`'s inputs". Two copies is how
 *    the two paths drift into disagreeing about when a hop may start.
 * 4. **App no longer reads the queue to decide it** — that read moved with the
 *    rule, into `hopReady`'s input.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const readSrc = (name: string): string => readFileSync(join(SRC, name), "utf8");
const app = (): string => readSrc("App.tsx");

describe("S11: the hop's three drivers left App.tsx for `useHop.ts`", () => {
  test("`useHop.ts` exists and defines `startHop`, `requestHop`, `hopIfQueued`", () => {
    expect(existsSync(join(SRC, "useHop.ts"))).toBe(true);
    const hop = readSrc("useHop.ts");
    expect(hop).toContain("const startHop = useCallback(");
    expect(hop).toContain("const requestHop = useCallback(");
    expect(hop).toContain("const hopIfQueued = useCallback(");
  });

  test("App.tsx no longer defines them, and calls the hook (a copy left behind is the drift)", () => {
    const src = app();
    expect(src).not.toContain("const startHop = useCallback(");
    expect(src).not.toContain("const requestHop = useCallback(");
    expect(src).not.toContain("const hopIfQueued = useCallback(");
    expect(src).toContain("useHop({");
  });

  test("`useHop.ts` declares no `useEffect` (the idle hop effect stays in App)", () => {
    const hop = readSrc("useHop.ts");
    // The CALL, not the word: the header explains why the effect stayed in App.
    expect(hop).not.toMatch(/useEffect\s*\(/);
    expect(hop).not.toMatch(/import \{[^}]*\buseEffect\b[^}]*\} from "react";/);
  });

  test("App keeps 22 effects, and the idle hop effect is still #20 (0-based 19)", () => {
    const src = app();
    const at = [...src.matchAll(/^\s*useEffect\(/gm)].map((m) => m.index ?? 0);
    expect(at.length).toBe(22);
    const body = (i: number): string => src.slice(at[i] ?? 0, (at[i] ?? 0) + 400);
    // The queued-hop driver, read through its ref: the one trigger that starts a
    // hop at the first true idle (D4).
    expect(body(19)).toContain("hopIfQueuedRef");
    // …and the hook call sits ABOVE it, so the order React sees is the order the
    // code is written in.
    expect(src.indexOf("useHop({")).toBeLessThan(at[19] ?? 0);
  });
});

describe("S11: the turn boundary is ONE pure rule, not two copies", () => {
  test("`hopReady` exists, and BOTH paths call it", () => {
    const command = readSrc("hop-command.ts");
    const hop = readSrc("useHop.ts");
    expect(command).toContain("export function hopReady(");
    expect(command).toMatch(/return hopReady\(/);
    expect(hop).toMatch(/hopReady\(/);
  });

  test("neither inline copy survives (no `running || … queued > 0` anywhere)", () => {
    for (const name of ["hop-command.ts", "useHop.ts", "App.tsx"]) {
      expect(readSrc(name)).not.toMatch(/running \|\|[^\n]*queued > 0/);
    }
  });

  test("App no longer reads the queue to decide the boundary", () => {
    expect(app()).not.toContain("shownRows(rowsRef.current, daemonQueueRef.current).length");
  });
});
