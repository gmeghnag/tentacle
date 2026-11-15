/**
 * Session info ON THE SCREEN (docs/feat/mobile-session-info.md slice 4): the "…"
 * menu opens it, the four pulls start when it does, and the title tap renames
 * through the EXISTING `session/rename` path (Owner decision 5).
 *
 * The controller is the seam (AGENTS §7): a fake handle answers `skills`,
 * `context` and `rename`, so what is asserted is the wiring the screen owns, not
 * the sheet's looks.
 */
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@tentacle/client";
import { PermissionBroker } from "@tentacle/core";
import type { McpServerStatus, QueueState, SessionListResult } from "@tentacle/protocol";
import { JsonRpcErrorCode } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import { createSessionController } from "../src/session-controller.ts";
import type { InfoPort } from "../src/session-info-controller.ts";
import { type SendableHandle, createSessionScreen } from "../src/session-screen-controller.ts";

function harness(
  options: {
    readonly rename?: (title: string) => Promise<string>;
    readonly skills?: () => Promise<never>;
    readonly context?: () => Promise<never>;
  } = {},
) {
  const calls = { skills: 0, context: 0, mcp: 0, list: 0 };
  const renamed: string[] = [];
  const handle: SendableHandle = {
    open: () => Promise.resolve(),
    detach: () => Promise.resolve(),
    watch: () => () => {},
    async *send(): AsyncIterable<SessionEvent> {
      yield { type: "turn_end", reason: "end_turn" } as never;
    },
    skills: () => {
      calls.skills += 1;
      return (
        options.skills?.() ??
        Promise.resolve({ slash: [], skills: [], problems: [], moreProblems: 0 })
      );
    },
    context: () => {
      calls.context += 1;
      return options.context?.() ?? Promise.resolve({ used: 84_000, exact: true });
    },
    rename: (title) => {
      renamed.push(title);
      return options.rename?.(title) ?? Promise.resolve(title);
    },
  };
  // The screen's handle, shaped as the port's `InfoSession` (a real `RemoteSession`
  // answers all three; a fake here need not be complete).
  const session = {
    skills: () =>
      handle.skills?.() ??
      Promise.resolve({ slash: [], skills: [], problems: [], moreProblems: 0 }),
    context: () => handle.context?.() ?? Promise.resolve({ used: 0, exact: true }),
  };
  const port: InfoPort = {
    daemon: () => ({ version: "1.4.0", model: "claude-sonnet-4-5", contextWindow: 200_000 }),
    computerName: () => "e2e-mac",
    title: () => "Alpha",
    phase: () => "open",
    sessionId: "s1",
    mcpStatus: () => {
      calls.mcp += 1;
      return Promise.resolve([] as readonly McpServerStatus[]);
    },
    sessionList: () => {
      calls.list += 1;
      return Promise.resolve({
        sessions: [
          {
            sessionId: "s1",
            title: "Alpha",
            cwd: "/srv/app",
            createdAt: 0,
            updatedAt: 0,
            running: false,
            attached: 1,
            archived: false,
          },
        ],
      } as SessionListResult);
    },
    session: () => session,
  };
  const screen = () =>
    createSessionScreen({
      sessionId: "s1",
      archived: false,
      title: "Alpha",
      project: "e2e-mac",
      controller: createSessionController<SendableHandle>({
        newSession: () => handle,
      }),
      broker: new PermissionBroker(undefined, { holdUntilSet: true }),
      now: () => 1,
      info: () => port,
    });
  return { screen, calls, renamed, handle };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve();
  }
};

