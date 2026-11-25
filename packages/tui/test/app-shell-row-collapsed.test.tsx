/**
 * docs/fix/tui-shell-row-collapsed at the App seam (ink frames): the shapes the
 * pure tests pin, end to end — collapsed a described `shell` row is its sentence
 * plus `⎿ $ cmd  exit=N`, with NO output in the frame; ctrl+o and a click on the
 * header both open the block (the whole command + the output at col 2), and the
 * input row does not move while the row above it grows.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App } from "../src/App.tsx";
import type { SessionController } from "../src/App.tsx";
import { inertSession } from "./session-stub.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const press = (col: number, row: number) => `\u001B[<0;${col};${row}M`;
const release = (col: number, row: number) => `\u001B[<0;${col};${row}m`;
const CTRL_O = "\u000F";

const SENTENCE = "Run the mobile package tests";
const COMMAND = "bun test apps/mobile";

/** A session whose single turn runs one FAILING `shell` call with output. */
function failingSession(): SessionController {
  return {
    ...inertSession(),
    async *send() {
      yield {
        type: "tool_start" as const,
        id: "c1",
        name: "shell",
        arguments: JSON.stringify({ command: COMMAND, description: SENTENCE }),
      };
      yield {
        type: "tool_result" as const,
        id: "c1",
        name: "shell",
        result: { content: "exit=1\n1 fail · 23 pass", isError: true },
        durationMs: 3400,
      };
      yield { type: "turn_end" as const, reason: "end_turn" as const };
    },
  } as unknown as SessionController;
}

/** Mount the App, send one prompt and let the turn settle. */
async function run(): Promise<{
  app: ReturnType<typeof render>;
  rows: () => string[];
}> {
  const app = render(
    <App
      createSession={failingSession}
      permissions={new PermissionBroker()}
      model="m"
      cwd="/tmp/work"
      mcpStatus={() => Promise.resolve([])}
    />,
  );
  await delay(60);
  app.stdin.write("go");
  await delay(20);
  app.stdin.write("\r");
  await delay(150);
  return { app, rows: () => strip(app.lastFrame() ?? "").split("\n") };
}

describe("a described shell call in the App (docs/fix/tui-shell-row-collapsed)", () => {
  test("collapsed: the sentence, `⎿ $ cmd  exit=1`, no output, no ✓, input row stable", async () => {
    const { app, rows } = await run();
    const frame = rows();
    const head = frame.findIndex((r) => r.includes(SENTENCE));
    expect(head).toBeGreaterThanOrEqual(0);
    expect(frame[head]).toBe(`● ${SENTENCE} 3.4s`);
    expect(frame[head]).not.toContain("✓");
    expect(frame[head + 1]).toBe(`⎿ $ ${COMMAND}  exit=1`);
    // The output is nowhere in the frame until ctrl+o.
    expect(frame.join("\n")).not.toContain("1 fail");
    const inputY = frame.findIndex((r) => r.includes("❯"));
    expect(inputY).toBeGreaterThan(head);

    // ctrl+o opens the block: the output appears at col 2, the input row does
    // NOT move (the viewport is fixed and the transcript scrolls), and nothing
    // ABOVE the call re-flows.
    app.stdin.write(CTRL_O);
    await delay(100);
    const open = rows();
    const openHead = open.findIndex((r) => r.includes(SENTENCE));
    expect(open[openHead]).toBe(`● ${SENTENCE} 3.4s`);
    expect(open[openHead + 1]).toBe(`⎿ $ ${COMMAND}  exit=1`);
    expect(open[openHead + 2]).toBe("  1 fail · 23 pass");
    expect(open.findIndex((r) => r.includes("❯"))).toBe(inputY);
    app.unmount();
  });

  test("a click on the header row opens the same block (expandedIds)", async () => {
    const { app, rows } = await run();
    const head = rows().findIndex((r) => r.includes(SENTENCE));
    expect(head).toBeGreaterThanOrEqual(0);
    app.stdin.write(press(3, head + 1));
    app.stdin.write(release(3, head + 1));
    await delay(100);
    const open = rows();
    expect(open.join("\n")).toContain("1 fail · 23 pass");
    // The `$` row keeps the code even expanded, and it is written once.
    expect(open.filter((r) => r.includes("exit=1"))).toHaveLength(1);
    app.unmount();
  });

  test("a click on the `⎿ $ cmd` row toggles the block like the header; output rows do not", async () => {
    const { app, rows } = await run();
    const head = rows().findIndex((r) => r.includes(SENTENCE));
    expect(head).toBeGreaterThanOrEqual(0);
    const dollar = head + 1;
    expect(rows()[dollar]).toBe(`⎿ $ ${COMMAND}  exit=1`);
    app.stdin.write(press(5, dollar + 1));
    app.stdin.write(release(5, dollar + 1));
    await delay(100);
    const open = rows();
    expect(open.join("\n")).toContain("1 fail · 23 pass");
    // A click on the OUTPUT row (first row after the `$` row) changes nothing.
    const out = open.findIndex((r) => r.includes("1 fail · 23 pass"));
    app.stdin.write(press(5, out + 1));
    app.stdin.write(release(5, out + 1));
    await delay(100);
    expect(rows().join("\n")).toContain("1 fail · 23 pass");
    // A second click on the `$` row collapses it again.
    app.stdin.write(press(5, dollar + 1));
    app.stdin.write(release(5, dollar + 1));
    await delay(100);
    expect(rows().join("\n")).not.toContain("1 fail · 23 pass");
    app.unmount();
  });
});
