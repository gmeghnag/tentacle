import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineHost, WorkloadFacts } from "../src/engine-host.ts";
import { ARGS, parseArgs } from "../src/flags.ts";
import {
  type KeptDeps,
  psCommand,
  removeVerifiedKept,
  resolveKeptAttach,
  rmCommand,
} from "../src/kept-cmd.ts";
import { readKept, recordKept } from "../src/kept-index.ts";
import type { KeptEntry } from "../src/kept.ts";
import { type ProcOf, lockHolder } from "../src/pod-resident.ts";
import {
  type OwnerRecord,
  ensureRunDir,
  laptopProc,
  ownerPath,
  relayLogPath,
  runDirIn,
  writeOwner,
  writePresence,
} from "../src/run-state.ts";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const H = 3_600_000;
const DOCKER_KEPT = { "tentacle.managed": "true", "tentacle.kept": "true" };
const K8S_KEPT = { "app.kubernetes.io/managed-by": "tentacle", "tentacle.kept": "true" };

/** What a fake engine answers for a name: facts, `null` (404), or a throw. */
type Answer = WorkloadFacts | null | Error;

/**
 * One fake engine per location: `describe` answers from a script (one answer
 * per call, the last repeating), `remove` is recorded — a DELETE we can count.
 */
class FakeEngine {
  readonly calls: string[] = [];
  readonly answers = new Map<string, Answer[]>();
  removeError: Error | null = null;
  onRemove: () => void = () => {};
  set(name: string, ...answers: Answer[]): void {
    this.answers.set(name, answers);
  }
  host(): EngineHost {
    return {
      describe: async (name: string) => {
        this.calls.push(`describe:${name}`);
        const list = this.answers.get(name) ?? [null];
        const answer = list.length > 1 ? list.shift() : list[0];
        if (answer instanceof Error) {
          throw answer;
        }
        return answer ?? null;
      },
      remove: async (name: string) => {
        this.calls.push(`remove:${name}`);
        this.onRemove();
        if (this.removeError) {
          throw this.removeError;
        }
      },
    } as unknown as EngineHost;
  }
}

const entry = (name: string, over: Partial<KeptEntry> = {}): KeptEntry => ({
  schemaVersion: 1,
  name,
  engine: "docker",
  endpoint: "unix:///var/run/docker.sock",
  model: "m",
  created: new Date(NOW - H).toISOString(),
  ...over,
});

function setup(entries: KeptEntry[], engines: Record<string, FakeEngine> = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), "kept-cmd-")), "kept");
  for (const e of entries) {
    recordKept(dir, e);
  }
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  let answer: string | undefined;
  const engineOf = (e: KeptEntry): FakeEngine => {
    const key = e.engine === "kubernetes" ? `k8s:${e.namespace}` : `${e.engine}:${e.endpoint}`;
    const found = engines[key];
    if (!found) {
      throw new Error(`no engine at ${key}`);
    }
    return found;
  };
  const deps = (over: Partial<KeptDeps> = {}): KeptDeps => ({
    dir,
    hostFor: (e) => engineOf(e).host(),
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    now: () => NOW,
    home: "/Users/me",
    dim: (t) => `<dim>${t}</dim>`,
    kubeconfig: () => undefined,
    ...(answer !== undefined
      ? {
          ask: async (p: string) => {
            asked.push(p);
            return answer ?? "";
          },
        }
      : {}),
    timeoutMs: 50,
    ...over,
  });
  return {
    dir,
    out,
    err,
    asked,
    deps,
    interactive: (a: string) => {
      answer = a;
    },
    /** STDOUT: the data only (the table, `-q` names, `rm`'s removed names). */
    text: () => out.join(""),
    /** STDERR: every note, prose line, error (docs/fix/cli-output-streams.md). */
    errText: () => err.join(""),
  };
}

const running = (labels: Record<string, string> = DOCKER_KEPT): WorkloadFacts => ({
  status: "running",
  labels,
});
const ownerOf = (state: OwnerRecord["state"], created = entry("a").created): OwnerRecord => ({
  schemaVersion: 1,
  kind: "relay",
  pid: 9,
  appVersion: "1",
  sessionId: "11111111-1111-4111-8111-111111111111",
  state,
  lastActivityAt: NOW,
  autoAccept: false,
  created,
});

