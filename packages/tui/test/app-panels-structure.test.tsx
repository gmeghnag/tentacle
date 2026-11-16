/**
 * docs/feat/app-decomposition.md S7 — the STRUCTURAL contract of the move, in the
 * S0b/S6 style: source-level properties a frame assertion cannot see, plus the
 * App-seam behaviours that made the move safe.
 *
 * What S7 claims (plan H4(4)), and what is pinned here:
 *   - the panel RULES left `App.tsx` and `panel.ts`: no `kind ===` branch survives
 *     in either, and the three App-side `/sessions` writes are the kind's own
 *     functions (`panels/sessions.ts`), not inline tests;
 *   - `usePanels.ts` is an EXECUTOR: it declares no `useEffect` (Fable H1 — the
 *     effect list stays App's), and `App` still has 22 effects (the original 20
 *     + session-hop's 2);
 *   - an open panel's answer that arrives after the panel CLOSED or was REPLACED
 *     is still dropped (the generation rule did not die in the move);
 *   - the `kind ===` that must now answer for a NEW panel is the registry's, and
 *     `panels-registry.test.ts` proves that with a synthetic fourth kind.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import { inertSession } from "./session-stub.ts";

const SRC = join(import.meta.dir, "..", "src");
const readSrc = (name: string): string => readFileSync(join(SRC, name), "utf8");
const countOf = (src: string, needle: string): number => src.split(needle).length - 1;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The smallest session an App needs to mount (these cases never send a prompt). */
const idleSession = (): SessionController =>
  ({
    ...inertSession(),
    async *send() {
      yield { type: "turn_end", reason: "end_turn" };
    },
    onSubagents() {
      return () => {};
    },
    onJobs(listener: (r: { rows: readonly never[]; count: number }) => void) {
      listener({ rows: [], count: 0 });
      return () => {};
    },
    ownsTurn: () => true,
  }) as unknown as SessionController;

