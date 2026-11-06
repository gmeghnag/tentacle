import { describe, expect, test } from "bun:test";
import chalk from "chalk";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { App, type SessionController } from "../src/App.tsx";
import { StatusBar } from "../src/components/StatusBar.tsx";
import type { ContextOpen } from "../src/status-view.ts";
import type { TargetBadge } from "../src/target-view.ts";
import { tokens } from "../src/theme.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function session(context?: () => Promise<ContextOpen>): () => SessionController {
  return () => ({
    async *send() {},
    ...(context ? { context } : {}),
  });
}

async function frame(props: {
  target?: TargetBadge;
  model?: string;
  columns?: number;
  context?: () => Promise<ContextOpen>;
  cwd?: string;
}): Promise<string> {
  const app = render(
    <App
      createSession={session(props.context)}
      model={props.model ?? "qwen3"}
      cwd={props.cwd ?? "/tmp/work"}
      contextWindow={128000}
      {...(props.target ? { target: props.target } : {})}
    />,
  );
  try {
    await delay(60);
    return app.lastFrame() ?? "";
  } finally {
    app.unmount();
  }
}

// SGR runs chalk/Ink write at colour level 3: dim, its end, the accent #06b6d4, the gold #fec20a.
const DIM = "\x1b[2m";
const DIM_OFF = "\x1b[22m";
const ACCENT = "\x1b[38;2;6;182;212m";
const GOLD = "\x1b[38;2;254;194;10m";
const bar = {
  cwd: "/w",
  tokens: null,
  contextTokens: 9000,
  contextApprox: true,
  contextWindow: 128000,
} as const;

const rows = (f: string): string[] => stripAnsi(f).split("\n");
const statusRow = (f: string): string =>
  rows(f)
    .filter((r) => r.trim() !== "")
    .at(-1) ?? "";
const borderRow = (f: string): string => rows(f).find((r) => /^─+ .* ─$/.test(r.trimEnd())) ?? "";

describe("target badge (left of the status bar)", () => {
  test("docker: `docker:<name> · <path> · …`", async () => {
    const f = await frame({ target: { engine: "docker", name: "tentacle-ba89d072" } });
    expect(statusRow(f).startsWith("docker:tentacle-ba89d072 · /tmp/work")).toBe(true);
  });

  test("podman, pod, and pod/container", async () => {
    expect(
      statusRow(await frame({ target: { engine: "podman", name: "t-1" } })).startsWith(
        "podman:t-1 · ",
      ),
    ).toBe(true);
    expect(
      statusRow(await frame({ target: { engine: "kubernetes", name: "dev" } })).startsWith(
        "kubernetes:dev · ",
      ),
    ).toBe(true);
    expect(
      statusRow(
        await frame({ target: { engine: "kubernetes", name: "dev", container: "app" } }),
      ).startsWith("kubernetes:dev/app · "),
    ).toBe(true);
  });

  test("local: no badge — the bar starts with the path", async () => {
    expect(statusRow(await frame({})).startsWith("/tmp/work · ")).toBe(true);
  });

  test("final pass (6): the prefix (colon included) is dim, the name keeps the accent colour (SGR kept)", async () => {
    const level = chalk.level;
    chalk.level = 3;
    const app = render(
      <App
        createSession={session()}
        model="m"
        cwd="/w"
        target={{ engine: "docker", name: "tentacle-x" }}
      />,
    );
    try {
      await delay(60);
      const raw =
        (app.lastFrame() ?? "").split("\n").filter((r) => r.includes("tentacle-x"))[0] ?? "";
      // The prefix is wrapped in the dim attribute; the name carries the accent
      // (#06b6d4) and is not wrapped in dim.
      expect(raw).toContain(`${DIM}docker:${DIM_OFF}`);
      expect(raw).toContain(`${ACCENT}tentacle-x`);
      expect(raw).not.toContain(`${DIM}tentacle-x`);
      expect(raw).not.toContain(`${ACCENT}docker:`);
    } finally {
      chalk.level = level;
      app.unmount();
    }
  });

  test("final pass (6): the same split for `kubernetes:` and for the cut `k8s:`", () => {
    const level = chalk.level;
    chalk.level = 3;
    try {
      const pod = "etcd-guard-sharedocp419-f84rv-master-0";
      const target = { engine: "kubernetes" as const, name: pod, container: "guard" };
      const wide = render(<StatusBar {...bar} columns={80} target={target} />).lastFrame() ?? "";
      expect(wide).toContain(`${DIM}kubernetes:${DIM_OFF}`);
      expect(wide).toContain(`${ACCENT}${pod}/guard`);
      const narrow = render(<StatusBar {...bar} columns={40} target={target} />).lastFrame() ?? "";
      expect(narrow).toContain(`${DIM}k8s:${DIM_OFF}`);
      expect(narrow).toContain(`${ACCENT}etcd…er-0/guard`);
    } finally {
      chalk.level = level;
    }
  });

  test("final pass (7): `auto-accept on` is golden yellow (autoAcceptHex), `off` stays dim", () => {
    const level = chalk.level;
    chalk.level = 3;
    try {
      const on = render(<StatusBar {...bar} columns={120} autoApprove />).lastFrame() ?? "";
      expect(on).toContain(`${GOLD} ⏵⏵ auto-accept on `);
      expect(on).not.toContain(`${ACCENT} ⏵⏵ auto-accept on `);
      const off = render(<StatusBar {...bar} columns={120} />).lastFrame() ?? "";
      expect(off).toContain(`${DIM} ⏵⏵ auto-accept off (shift+tab) `);
      expect(tokens.dark.autoAccept).toBe("#fec20a");
      expect(tokens.dark.autoAccept).not.toBe(tokens.dark.accent);
    } finally {
      chalk.level = level;
    }
  });

  test("never truncated: a long cwd shrinks, the badge stays whole", async () => {
    const f = await frame({
      target: { engine: "docker", name: "tentacle-ba89d072" },
      cwd: "/very/long/directory/name/that/goes/on/and/on/forever/and/ever/trash",
    });
    const row = statusRow(f);
    expect(row.startsWith("docker:tentacle-ba89d072 · ")).toBe(true);
    expect(row).toContain("…");
    expect(row).toContain("ctx ");
  });
});

