import { describe, expect, test } from "bun:test";
import {
  EMPTY_LINE,
  KEPT_LABEL,
  type KeptEntry,
  type KeptRow,
  ambiguousMessage,
  formatAge,
  formatMount,
  isKeptWorkload,
  keptMetadata,
  parseKeptEntry,
  removedLine,
  renderTable,
  renderVerbose,
  resolveByName,
  sortKept,
  summaryLine,
  whereOf,
} from "../src/kept.ts";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const HOME = "/Users/me";
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const H = 3_600_000;
const D = 24 * H;

const entry = (over: Partial<KeptEntry> & Pick<KeptEntry, "name" | "engine">): KeptEntry => ({
  schemaVersion: 1,
  model: "m",
  created: ago(H),
  ...(over.engine === "kubernetes"
    ? { namespace: "agents", context: "dev" }
    : { endpoint: "unix:///var/run/docker.sock" }),
  ...over,
});
const running = { kind: "state" as const, state: "running", labels: {} };

describe("keptMetadata / isKeptWorkload", () => {
  test("kept is a LABEL; engine/model/created are annotations (k8s label values cannot hold them)", () => {
    const m = keptMetadata({ engine: "kubernetes", model: "openai/gpt-x", created: ago(0) });
    expect(m.labels).toEqual({ [KEPT_LABEL]: "true" });
    expect(m.annotations).toEqual({
      "tentacle.engine": "kubernetes",
      "tentacle.model": "openai/gpt-x",
      "tentacle.created": ago(0),
    });
  });

  test("needs the engine's owner marker AND kept=true", () => {
    expect(isKeptWorkload("docker", { "tentacle.managed": "true", [KEPT_LABEL]: "true" })).toBe(
      true,
    );
    expect(isKeptWorkload("docker", { [KEPT_LABEL]: "true" })).toBe(false);
    expect(isKeptWorkload("docker", { "tentacle.managed": "true" })).toBe(false);
    expect(isKeptWorkload("podman", { "tentacle.managed": "yes", [KEPT_LABEL]: "true" })).toBe(
      false,
    );
    expect(isKeptWorkload("docker", null)).toBe(false);
    const k8s = { "app.kubernetes.io/managed-by": "tentacle", [KEPT_LABEL]: "true" };
    expect(isKeptWorkload("kubernetes", k8s)).toBe(true);
    // the docker marker means nothing on a pod
    expect(isKeptWorkload("kubernetes", { "tentacle.managed": "true", [KEPT_LABEL]: "true" })).toBe(
      false,
    );
  });
});

describe("parseKeptEntry", () => {
  const good = entry({ name: "tentacle-ab12cd", engine: "docker", mount: "/Users/me/code" });

  test("round-trips an entry", () => {
    expect(parseKeptEntry(JSON.stringify(good))).toEqual({ ok: true, entry: good });
  });

  test("refuses, never half-loads: corrupt, another schemaVersion, missing fields", () => {
    expect(parseKeptEntry("{oops")).toEqual({ ok: false, problem: "not valid JSON" });
    const newer = parseKeptEntry(JSON.stringify({ ...good, schemaVersion: 2 }));
    expect(newer.ok).toBe(false);
    expect(!newer.ok && newer.problem).toContain("upgrade tentacle");
    expect(parseKeptEntry(JSON.stringify({ ...good, engine: "lxc" })).ok).toBe(false);
    expect(parseKeptEntry(JSON.stringify({ ...good, created: "yesterday" })).ok).toBe(false);
    const { endpoint: _e, ...noWhere } = good;
    expect(parseKeptEntry(JSON.stringify(noWhere)).ok).toBe(false);
    const pod = entry({ name: "p", engine: "kubernetes" });
    const { namespace: _n, ...noNs } = pod;
    expect(parseKeptEntry(JSON.stringify(noNs)).ok).toBe(false);
  });
});

describe("formatting", () => {
  test("whereOf: local | ssh://host | tcp://… | ctx/ns", () => {
    expect(whereOf(entry({ name: "a", engine: "docker" }))).toBe("local");
    expect(
      whereOf(entry({ name: "a", engine: "docker", endpoint: "ssh://me@build-box:2222" })),
    ).toBe("ssh://build-box");
    expect(whereOf(entry({ name: "a", engine: "docker", endpoint: "tcp://10.0.0.2:2376" }))).toBe(
      "tcp://10.0.0.2:2376",
    );
    expect(whereOf(entry({ name: "a", engine: "kubernetes" }))).toBe("dev/agents");
    expect(
      whereOf({
        ...entry({ name: "a", engine: "kubernetes" }),
        context: undefined,
        server: "https://api.c:6443",
      }),
    ).toBe("api.c/agents");
  });

  test("formatAge boundaries", () => {
    const at = (ms: number) => formatAge(NOW, ago(ms));
    expect(at(59_000)).toBe("now");
    expect(at(60_000)).toBe("1m");
    expect(at(59 * 60_000)).toBe("59m");
    expect(at(H)).toBe("1h");
    expect(at(23 * H)).toBe("23h");
    expect(at(D)).toBe("1d");
    expect(at(-60_000)).toBe("?");
    expect(formatAge(NOW, "nope")).toBe("?");
  });

  test("formatMount: ~, outside home, none", () => {
    expect(formatMount("/Users/me/code/tentacle", HOME)).toBe("~/code/tentacle");
    expect(formatMount("/Users/me", HOME)).toBe("~");
    expect(formatMount("/Users/meow/x", HOME)).toBe("/Users/meow/x");
    expect(formatMount(undefined, HOME)).toBe("—");
  });
});

