/**
 * docs/feat/shell-intent-line.md §3 + docs/fix/tui-shell-row-uniform.md at the
 * App seam (ink frames): a described `shell` call draws its sentence and a block
 * whose first line is `⎿ $ cmd` while it runs, the spinner slot is UNCHANGED
 * (still `Working…`), and when the call settles the title gains NO `✓` (its
 * absence is the success) while the input row does not move — the block's
 * command line was already there, so only the output appears under it.
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

function gated(): { session: SessionController; settle: () => void; end: () => void } {
  let settle = () => {};
  let end = () => {};
  const settled = new Promise<void>((r) => {
    settle = r;
  });
  const ended = new Promise<void>((r) => {
    end = r;
  });
  const session = {
    ...inertSession(),
    async *send() {
      yield {
        type: "tool_start" as const,
        id: "c1",
        name: "shell",
        arguments: JSON.stringify({
          command: "bun test apps/mobile",
          description: "Run the mobile package tests",
        }),
      };
      await settled;
      yield {
        type: "tool_result" as const,
        id: "c1",
        name: "shell",
        result: { content: "exit=0", isError: false },
        durationMs: 1200,
      };
      await ended;
      yield { type: "turn_end" as const, reason: "end_turn" as const };
    },
  } as unknown as SessionController;
  return { session, settle, end };
}

describe("a described shell call in the App", () => {
  test("a `⎿ $ cmd` block while running, slot unchanged, no ✓ when settled, input row stable", async () => {
    const g = gated();
    const app = render(
      <App
        createSession={() => g.session}
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
    const rows = () => strip(app.lastFrame() ?? "").split("\n");
    const running = rows();
    const head = running.findIndex((r) => r.includes("Run the mobile package tests"));
    expect(head).toBeGreaterThanOrEqual(0);
    expect(running[head + 1]).toBe("⎿ $ bun test apps/mobile");
    expect(running.some((r) => r.includes("Working…"))).toBe(true);
    expect(running.some((r) => r.includes("running…"))).toBe(false);
    expect(running[head]).not.toContain("✓");
    const inputY = running.findIndex((r) => r.includes("❯"));
    expect(inputY).toBeGreaterThan(head);

    g.settle();
    await delay(120);
    const done = rows();
    const doneHead = done.findIndex((r) => r.includes("Run the mobile package tests"));
    expect(done[doneHead]).not.toContain("✓");
    expect(done[doneHead]).toBe("● Run the mobile package tests 1.2s");
    expect(done[doneHead + 1]).toBe("⎿ $ bun test apps/mobile");
    expect(done.join("\n")).not.toContain("exit=0");
    expect(done.findIndex((r) => r.includes("❯"))).toBe(inputY);
    g.end();
    await delay(60);
    app.unmount();
  });
});