describe("round 2: real StatusBar frames at 80 and 40 columns (one row, ctx max whole)", () => {
  const at = (columns: number, extra: Partial<Parameters<typeof StatusBar>[0]> = {}): string =>
    stripAnsi(
      render(
        <StatusBar
          cwd="/Users/someone/projects/deep/nested/folder"
          tokens={null}
          contextTokens={9000}
          contextApprox
          contextWindow={128000}
          columns={columns}
          {...extra}
        />,
      ).lastFrame() ?? "",
    );

  test("80 local: the path shrinks, `(~9k/128k)` is whole, one row", () => {
    const f = at(80);
    expect(f.split("\n")).toHaveLength(1);
    expect(f).toContain("(~9k/128k)");
    expect(f).toContain("…");
  });

  test("80 docker: badge whole, ctx max whole", () => {
    const f = at(80, { target: { engine: "docker", name: "tentacle-ba89d072" } });
    expect(f.split("\n")).toHaveLength(1);
    expect(f.startsWith("docker:tentacle-ba89d072 · ")).toBe(true);
    expect(f).toContain("(~9k/128k)");
  });

  test("40 columns, a pod name wider than the terminal: ONE row, name cut in the middle, ctx max kept", () => {
    const f = at(40, {
      target: {
        engine: "kubernetes",
        name: "a-very-long-pod-name-that-kubernetes-does-allow-here",
        container: "sidecar",
      },
    });
    expect(f.split("\n")).toHaveLength(1);
    expect(f.startsWith("k8s:")).toBe(true);
    expect(f).toContain("/sidecar");
    expect(f).toContain("…");
    expect(f).toContain("/128k)");
  });
});

