/**
 * docs/feat/model-artifacts.md S6a — the TUI's artifact wiring through the REAL
 * App (T6a's frames): the card row under a live `present` call, the same card
 * after a resume (`initialItems` joined from the daemon's list), the
 * `/artifacts` panel opened by its command, and `enter` reaching the OPENER
 * PORT with the meta under the cursor.
 *
 * Frames come from `ink-testing-library` (SGR stripped), the pattern
 * `app.test.tsx` uses (AGENTS §6). The panel's rows are pinned in
 * `artifacts-panel.test.ts`; what is pinned HERE is that the App really paints
 * them and really routes Enter to the opener.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import type { ArtifactMeta } from "@tentacle/protocol";
import { render } from "ink-testing-library";
import { App, type AppProps, type SessionController } from "../src/App.tsx";
import { messagesToItems } from "../src/resume.ts";
import type { DisplayItem } from "../src/state.ts";
import { inertSession } from "./session-stub.ts";

const ENTER = "\r";
const ESC = "\u001B";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function meta(over: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return {
    artifactId: "latency-p99",
    version: 1,
    sha256: "a".repeat(64),
    size: 240_000,
    mimeType: "image/png",
    kind: "image",
    title: "latency-p99.png",
    callId: "c1",
    createdAt: 1_000,
    width: 1280,
    height: 720,
    ...over,
  };
}

const DASHBOARD = meta({
  artifactId: "dashboard",
  version: 2,
  sha256: "b".repeat(64),
  mimeType: "text/html",
  kind: "html",
  title: "Q3 revenue dashboard",
  callId: "c2",
  size: 14_000,
  createdAt: 3_000,
});

/** A session whose one turn runs a `present` call that returns `m` as its detail. */
function presenting(m: ArtifactMeta): SessionController {
  return {
    ...inertSession(),
    async *send() {
      yield { type: "tool_start", id: m.callId, name: "present", arguments: '{"path":"x.png"}' };
      yield {
        type: "tool_result",
        id: m.callId,
        name: "present",
        result: {
          content: "Presented.",
          isError: false,
          details: { kind: "artifact", artifact: m },
        },
      };
      yield { type: "turn_end", reason: "end_turn" };
    },
  } as unknown as SessionController;
}

async function mount(
  session: SessionController,
  props: Partial<AppProps> = {},
  dimensions?: { columns: number; rows: number },
) {
  const app = render(
    <App
      createSession={() => session}
      permissions={new PermissionBroker()}
      model="m"
      cwd="/tmp/work"
      {...props}
    />,
  );
  await delay(50);
  const line = async (text: string, settle = 120) => {
    app.stdin.write(text);
    await delay(20);
    app.stdin.write(ENTER);
    await delay(settle);
  };
  const frame = () => strip(app.lastFrame() ?? "");
  return { app, line, frame, rowWidths: () => frame().split("\n"), ...(dimensions ?? {}) };
}

const rowOf = (frame: string, needle: string): number =>
  frame.split("\n").findIndex((l) => l.includes(needle));

describe("S6a: the card under a live `present` row", () => {
  test("the frame shows the card's own glyph, title and meta, not the tool's text", async () => {
    const t = await mount(presenting(meta()));
    await t.line("show me");
    expect(t.frame()).toContain("▣ latency-p99.png");
    expect(t.frame()).toContain("PNG · 1280×720 · 240 KB");
    expect(t.frame()).toContain("^X^O open");
    expect(t.frame()).not.toContain("Presented.");
    t.app.unmount();
  });

  test("the card sits directly under its call's header (one block, two rows)", async () => {
    const t = await mount(presenting(DASHBOARD));
    await t.line("show me");
    const frame = t.frame();
    const header = rowOf(frame, "Present");
    const cardRow = rowOf(frame, "◈ Q3 revenue dashboard");
    expect(header).toBeGreaterThanOrEqual(0);
    expect(cardRow).toBe(header + 1);
    t.app.unmount();
  });
});

