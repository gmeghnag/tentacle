import { describe, expect, test } from "bun:test";
import {
  PALETTE_MAX_ROWS,
  SLASH_COMMANDS,
  helpText,
  isSessionMutating,
  lastAssistantText,
  lastUserText,
  matchCommands,
  mcpStatusError,
  paletteWindow,
  quitAction,
  resolveSlash,
  retryPlan,
  slashCatalog,
  transcriptToMarkdown,
} from "../src/commands.ts";
import type { DisplayItem } from "../src/state.ts";

const items: DisplayItem[] = [
  { kind: "user", text: "first" },
  { kind: "assistant", text: "reply one" },
  {
    kind: "tool",
    id: "t1",
    name: "fs_write",
    args: '{"path":"a"}',
    status: "ok",
    startedAt: 0,
    endedAt: 1,
    detail: { kind: "diff", path: "a", patch: "@@\n+x\n", added: 1, removed: 0 },
  },
  { kind: "user", text: "second" },
  { kind: "assistant", text: "reply two" },
];

describe("help text", () => {
  test("lists every slash command", () => {
    const text = helpText();
    for (const c of SLASH_COMMANDS) {
      expect(text).toContain(c.name);
    }
  });
});

describe("matchCommands (palette autocomplete)", () => {
  test("a bare slash lists every command", () => {
    expect(matchCommands("/")).toEqual(SLASH_COMMANDS);
  });

  test("filters by case-insensitive prefix", () => {
    const names = matchCommands("/co").map((c) => c.name);
    expect(names).toEqual(["/compact", "/copy"]);
    expect(matchCommands("/CO").map((c) => c.name)).toEqual(["/compact", "/copy"]);
  });

  test("closes once the name is fully and unambiguously typed", () => {
    expect(matchCommands("/compact")).toEqual([]);
  });

  test("is inactive without a leading slash or once a space is typed", () => {
    expect(matchCommands("hello")).toEqual([]);
    expect(matchCommands("/save now")).toEqual([]);
  });

  test("returns nothing for an unknown command", () => {
    expect(matchCommands("/zzz")).toEqual([]);
  });
});

describe("last-message lookup", () => {
  test("finds the most recent assistant and user text", () => {
    expect(lastAssistantText(items)).toBe("reply two");
    expect(lastUserText(items)).toBe("second");
  });

  test("returns null when absent", () => {
    expect(lastAssistantText([])).toBeNull();
    // A command's notice (`/mcp`, `/model`) is not a reply: /copy skips it.
    expect(
      lastAssistantText([
        { kind: "assistant", text: "the reply" },
        { kind: "assistant", text: "Model: `m`", notice: true },
      ]),
    ).toBe("the reply");
    expect(lastUserText([{ kind: "assistant", text: "x" }])).toBeNull();
  });
});

describe("transcriptToMarkdown", () => {
  test("renders users, assistants and tools with a diff fence", () => {
    const md = transcriptToMarkdown(items);
    expect(md).toContain("## User\n\nfirst");
    expect(md).toContain("## Assistant\n\nreply one");
    expect(md).toContain("### Tool ✔ `fs_write`");
    expect(md).toContain("```diff");
    expect(md).toContain("+x");
  });

  test("omits empty assistant items", () => {
    const md = transcriptToMarkdown([{ kind: "assistant", text: "   " }]);
    expect(md.trim()).toBe("");
  });
});

describe("isSessionMutating", () => {
  test("flags turn-starting / session-swapping commands only", () => {
    expect(isSessionMutating("/retry")).toBe(true);
    expect(isSessionMutating("/clear")).toBe(true);
    // Read-only or self-guarding commands are safe to run mid-turn.
    for (const cmd of ["/help", "/model", "/tokens", "/copy", "/save", "/compact", "/exit"]) {
      expect(isSessionMutating(cmd)).toBe(false);
    }
  });
});