describe("round 3: the owner's rule on real frames", () => {
  const at = (columns: number, extra: Partial<Parameters<typeof StatusBar>[0]> = {}): string =>
    stripAnsi(
      render(
        <StatusBar
          cwd="/w"
          tokens={null}
          contextTokens={9000}
          contextApprox
          contextWindow={128000}
          columns={columns}
          {...extra}
        />,
      ).lastFrame() ?? "",
    );
  const pod = "etcd-guard-sharedocp419-f84rv-master-0";

  test("owner example at 40 columns: `k8s:etcd…er-0/guard · ctx ~7% (~9k/128k)`", () => {
    const f = at(40, { target: { engine: "kubernetes", name: pod, container: "guard" } });
    expect(f).toBe("k8s:etcd…er-0/guard · ctx ~7% (~9k/128k)");
  });

  test("a 63-char container (the k8s maximum): ONE row, within the terminal, ctx max visible — at 40 and 80", () => {
    for (const columns of [40, 80]) {
      const f = at(columns, {
        target: { engine: "kubernetes", name: pod, container: "c".repeat(63) },
      });
      const rows = f.split("\n");
      expect(rows).toHaveLength(1);
      expect([...(rows[0] ?? "")].length).toBeLessThanOrEqual(columns);
      expect(f).toContain("/128k)");
      expect(f.startsWith("k8s:")).toBe(true);
    }
  });

  const longLink = {
    text: "disconnected: connection refused by the remote daemon and more",
    tone: "error" as const,
  };

  test("round 4 (owner rule), real frame at 40: the link whole-ish, no badge (`k8s:…` does not fit beside it)", () => {
    const f = at(40, {
      target: { engine: "kubernetes", name: pod, container: "guard" },
      link: longLink,
    });
    expect(f.startsWith("disconnected")).toBe(true);
    expect(f.endsWith(" · ctx ~7% (~9k/128k)")).toBe(true);
    expect(f).not.toContain("k8s:");
  });

  test("round 4, real frame at 80: the link whole-ish, the badge cut, ctx whole — one row", () => {
    const f = at(80, {
      target: { engine: "kubernetes", name: pod, container: "guard" },
      link: longLink,
    });
    expect(f.split("\n")).toHaveLength(1);
    expect(f.startsWith("disconnected: connection refused")).toBe(true);
    expect(f).toContain("/guard · ctx ~7% (~9k/128k)");
  });

  test("round 4 (MEDIUM 1): CJK and emoji at 40 and 80 — one row, within the terminal, ctx max visible", () => {
    const wide = "/ユーザー/フォルダの名前/さらに深い場所/🚀🚀🚀/データ";
    for (const columns of [40, 80]) {
      for (const extra of [
        {},
        {
          target: {
            engine: "kubernetes" as const,
            name: "ポッド名前テスト-ポッド名前テスト",
            container: "コンテナ",
          },
        },
        { target: { engine: "docker" as const, name: "🚀🚀🚀🚀🚀🚀🚀🚀-pod" }, link: longLink },
      ]) {
        const f = at(columns, { cwd: wide, ...extra });
        expect(f.split("\n")).toHaveLength(1);
        expect(stringWidth(f)).toBeLessThanOrEqual(columns);
        expect(f).toContain("(~9k/128k)");
      }
    }
  });

  test("round 4 (LOW 4/5): the painted row IS the layout's plain text; the scroll hint is whole or absent", () => {
    const target = { engine: "docker" as const, name: "tentacle-ba89d072" };
    const wide = at(100, { target, scrolledUp: true, hiddenAbove: 12 });
    expect(wide).toContain("↑12 more (↓ to follow)");
    expect(wide.split("\n")).toHaveLength(1);
    const narrow = at(40, { target, scrolledUp: true, hiddenAbove: 12 });
    expect(narrow).not.toContain("↑12 mor");
    expect(narrow).toContain("(~9k/128k)");
  });

  test("final pass (3): owner frames, scrolled and expanded, at 80 and 40 — the hint never cuts the badge name", () => {
    const target = { engine: "kubernetes" as const, name: pod, container: "guard" };
    const at80 = "kubernetes:etcd-guard-sharedocp419-f84rv-master-0/guard · ctx ~7% (~9k/128k)";
    const at40 = "k8s:etcd…er-0/guard · ctx ~7% (~9k/128k)";
    expect(at(80, { target })).toBe(at80);
    expect(at(40, { target })).toBe(at40);
    for (const extra of [{ scrolledUp: true, hiddenAbove: 12 }, { expandAll: true }]) {
      expect(at(80, { target, ...extra })).toBe(at80);
      expect(at(40, { target, ...extra })).toBe(at40);
    }
  });

  test("final pass (4): a newline in the link text is ONE row on a real frame", () => {
    for (const columns of [40, 80]) {
      const f = at(columns, {
        target: { engine: "docker" as const, name: "tentacle-x" },
        link: { text: "disconnected: line one\nline two", tone: "error" as const },
      });
      expect(f.split("\n")).toHaveLength(1);
      expect(stringWidth(f)).toBeLessThanOrEqual(columns);
    }
  });
});