describe("S6a: the card after a resume (joined from the daemon's list)", () => {
  const HISTORY = [
    { role: "user", content: "show me" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c2", name: "present", arguments: '{"content":"<h1>x</h1>"}' }],
    },
    { role: "tool", content: "Presented.", toolCallId: "c2" },
  ] as unknown as Parameters<typeof messagesToItems>[0];

  test("a reloaded transcript shows the card when the list names its call", async () => {
    const items: DisplayItem[] = messagesToItems(HISTORY, new Map([["c2", DASHBOARD]]));
    const t = await mount(presenting(meta()), { initialItems: items });
    expect(t.frame()).toContain("◈ Q3 revenue dashboard");
    expect(t.frame()).toContain("HTML page · 14 KB · v2");
    t.app.unmount();
  });

  test("without the list the row stays plain (no invented card)", async () => {
    const items: DisplayItem[] = messagesToItems(HISTORY);
    const t = await mount(presenting(meta()), { initialItems: items });
    expect(t.frame()).toContain("Presented.");
    expect(t.frame()).not.toContain("◈ Q3 revenue dashboard");
    t.app.unmount();
  });
});

describe("S6a: `/artifacts` opens the panel, and Enter reaches the opener port", () => {
  const listed = (): ArtifactMeta[] => [
    meta({
      artifactId: "chart",
      version: 1,
      sha256: "c".repeat(64),
      callId: "c3",
      title: "chart-v1.png",
      createdAt: 500,
    }),
    meta(),
    DASHBOARD,
  ];

  test("the command lists the daemon's artifacts, newest artifact first", async () => {
    const seen: string[] = [];
    const session = {
      ...presenting(meta()),
      listArtifacts: () => {
        seen.push("list");
        return Promise.resolve({ artifacts: listed() });
      },
    } as unknown as SessionController;
    const t = await mount(session);
    await t.line("/artifacts");
    expect(seen).toEqual(["list"]);
    const frame = t.frame();
    expect(frame).toContain("artifacts · 3");
    // `dashboard` v2 was presented last (createdAt 3000), so it is the top row,
    // and its older `chart` neighbour (500) is the bottom one — not wire order.
    expect(rowOf(frame, "Q3 revenue dashboard")).toBeLessThan(rowOf(frame, "chart-v1.png"));
    t.app.unmount();
  });

  test("Enter on the selected row calls the opener with THAT meta", async () => {
    const opened: ArtifactMeta[] = [];
    const session = {
      ...presenting(meta()),
      listArtifacts: () => Promise.resolve({ artifacts: listed() }),
    } as unknown as SessionController;
    const t = await mount(session, { openArtifact: (m) => opened.push(m) });
    await t.line("/artifacts");
    await t.line("", 80);
    // The cursor starts on the newest artifact's NEWEST version.
    expect(opened.map((m) => [m.artifactId, m.version])).toEqual([["dashboard", 2]]);
    t.app.unmount();
  });

  test("Esc closes it, and no opener runs", async () => {
    const opened: ArtifactMeta[] = [];
    const session = {
      ...presenting(meta()),
      listArtifacts: () => Promise.resolve({ artifacts: listed() }),
    } as unknown as SessionController;
    const t = await mount(session, { openArtifact: (m) => opened.push(m) });
    await t.line("/artifacts");
    // Open first: without this the "closed" assertion below would hold on a
    // panel that never opened at all (non-vacuity).
    expect(t.frame()).toContain("Q3 revenue dashboard");
    t.app.stdin.write(ESC);
    await delay(80);
    expect(t.frame()).not.toContain("Q3 revenue dashboard");
    expect(opened).toEqual([]);
    t.app.unmount();
  });

  test("an old daemon says so and opens nothing (no crash, no empty panel)", async () => {
    const session = {
      ...presenting(meta()),
      listArtifacts: () =>
        Promise.reject(Object.assign(new Error("method not found"), { code: -32601 })),
    } as unknown as SessionController;
    const t = await mount(session);
    await t.line("/artifacts");
    expect(t.frame()).toContain("newer tentacle");
    t.app.unmount();
  });

  test("a runtime with no artifact list says the panel is unavailable", async () => {
    const t = await mount(presenting(meta()));
    await t.line("/artifacts");
    expect(t.frame()).toContain("Artifacts aren't available on this runtime.");
    t.app.unmount();
  });
});