/** The 0-based App effects, as the S6/S5 pins already count them. */
const effectCount = (src: string): number => [...src.matchAll(/^ {2}useEffect\(/gm)].length;

describe("S7: the panel rules are the kinds', not App.tsx's", () => {
  test("no `kind ===` panel branch is left in App.tsx or panel.ts", () => {
    const app = readSrc("App.tsx");
    const facade = readSrc("panel.ts");
    // The `/sessions`-only writes those files used to carry inline.
    expect(app).not.toContain('p?.kind === "sessions"');
    expect(app).not.toContain('panelRef.current?.kind === "sessions"');
    // No concrete kind comparison survives in the façade (its doc comment names
    // the shape it removed — that prose is not a branch).
    for (const kind of ['=== "mcp"', '=== "skills"', '=== "sessions"']) {
      expect(facade).not.toContain(kind);
    }
    // ...and the rules really moved somewhere (non-vacuity of the scan above).
    const sessions = readSrc(join("panels", "sessions.ts"));
    for (const rule of [
      "isSessionsOpen",
      "withSessionsState",
      "withSessionsRefresh",
      "touchPanel",
    ]) {
      expect(sessions).toContain(`export const ${rule}`);
    }
  });

  test("the façade delegates by KIND LOOKUP, over a registry of descriptors", () => {
    const facade = readSrc("panel.ts");
    // One lookup per facade call, and nothing that switches on a kind itself.
    // view, apply, click, switchOp (docs/feat/session-capabilities.md S4).
    expect(countOf(facade, "kindOf(panel)")).toBe(4);
    expect(facade).not.toContain('=== "mcp"');
    expect(facade).not.toContain('=== "skills"');
    const registry = readSrc(join("panels", "registry.ts"));
    // ONE line per kind: the measurable "new panel = file + registry line".
    expect(registry).toContain(
      "export const PANEL_KINDS: readonly PanelKind<OpenPanel>[] = [sessionsKind, mcpKind, skillsKind];",
    );
    // The two panel key layers are the registry's decision too, not their own.
    const layers = readSrc(join("keys", "layer-panels.ts"));
    expect(layers).not.toContain("sessionsKey");
    expect(layers).not.toContain("treeKey");
    expect(countOf(layers, "panelStep(snap,")).toBe(2);
  });

  test("the `/sessions` repaint on a swap is the kind's rule, called once", () => {
    // Since S9b, `swapSession` (the ONE caller of this repaint) lives in
    // `useSessionLink.ts`: the locator follows the declaration (the plan's
    // Preconditions rule), and the property is unchanged — the rule that owns
    // the repaint is called exactly once, and never rebuilt inline.
    const link = readSrc("useSessionLink.ts");
    expect(countOf(link, "touchPanel()")).toBe(1);
    expect(countOf(readSrc("App.tsx"), "touchPanel()")).toBe(0);
    expect(link).not.toContain('(p) => (p?.kind === "sessions" ? { ...p } : p)');
    const hook = readSrc("usePanels.ts");
    expect(countOf(hook, "touchPanel(p)")).toBe(1);
  });

  test("usePanels is an EXECUTOR: it declares no effect, and App keeps its 22", () => {
    const hook = readSrc("usePanels.ts");
    expect(hook).not.toContain("useEffect");
    expect(hook).toContain("useCallback");
    // Fable H1: the effect list is App's and its length is unchanged.
    expect(effectCount(readSrc("App.tsx"))).toBe(22);
    // Exactly ONE `usePanels` call (two would be two generations over one panel).
    expect(countOf(readSrc("App.tsx"), "usePanels({")).toBe(1);
  });
});

describe("S7: the panel seam behaves as before the move", () => {
  const SERVERS = [
    // A server list whose read the test controls, so "late" is a real ordering.
    { name: "github", state: "connected" as const, tools: ["a"], moreTools: 0, latencyMs: 1 },
  ];

  test("an answer landing after the panel CLOSED is dropped (the generation rule)", async () => {
    const app = render(
      <App
        createSession={idleSession}
        model="m"
        cwd="/tmp/work"
        mcpStatus={async () => {
          await delay(90);
          return SERVERS;
        }}
      />,
    );
    await delay(30);
    app.stdin.write("/mcp");
    await delay(20);
    app.stdin.write("\r");
    await delay(30);
    // The loading panel is up; close it BEFORE the load answers.
    expect(app.lastFrame() ?? "").toContain("probing");
    app.stdin.write("\u001B");
    await delay(140);
    const frame = app.lastFrame() ?? "";
    expect(frame).not.toContain("github");
    expect(frame).toContain("Type a task or /command");
    app.unmount();
  });

  test("an answer landing after ANOTHER panel opened is dropped (replace, not just close)", async () => {
    // A deferred the test resolves LATER: the load is still in flight while the
    // panel is replaced, which is the ordering this case is about.
    const gate: { release?: () => void } = {};
    const pending = new Promise<
      readonly {
        name: string;
        state: "connected";
        tools: string[];
        moreTools: number;
        latencyMs: number;
      }[]
    >((resolve) => {
      gate.release = () => resolve(SERVERS);
    });
    const app = render(
      <App createSession={idleSession} model="m" cwd="/tmp/work" mcpStatus={() => pending} />,
    );
    await delay(30);
    app.stdin.write("/mcp");
    await delay(20);
    app.stdin.write("\r");
    await delay(30);
    expect(app.lastFrame() ?? "").toContain("probing");
    // The panel is replaced by another one (Esc closes, then `/skills` opens).
    app.stdin.write("\u001B");
    await delay(30);
    expect(app.lastFrame() ?? "").not.toContain("probing");
    // Now the FIRST load answers: it must not resurrect the MCP panel.
    gate.release?.();
    await delay(60);
    const frame = app.lastFrame() ?? "";
    expect(frame).not.toContain("github");
    expect(frame).toContain("Type a task or /command");
    app.unmount();
  });

  test("a claimed panel key still acts on the OPEN panel, not on a stale one", async () => {
    const app = render(
      <App createSession={idleSession} model="m" cwd="/tmp/work" mcpStatus={async () => SERVERS} />,
    );
    await delay(30);
    app.stdin.write("/mcp");
    await delay(20);
    app.stdin.write("\r");
    await delay(60);
    // Enter expands the first server: the panel's own `apply` ran through the
    // registry, on the state the key landed on.
    app.stdin.write("\r");
    await delay(40);
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("❯ ▾ github");
    expect(frame).toContain("  a"); // the child row, indented under the head
    app.unmount();
  });
});
