/**
 * docs/feat/app-decomposition.md S4 — the mouse LAYER at the App seam.
 *
 * `mouse-stream.test.ts` proves the pure decisions. What it cannot prove is that
 * `useMouse` threads a coalesced chunk's state the way the inline handler did:
 * the reports of ONE write see each other with NO render between them. A drag
 * that arrives as a single chunk (press, motion, release — the common case, a
 * terminal writing the whole gesture in one `read`) must COPY, which it only
 * does if each report's state is the previous report's rather than a React
 * state read taken before the chunk started.
 *
 * S0b pins the order/identity/freshness of the key layer; this file pins the
 * same properties for the mouse layer that replaced the inline block.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type AppProps, type SessionController } from "../src/App.tsx";
import { inertSession } from "./session-stub.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
// SGR mouse: left press / left drag / release at (col=x, row=y).
const press = (x: number, y: number): string => `\u001B[<0;${x};${y}M`;
const drag = (x: number, y: number): string => `\u001B[<32;${x};${y}M`;
const release = (x: number, y: number): string => `\u001B[<0;${x};${y}m`;

function fake(): SessionController {
  return {
    ...inertSession(),
    async *send() {
      yield { type: "turn_end", reason: "end_turn" };
    },
    onJobs(listener: (r: { rows: readonly never[]; count: number }) => void) {
      listener({ rows: [], count: 0 });
      return () => {};
    },
    onSubagents(listener: (rows: readonly never[]) => void) {
      listener([]);
      return () => {};
    },
    ownsTurn: () => true,
  } as unknown as SessionController;
}

/** A turn with ONE tool call whose header row carries a long, wrapped command. */
function toolCallSession(): SessionController {
  return {
    ...inertSession(),
    async *send() {
      yield {
        type: "tool_start" as const,
        id: "c1",
        name: "shell",
        arguments: JSON.stringify({ command: `echo ${"x".repeat(120)}` }),
      };
      await delay(10);
      yield {
        type: "tool_result" as const,
        id: "c1",
        name: "shell",
        result: { content: "ok", isError: false },
        durationMs: 20,
      };
      yield { type: "turn_end" as const, reason: "end_turn" as const };
    },
  } as unknown as SessionController;
}

async function mount(extra: Partial<AppProps> = {}) {
  const app = render(
    <App
      createSession={() => fake()}
      permissions={new PermissionBroker()}
      model="m"
      cwd="/tmp/work"
      mcpStatus={() => Promise.resolve([])}
      {...extra}
    />,
  );
  await delay(80);
  return app;
}

describe("S4 mouse layer: a coalesced chunk threads its own state", () => {
  test("press+release on a tool header in ONE write is still a CLICK (the click state is threaded)", async () => {
    // The click recogniser's state reaches its ref only AFTER the chunk's
    // reports, so a chunk that reads the refs per report sees `CLICK_IDLE` for
    // the release and never completes the click. This is the property the
    // selection tests cannot see (the selection IS written to its ref inside the
    // loop); it is the one mutation M14 turns on.
    const app = render(<App createSession={() => toolCallSession()} model="m" cwd="/tmp/work" />);
    await delay(40);
    Object.defineProperty(app.stdout, "columns", { value: 160, configurable: true });
    app.stdout.emit("resize");
    await delay(60);
    app.stdin.write("go");
    await delay(20);
    app.stdin.write("\r");
    await delay(200);
    const frame = () => app.lastFrame() ?? "";
    const rows = () => frame().split("\n").map(strip);
    const y = rows().findIndex((r) => r.includes("Bash")) + 1;
    expect(y).toBeGreaterThan(0);
    // An expanded `shell` call's command rows: the `⎿ $ …` block opener and the
    // continuation rows hung 4 cells under it (docs/fix/tui-shell-row-collapsed —
    // no `  │ ` rows for a shell command any more).
    const cont = () => rows().filter((r) => r.startsWith("⎿ $ ") || /^ {4}\S/.test(r));
    expect(cont()).toHaveLength(0); // nothing expanded yet
    app.stdin.write(`${press(3, y)}${release(3, y)}`);
    await delay(120);
    expect(cont().length).toBeGreaterThan(0); // the call expanded
    app.unmount();
  });

  test("press+motion+release in ONE write copies the selection (no render between reports)", async () => {
    const copied: string[] = [];
    const app = await mount({
      clipboard: async (t: string) => {
        copied.push(t);
      },
    });
    // The whole gesture in a single chunk: nothing between the three reports
    // forces a render, so the release can only see the selection if the layer
    // threaded it through the reports itself.
    // Row 1 is the startup header's first line, `tentacle` (docs/feat/tui-mascot.md):
    // no bullet, so the name starts at column 1.
    app.stdin.write(`${press(1, 1)}${drag(9, 1)}${release(9, 1)}`);
    await delay(120);

    expect(copied).toHaveLength(1);
    expect(copied[0]).toBe("tentacle");
    // The title of the inverted run goes with the release, not with a repaint.
    app.unmount();
  });

  test("the same gesture split across chunks (a render each time) copies the same text", async () => {
    const copied: string[] = [];
    const app = await mount({
      clipboard: async (t: string) => {
        copied.push(t);
      },
    });
    app.stdin.write(press(1, 1));
    await delay(60);
    app.stdin.write(drag(9, 1));
    await delay(60);
    app.stdin.write(release(9, 1));
    await delay(120);

    expect(copied).toHaveLength(1);
    expect(copied[0]).toBe("tentacle");
    app.unmount();
  });
});