describe("renderTable (the owner-approved UX)", () => {
  const rows: KeptRow[] = [
    {
      entry: entry({
        name: "tentacle-77c0aa",
        engine: "kubernetes",
        created: ago(5 * D),
        model: "gpt-x",
      }),
      status: running,
    },
    {
      entry: entry({
        name: "tentacle-ab12cd",
        engine: "docker",
        mount: "/Users/me/code/tentacle",
        created: ago(2 * H),
        model: "claude-opus-5-5",
      }),
      status: running,
    },
    {
      entry: entry({
        name: "tentacle-5e6f70",
        engine: "docker",
        endpoint: "ssh://me@build-box",
        created: ago(4 * D),
        model: "gpt-x",
      }),
      status: { kind: "gone" },
    },
    {
      entry: entry({
        name: "tentacle-9f3e01",
        engine: "podman",
        endpoint: "unix:///run/podman.sock",
        mount: "/Users/me/code/site",
        created: ago(3 * D),
        model: "gpt-x",
      }),
      status: { kind: "state", state: "exited", labels: {} },
    },
  ];

  test("golden: columns, oldest at the bottom, summary", () => {
    const lines = renderTable(sortKept(rows), NOW, HOME);
    expect([...lines, "", summaryLine(rows.length)].join("\n")).toBe(
      [
        "NAME             ENGINE      WHERE            MOUNT            MODEL            AGE  STATUS",
        "tentacle-ab12cd  docker      local            ~/code/tentacle  claude-opus-5-5  2h   running",
        "tentacle-9f3e01  podman      local            ~/code/site      gpt-x            3d   exited",
        "tentacle-5e6f70  docker      ssh://build-box  —                gpt-x            4d   gone",
        "tentacle-77c0aa  kubernetes  dev/agents       —                gpt-x            5d   running",
        "",
        "4 kept · resume: tentacle attach <name> · remove: tentacle rm <name>",
      ].join("\n"),
    );
    expect(EMPTY_LINE).toBe("No kept containers or pods.");
  });

  test("sort ties break by name", () => {
    const same = ago(H);
    const sorted = sortKept([
      { entry: entry({ name: "b", engine: "docker", created: same }) },
      { entry: entry({ name: "a", engine: "docker", created: same }) },
    ]);
    expect(sorted.map((r) => r.entry.name)).toEqual(["a", "b"]);
  });

  test("an ESC sequence in a recorded or labelled value never reaches the terminal", () => {
    const evil = entry({ name: "x\u001b[2Jy", engine: "docker", model: "m\u001b]0;pwn\u0007" });
    const masked = { "tentacle.workspace-masked": JSON.stringify(["/Users/me/a\u001b[31m"]) };
    const text = [
      ...renderTable([{ entry: evil, status: running }], NOW, HOME),
      ...renderVerbose([{ entry: evil, status: { ...running, labels: masked } }], NOW, HOME),
    ].join("\n");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0007");
  });

  test("-v: location, masked paths from the label, model, status reason", () => {
    const e = entry({ name: "t1", engine: "docker", mount: "/Users/me/code" });
    const labels = {
      "tentacle.workspace-masked": JSON.stringify(["/Users/me/code/.ssh", "/Users/me/code/cfg"]),
    };
    const text = renderVerbose([{ entry: e, status: { ...running, labels } }], NOW, HOME).join(
      "\n",
    );
    expect(text).toContain("  where     unix:///var/run/docker.sock");
    expect(text).toContain("  hidden    ~/code/.ssh, ~/code/cfg");
    expect(text).toContain("  model     m (the session's model at start)");
    const down = renderVerbose(
      [{ entry: e, status: { kind: "unreachable", reason: "socket not found" } }],
      NOW,
      HOME,
    ).join("\n");
    expect(down).toContain("  status    unreachable — socket not found");
  });
});

describe("resolveByName", () => {
  const a = { entry: entry({ name: "a", engine: "docker" }) };
  const b1 = { entry: entry({ name: "b", engine: "docker" }) };
  const b2 = { entry: entry({ name: "b", engine: "kubernetes" }) };
  const items = [a, b1, b2];

  test("one / none / ambiguous; --engine narrows", () => {
    expect(resolveByName("a", items)).toEqual({ kind: "one", match: a });
    expect(resolveByName("zz", items)).toEqual({ kind: "none" });
    expect(resolveByName("b", items)).toEqual({ kind: "ambiguous", candidates: [b1, b2] });
    expect(resolveByName("b", items, "kubernetes")).toEqual({ kind: "one", match: b2 });
    expect(ambiguousMessage("b", [b1.entry, b2.entry])).toBe(
      '"b" names 2 kept workloads:\n  docker · local\n  kubernetes · dev/agents\nNarrow it with --engine <kubernetes|docker|podman>.',
    );
  });

  test("removedLine: the mount, else WHERE", () => {
    expect(
      removedLine(entry({ name: "t", engine: "docker", mount: "/Users/me/code/x" }), HOME),
    ).toBe("Removed t (docker, ~/code/x).");
    expect(removedLine(entry({ name: "p", engine: "kubernetes" }), HOME)).toBe(
      "Removed p (kubernetes, dev/agents).",
    );
  });
});