describe("tentacle ps", () => {
  test("empty index → only the header row (like `docker ps`), exit 0; -q prints nothing", async () => {
    // Mutation: print a message instead of the header → this fails (owner Q-R2).
    const s = setup([]);
    expect(await psCommand({}, s.deps())).toBe(0);
    expect(s.text()).toBe("NAME   ENGINE   WHERE   MOUNT   MODEL   AGE   STATUS\n");
    s.out.length = 0;
    expect(await psCommand({ quiet: true }, s.deps())).toBe(0);
    expect(s.text()).toBe("");
    expect(await psCommand({ verbose: true }, s.deps())).toBe(0); // no blocks, no message
    expect(s.text()).toBe("");
  });

  test("F4 (owner OQ8): plain `ps` hides a gone row, with no footer; the entry stays; -a lists it", async () => {
    // Mutation: no filter → the `b … gone` row is printed by a plain `ps`.
    const docker = new FakeEngine();
    docker.set("a", running());
    const s = setup([entry("a"), entry("b", { created: new Date(NOW - 2 * H).toISOString() })], {
      "docker:unix:///var/run/docker.sock": docker,
    });
    expect(await psCommand({}, s.deps())).toBe(0);
    expect(s.text()).toBe(
      [
        "NAME   ENGINE   WHERE   MOUNT   MODEL   AGE   STATUS",
        "a      docker   local   —       m       1h    running",
        "",
      ].join("\n"),
    );
    expect(readKept(s.dir).entries).toHaveLength(2); // hidden, never pruned
    s.out.length = 0;
    expect(await psCommand({ all: true }, s.deps())).toBe(0);
    expect(s.text()).toMatch(/\nb +docker .* gone\n/);
  });

  test("F4: only gone rows → only the header row, no message or hint (owner Q-R2)", async () => {
    const s = setup([entry("b")], { "docker:unix:///var/run/docker.sock": new FakeEngine() });
    expect(await psCommand({}, s.deps())).toBe(0);
    expect(s.text()).toBe("NAME   ENGINE   WHERE   MOUNT   MODEL   AGE   STATUS\n");
    s.out.length = 0;
    expect(await psCommand({ all: true }, s.deps())).toBe(0); // `-a` is unchanged
    expect(s.text()).toMatch(/\nb +docker .* gone\n/);
  });

  test("F4: a gone row a live relay or TUI still acts on stays visible", async () => {
    // Mutation: hide every gone row → a running relay disappears from `ps`.
    const procOf: ProcOf = () => ({ state: "S", start: "1" });
    const e = entry("b");
    const s = setup([e], { "docker:unix:///var/run/docker.sock": new FakeEngine() });
    const dir = ensureRunDir(runDirIn(s.dir, e));
    writeFileSync(join(dir, ".lock.1"), String(process.pid));
    writeOwner(dir, ownerOf("running", e.created));
    expect(await psCommand({}, s.deps({ procOf }))).toBe(0);
    expect(s.text()).toMatch(/\nb +docker .* gone\n/);
    // A TUI's presence counts too.
    const t = setup([e], { "docker:unix:///var/run/docker.sock": new FakeEngine() });
    const tdir = ensureRunDir(runDirIn(t.dir, e));
    writeOwner(tdir, { ...ownerOf("attached", e.created), kind: "tui" });
    writePresence(tdir, process.pid, procOf);
    expect(await psCommand({}, t.deps({ procOf }))).toBe(0);
    expect(t.text()).toMatch(/\nb +docker .* gone\n/);
  });

  test("-a: lists every entry with the engine's status; vanished ones are MARKED gone, not dropped", async () => {
    const docker = new FakeEngine();
    docker.set("a", running());
    const k8s = new FakeEngine();
    k8s.set("p", { status: "exited", labels: K8S_KEPT });
    const s = setup(
      [
        entry("a", { mount: "/Users/me/code/x" }),
        entry("b", { created: new Date(NOW - 2 * H).toISOString() }),
        entry("p", {
          engine: "kubernetes",
          endpoint: undefined,
          namespace: "agents",
          context: "dev",
          created: new Date(NOW - 3 * H).toISOString(),
        }),
      ],
      { "docker:unix:///var/run/docker.sock": docker, "k8s:agents": k8s },
    );
    expect(await psCommand({ all: true }, s.deps())).toBe(0);
    expect(s.text()).toBe(
      [
        "NAME   ENGINE       WHERE        MOUNT      MODEL   AGE   STATUS",
        "a      docker       local        ~/code/x   m       1h    running",
        "b      docker       local        —          m       2h    gone",
        "p      kubernetes   dev/agents   —          m       3h    exited",
        "",
      ].join("\n"),
    );
    // ps never removes anything, nor forgets an entry
    expect(docker.calls.some((c) => c.startsWith("remove:"))).toBe(false);
    expect(readKept(s.dir).entries).toHaveLength(3);
  });

  test("an unreachable engine: dim line, its rows stay (unreachable), others listed, exit 0", async () => {
    const docker = new FakeEngine();
    docker.set("a", running());
    const hung = new FakeEngine();
    hung.set("r", new Error("ssh: connect to host box: Connection refused"));
    const s = setup(
      [
        entry("a"),
        entry("r", { endpoint: "ssh://me@box", created: new Date(NOW - 2 * H).toISOString() }),
      ],
      { "docker:unix:///var/run/docker.sock": docker, "docker:ssh://me@box": hung },
    );
    // a podman entry whose host cannot even be built (no socket) — never an error
    recordKept(s.dir, entry("pm", { engine: "podman", endpoint: "unix:///nope.sock" }));
    expect(await psCommand({}, s.deps())).toBe(0);
    const text = s.text();
    expect(text).toMatch(/\na +docker +local .* running\n/);
    expect(text).toMatch(/r +docker +ssh:\/\/box .* unreachable/);
    // The notes go to STDERR (stdout stays the table), one dim line each.
    expect(text).not.toContain("not reachable");
    const notes = s.err.join("");
    expect(notes).toContain(
      "<dim>docker ssh://box: not reachable (skipped) — ssh: connect to host box: Connection refused</dim>\n",
    );
    expect(notes).toContain(
      "<dim>podman local: not reachable (skipped) — no engine at podman:unix:///nope.sock</dim>\n",
    );
    expect(readKept(s.dir).entries).toHaveLength(3); // unreachable never prunes
  });

  test("a hung engine is bounded (no answer → unreachable)", async () => {
    const s = setup([entry("slow")], {});
    const deps = s.deps({
      hostFor: () => ({ describe: () => new Promise(() => {}) }) as unknown as EngineHost,
    });
    expect(await psCommand({}, deps)).toBe(0);
    expect(s.err.join("")).toContain("not reachable (skipped) — no answer within 0.05s");
  });

  test("a missing podman socket: the short engine-specific note on stderr, no path; -q stays clean", async () => {
    const gone = (): EngineHost =>
      ({
        describe: async () => {
          throw new Error(
            "Docker engine socket not found at /var/folders/x/podman-machine-default-api.sock (podman socket (auto-discovered)) — is Docker Desktop running / `podman machine start`?",
          );
        },
      }) as unknown as EngineHost;
    const s = setup([entry("pm", { engine: "podman", endpoint: "unix:///x.sock" })], {});
    expect(await psCommand({}, s.deps({ hostFor: gone }))).toBe(0);
    expect(s.err.join("")).toBe(
      "<dim>podman local: not reachable (skipped) — no podman socket · run podman machine start</dim>\n",
    );
    expect(s.text()).not.toContain("socket");
    s.err.length = 0;
    s.out.length = 0;
    expect(await psCommand({ quiet: true }, s.deps({ hostFor: gone }))).toBe(0);
    expect(s.text()).toBe("pm\n");
    expect(s.err).toEqual([]);
  });

  test("k8s WHERE is <cluster>/<ns> from the kubeconfig, read once; a throwing loader never breaks ps", async () => {
    const k8s = new FakeEngine();
    k8s.set("p", { status: "running", labels: K8S_KEPT });
    k8s.set("q", { status: "running", labels: K8S_KEPT });
    const s = setup(
      [
        entry("p", { engine: "kubernetes", endpoint: undefined, namespace: "n", context: "c" }),
        entry("q", { engine: "kubernetes", endpoint: undefined, namespace: "n", context: "c" }),
      ],
      { "k8s:n": k8s },
    );
    let reads = 0;
    const kube = {
      contexts: [{ name: "c", context: { cluster: "x" } }],
      clusters: [{ name: "x", cluster: { server: "https://api.prod.example.com:6443" } }],
    };
    const deps = s.deps({
      kubeconfig: () => {
        reads++;
        return kube;
      },
    });
    expect(await psCommand({}, deps)).toBe(0);
    expect(s.text()).toMatch(/\np +kubernetes +prod\/n /);
    expect(reads).toBe(1);
    s.out.length = 0;
    const boom = s.deps({
      kubeconfig: () => {
        throw new Error("unreadable");
      },
    });
    expect(await psCommand({}, boom)).toBe(0);
    expect(s.text()).toMatch(/\np +kubernetes +c\/n /);
  });

  test("rm reads the kubeconfig only for a kubernetes name", async () => {
    const docker = new FakeEngine();
    docker.set("a", running({ "tentacle.managed": "true", "tentacle.kept": "true" }));
    const s = setup([entry("a")], { "docker:unix:///var/run/docker.sock": docker });
    let reads = 0;
    await rmCommand(
      "a",
      { force: true },
      s.deps({
        kubeconfig: () => {
          reads++;
          return undefined;
        },
      }),
    );
    expect(reads).toBe(0);
  });

  test("rm labels use the same cluster", async () => {
    const k8s = new FakeEngine();
    k8s.set("p", { status: "running", labels: { "tentacle.kept": "true" } }); // not managed → refused, label printed
    const s = setup(
      [entry("p", { engine: "kubernetes", endpoint: undefined, namespace: "n", context: "c" })],
      { "k8s:n": k8s },
    );
    const kube = {
      contexts: [{ name: "c", context: { cluster: "x" } }],
      clusters: [{ name: "x", cluster: { server: "https://api.prod.example.com:6443" } }],
    };
    expect(await rmCommand("p", { force: true }, s.deps({ kubeconfig: () => kube }))).toBe(1);
    expect(s.errText()).toContain("p (kubernetes, prod/n)");
    expect(s.text()).toBe(""); // a failed rm: nothing on stdout
  });

  test("a name now held by a foreign container shows not-tentacle", async () => {
    const docker = new FakeEngine();
    docker.set("a", running({ "tentacle.managed": "true" })); // managed but not kept
    const s = setup([entry("a")], { "docker:unix:///var/run/docker.sock": docker });
    await psCommand({}, s.deps());
    expect(s.text()).toMatch(/a +docker .* not-tentacle/);
  });

  test("--engine filters before dialling; -q prints names only (diagnostics to stderr)", async () => {
    const docker = new FakeEngine();
    const s = setup([entry("a"), entry("pod1", { engine: "kubernetes", namespace: "n" })], {
      "docker:unix:///var/run/docker.sock": docker,
    });
    writeFileSync(join(s.dir, "broken.json"), "{");
    await psCommand({ engine: "docker" }, s.deps());
    expect(s.text()).not.toContain("pod1");
    // docs/fix/cli-output-streams.md (audit row 7): the note is stderr's; the table alone on stdout.
    expect(s.text()).toStartWith("NAME ");
    expect(s.text()).not.toContain("kept index");
    expect(s.errText()).toContain(
      `<dim>kept index: ${join(s.dir, "broken.json")}: not valid JSON — left untouched</dim>`,
    );
    s.out.length = 0;
    s.err.length = 0;
    await psCommand({ quiet: true }, s.deps());
    expect(s.text()).toBe("a\npod1\n");
    expect(s.err.join("")).toContain("not valid JSON");
    expect(docker.calls).toEqual(["describe:a"]); // -q dials nothing
  });

  test("-v: the detail block", async () => {
    const docker = new FakeEngine();
    docker.set(
      "a",
      running({ ...DOCKER_KEPT, "tentacle.workspace-masked": '["/Users/me/x/.ssh"]' }),
    );
    const s = setup([entry("a", { mount: "/Users/me/x" })], {
      "docker:unix:///var/run/docker.sock": docker,
    });
    await psCommand({ verbose: true }, s.deps());
    expect(s.text()).toContain("  hidden    ~/x/.ssh");
  });
});

