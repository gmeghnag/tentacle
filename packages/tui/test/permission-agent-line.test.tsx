import { describe, expect, test } from "bun:test";
import { PermissionBroker, type PermissionRequest } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import { cellWidth } from "../src/cells.ts";
import { PermissionPrompt, permissionPromptRows } from "../src/components/PermissionPrompt.tsx";
import { permissionAgentLine } from "../src/permission-ui.ts";

// docs/feat/parallel-agents.md T-L: the dialog names the sub-agent that asks.

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const REQ: PermissionRequest = {
  tool: "shell",
  level: "ask",
  title: "Run a shell command",
  detail: "bun test",
  input: {},
};
const AGENT = { type: "explore", description: "find callers" };

describe("permissionAgentLine", () => {
  test("type and description", () => {
    expect(permissionAgentLine(AGENT, 80)).toBe('explore · "find callers"');
  });

  test("a BACKGROUND child's ask names its id and says so (docs/feat/subagent-background.md)", () => {
    // Mutation: ignore `id` → the line is the foreground one → red.
    expect(permissionAgentLine({ ...AGENT, id: "sa-3" }, 80)).toBe(
      'sa-3 · explore · "find callers" · background',
    );
    // The row never wraps: truncated to the width like the foreground one.
    expect(permissionAgentLine({ ...AGENT, id: "sa-3" }, 24).length).toBe(21);
  });

  test("truncated to the width", () => {
    const line = permissionAgentLine({ type: "explore", description: "x".repeat(200) }, 40);
    expect(line.length).toBe(37);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("the dialog's agent row", () => {
  const prompt = (agentLine?: string) =>
    render(
      <PermissionPrompt
        req={REQ}
        options={["Yes", "No"]}
        selected={0}
        cwd="/tmp/work"
        {...(agentLine !== undefined ? { agentLine } : {})}
      />,
    );

  test("drawn under the title, and the row count says so", () => {
    const withAgent = prompt('explore · "find callers"');
    const rows = (withAgent.lastFrame() ?? "").split("\n");
    expect(rows[1]).toBe(' explore · "find callers"');
    expect(rows.length).toBe(permissionPromptRows(2, 1, true, undefined, true));
    withAgent.unmount();
  });

  test("a call's own ask has no row", () => {
    const own = prompt();
    const frame = own.lastFrame() ?? "";
    expect(frame).not.toContain("·  ");
    expect(frame.split("\n")[1]).toBe(" bun test");
    expect(frame.split("\n").length).toBe(permissionPromptRows(2));
    own.unmount();
  });
});

// docs/fix/parallel-agents-followups.md (1): cut by terminal cells, not UTF-16 length.
describe("wide labels are cut by cells", () => {
  test("permissionAgentLine never exceeds the width in cells", () => {
    const line = permissionAgentLine({ type: "explore", description: "查找调用者".repeat(40) }, 40);
    expect(cellWidth(line)).toBeLessThanOrEqual(37);
    expect(line.endsWith("…")).toBe(true);
  });

  test("a CJK detail, cwd and agent row keep the dialog at permissionPromptRows", () => {
    const wide = "漢字検索".repeat(60);
    const agentLine = permissionAgentLine({ type: "explore", description: wide }, 80);
    const view = render(
      <PermissionPrompt
        req={{ ...REQ, detail: wide }}
        options={["Yes", "No"]}
        selected={0}
        cwd={`/tmp/${wide}`}
        agentLine={agentLine}
      />,
    );
    const rows = (view.lastFrame() ?? "").split("\n");
    expect(rows.length).toBe(permissionPromptRows(2, 1, true, undefined, true));
    view.unmount();
  });
});

describe("in the App", () => {
  const session = (): SessionController => ({
    async *send() {
      yield { type: "turn_end", reason: "end_turn" };
    },
  });

  test("the broker's agent reaches the dialog; the next request's own ask drops it", async () => {
    const permissions = new PermissionBroker();
    const app = render(
      <App createSession={session} permissions={permissions} model="m" cwd="/tmp/work" />,
    );
    await delay(30);
    void permissions.request(REQ, { agent: AGENT });
    await delay(40);
    expect(app.lastFrame() ?? "").toContain('explore · "find callers"');
    app.stdin.write("y");
    await delay(40);
    void permissions.request(REQ);
    await delay(40);
    expect(app.lastFrame() ?? "").toContain("Run a shell command");
    expect(app.lastFrame() ?? "").not.toContain("find callers");
    app.unmount();
  });
});
