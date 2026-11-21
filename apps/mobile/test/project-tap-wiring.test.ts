/**
 * The Computers route's tap wiring (docs/fix/mobile-project-first-tap.md Review
 * round 1). `App.tsx` is not importable from Bun (React Native's sources are
 * Flow), so this pins the structure from the source — the
 * `hub-tap-wiring.test.ts` pattern. WHAT a settle decides is
 * `project-rows.test.ts`'s (`tapSettled`); this is only that the route gives it
 * the facts to decide with, on every path the person can take.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
/** The source with its comment lines removed: prose names things the code must not do. */
const code = (src: string) =>
  src
    .split("\n")
    .filter((line) => !/^\s*(\/?\*|\/\/)/.test(line))
    .join("\n");

const APP = readFileSync(join(ROOT, "App.tsx"), "utf8");
const ROUTE = code(
  APP.slice(APP.indexOf("function ComputersRoute"), APP.indexOf("function SessionsRoute")),
);

/** One of the route's props, from `NAME={` to the matching close at column 6. */
const handler = (name: string): string => {
  const at = ROUTE.indexOf(`      ${name}=`);
  expect(at).toBeGreaterThan(-1);
  const next = ROUTE.slice(at + 1).search(/\n {6}\S/);
  return ROUTE.slice(at, next === -1 ? undefined : at + 1 + next);
};

describe("a tap's wait obeys what the person asked for after the tap", () => {
  test("the settle is given `superseded` and `backgrounded`, not just the row", () => {
    // The MEDIUM: `tapSettled` opened the row it had asked about, so a tap on a
    // working row B while unreachable A re-probed was undone by A's screen when
    // A's probe landed. The decision now takes the facts only the screen knows.
    expect(ROUTE).toContain("const superseded = mine !== tapGeneration.current");
    expect(ROUTE).toContain("tapSettled(settledRow, { superseded, backgrounded: offscreen })");
    // …and a dropped settle may not repaint or navigate: it returns first.
    const at = ROUTE.indexOf("const outcome = tapSettled(");
    const after = ROUTE.slice(at, ROUTE.indexOf("if (inputs !== undefined)", at));
    expect(after).toContain('if (outcome === "drop") {');
    expect(after).toContain("return;");
    expect(after).not.toContain("setSections(");
  });

  test("every ask the person can make supersedes the waits already running (mutation: drop one `supersede()` → red)", () => {
    // A tap that only waits, a tap on a working row, the menu, Add, its scan,
    // Retry, Pair again and Remove: each is the person choosing something, so
    // any earlier tap's wait is stale from that moment on.
    for (const name of [
      "onOpen",
      "onAdd",
      "onScan",
      "onRetry",
      "onPairAgain",
      "onMenu",
      "onRemove",
      "onOpenSettings",
    ]) {
      expect(handler(name)).toContain("supersede()");
    }
  });

  test("leaving the screen supersedes as well, from an effect the 15 s re-probe does not re-run", () => {
    // Backgrounding, or navigating away while a wait runs: it must not act.
    const at = ROUTE.indexOf("sentOffscreen.current = true");
    expect(at).toBeGreaterThan(-1);
    const close = ROUTE.indexOf("}),", at) + "}),".length;
    const effect = ROUTE.slice(ROUTE.lastIndexOf("useFocusEffect(", at), close);
    expect(effect).toContain("sentOffscreen.current = true");
    expect(effect).toContain("supersede()");
    // The re-probe effect depends on `tick`; this one must NOT, or the 15 s
    // reconsideration would count as the person moving on.
    expect(effect).toContain("}, [supersede]),");
  });

  test("a second tap is not swallowed while the first wait runs", () => {
    // The round-0 wiring ignored it (`if (settling.current) return;`), which left
    // "two taps during checking" uncovered.
    expect(ROUTE).not.toContain("settling.current");
  });

  test("the app going to the background supersedes too, through the one `wasBackgrounded` rule (mutation: ignore the AppState change → red)", () => {
    // The `useFocusEffect` cleanup cannot see a backgrounded app (the screen stays
    // focused), so the AppState listener must do it — and read the state through
    // the pure rule `project-rows.test.ts` pins.
    const at = ROUTE.indexOf('AppState.addEventListener("change"');
    expect(at).toBeGreaterThan(-1);
    const listener = ROUTE.slice(at, ROUTE.indexOf("});", at));
    expect(listener).toContain("wasBackgrounded(state)");
    expect(listener).toContain("supersede()");
    // `inactive` counts (a sheet, the app switcher): it is not `active`.
    expect(listener).not.toContain('state === "active"');
    // And the flag starts from the TRUTH, never from a literal `false`: both
    // effects re-run on every 15 s reconsideration, which must not mark a
    // backgrounded app as being in front.
    expect(ROUTE).not.toContain("sentOffscreen.current = false");
    expect(
      ROUTE.match(/sentOffscreen\.current = wasBackgrounded\(AppState\.currentState\)/g),
    ).toHaveLength(2);
  });
});
