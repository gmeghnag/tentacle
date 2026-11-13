/**
 * docs/feat/app-decomposition.md S0 — COMMAND SMOKE over the real `App`: every
 * built-in slash command shows its notice / panel / effect, and every
 * session-mutating one is refused mid-turn. Pins `handleCommand` before it is
 * split into one file per command (S2), so a case that goes missing or changes
 * its words turns red here.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type AppProps, type SessionController } from "../src/App.tsx";
import { SLASH_COMMANDS } from "../src/commands.ts";
import { BACKGROUND_ROW, type DockTestRow } from "./subagent-row.ts";

const ENTER = "\r";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Fake {
  readonly session: SessionController;
  readonly prompts: string[];
  readonly closes: () => number;
}

/** A session; a prompt starting with `hang` holds its turn until aborted. */
function fake(
  opts: { agents?: readonly DockTestRow[]; extra?: Partial<SessionController> } = {},
): Fake {
  const prompts: string[] = [];
  let closes = 0;
  const session = {
    async *send(prompt: string, signal?: AbortSignal) {
      prompts.push(prompt);
      if (prompt.startsWith("hang")) {
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        yield { type: "turn_end", reason: "cancelled" };
        return;
      }
      yield { type: "text", delta: `reply to ${prompt}` };
      yield { type: "usage", usage: { promptTokens: 7, completionTokens: 3 } };
      yield { type: "turn_end", reason: "end_turn" };
    },
    onSubagents(listener: (rows: readonly DockTestRow[]) => void) {
      listener(opts.agents ?? []);
      return () => {};
    },
    close() {
      closes += 1;
    },
    ownsTurn: () => true,
    ...opts.extra,
  } as unknown as SessionController;
  return { session, prompts, closes: () => closes };
}

async function mount(f: Fake, props: Partial<AppProps> = {}) {
  const app = render(
    <App
      createSession={() => f.session}
      permissions={new PermissionBroker()}
      model="m"
      cwd="/tmp/work"
      {...props}
    />,
  );
  await delay(40);
  /** Type a line (a command or a prompt) and submit it. */
  const line = async (text: string, settle = 60) => {
    app.stdin.write(text);
    await delay(20);
    app.stdin.write(ENTER);
    await delay(settle);
  };
  const frame = () => app.lastFrame() ?? "";
  return { app, line, frame };
}