describe("tentacle ps: detached runs (docs/feat/detached-relay-lifecycle.md L28)", () => {
  const key = "docker:unix:///var/run/docker.sock";
  const procOf: ProcOf = () => ({ state: "S", start: "1" });
  const rows = async (write: (dir: string, e: KeptEntry) => void, verbose = false) => {
    const docker = new FakeEngine();
    docker.set("a", running());
    const e = entry("a");
    const s = setup([e], { [key]: docker });
    write(ensureRunDir(runDirIn(s.dir, e)), e);
    expect(await psCommand({ verbose }, s.deps({ procOf }))).toBe(0);
    return s.text();
  };

  test("a live relay's state replaces the engine's word", async () => {
    const text = await rows((dir) => {
      writeFileSync(join(dir, ".lock.1"), String(process.pid));
      writeOwner(dir, { ...ownerOf("waiting-permission"), tool: "shell", autoAccept: true });
    });
    expect(text).toContain("detached · waiting: permission (shell) · auto");
  });

  test("a dead one: `running · relay lost`", async () => {
    const text = await rows((dir) => {
      writeFileSync(join(dir, ".lock.1"), "");
      writeOwner(dir, ownerOf("running"));
    });
    expect(text).toContain("running · relay lost");
  });

  test("R6 keep=false, its relay gone mid-run: `not saved` while the workload is there, not once it is gone", async () => {
    // Owner, 2026-11-02. A workload the net deleted (its save confirmed) is `gone`, nothing more.
    const text = await rows((dir) => {
      writeFileSync(join(dir, ".lock.1"), "");
      writeOwner(dir, { ...ownerOf("running"), keep: false });
    });
    expect(text).toContain("running · relay lost · not saved");
    const docker = new FakeEngine(); // nothing named `a`: gone
    const e = entry("a");
    const s = setup([e], { [key]: docker });
    writeOwner(ensureRunDir(runDirIn(s.dir, e)), { ...ownerOf("running"), keep: false });
    expect(await psCommand({ all: true }, s.deps({ procOf }))).toBe(0);
    expect(s.text()).toContain("gone");
    expect(s.text()).not.toContain("not saved");
  });

  test("a workload left behind: the reason reaches `ps`, sanitised", async () => {
    // Mutation: drop `detail` for `idle` → the owner sees a plain `idle`.
    const text = await rows((dir) => {
      writeFileSync(join(dir, ".lock.1"), "");
      writeOwner(dir, {
        ...ownerOf("idle"),
        keep: false,
        detail: "not removed: engine \u001b[31mdown — tentacle rm a",
      });
    });
    expect(text).toContain("idle (not removed: engine [31mdown — tentacle rm a)");
    expect(text).not.toContain("\u001b");
  });

  test("-v: pid, session, log, removal", async () => {
    let log = "";
    const text = await rows((dir) => {
      log = relayLogPath(dir);
      writeFileSync(join(dir, ".lock.1"), String(process.pid));
      writeOwner(dir, { ...ownerOf("running"), keep: false, sessionId: "u1" });
    }, true);
    expect(text).toContain(`  relay     pid ${process.pid}`);
    expect(text).toContain("  session   u1");
    expect(text).toContain(`  log       ${log}`);
    expect(text).toContain("  removal   when the run ends");
  });

  test("R4 a record of an EARLIER workload of a reused name: no session, no removal shown (as `attach` does)", async () => {
    // Mutation: show `owner.sessionId` regardless → `ps` promises a session and a
    // delete that `attach`/the quit will not do (review R4).
    const text = await rows((dir) => {
      writeFileSync(join(dir, ".lock.1"), String(process.pid));
      writeOwner(dir, {
        ...ownerOf("running", new Date(NOW - 9 * H).toISOString()),
        keep: false,
        sessionId: "stale-session",
      });
    }, true);
    expect(text).not.toContain("stale-session");
    expect(text).not.toContain("  removal   when the run ends");
  });

  test("H21 TUIs on the run: `attached (2)`, `-v` their pids; with none, `tui lost` (docs/feat/detached-handover.md)", async () => {
    // Mutation: read only the relay's lock → a TUI-run reads `relay lost` / nothing.
    const tui: OwnerRecord = { ...ownerOf("attached"), kind: "tui" };
    const two = await rows((dir) => {
      writeOwner(dir, tui);
      writePresence(dir, process.pid, procOf);
      writePresence(dir, process.ppid, procOf);
    }, true);
    expect(two).toContain("attached (2)");
    expect(two).toContain(
      `  attached  pid ${Math.min(process.pid, process.ppid)}, pid ${Math.max(process.pid, process.ppid)}`,
    );
    const one = await rows((dir) => {
      writeOwner(dir, tui);
      writePresence(dir, process.pid, procOf);
    });
    expect(one).toContain("running · attached");
    expect(one).not.toContain("attached (");
    const lost = await rows((dir) => writeOwner(dir, tui));
    expect(lost).toContain("running · tui lost");
  });

  test("no run dir: no field, and no process is looked at", async () => {
    // Mutation: probe every entry → a `ps` subprocess per kept workload.
    const docker = new FakeEngine();
    docker.set("a", running());
    const s = setup([entry("a")], { [key]: docker });
    let looked = 0;
    await psCommand(
      {},
      s.deps({
        procOf: () => {
          looked += 1;
          return undefined;
        },
      }),
    );
    expect(looked).toBe(0);
    expect(s.text()).not.toContain("detached");
  });
});