describe("model name on the input's top border", () => {
  test("right-aligned on the border and no longer in the status bar", async () => {
    const f = await frame({ model: "rits/deepseek-ai/DeepSeek-V4.1-Flash-1017" });
    expect(borderRow(f).endsWith("rits/deepseek-ai/DeepSeek-V4.1-Flash-1017 ─")).toBe(true);
    expect(statusRow(f)).not.toContain("DeepSeek");
  });
});

describe("round 2 (LOW 5/6): stale answers and /compact", () => {
  const type = async (app: ReturnType<typeof render>, text: string): Promise<void> => {
    app.stdin.write(text);
    await delay(30);
    app.stdin.write("\r");
    await delay(80);
  };

  test("a late answer for a session the view has LEFT (/clear) is dropped", async () => {
    let release: ((v: ContextOpen) => void) | undefined;
    let n = 0;
    const createSession = (): SessionController => {
      n += 1;
      if (n === 1) {
        return {
          async *send() {},
          context: () =>
            new Promise<ContextOpen>((resolve) => {
              release = resolve;
            }),
        };
      }
      return { async *send() {}, context: async () => ({ used: 64000, exact: true }) };
    };
    const app = render(
      <App createSession={createSession} model="m" cwd="/w" contextWindow={128000} />,
    );
    try {
      await delay(60);
      await type(app, "/clear");
      expect(stripAnsi(app.lastFrame() ?? "")).toContain("50% (64k/128k)");
      release?.({ used: 1000, exact: true }); // the OLD session answers late
      await delay(60);
      const after = stripAnsi(app.lastFrame() ?? "");
      expect(after).toContain("50% (64k/128k)");
      expect(after).not.toContain("(1k/128k)");
    } finally {
      app.unmount();
    }
  });

  test("/compact asks the context again: the figure follows the shrunk history", async () => {
    let asked = 0;
    const session: SessionController = {
      async *send() {},
      async compact() {
        return { before: 10, after: 2 };
      },
      context: async () => {
        asked += 1;
        return asked === 1 ? { used: 64000, exact: true } : { used: 8000, exact: true };
      },
    };
    const app = render(
      <App createSession={() => session} model="m" cwd="/w" contextWindow={128000} />,
    );
    try {
      await delay(60);
      expect(stripAnsi(app.lastFrame() ?? "")).toContain("(64k/128k)");
      await type(app, "/compact");
      await delay(60);
      expect(asked).toBe(2);
      expect(stripAnsi(app.lastFrame() ?? "")).toContain("(8k/128k)");
    } finally {
      app.unmount();
    }
  });
});

describe("context at open", () => {
  test("no count (a bare session): `ctx –/128k`, ↑↓ hidden", async () => {
    const row = statusRow(await frame({}));
    expect(row).toContain("ctx –/128k");
    expect(row).not.toContain("↑");
  });

  test("an estimate shows `~` on percent and used, with the max", async () => {
    const row = statusRow(await frame({ context: async () => ({ used: 9000, exact: false }) }));
    expect(row).toContain("ctx █░░░░░░░░░ ~7% (~9k/128k)");
    expect(row).not.toContain("↑");
  });

  test("an exact count shows no `~`", async () => {
    const row = statusRow(await frame({ context: async () => ({ used: 64000, exact: true }) }));
    expect(row).toContain("50% (64k/128k)");
    expect(row).not.toContain("~");
  });

  test("a failing count leaves `ctx –/128k` silently", async () => {
    const row = statusRow(
      await frame({
        context: () => Promise.reject(new Error("tokenize failed")),
      }),
    );
    expect(row).toContain("ctx –/128k");
  });
});
