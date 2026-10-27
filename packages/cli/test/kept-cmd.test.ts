import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineHost, WorkloadFacts } from "../src/engine-host.ts";
import { type KeptDeps, psCommand, resolveKeptAttach, rmCommand } from "../src/kept-cmd.ts";
import { readKept, recordKept } from "../src/kept-index.ts";
import type { KeptEntry } from "../src/kept.ts";

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
    write: (t) => out.push(t),
    writeErr: (t) => err.push(t),
    now: () => NOW,
    home: "/Users/me",
    dim: (t) => `<dim>${t}</dim>`,
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
    text: () => out.join(""),
  };
}

const running = (labels: Record<string, string> = DOCKER_KEPT): WorkloadFacts => ({
  status: "running",
  labels,
});

describe("tentacle ps", () => {
  test("empty index → the empty line, exit 0; -q prints nothing", async () => {
    const s = setup([]);
    expect(await psCommand({}, s.deps())).toBe(0);
    expect(s.text()).toBe("No kept containers or pods.\n");
    s.out.length = 0;
    expect(await psCommand({ quiet: true }, s.deps())).toBe(0);
    expect(s.text()).toBe("");
  });

  test("lists every entry with the engine's status; vanished ones are MARKED gone, not dropped", async () => {
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
    expect(await psCommand({}, s.deps())).toBe(0);
    expect(s.text()).toBe(
      [
        "NAME  ENGINE      WHERE       MOUNT     MODEL  AGE  STATUS",
        "a     docker      local       ~/code/x  m      1h   running",
        "b     docker      local       —         m      2h   gone",
        "p     kubernetes  dev/agents  —         m      3h   exited",
        "",
        "3 kept · resume: tentacle attach <name> · remove: tentacle rm <name>",
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
    expect(text).toContain(
      "<dim>docker ssh://box: not reachable (skipped) — ssh: connect to host box: Connection refused</dim>",
    );
    expect(text).toContain(
      "<dim>podman local: not reachable (skipped) — no engine at podman:unix:///nope.sock</dim>",
    );
    expect(readKept(s.dir).entries).toHaveLength(3); // unreachable never prunes
  });

  test("a hung engine is bounded (no answer → unreachable)", async () => {
    const s = setup([entry("slow")], {});
    const deps = s.deps({
      hostFor: () => ({ describe: () => new Promise(() => {}) }) as unknown as EngineHost,
    });
    expect(await psCommand({}, deps)).toBe(0);
    expect(s.text()).toContain("not reachable (skipped) — no answer within 0.05s");
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
    expect(s.text()).toContain(
      `<dim>kept index: ${join(s.dir, "broken.json")}: not valid JSON — left untouched</dim>`,
    );
    s.out.length = 0;
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

describe("tentacle rm", () => {
  const key = "docker:unix:///var/run/docker.sock";

  test("happy path (not running): removed, entry dropped, the approved line", async () => {
    const docker = new FakeEngine();
    docker.set("a", { status: "exited", labels: DOCKER_KEPT });
    const s = setup([entry("a", { mount: "/Users/me/code/tentacle" })], { [key]: docker });
    expect(await rmCommand("a", {}, s.deps())).toBe(0);
    expect(s.text()).toBe("Removed a (docker, ~/code/tentacle).\n");
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
    expect(s.text()).toContain("Pass -f to remove it without asking.");
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
      expect(s.text()).toContain("left it alone; dropped its stale entry");
      expect(readKept(s.dir).entries).toEqual([]);
    }
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
    expect(s.text()).toBe(
      "Removed the entry of a (docker, local): the container no longer exists.\n",
    );
    expect(readKept(s.dir).entries).toEqual([]);
  });

  test("unreachable → error, entry KEPT; a failed delete → error, entry kept", async () => {
    const docker = new FakeEngine();
    docker.set("a", new Error("socket not found"));
    const s = setup([entry("a")], { [key]: docker });
    expect(await rmCommand("a", { force: true }, s.deps())).toBe(1);
    expect(s.text()).toContain("[error] cannot reach a (docker, local): socket not found");
    expect(readKept(s.dir).entries).toHaveLength(1);
    docker.set("a", { status: "exited", labels: DOCKER_KEPT });
    docker.removeError = new Error("refusing to remove container");
    expect(await rmCommand("a", {}, s.deps())).toBe(1);
    expect(s.text()).toContain(
      "[error] removing a (docker, local) failed: refusing to remove container",
    );
    expect(readKept(s.dir).entries).toHaveLength(1);
  });

  test("none / ambiguous → error, nothing dialled; --engine narrows", async () => {
    const docker = new FakeEngine();
    docker.set("x", { status: "exited", labels: DOCKER_KEPT });
    const s = setup([entry("x"), entry("x", { engine: "podman", endpoint: "unix:///p.sock" })], {
      [key]: docker,
    });
    expect(await rmCommand("nope", {}, s.deps())).toBe(1);
    expect(s.text()).toContain('[error] no kept container or pod named "nope" — see `tentacle ps`');
    expect(await rmCommand("x", {}, s.deps())).toBe(1);
    expect(s.text()).toContain('"x" names 2 kept workloads:');
    expect(s.text()).toContain("Nothing was removed.");
    expect(docker.calls).toEqual([]);
    expect(await rmCommand("x", { engine: "docker" }, s.deps())).toBe(0);
    expect(readdirSync(s.dir)).toHaveLength(1);
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