describe("tentacle rm", () => {
  const key = "docker:unix:///var/run/docker.sock";

  test("happy path (not running): removed, entry dropped, the approved line", async () => {
    const docker = new FakeEngine();
    docker.set("a", { status: "exited", labels: DOCKER_KEPT });
    const s = setup([entry("a", { mount: "/Users/me/code/tentacle" })], { [key]: docker });
    expect(await rmCommand("a", {}, s.deps())).toBe(0);
    // docs/fix/cli-output-streams.md D3: the NAME on stdout (like `docker rm`),
    // the prose on stderr.
    // Mutation: drop `removedName()` → stdout is empty.
    expect(s.text()).toBe("a\n");
    expect(s.errText()).toBe("Removed a (docker, ~/code/tentacle).\n");
    expect(docker.calls).toEqual(["describe:a", "describe:a", "remove:a"]);
    expect(readKept(s.dir).entries).toEqual([]);
  });

  test("running: asks [y/N]; n / empty → nothing removed; y → removed", async () => {
    for (const [answer, removed] of [
      ["n", false],
      ["", false],
      ["y", true],
    ] as const) {
      const docker = new FakeEngine();
      docker.set("a", running());
      const s = setup([entry("a")], { [key]: docker });
      s.interactive(answer);
      expect(await rmCommand("a", {}, s.deps())).toBe(removed ? 0 : 1);
      expect(s.asked).toEqual([
        "a (docker, local) is running — a session may be attached. Remove it? [y/N] ",
      ]);
      expect(docker.calls.includes("remove:a")).toBe(removed);
      expect(readKept(s.dir).entries).toHaveLength(removed ? 0 : 1);
    }
  });

  test("running with no terminal → refused (pass -f); -f → no question, removed", async () => {
    const docker = new FakeEngine();
    docker.set("a", running());
    const s = setup([entry("a")], { [key]: docker });
    expect(await rmCommand("a", {}, s.deps())).toBe(1);
    expect(s.errText()).toContain("Pass -f to remove it without asking.");
    expect(docker.calls).not.toContain("remove:a");
    expect(await rmCommand("a", { force: true }, s.deps())).toBe(0);
    expect(docker.calls).toContain("remove:a");
  });

  test("a foreign / unlabelled / managed-but-not-kept workload at that name: ZERO removes", async () => {
    const cases: Record<string, string>[] = [
      {},
      { "tentacle.managed": "true" },
      { "tentacle.kept": "true" },
    ];
    for (const labels of cases) {
      const docker = new FakeEngine();
      docker.set("a", { status: "exited", labels });
      const s = setup([entry("a")], { [key]: docker });
      expect(await rmCommand("a", { force: true }, s.deps())).toBe(1);
      expect(docker.calls.filter((c) => c.startsWith("remove:"))).toEqual([]);
      expect(s.errText()).toContain("left it alone; dropped its stale entry");
      expect(readKept(s.dir).entries).toEqual([]);
    }
  });

  test("R3 a KEPT workload re-created here outside this index: its own `created` wins — ZERO removes, the stale entry dropped", async () => {
    // Mutation: tie on labels only → a stranger's workload (another laptop, same
    // place and name) is deleted by this stale entry (review R3).
    const mine = entry("a");
    const stranger = { ...mine, created: new Date(NOW - 9 * H).toISOString() };
    const docker = new FakeEngine();
    docker.set("a", {
      status: "exited",
      labels: { ...DOCKER_KEPT, "tentacle.created": stranger.created },
    });
    const s = setup([mine], { [key]: docker });
    expect(await rmCommand("a", { force: true }, s.deps())).toBe(1);
    expect(docker.calls.filter((c) => c.startsWith("remove:"))).toEqual([]);
    expect(s.errText()).toContain("now names another tentacle workload");
    expect(s.errText()).toContain("left it alone; dropped its stale entry");
    expect(readKept(s.dir).entries).toEqual([]);
  });

  test("R3 k8s: the pod's own `created` ANNOTATION is the tie (labels alone are not enough)", async () => {
    const mine = entry("p", { engine: "kubernetes", namespace: "n" });
    const k8s = new FakeEngine();
    k8s.set("p", {
      status: "running",
      labels: K8S_KEPT,
      annotations: { "tentacle.created": new Date(NOW - 9 * H).toISOString() },
    });
    const s = setup([mine], { "k8s:n": k8s });
    expect(await rmCommand("p", { force: true }, s.deps())).toBe(1);
    expect(k8s.calls).not.toContain("remove:p");
    // Matching `created` (the same workload): the delete goes through.
    k8s.set("p", {
      status: "running",
      labels: K8S_KEPT,
      annotations: { "tentacle.created": mine.created },
    });
    recordKept(s.dir, mine);
    expect(await rmCommand("p", { force: true }, s.deps())).toBe(0);
    expect(k8s.calls.at(-1)).toBe("remove:p");
  });

  test("R3 a workload that declares no `created` at all: the labels alone decide, as before", async () => {
    // An older build's workload has no annotation: not dating it is not evidence.
    const docker = new FakeEngine();
    docker.set("a", { status: "exited", labels: DOCKER_KEPT });
    const s = setup([entry("a")], { [key]: docker });
    expect(await rmCommand("a", { force: true }, s.deps())).toBe(0);
    expect(docker.calls).toContain("remove:a");
  });

  test("k8s: the pod's labels are checked before the delete (deletePod has no guard)", async () => {
    const k8s = new FakeEngine();
    k8s.set("p", { status: "running", labels: { "tentacle.kept": "true" } }); // no managed-by
    const s = setup([entry("p", { engine: "kubernetes", namespace: "n" })], { "k8s:n": k8s });
    expect(await rmCommand("p", { force: true }, s.deps())).toBe(1);
    expect(k8s.calls).toEqual(["describe:p", "describe:p"]);
    k8s.set("p", { status: "running", labels: K8S_KEPT });
    recordKept(s.dir, entry("p", { engine: "kubernetes", namespace: "n" }));
    expect(await rmCommand("p", { force: true }, s.deps())).toBe(0);
    expect(k8s.calls.at(-1)).toBe("remove:p");
  });

  test("race: labels stripped between the question and the delete → refused, nothing removed", async () => {
    const docker = new FakeEngine();
    docker.set("a", running(), { status: "running", labels: {} });
    const s = setup([entry("a")], { [key]: docker });
    s.interactive("y");
    expect(await rmCommand("a", {}, s.deps())).toBe(1);
    expect(docker.calls).toEqual(["describe:a", "describe:a"]);
  });

  test("gone (removed outside tentacle) → the entry is dropped, said, exit 0", async () => {
    const docker = new FakeEngine();
    docker.set("a", null);
    const s = setup([entry("a")], { [key]: docker });
    expect(await rmCommand("a", {}, s.deps())).toBe(0);
    expect(s.errText()).toBe(
      "Removed the entry of a (docker, local): the container no longer exists.\n",
    );
    expect(readKept(s.dir).entries).toEqual([]);
  });

  test("a stale entry after a successful delete: the message never says `not removed`", async () => {
    // Mutation: `forgetKept` throwing turns `removed` into `failed` → "not removed:
    // EISDIR", although the container IS gone (docs/feat…lifecycle.md, Review 3).
    const docker = new FakeEngine();
    docker.set("a", { status: "exited", labels: DOCKER_KEPT });
    const s = setup([entry("a")], { [key]: docker });
    const file = readKept(s.dir).entries[0]?.file;
    if (file === undefined) {
      throw new Error("no entry");
    }
    // A directory where the entry file is: `rmSync` fails, the delete itself worked.
    rmSync(file, { force: true });
    mkdirSync(file);
    const removal = await removeVerifiedKept(entry("a"), file, s.deps());
    expect(docker.calls).toContain("remove:a");
    expect(removal.kind).toBe("removed");
    if (removal.kind !== "removed") {
      throw new Error("unreachable");
    }
    expect(removal.forgetError).toContain("EISDIR");
  });

  test("`rm` after a successful delete but a failed forget: says `gone`, never `not removed`", async () => {
    // Mutation: `forgetKept` throwing becomes `failed` → "not removed: EACCES",
    // although the container IS gone (docs/feat…lifecycle.md, Review 3).
    const docker = new FakeEngine();
    docker.set("a", { status: "exited", labels: DOCKER_KEPT });
    const s = setup([entry("a")], { [key]: docker });
    chmodSync(s.dir, 0o500); // the index cannot be written to: `unlink` fails
    try {
      expect(await rmCommand("a", { force: true }, s.deps())).toBe(0);
    } finally {
      chmodSync(s.dir, 0o700);
    }
    expect(docker.calls).toContain("remove:a");
    expect(s.errText()).toContain("Removed a (docker, local).");
    expect(s.errText()).not.toContain("not removed");
    expect(s.errText()).toContain("[warn] its entry in the kept index was not dropped");
  });

  test("a foreign workload whose entry will not drop: left alone is said, the entry too", async () => {
    const docker = new FakeEngine();
    docker.set("a", { status: "running", labels: {} });
    const s = setup([entry("a")], { [key]: docker });
    chmodSync(s.dir, 0o500);
    try {
      expect(await rmCommand("a", { force: true }, s.deps())).toBe(1);
    } finally {
      chmodSync(s.dir, 0o700);
    }
    expect(docker.calls.filter((c) => c.startsWith("remove:"))).toEqual([]);
    expect(s.errText()).toContain("left it alone");
    // The entry was NOT dropped, so the first line must not say it was: only the
    // `[warn]` may mention it (docs/feat…lifecycle.md, Review fix round 1 — B).
    expect(s.errText()).not.toContain("dropped its stale entry");
    expect(s.errText()).toContain("[warn] its entry in the kept index was not dropped");
  });

  test("gone with a failed forget: the line never says the ENTRY was removed", async () => {
    // Mutation: print "Removed the entry of …" whenever `gone` (finding B) → it
    // contradicts the `[warn]` right below it: the entry is still there.
    const docker = new FakeEngine();
    docker.set("a", null);
    const s = setup([entry("a")], { [key]: docker });
    chmodSync(s.dir, 0o500); // the index cannot be written to: `unlink` fails
    try {
      expect(await rmCommand("a", { force: true }, s.deps())).toBe(0);
    } finally {
      chmodSync(s.dir, 0o700);
    }
    expect(s.errText()).toContain("The container of a (docker, local) no longer exists.");
    expect(s.errText()).not.toContain("Removed the entry");
    expect(s.errText()).toContain("[warn] its entry in the kept index was not dropped");
  });

  test("unreachable → error, entry KEPT; a failed delete → error, entry kept", async () => {
    const docker = new FakeEngine();
    docker.set("a", new Error("socket not found"));
    const s = setup([entry("a")], { [key]: docker });
    expect(await rmCommand("a", { force: true }, s.deps())).toBe(1);
    expect(s.errText()).toContain("[error] cannot reach a (docker, local): socket not found");
    expect(readKept(s.dir).entries).toHaveLength(1);
    docker.set("a", { status: "exited", labels: DOCKER_KEPT });
    docker.removeError = new Error("refusing to remove container");
    expect(await rmCommand("a", {}, s.deps())).toBe(1);
    expect(s.errText()).toContain(
      "[error] removing a (docker, local) failed: refusing to remove container",
    );
    expect(readKept(s.dir).entries).toHaveLength(1);
  });

  describe("a detached run (docs/feat/detached-relay-lifecycle.md L29)", () => {
    const e = entry("a");
    /** A real process holds the run's lock: `rm` must really stop it. */
    const holder = (s: ReturnType<typeof setup>, state = "running") => {
      const dir = ensureRunDir(runDirIn(s.dir, e));
      const child = spawn("sleep", ["30"], { stdio: "ignore" });
      if (child.pid === undefined) {
        throw new Error("no child");
      }
      writeFileSync(join(dir, ".lock.1"), String(child.pid));
      writeOwner(dir, ownerOf(state as OwnerRecord["state"]));
      return { dir, child, pid: child.pid };
    };
    /** The OS's word: a child's `exitCode` lags behind a kill by an event-loop turn. */
    const alive = (dir: string, pid: number) => lockHolder(dir, laptopProc)?.pid === pid;

    test("y: the prompt names pid and state, the stop comes before the delete, the run dir goes", async () => {
      // Mutation: remove with no stop → the workload goes under a live relay.
      const docker = new FakeEngine();
      docker.set("a", running());
      const s = setup([e], { [key]: docker });
      const { dir, child, pid } = holder(s, "waiting-permission");
      s.interactive("y");
      let locked: unknown = "never removed";
      docker.onRemove = () => {
        locked = lockHolder(dir, laptopProc);
      };
      expect(await rmCommand("a", {}, s.deps())).toBe(0);
      expect(s.asked).toHaveLength(1);
      expect(s.asked[0]).toContain(`pid ${pid}`);
      expect(s.asked[0]).toContain("detached · waiting: permission");
      expect(locked).toBeNull();
      expect(s.errText()).toContain(`stopping the detached run (pid ${pid})…`);
      expect(s.errText()).toContain("Removed a (docker, local).");
      expect(readKept(s.dir).entries).toEqual([]);
      expect(existsSync(dir)).toBe(false);
      child.kill("SIGKILL");
    });

    test('"n" stops nothing; no terminal refuses, naming the pid', async () => {
      // Mutation: stop before asking → a "no" has already cancelled the turn.
      const docker = new FakeEngine();
      docker.set("a", { status: "exited", labels: DOCKER_KEPT });
      const s = setup([e], { [key]: docker });
      const { dir, child, pid } = holder(s);
      expect(await rmCommand("a", {}, s.deps())).toBe(1);
      expect(s.errText()).toContain(`owned by a detached run (pid ${pid})`);
      expect(s.errText()).toContain("Pass -f to stop it and remove it without asking.");
      s.interactive("n");
      expect(await rmCommand("a", {}, s.deps())).toBe(1);
      expect(s.asked).toHaveLength(1);
      expect(alive(dir, pid)).toBe(true);
      expect(docker.calls).not.toContain("remove:a");
      expect(s.errText()).not.toContain("stopping the detached run");
      child.kill("SIGKILL");
    });

    test("-f with no terminal stops and removes, no question", async () => {
      const docker = new FakeEngine();
      docker.set("a", running());
      const s = setup([e], { [key]: docker });
      const { dir, child } = holder(s);
      expect(await rmCommand("a", { force: true }, s.deps())).toBe(0);
      expect(s.asked).toEqual([]);
      expect(existsSync(dir)).toBe(false);
      child.kill("SIGKILL");
    });

    test("an unreachable engine stops nothing: the run goes on", async () => {
      const docker = new FakeEngine();
      docker.set("a", new Error("socket not found"));
      const s = setup([e], { [key]: docker });
      const { dir, child, pid } = holder(s);
      expect(await rmCommand("a", { force: true }, s.deps())).toBe(1);
      expect(s.errText()).toContain("[error] cannot reach a (docker, local): socket not found");
      expect(s.errText()).not.toContain("stopping the detached run");
      expect(alive(dir, pid)).toBe(true);
      expect(existsSync(dir)).toBe(true);
      expect(readKept(s.dir).entries).toHaveLength(1);
      child.kill("SIGKILL");
    });

    test("gone after a stop is the relay's own keep=false removal: the normal line, exit 0", async () => {
      const docker = new FakeEngine();
      docker.set("a", running(), null);
      const s = setup([e], { [key]: docker });
      const { dir, child } = holder(s);
      expect(await rmCommand("a", { force: true }, s.deps())).toBe(0);
      expect(s.errText()).toContain("Removed a (docker, local).");
      expect(s.errText()).not.toContain("no longer exists");
      expect(docker.calls).not.toContain("remove:a");
      expect(existsSync(dir)).toBe(false);
      child.kill("SIGKILL");
    });

    test("a stop that throws: [error], nothing removed", async () => {
      const docker = new FakeEngine();
      docker.set("a", running());
      const s = setup([e], { [key]: docker });
      const { dir, child } = holder(s);
      const code = await rmCommand(
        "a",
        { force: true },
        s.deps({ stopRelay: () => Promise.reject(new Error("EPERM")) }),
      );
      expect(code).toBe(1);
      expect(s.errText()).toContain("[error] could not stop the detached run");
      expect(s.errText()).toContain("EPERM");
      expect(docker.calls).not.toContain("remove:a");
      expect(existsSync(dir)).toBe(true);
      child.kill("SIGKILL");
    });

    test("after the delete and on `gone`, with a dead relay: the run dir goes", async () => {
      const docker = new FakeEngine();
      docker.set("a", { status: "exited", labels: DOCKER_KEPT });
      const s = setup([e], { [key]: docker });
      const dir = ensureRunDir(runDirIn(s.dir, e));
      writeOwner(dir, ownerOf("idle"));
      expect(await rmCommand("a", {}, s.deps())).toBe(0);
      expect(s.errText()).toBe("Removed a (docker, local).\n");
      expect(existsSync(dir)).toBe(false);

      recordKept(s.dir, e);
      ensureRunDir(dir);
      writeOwner(dir, ownerOf("idle"));
      docker.set("a", null);
      expect(await rmCommand("a", {}, s.deps())).toBe(0);
      expect(s.errText()).toContain("the container no longer exists");
      expect(existsSync(dir)).toBe(false);
    });

    test("a foreign workload: its run dir goes with the entry", async () => {
      const docker = new FakeEngine();
      docker.set("a", { status: "exited", labels: {} });
      const s = setup([e], { [key]: docker });
      const dir = ensureRunDir(runDirIn(s.dir, e));
      writeOwner(dir, ownerOf("idle"));
      expect(await rmCommand("a", {}, s.deps())).toBe(1);
      expect(docker.calls).not.toContain("remove:a");
      expect(existsSync(dir)).toBe(false);
    });

    test("a failed delete keeps the run dir", async () => {
      const docker = new FakeEngine();
      docker.set("a", { status: "exited", labels: DOCKER_KEPT });
      docker.removeError = new Error("nope");
      const s = setup([e], { [key]: docker });
      const dir = ensureRunDir(runDirIn(s.dir, e));
      writeOwner(dir, ownerOf("idle"));
      expect(await rmCommand("a", {}, s.deps())).toBe(1);
      expect(existsSync(dir)).toBe(true);
    });

    test("Q3 an unknown owner.json is left byte-identical, and named", async () => {
      // Mutation: remove the run dir regardless.
      const docker = new FakeEngine();
      docker.set("a", { status: "exited", labels: DOCKER_KEPT });
      const s = setup([e], { [key]: docker });
      const dir = ensureRunDir(runDirIn(s.dir, e));
      writeFileSync(ownerPath(dir), '{"schemaVersion":99,"future":true}');
      expect(await rmCommand("a", {}, s.deps())).toBe(0);
      expect(s.errText()).toContain("Removed a (docker, local).");
      expect(s.errText()).toContain(ownerPath(dir));
      expect(readFileSync(ownerPath(dir), "utf8")).toBe('{"schemaVersion":99,"future":true}');
    });
  });

  test("none / ambiguous → error, nothing dialled; --engine narrows", async () => {
    const docker = new FakeEngine();
    docker.set("x", { status: "exited", labels: DOCKER_KEPT });
    const s = setup([entry("x"), entry("x", { engine: "podman", endpoint: "unix:///p.sock" })], {
      [key]: docker,
    });
    expect(await rmCommand("nope", {}, s.deps())).toBe(1);
    expect(s.errText()).toContain(
      '[error] no kept container or pod named "nope" — see `tentacle ps`',
    );
    expect(await rmCommand("x", {}, s.deps())).toBe(1);
    expect(s.errText()).toContain('"x" names 2 kept workloads:');
    expect(s.errText()).toContain("Nothing was removed.");
    expect(docker.calls).toEqual([]);
    expect(await rmCommand("x", { engine: "docker" }, s.deps())).toBe(0);
    expect(readdirSync(s.dir)).toHaveLength(1);
  });

  test("F3 the parser takes several names (and still needs one); ps takes -a", () => {
    const many = parseArgs(["a", "-f", "b", "c"], ARGS.rm);
    expect(many.ok && many.positional).toEqual(["a", "b", "c"]);
    expect(parseArgs([], ARGS.rm).ok).toBe(false);
    const all = parseArgs(["-a"], ARGS.ps);
    expect(all.ok && all.bools.has("all")).toBe(true);
  });

  test("F3 several names: each removed in order, exit 0", async () => {
    const docker = new FakeEngine();
    docker.set("a", { status: "exited", labels: DOCKER_KEPT });
    docker.set("b", { status: "exited", labels: DOCKER_KEPT });
    const s = setup([entry("a"), entry("b")], { [key]: docker });
    expect(await rmCommand(["a", "b"], {}, s.deps())).toBe(0);
    expect(docker.calls.filter((c) => c.startsWith("remove:"))).toEqual(["remove:a", "remove:b"]);
    expect(readKept(s.dir).entries).toEqual([]);
  });

  test("F3 (owner OQ7): past a failure the next names still go; exit 1", async () => {
    // Mutation: stop at the first failure → `b` is never removed.
    const docker = new FakeEngine();
    docker.set("a", { status: "exited", labels: DOCKER_KEPT });
    docker.set("b", { status: "exited", labels: DOCKER_KEPT });
    const s = setup([entry("a"), entry("b")], { [key]: docker });
    expect(await rmCommand(["a", "nope", "b"], {}, s.deps())).toBe(1);
    expect(s.errText()).toContain('[error] no kept container or pod named "nope"');
    expect(docker.calls.filter((c) => c.startsWith("remove:"))).toEqual(["remove:a", "remove:b"]);
    // stdout: exactly the names removed, in order (`rm $(…) | …` reads them).
    expect(s.text()).toBe("a\nb\n");
  });

  test("F3 a repeated name is handled once: one question, no second error", async () => {
    // Mutation: no dedup → the declined `a` is asked twice.
    const docker = new FakeEngine();
    docker.set("a", running());
    const s = setup([entry("a")], { [key]: docker });
    s.interactive("n");
    expect(await rmCommand(["a", "a"], {}, s.deps())).toBe(1);
    expect(s.asked).toHaveLength(1);
    expect(s.errText()).toBe("Not removed.\n");
  });

  test("F3 one y/N per running name; -f asks nothing", async () => {
    const docker = new FakeEngine();
    docker.set("a", running());
    docker.set("b", running());
    const s = setup([entry("a"), entry("b")], { [key]: docker });
    s.interactive("y");
    expect(await rmCommand(["a", "b"], {}, s.deps())).toBe(0);
    expect(s.asked).toHaveLength(2);
    const f = setup([entry("a"), entry("b")], { [key]: docker });
    f.interactive("n");
    expect(await rmCommand(["a", "b"], { force: true }, f.deps())).toBe(0);
    expect(f.asked).toEqual([]);
  });
});

describe("attach <name> resolution", () => {
  test("from the index alone: one / none / ambiguous", () => {
    const s = setup([entry("a"), entry("b"), entry("b", { engine: "podman" })]);
    const one = resolveKeptAttach("a", s.dir).resolved;
    expect(one.kind === "one" && one.match.entry.engine).toBe("docker");
    expect(resolveKeptAttach("z", s.dir).resolved.kind).toBe("none");
    expect(resolveKeptAttach("b", s.dir).resolved.kind).toBe("ambiguous");
  });
});