describe("opening Session info", () => {
  test("the context pull runs AT ATTACH, so the header's bar has a figure (the TUI's rule)", async () => {
    const h = harness();
    const screen = h.screen();
    expect(screen.state().view.headerContext).toBeNull();
    await screen.open();
    // ONE pull at attach: the session's count, before any turn measured a fill.
    for (let i = 0; i < 40; i += 1) {
      await Promise.resolve();
    }
    expect(h.calls.context).toBe(1);
    // 84k of a 200k window. The figure is the daemon's count (an EXACT one here),
    // so no `≈`.
    expect(screen.state().view.headerContext).toEqual({ percent: 42, approx: false });
  });

  test("nothing else is pulled at attach (the sheet's own pulls wait for it)", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    expect(h.calls.mcp).toBe(0);
    expect(h.calls.skills).toBe(0);
    expect(screen.state().info === null || screen.state().info?.view.sections.length === 4).toBe(
      true,
    );
  });
  test("opening it starts all four pulls over the client stack", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    await screen.openInfo();
    await settle();
    expect(h.calls.mcp).toBe(1);
    expect(h.calls.list).toBe(1);
    expect(h.calls.skills).toBe(1);
    // The attach already asked for the context (the header's bar): the sheet's
    // pull is a SECOND, fresh one — never reusing a figure a turn has outdated.
    expect(h.calls.context).toBe(2);
    const sections = screen.state().info?.view.sections ?? [];
    expect(sections.find((s) => s.id === "mcp")?.phase).toBe("empty");
    expect(sections.find((s) => s.id === "skills")?.phase).toBe("empty");
  });

  test("closing it stops following the link (a second open starts over)", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    await screen.openInfo();
    screen.closeInfo();
    await screen.openInfo();
    await settle();
    expect(h.calls.mcp).toBe(2);
  });

  test("a daemon too old for session/skills says so in that ONE section", async () => {
    const h = harness({
      skills: () => Promise.reject(new RpcError(JsonRpcErrorCode.MethodNotFound, "unknown method")),
    });
    const screen = h.screen();
    await screen.open();
    await screen.openInfo();
    await settle();
    const sections = screen.state().info?.view.sections ?? [];
    expect(sections.find((s) => s.id === "skills")?.phase).toBe("unsupported");
    expect(sections.find((s) => s.id === "mcp")?.phase).toBe("empty");
  });

  test("the header's model comes from the daemon's handshake (Owner decision 2)", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    expect(screen.state().view.headerModel).toBe("claude-sonnet-4-5");
  });
});

describe("renaming from the title (Owner decision 5)", () => {
  test("the field opens on the CURRENT title, and Save sends session/rename", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    screen.beginRename();
    expect(screen.state().renaming?.text).toBe("Alpha");
    screen.setRenameText("A better name");
    await screen.submitRename();
    expect(h.renamed).toEqual(["A better name"]);
    // The header follows what the daemon stored, and the field closes.
    expect(screen.state().renaming).toBeNull();
    expect(screen.state().view.title).toBe("A better name");
  });

  test("an EMPTY or unchanged title is a no-op: nothing is sent", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    screen.beginRename();
    screen.setRenameText("");
    await screen.submitRename();
    expect(h.renamed).toEqual([]);
    expect(screen.state().renaming).toBeNull();

    screen.beginRename();
    screen.setRenameText("Alpha");
    await screen.submitRename();
    expect(h.renamed).toEqual([]);
  });

  test("Cancel closes the field and sends nothing", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    screen.beginRename();
    screen.setRenameText("nope");
    screen.cancelRename();
    expect(screen.state().renaming).toBeNull();
    expect(h.renamed).toEqual([]);
  });

  test("a failed rename keeps the words and says why (never a silent success)", async () => {
    const h = harness({ rename: () => Promise.reject(new Error("not connected to the daemon")) });
    const screen = h.screen();
    await screen.open();
    screen.beginRename();
    screen.setRenameText("Both a name");
    await screen.submitRename();
    const field = screen.state().renaming;
    expect(field?.text).toBe("Both a name");
    expect(field?.error).toContain("not connected");
    // The header keeps the title it had: nothing was renamed.
    expect(screen.state().view.title).toBe("Alpha");
  });

  test("an older daemon's MethodNotFound reads as a tentacle to update", async () => {
    const h = harness({
      rename: () => Promise.reject(new RpcError(JsonRpcErrorCode.MethodNotFound, "unknown method")),
    });
    const screen = h.screen();
    await screen.open();
    screen.beginRename();
    screen.setRenameText("Both a name");
    await screen.submitRename();
    expect(screen.state().renaming?.error).toContain("too old");
  });
});