describe("S0 command smoke: every built-in command answers", () => {
  test("the registry this file covers is exactly SLASH_COMMANDS (a new command must be added here)", () => {
    expect(SLASH_COMMANDS.map((c) => c.name)).toEqual([
      "/help",
      "/clear",
      "/compact",
      "/rename",
      "/sessions",
      "/close",
      "/model",
      "/retry",
      "/attach",
      "/copy",
      "/save",
      "/tokens",
      "/mcp",
      "/skills",
      "/agents",
      "/settings",
      "/exit",
    ]);
  });

  test("/help lists the commands", async () => {
    const t = await mount(fake());
    await t.line("/help");
    expect(t.frame()).toContain("/compact");
    expect(t.frame()).toContain("/tokens");
    t.app.unmount();
  });

  test("/model names the shown model", async () => {
    const t = await mount(fake(), { modelLabel: "qwen3-27b @ local" });
    await t.line("/model");
    expect(t.frame()).toContain("Model: qwen3-27b @ local");
    t.app.unmount();
  });

  test("/tokens reports the session totals", async () => {
    const t = await mount(fake());
    await t.line("/tokens");
    expect(t.frame()).toContain("Tokens — prompt 0, completion 0, total 0");
    await t.line("hello");
    await t.line("/tokens");
    expect(t.frame()).toContain("Tokens — prompt 7, completion 3, total 10");
    t.app.unmount();
  });

  test("/agents with nothing running says so; with a child it focuses the dock", async () => {
    const a = await mount(fake());
    await a.line("/agents");
    expect(a.frame()).toContain("Nothing is running in the background.");
    a.app.unmount();
    const b = await mount(fake({ agents: [BACKGROUND_ROW.sa1] }));
    await b.line("/agents");
    expect(b.frame()).toContain("enter open · esc back");
    b.app.unmount();
  });

  test("/copy: nothing to copy; the last reply copied; the clipboard failing", async () => {
    const copied: string[] = [];
    // A seeded transcript with no reply (the welcome line would count as one).
    const t = await mount(fake(), {
      initialItems: [{ kind: "user", text: "earlier" }],
      clipboard: (text) => {
        copied.push(text);
        return Promise.resolve();
      },
    });
    await t.line("/copy");
    expect(t.frame()).toContain("No assistant reply to copy.");
    expect(copied).toEqual([]);
    await t.line("hello");
    await t.line("/copy");
    expect(copied).toEqual(["reply to hello"]);
    expect(t.frame()).toContain("Copied last reply to the clipboard.");
    t.app.unmount();

    const u = await mount(fake(), { clipboard: () => Promise.reject(new Error("no")) });
    await u.line("hello");
    await u.line("/copy");
    expect(u.frame()).toContain("Clipboard unavailable.");
    u.app.unmount();
  });

  test("/retry: nothing yet; then the last prompt is sent again", async () => {
    const f = fake();
    const t = await mount(f);
    await t.line("/retry");
    expect(t.frame()).toContain("Nothing to retry yet.");
    await t.line("hello");
    await t.line("/retry");
    expect(f.prompts).toEqual(["hello", "hello"]);
    t.app.unmount();
  });

  test("/save writes the transcript under cwd", async () => {
    const saved: string[] = [];
    const t = await mount(fake(), {
      saveFile: (path) => {
        saved.push(path);
        return Promise.resolve();
      },
    });
    await t.line("/save");
    expect(saved).toHaveLength(1);
    expect(saved[0]?.startsWith("/tmp/work/tentacle-transcript-")).toBe(true);
    expect(t.frame()).toContain("Saved transcript to /tmp/work/tentacle-transcript-");
    t.app.unmount();
  });

  test("the runtime-dependent commands say when they are unavailable", async () => {
    const t = await mount(fake());
    await t.line("/sessions");
    expect(t.frame()).toContain("Sessions aren't available on this runtime.");
    await t.line("/compact");
    expect(t.frame()).toContain("Compaction isn't available for this session.");
    await t.line("/rename x");
    expect(t.frame()).toContain("Renaming isn't available on this runtime.");
    await t.line("/mcp");
    expect(t.frame()).toContain("MCP status isn't available on this runtime.");
    t.app.unmount();
  });

  test("/rename with no title shows its usage; with one, the daemon's answer", async () => {
    const titles: string[] = [];
    const f = fake({
      extra: {
        rename: (title: string) => {
          titles.push(title);
          return Promise.resolve(title);
        },
      },
    });
    const t = await mount(f);
    await t.line("/rename");
    expect(t.frame()).toContain("/rename <title>");
    await t.line("/rename my work");
    expect(titles).toEqual(["my work"]);
    t.app.unmount();
  });

  test("/mcp and /skills open their panels", async () => {
    const t = await mount(fake(), { mcpStatus: () => Promise.resolve([]) });
    const before = t.frame();
    await t.line("/mcp");
    expect(t.frame()).not.toBe(before);
    expect(t.frame()).not.toContain("MCP status isn't available");
    expect(t.frame()).toContain("MCP");
    t.app.unmount();
    const s = await mount(fake());
    await s.line("/skills");
    expect(s.frame()).toContain("skills");
    s.app.unmount();
  });

  test("/close ends the session", async () => {
    const f = fake();
    const t = await mount(f);
    await t.line("/close");
    expect(f.closes()).toBe(1);
    t.app.unmount();
  });

  test("/quit with a background child asks first", async () => {
    const t = await mount(fake({ agents: [BACKGROUND_ROW.sa1] }));
    await t.line("/quit");
    expect(t.frame()).toContain("(y/N)");
    t.app.unmount();
  });

  test("an unknown command points at /help", async () => {
    const t = await mount(fake());
    await t.line("/nope");
    expect(t.frame()).toContain("Unknown command: /nope. Try /help.");
    t.app.unmount();
  });

  test("/settings with no settings seam says so; `sync` says it too", async () => {
    const f = fake();
    const t = await mount(f);
    await t.line("/settings");
    expect(t.frame()).toContain("/settings isn't available for this session.");
    await t.line("/settings sync");
    expect(t.frame()).toContain("/settings isn't available for this session.");
    expect(f.prompts).toEqual([]);
    t.app.unmount();
  });

  test("/settings with a seam shows the session's lines, and `sync` shows its answer", async () => {
    const synced: string[] = [];
    const f = fake({
      extra: {
        settings: () => [{ text: "model: qwen3" }, { text: "auto-accept: off", hint: "shift+tab" }],
        updateSettings: () => {
          synced.push("sync");
          return Promise.resolve([{ text: "settings synced" }]);
        },
      },
    });
    const t = await mount(f);
    await t.line("/settings");
    expect(t.frame()).toContain("model: qwen3");
    expect(t.frame()).toContain("auto-accept: off");
    await t.line("/settings sync");
    expect(synced).toEqual(["sync"]);
    expect(t.frame()).toContain("settings synced");
    t.app.unmount();
  });

  test("/attach with no path shows its usage line; it is not a prompt", async () => {
    const f = fake();
    const t = await mount(f);
    await t.line("/attach");
    expect(t.frame()).toContain("Usage: /attach <path>");
    expect(f.prompts).toEqual([]);
    t.app.unmount();
  });

  test("/exit (the alias of /quit) asks first with a background child", async () => {
    const t = await mount(fake({ agents: [BACKGROUND_ROW.sa1] }));
    await t.line("/exit");
    expect(t.frame()).toContain("(y/N)");
    t.app.unmount();
  });

  test("/exit with nothing to lose exits: Ink unmounts, nothing is closed here", async () => {
    // `/exit` is `/quit`'s alias (they share a case): with no background child
    // it exits AT ONCE. The runtime delivers the close on its exit path
    // (docs/feat/detach-live.md), so `close()` is not the App's to call — the
    // observable fact here is the unmount, spied through the notice feed.
    const f = fake();
    const log: string[] = [];
    const t = await mount(f, {
      notices: {
        onNotice: () => () => {
          log.push("unmounted");
        },
      },
    });
    await t.line("/exit");
    await delay(60);
    expect(log).toEqual(["unmounted"]);
    expect(f.closes()).toBe(0);
    t.app.unmount();
  });
});

describe("S0 command smoke: the session-mutating commands are refused mid-turn", () => {
  for (const cmd of ["/retry", "/clear", "/close"]) {
    test(`${cmd} while a turn runs → the refusal, nothing else`, async () => {
      // No `clear` on this session: `/clear` is the legacy close-and-replace,
      // which must wait (only an in-place clear is exempt).
      const f = fake();
      const t = await mount(f);
      await t.line("hang");
      await t.line(cmd);
      expect(t.frame()).toContain(
        `Can't run ${cmd} while a turn is running — stop it first (esc).`,
      );
      expect(f.prompts).toEqual(["hang"]);
      expect(f.closes()).toBe(0);
      t.app.unmount();
    });
  }
});
