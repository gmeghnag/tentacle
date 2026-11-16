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
import type { OpenPlan } from "../src/artifact-open.ts";
import type { ArtifactOpener, SaveRequest } from "../src/os-open.ts";
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

  test("Enter on the selected row reads and opens THAT meta", async () => {
    const opened: ArtifactMeta[] = [];
    const files: (string | null)[] = [];
    const session = {
      ...presenting(meta()),
      listArtifacts: () => Promise.resolve({ artifacts: listed() }),
      readArtifact: (m: ArtifactMeta) => {
        opened.push(m);
        return Promise.resolve(new Uint8Array([1]));
      },
    } as unknown as SessionController;
    const opener: ArtifactOpener = {
      open: async (plan) => {
        files.push(plan.file);
      },
      save: async () => "",
    };
    const t = await mount(session, { artifactOpener: opener });
    await t.line("/artifacts");
    await t.line("", 80);
    // The cursor starts on the newest artifact's NEWEST version.
    expect(opened.map((m) => [m.artifactId, m.version])).toEqual([["dashboard", 2]]);
    expect(files).toEqual(["bbbbbbbb.html"]);
    t.app.unmount();
  });

  test("Esc closes it, and no opener runs", async () => {
    const opened: ArtifactMeta[] = [];
    const session = {
      ...presenting(meta()),
      listArtifacts: () => Promise.resolve({ artifacts: listed() }),
      readArtifact: (m: ArtifactMeta) => {
        opened.push(m);
        return Promise.resolve(new Uint8Array([1]));
      },
    } as unknown as SessionController;
    const t = await mount(session, {
      artifactOpener: { open: async () => {}, save: async () => "" },
    });
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

// --- S6b: the opener (docs/feat/model-artifacts.md D8) --------------------------

const CTRL_X = "\u0018";
const CTRL_O = "\u000f";

/** A spy opener port: what would have been written + spawned / saved. */
function spyOpener() {
  const opened: { plan: OpenPlan; bytes: Uint8Array }[] = [];
  const saved: { request: SaveRequest; bytes: Uint8Array }[] = [];
  const opener: ArtifactOpener = {
    open: async (plan, bytes) => {
      opened.push({ plan, bytes });
    },
    save: async (request, bytes) => {
      saved.push({ request, bytes });
      return `/home/u/Downloads/${request.name}`;
    },
  };
  return { opener, opened, saved };
}

/** `presenting(m)` plus a `readArtifact` that answers `BYTES` (and records the meta). */
function readable(m: ArtifactMeta, list: ArtifactMeta[] = [m], fail?: Error) {
  const reads: ArtifactMeta[] = [];
  const session = {
    ...presenting(m),
    listArtifacts: () => Promise.resolve({ artifacts: list }),
    readArtifact: (read: ArtifactMeta) => {
      reads.push(read);
      return fail ? Promise.reject(fail) : Promise.resolve(new TextEncoder().encode("BYTES"));
    },
  } as unknown as SessionController;
  return { session, reads };
}

async function chord(t: Awaited<ReturnType<typeof mount>>): Promise<void> {
  t.app.stdin.write(CTRL_X);
  await delay(20);
  t.app.stdin.write(CTRL_O);
  await delay(100);
}

describe("S6b: Ctrl+X Ctrl+O opens the newest artifact", () => {
  test("local: read through the controller, handed to the opener as `<sha8>.<ext>`", async () => {
    const { session, reads } = readable(meta());
    const spy = spyOpener();
    const t = await mount(session, { artifactOpener: spy.opener });
    await t.line("show me");
    await chord(t);
    expect(reads.map((m) => m.artifactId)).toEqual(["latency-p99"]);
    expect(spy.opened.map((o) => o.plan.file)).toEqual(["aaaaaaaa.png"]);
    expect(new TextDecoder().decode(spy.opened[0]?.bytes ?? new Uint8Array())).toBe("BYTES");
    t.app.unmount();
  });

  test("no card in the transcript: one notice, nothing read", async () => {
    const { session, reads } = readable(meta());
    const spy = spyOpener();
    const t = await mount(session, { artifactOpener: spy.opener });
    await chord(t);
    expect(t.frame()).toContain("No artifact in this transcript");
    expect(reads).toEqual([]);
    t.app.unmount();
  });

  test("a failed read is one notice, and the opener never runs", async () => {
    const { session } = readable(meta(), [meta()], new Error("sha256 mismatch"));
    const spy = spyOpener();
    const t = await mount(session, { artifactOpener: spy.opener });
    await t.line("show me");
    await chord(t);
    expect(t.frame()).toContain('Couldn\'t open "latency-p99.png": sha256 mismatch');
    expect(spy.opened).toEqual([]);
    t.app.unmount();
  });

  test("no opener on this runtime: says so, reads nothing", async () => {
    const { session, reads } = readable(meta());
    const t = await mount(session);
    await t.line("show me");
    await chord(t);
    expect(t.frame()).toContain("Opening artifacts isn't available on this runtime.");
    expect(reads).toEqual([]);
    t.app.unmount();
  });
});

describe("S6b: a pod's bytes always ask, and nothing is remembered (T6b.3)", () => {
  test("the confirm line names the pod; `y` opens offline; the next open asks again", async () => {
    const { session, reads } = readable(DASHBOARD);
    const spy = spyOpener();
    const t = await mount(session, { artifactOpener: spy.opener, daemonInPod: true });
    await t.line("show me");
    await chord(t);
    expect(t.frame()).toContain("HTML page from the pod");
    expect(t.frame()).toContain("network blocked");
    // Asked, not read: no pod byte is fetched before the person says yes.
    expect(reads).toEqual([]);
    expect(spy.opened).toEqual([]);
    t.app.stdin.write("y");
    await delay(100);
    expect(spy.opened.map((o) => [o.plan.file, o.plan.wrap, o.plan.network])).toEqual([
      ["bbbbbbbb.html", "csp", false],
    ]);
    expect(t.frame()).not.toContain("from the pod) in your browser");
    // Not remembered: the same artifact asks again, and anything but `y` is No.
    await chord(t);
    expect(t.frame()).toContain("from the pod) in your browser");
    t.app.stdin.write("n");
    await delay(80);
    expect(spy.opened.length).toBe(1);
    expect(t.frame()).not.toContain("from the pod) in your browser");
    t.app.unmount();
  });

  test("`n` in the panel offers no network for a pod's page", async () => {
    const { session } = readable(DASHBOARD);
    const spy = spyOpener();
    const t = await mount(session, { artifactOpener: spy.opener, daemonInPod: true });
    await t.line("/artifacts");
    t.app.stdin.write("n");
    await delay(100);
    expect(t.frame()).toContain("Network isn't offered for a pod's page");
    expect(spy.opened).toEqual([]);
    t.app.unmount();
  });
});

describe("S6b: the panel's `s` and an `other` artifact", () => {
  test("`s` saves a copy and says where", async () => {
    const { session } = readable(DASHBOARD);
    const spy = spyOpener();
    const t = await mount(session, { artifactOpener: spy.opener });
    await t.line("/artifacts");
    t.app.stdin.write("s");
    await delay(100);
    expect(spy.saved.map((s) => s.request)).toEqual([
      { name: "Q3 revenue dashboard.html", wrap: "csp" },
    ]);
    expect(t.frame()).toContain("/home/u/Downloads/Q3 revenue dashboard.html");
    t.app.unmount();
  });

  test("Enter on an `other` artifact never reaches the opener", async () => {
    const zip = meta({
      kind: "other",
      mimeType: "application/zip",
      title: "build.zip",
      sha256: "d".repeat(64),
    });
    const { session, reads } = readable(zip);
    const spy = spyOpener();
    const t = await mount(session, { artifactOpener: spy.opener });
    await t.line("/artifacts");
    await t.line("", 80);
    expect(t.frame()).toContain("isn't opened (unknown type)");
    expect(reads).toEqual([]);
    expect(spy.opened).toEqual([]);
    t.app.unmount();
  });
});
