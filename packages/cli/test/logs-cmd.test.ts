import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectKey } from "@tentacle/agent";
import { entryLines, headerLine } from "@tentacle/daemon";
import type { KnownLogEntry } from "@tentacle/protocol";
import { main } from "../src/index.ts";
import { logsCommand } from "../src/logs-cmd.ts";

// docs/feat/logs-cmd.md sub-task 1 (`logs-tail`): the file reader — session
// lookup (laptop store, this project's `serve` store, other projects), strict
// parsing, the sidecar's head, `--tail`/`--only`/`--summary`/`-f`. Each test
// names the mutation that turns it red (AGENTS §9).

const UID = "025e6a9d-d332-4a45-9051-8a957fa31811";
const OTHER = "9f1d2c3b-aaaa-4bbb-8ccc-0123456789ab";
// The launch directory: `main` uses `process.cwd()` for `config.cwd`, so the
// store lookups must be relative to that (configDir is the scratch dir).
const CWD = process.cwd();
const DAEMON_STATE_FORMAT = "tentacle-daemon-state";

/** One incarnation's entry chain. */
function chain(inc: string, ts = 1000) {
  let seq = 0;
  let prev: string | undefined;
  return (body: Record<string, unknown>, at = ts): KnownLogEntry => {
    seq++;
    const id = `${inc}/${seq}`;
    const entry = { ...body, seq, id, ...(prev ? { prev } : {}), ts: at } as KnownLogEntry;
    prev = id;
    return entry;
  };
}

/** A small session: two turns, one tool call, one file written. */
function sampleLog(inc = "a"): KnownLogEntry[] {
  const next = chain(inc);
  return [
    next({ type: "base", critical: true, inc, reason: "create", count: 0 }),
    next({ type: "title", title: { text: "a session", source: "user" } }),
    next({ type: "turn_start", turnId: "t1" }),
    next({ type: "message", critical: true, message: { role: "user", content: "write a file" } }),
    next({
      type: "message",
      critical: true,
      message: {
        role: "assistant",
        content: "writing",
        toolCalls: [{ id: "c1", name: "fs_write", arguments: '{"path":"/w/app/a.ts"}' }],
      },
    }),
    next({ type: "call_started", callId: "c1" }),
    next({
      type: "message",
      critical: true,
      message: { role: "tool", content: "wrote it", toolCallId: "c1" },
    }),
    next({ type: "turn_end", turnId: "t1", stopReason: "end_turn" }),
  ];
}

const header = (id: string, cwd = CWD) => headerLine({ id, cwd, model: "m1", createdAt: 1 });

let root = "";
let configDir = "";

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** `main(["logs", …])` with the scratch config dir; never a real terminal. */
async function logs(
  args: string[],
  seams: { sleep?: () => Promise<void>; signal?: AbortSignal } = {},
): Promise<Run> {
  let out = "";
  let err = "";
  const code = await main(["bun", "cli", "logs", ...args], {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    terminal: { stdin: false, stdout: false },
    colour: false,
    ...(seams.sleep !== undefined ? { logsSleep: seams.sleep } : {}),
    ...(seams.signal !== undefined ? { logsSignal: seams.signal } : {}),
  });
  return { code, out, err };
}

/** Write a session's laptop log (`<configDir>/sessions/<projectKey>/<uid>.jsonl`). */
async function writeLaptop(
  id: string,
  entries: readonly KnownLogEntry[],
  cwd = CWD,
): Promise<string> {
  const dir = join(configDir, "sessions", projectKey(cwd));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  await writeFile(file, `${header(id, cwd)}${entryLines(entries)}`);
  return file;
}

/** A `serve` store's log + its sidecar (`<configDir>/daemon/<projectKey>/`). */
async function writeServe(
  id: string,
  entries: readonly KnownLogEntry[],
  head: { readonly seq: number; readonly id: string },
): Promise<string> {
  const dir = join(configDir, "daemon", projectKey(CWD));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  await writeFile(file, `${header(id)}${entryLines(entries)}`);
  await writeFile(
    join(dir, `${id}.state.json`),
    JSON.stringify({
      format: DAEMON_STATE_FORMAT,
      schemaVersion: 1,
      id,
      logHead: head,
      k: 0,
      tail: [],
      lastActiveAt: 1,
      updatedAt: 1,
      title: "t",
      turns: [],
      enqueueIds: [],
      returned: [],
    }),
  );
  return file;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "logs-cmd-"));
  configDir = join(root, "config");
  process.env.TENTACLE_CONFIG_DIR = configDir;
});