describe("quitAction", () => {
  test("idle quits; mid-turn /exit stops first; a second request quits; Ctrl+C mid-turn only stops", () => {
    expect(quitAction("command", false, false)).toBe("exit");
    expect(quitAction("ctrl-c", false, false)).toBe("exit");
    expect(quitAction("command", true, false)).toBe("stop-then-exit");
    expect(quitAction("ctrl-c", true, false)).toBe("stop");
    expect(quitAction("command", true, true)).toBe("exit");
    expect(quitAction("ctrl-c", true, true)).toBe("exit");
  });

  test("a foreign turn (docs/feat/tui-foreign-turns.md C4): /exit exits at once, Ctrl+C still only stops it", () => {
    expect(quitAction("command", true, false, true)).toBe("exit");
    expect(quitAction("ctrl-c", true, false, true)).toBe("stop");
    expect(quitAction("ctrl-c", true, true, true)).toBe("exit");
  });
});

describe("skills as /name (docs/feat/skills-slash.md)", () => {
  const skills = [
    { name: "deploy-app", description: "Deploy the app\nto staging." },
    { name: "help", description: "a skill named like a built-in" },
    { name: "quit", description: "shadowed by the /exit alias" },
    { name: "deploy-app", description: "duplicate" },
    { name: "compact-notes", description: "Notes." },
  ];

  test("resolveSlash: only an exact first token selects a skill; the rest is never parsed", () => {
    const cases: [string, ReturnType<typeof resolveSlash>][] = [
      ["/deploy-app", { kind: "skill", name: "deploy-app", text: "/deploy-app" }],
      [
        "/deploy-app to staging, then /tmp/x",
        { kind: "skill", name: "deploy-app", text: "/deploy-app to staging, then /tmp/x" },
      ],
      ["/deploy-app\nmore", { kind: "skill", name: "deploy-app", text: "/deploy-app\nmore" }],
      ["/help", { kind: "builtin", command: "/help" }],
      ["/help me", { kind: "builtin", command: "/help" }],
      ["/quit", { kind: "builtin", command: "/quit" }],
      ["/tmp/x is broken", { kind: "unknown", command: "/tmp/x" }],
      ["/deploy-app/x", { kind: "unknown", command: "/deploy-app/x" }],
      ["/Deploy-App", { kind: "unknown", command: "/Deploy-App" }],
      ["/deploy", { kind: "unknown", command: "/deploy" }],
      ["/", { kind: "unknown", command: "/" }],
    ];
    for (const [text, want] of cases) {
      expect({ text, got: resolveSlash(text, skills) }).toEqual({ text, got: want });
    }
    // Without the daemon's catalog nothing is a skill.
    expect(resolveSlash("/deploy-app", [])).toEqual({ kind: "unknown", command: "/deploy-app" });
  });

  test("slashCatalog: built-ins first, skills after; a built-in name shadows a skill (reported)", () => {
    const catalog = slashCatalog(skills);
    expect(catalog.commands.slice(0, SLASH_COMMANDS.length)).toEqual([...SLASH_COMMANDS]);
    expect(catalog.commands.slice(SLASH_COMMANDS.length)).toEqual([
      { name: "/deploy-app", description: "Deploy the app to staging.", skill: true },
      { name: "/compact-notes", description: "Notes.", skill: true },
    ]);
    expect(catalog.shadowed).toEqual(["help", "quit"]);
    expect([...catalog.skillNames]).toEqual(["deploy-app", "compact-notes"]);
  });

  test("matchCommands lists skills by prefix; /compact keeps the palette open for /compact-notes", () => {
    expect(matchCommands("/dep", skills).map((c) => c.name)).toEqual(["/deploy-app"]);
    expect(matchCommands("/compact", skills).map((c) => c.name)).toEqual([
      "/compact",
      "/compact-notes",
    ]);
    expect(matchCommands("/deploy-app", skills)).toEqual([]);
    expect(matchCommands("/", skills)).toHaveLength(SLASH_COMMANDS.length + 2);
    expect(matchCommands("/dep")).toEqual([]);
  });

  test("an exactly typed name comes first, so Enter/Tab run what was typed (review finding 1)", () => {
    // Precedence order across scopes is not alphabetical: project deploy-prod
    // before user deploy. Built-ins are listed first: a skill `c` after /clear.
    const ordered = [
      { name: "deploy-prod", description: "p" },
      { name: "deploy", description: "d" },
      { name: "c", description: "c" },
    ];
    expect(matchCommands("/deploy", ordered).map((c) => c.name)).toEqual([
      "/deploy",
      "/deploy-prod",
    ]);
    expect(matchCommands("/c", ordered)[0]?.name).toBe("/c");
    // No exact match: catalog order, unchanged.
    expect(matchCommands("/dep", ordered).map((c) => c.name)).toEqual(["/deploy-prod", "/deploy"]);
  });

  test("descriptions drop bidi overrides and zero-width characters (review finding 5)", () => {
    const [entry] = slashCatalog([
      { name: "a", description: "safe\u202e txt.exe\u200b\u2066x\u2069\ufeff" },
    ]).commands.filter((c) => c.skill);
    expect(entry?.description).toBe("safe txt.exex");
  });

  test("helpText lists the skills and the shadowed ones; unchanged without skills", () => {
    const help = helpText(skills);
    expect(help).toContain("**Skills**");
    expect(help).toContain("`/deploy-app [what to do]` — Deploy the app to staging.");
    expect(help).toContain("skill `help` is hidden by the built-in `/help`");
    expect(helpText([])).toBe(helpText());
    expect(helpText()).not.toContain("Skills");
  });

  test("retryPlan: a prompt as is; a past activation is an activation again, or gone", () => {
    expect(retryPlan("fix the bug", skills)).toEqual({ kind: "prompt", text: "fix the bug" });
    expect(retryPlan("/deploy-app now", skills)).toEqual({
      kind: "skill",
      name: "deploy-app",
      text: "/deploy-app now",
    });
    expect(retryPlan("/deploy-app now", [])).toEqual({ kind: "gone", command: "/deploy-app" });
  });

  test("paletteWindow keeps the selection visible within PALETTE_MAX_ROWS rows", () => {
    expect(paletteWindow(0, 0)).toEqual({ start: 0, end: 0 });
    expect(paletteWindow(3, 2)).toEqual({ start: 0, end: 3 });
    expect(paletteWindow(200, 0)).toEqual({ start: 0, end: PALETTE_MAX_ROWS });
    expect(paletteWindow(200, PALETTE_MAX_ROWS - 1)).toEqual({ start: 0, end: PALETTE_MAX_ROWS });
    expect(paletteWindow(200, PALETTE_MAX_ROWS)).toEqual({ start: 1, end: PALETTE_MAX_ROWS + 1 });
    expect(paletteWindow(200, 199)).toEqual({ start: 200 - PALETTE_MAX_ROWS, end: 200 });
    expect(paletteWindow(200, 999)).toEqual({ start: 200 - PALETTE_MAX_ROWS, end: 200 });
    for (let sel = 0; sel < 30; sel++) {
      const w = paletteWindow(30, sel);
      expect(sel >= w.start && sel < w.end && w.end - w.start === PALETTE_MAX_ROWS).toBe(true);
    }
  });
});

describe("/mcp (docs/feat/mcp-status.md; the panel: mcp-panel.test.ts)", () => {
  test("is a built-in, not session-mutating", () => {
    expect(SLASH_COMMANDS.map((c) => c.name)).toContain("/mcp");
    expect(isSessionMutating("/mcp")).toBe(false);
  });

  test("errors: MethodNotFound → unsupported daemon; anything else → its message", () => {
    expect(mcpStatusError(Object.assign(new Error("unknown method"), { code: -32601 }))).toBe(
      "_This daemon doesn't support /mcp (it predates it)._",
    );
    expect(mcpStatusError(new Error("not connected to the daemon"))).toBe(
      "_MCP status unavailable: not connected to the daemon_",
    );
  });
});