afterAll(async () => {
  Reflect.deleteProperty(process.env, "TENTACLE_CONFIG_DIR");
  await rm(root, { recursive: true, force: true });
});

describe("logsCommand: the file it reads", () => {
  test("the newest session of this project, said on stderr; events on stdout", async () => {
    // Mutation: take records[records.length-1] (the oldest) → the tail is of a
    // session nobody asked about.
    const older = await writeLaptop(UID, sampleLog("a"));
    const newer = await writeLaptop(OTHER, sampleLog("b"));
    const later = Date.now() / 1000 + 60;
    await writeFile(newer, `${header(OTHER)}${entryLines(sampleLog("c"))}`);
    const { utimes } = await import("node:fs/promises");
    await utimes(older, later - 600, later - 600);
    await utimes(newer, later, later);
    const run = await logs([]);
    expect(run.code).toBe(0);
    expect(run.err).toContain(newer);
    expect(run.out).toContain("write a file");
    expect(run.out).toContain("tool fs_write");
    expect(run.out).toContain("turn end t1");
  });

  test("--tail keeps the last N events; --tail 0 prints nothing", async () => {
    const run = await logs([UID, "--tail", "2"]);
    expect(run.code).toBe(0);
    expect(run.out.trimEnd().split("\n")).toHaveLength(2);
    const none = await logs([UID, "--tail", "0"]);
    expect(none.code).toBe(0);
    expect(none.out).toBe("");
  });

  test("--only narrows by category, and an unknown one is refused before reading", async () => {
    const turn = await logs([UID, "--only", "turn", "--json"]);
    expect(turn.code).toBe(0);
    const types = turn.out
      .trimEnd()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toEqual(["turn_start", "turn_end"]);
    // Mutation: accept an unknown category → a typo silently prints nothing.
    const bad = await logs([UID, "--only", "asq"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("asq");
  });

  test("--json prints one NDJSON object per line, C1-escaped", async () => {
    // Mutation: print `JSON.stringify` alone → U+009B reaches the terminal raw.
    const id = "11111111-2222-3333-4444-555555555555";
    const next = chain("z");
    await writeLaptop(id, [
      next({ type: "base", critical: true, inc: "z", reason: "create", count: 0 }),
      next({
        type: "message",
        critical: true,
        message: { role: "assistant", content: "a\u009bb" },
      }),
    ]);
    const run = await logs([id, "--json"]);
    expect(run.code).toBe(0);
    expect(run.out).not.toContain("\u009b");
    expect(run.out).toContain("\\u009b");
    for (const line of run.out.trimEnd().split("\n")) {
      const parsed = JSON.parse(line) as { v: number; session: string };
      expect(parsed.v).toBe(1);
      expect(parsed.session).toBe(id);
    }
  });

  test("--summary counts tools, files and turns, and names the file", async () => {
    const run = await logs([UID, "--summary"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("/w/app/a.ts");
    expect(run.out).toContain("fs_write ×1");
    expect(run.out).toContain("turns     1 (last end_turn)");
    const json = await logs([UID, "--summary", "--json"]);
    const summary = JSON.parse(json.out.trimEnd()) as { files: string[]; turns: number };
    expect(summary.files).toEqual(["/w/app/a.ts"]);
    expect(summary.turns).toBe(1);
  });

  test("--summary names a detached run's daemon/relay logs, never merging them", async () => {
    // Owner Q6: the free-text logs are not merged in v1 — their PATH is printed,
    // and it comes from the laptop's kept index (never a workload, AGENTS §7).
    // Mutation: print the session's own path twice (or name no run) → the person
    // cannot find the daemon's stderr for a run that failed.
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await writeLaptop(id, sampleLog("r"));
    const { recordKept } = await import("../src/kept-index.ts");
    const { runDirFor } = await import("../src/run-state.ts");
    const entry = {
      schemaVersion: 1 as const,
      name: "demo-run",
      engine: "kubernetes" as const,
      namespace: "default",
      model: "m1",
      created: "2026-11-14T00:00:00Z",
      sessionId: id,
    };
    recordKept(join(configDir, "kept"), entry);
    const run = await logs([id, "--summary"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("run       demo-run");
    expect(run.out).toContain(join(runDirFor(configDir, entry), "daemon.log"));
    expect(run.out).toContain(join(runDirFor(configDir, entry), "relay.log"));
  });
});

describe("logsCommand: refusals (loud, never half-shown)", () => {
  test("a corrupt line exits 1 with the parser's reason and the file", async () => {
    // Mutation: swallow parseLogFile's `ok: false` → half a log looks complete.
    const id = "22222222-3333-4444-5555-666666666666";
    const file = await writeLaptop(id, sampleLog("d"));
    const { readFile, writeFile: write } = await import("node:fs/promises");
    await write(file, `${await readFile(file, "utf8")}{"type":"message", "seq": 9}\n`);
    const run = await logs([id]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("malformed");
    expect(run.err).toContain(file);
    expect(run.out).toBe("");
  });

  test("a malformed message is refused, not half-loaded", async () => {
    // Mutation: parse with `{ lax: true }` (the listing's cheap walk) → an entry
    // whose message is not a `ChatMessage` is loaded and printed as if valid.
    const id = "88888888-9999-aaaa-bbbb-cccccccccccc";
    const file = await writeLaptop(id, sampleLog("m"));
    const { appendFile } = await import("node:fs/promises");
    const next = chain("m");
    // A `message` entry whose `message` is not a `ChatMessage` (role "wizard").
    await appendFile(
      file,
      entryLines([
        next({
          type: "message",
          critical: true,
          message: { role: "wizard", content: "?" },
        }),
      ]),
    );
    const run = await logs([id]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("malformed message entry");
  });

  test("only the CURRENT segment is shown, and an older kept one is noted", async () => {
    // Mutation: fold the whole file, or print every segment's events → the
    // pre-compaction history is shown as if it were still the conversation.
    const id = "99999999-aaaa-bbbb-cccc-dddddddddddd";
    const second = chain("q");
    await writeLaptop(id, [
      ...sampleLog("p"),
      second({ type: "base", critical: true, inc: "q", reason: "compact", count: 0 }),
      second({
        type: "message",
        critical: true,
        message: { role: "user", content: "the summary" },
      }),
    ]);
    const run = await logs([id, "--tail", "50"]);
    expect(run.code).toBe(0);
    expect(run.out).not.toContain("write a file");
    expect(run.out).toContain("the summary");
    expect(run.err).toContain("older kept segment");
    const summary = await logs([id, "--summary", "--json"]);
    const parsed = JSON.parse(summary.out.trimEnd()) as { olderSegments: number };
    expect(parsed.olderSegments).toBe(1);
  });

  test("a torn last line is tolerated (a crash mid-append is not corruption)", async () => {
    const id = "33333333-4444-5555-6666-777777777777";
    const file = await writeLaptop(id, sampleLog("e"));
    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, '{"type":"title","seq":99,');
    const run = await logs([id]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("turn end t1");
  });

  test("an invalid uid and an absent session are refused", async () => {
    const bad = await logs(["../../etc/passwd"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("not a valid session id");
    const absent = await logs(["44444444-5555-6666-7777-888888888888"]);
    expect(absent.code).toBe(1);
    expect(absent.err).toContain("no session 44444444");
  });

  test("no session in this project at all", async () => {
    // Mutation: fall back to ANOTHER project's session silently → `logs` in a
    // fresh folder would show a conversation that is not this folder's.
    let err = "";
    const code = await logsCommand(
      { tail: 5, json: false, summary: false, follow: false },
      {
        configDir: join(root, "empty-config"),
        cwd: CWD,
        out: () => {},
        err: (text) => {
          err += text;
        },
      },
    );
    expect(code).toBe(1);
    expect(err).toContain("no session in");
  });
});

describe("logsCommand: a serve copy is cut at the sidecar's head", () => {
  test("only entries up to logHead are shown; the rest is a crash's uncommitted tail", async () => {
    // Mutation: ignore the sidecar → a crash's half-written round is printed as
    // if it were committed (the daemon itself would never load it).
    const id = "55555555-6666-7777-8888-999999999999";
    const entries = sampleLog("s");
    const head = entries[5];
    if (head === undefined) throw new Error("fixture");
    const file = await writeServe(id, entries, { seq: head.seq, id: head.id });
    const run = await logs([id, "--json"]);
    expect(run.code).toBe(0);
    expect(run.err).toContain(file);
    const types = run.out
      .trimEnd()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toEqual([
      "segment",
      "title",
      "turn_start",
      "user",
      "assistant",
      "tool_call",
      "call_started",
    ]);
    expect(run.out).not.toContain("turn end t1");
  });
});

describe("logsCommand: -f follows the file (owner Q4)", () => {
  test("prints the first batch, then only what is new, and says what it cannot show", async () => {
    // Mutation: re-read without resuming by entry id → every poll reprints the
    // whole log (a `-f` that scrolls forever).
    const id = "66666666-7777-8888-9999-aaaaaaaaaaaa";
    const next = chain("f");
    const first = [
      next({ type: "base", critical: true, inc: "f", reason: "create", count: 0 }),
      next({ type: "message", critical: true, message: { role: "user", content: "one" } }),
    ];
    const file = await writeLaptop(id, first);
    const { appendFile } = await import("node:fs/promises");
    const controller = new AbortController();
    let polls = 0;
    const run = await logs([id, "-f"], {
      signal: controller.signal,
      sleep: async () => {
        polls++;
        if (polls === 1) {
          await appendFile(
            file,
            entryLines([
              next({
                type: "message",
                critical: true,
                message: { role: "assistant", content: "two" },
              }),
            ]),
          );
        } else {
          controller.abort();
        }
      },
    });
    expect(run.code).toBe(0);
    expect(run.err).toContain("committed events only");
    const lines = run.out.trimEnd().split("\n");
    expect(lines.filter((line) => line.includes("you: one"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("agent: two"))).toHaveLength(1);
  });

  test("a rewrite (the id is gone) says so and shows the new segment", async () => {
    const id = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
    const next = chain("g");
    const entries = [
      next({ type: "base", critical: true, inc: "g", reason: "create", count: 0 }),
      next({ type: "message", critical: true, message: { role: "user", content: "before" } }),
    ];
    const file = await writeLaptop(id, entries);
    const controller = new AbortController();
    let polls = 0;
    const run = await logs([id, "-f"], {
      signal: controller.signal,
      sleep: async () => {
        polls++;
        if (polls === 1) {
          const fresh = chain("h");
          await writeFile(
            file,
            `${header(id)}${entryLines([
              fresh({ type: "base", critical: true, inc: "h", reason: "compact", count: 0 }),
              fresh({
                type: "message",
                critical: true,
                message: { role: "user", content: "summary of it" },
              }),
            ])}`,
          );
        } else {
          controller.abort();
        }
      },
    });
    expect(run.code).toBe(0);
    expect(run.err).toContain("the log was rewritten");
    expect(run.out).toContain("summary of it");
  });
});

describe("the command line", () => {
  test("`logs` is a subcommand, not a prompt (the Context's repro)", async () => {
    // Mutation: leave `logs` out of `cliMode`/`SUBCOMMANDS` → `tentacle logs …`
    // is sent to the model as the text "logs --tail 5" (the defect).
    const { cliMode } = await import("../src/flags.ts");
    expect(cliMode(["logs", "--tail", "5"])).toBe("logs");
    expect(cliMode(["logs"])).toBe("logs");
    expect(cliMode(["logs", UID, "-f"])).toBe("logs");
  });

  test("a bad --tail and a second positional are refused, with the usage line", async () => {
    const bad = await logs([UID, "--tail", "5x"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("--tail must be a whole number");
    expect(bad.err).toContain("usage: tentacle logs");
    const two = await logs([UID, OTHER]);
    expect(two.code).toBe(1);
    expect(two.err).toContain("unexpected argument");
  });

  test("a swallowed sentence gets the way back to a prompt", async () => {
    const run = await logs(["why", "did", "it"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("tentacle -- logs why did it");
  });
});

describe("logsCommand directly (no main): the output streams", () => {
  test("data on out, prose (which file, refusals) on err", async () => {
    let out = "";
    let err = "";
    const code = await logsCommand(
      { uid: UID, tail: 5, json: false, summary: false, follow: false },
      {
        configDir,
        cwd: CWD,
        out: (text) => {
          out += text;
        },
        err: (text) => {
          err += text;
        },
      },
    );
    expect(code).toBe(0);
    expect(err).toContain("[logs] ");
    expect(out).not.toContain("[logs] ");
  });
});
