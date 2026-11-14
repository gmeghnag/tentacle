import { describe, expect, test } from "bun:test";
import {
  HOP_ATTACH_USAGE,
  HOP_NAME_USAGE,
  HOP_USAGE,
  HOP_WORKLOAD_PART_MAX,
  type HopParse,
  type HopSpec,
  type HopWorkload,
  hopWorkload,
  parseHopCommand,
  workloadText,
} from "../src/hop-command.ts";

// docs/feat/session-hop.md slice H1: the `/move` grammar, pure.

const spec = (raw: string): HopSpec => {
  const parsed = parseHopCommand(raw);
  if (parsed.kind !== "spec") {
    throw new Error(`expected a spec, got ${parsed.kind}: ${JSON.stringify(parsed)}`);
  }
  return parsed.spec;
};
const error = (raw: string): string => {
  const parsed: HopParse = parseHopCommand(raw);
  if (parsed.kind !== "error") {
    throw new Error(`expected an error, got ${parsed.kind}: ${JSON.stringify(parsed)}`);
  }
  return parsed.text;
};

describe("parseHopCommand: targets", () => {
  test("/move local, keep by default (decision 5)", () => {
    expect(spec("/move local")).toEqual({ target: "local", keep: true });
    expect(spec("  /move   local  ")).toEqual({ target: "local", keep: true });
  });

  test("/move container, with or without an image", () => {
    expect(spec("/move container")).toEqual({ target: "container", keep: true });
    expect(spec("/move container ghcr.io/x/y:1")).toEqual({
      target: "container",
      image: "ghcr.io/x/y:1",
      keep: true,
    });
  });

  test("/move attach names an engine and a workload", () => {
    expect(spec("/move attach docker:box")).toEqual({
      target: "attach",
      workload: { engine: "docker", name: "box" },
      keep: true,
    });
    expect(spec("/move attach podman:box")).toEqual({
      target: "attach",
      workload: { engine: "podman", name: "box" },
      keep: true,
    });
    expect(spec("/move attach kubernetes:web-0/guard")).toEqual({
      target: "attach",
      workload: { engine: "kubernetes", namespace: "web-0", name: "guard" },
      keep: true,
    });
    // OD1's 1/2/3 rule: one segment = the pod (namespace from the OD2 rule), two =
    // `<ns>/<pod>`, three = `<ns>/<pod>/<container>`. The old `pod/container`
    // reading is GONE on purpose (pre-public, owner's decision).
    expect(spec("/move attach kubernetes:web-0")).toEqual({
      target: "attach",
      workload: { engine: "kubernetes", name: "web-0" },
      keep: true,
    });
    expect(spec("/move attach kubernetes:openshift-etcd/etcd-0/etcdctl")).toEqual({
      target: "attach",
      workload: {
        engine: "kubernetes",
        namespace: "openshift-etcd",
        name: "etcd-0",
        container: "etcdctl",
      },
      keep: true,
    });
  });

  test("--rm asks for a delete, --keep says it out loud; both are the keep flag", () => {
    // Mutation: drop the `--rm` branch → the first and third rows fail.
    expect(spec("/move local --rm")).toEqual({ target: "local", keep: false });
    expect(spec("/move local --keep")).toEqual({ target: "local", keep: true });
    expect(spec("/move container img --rm")).toEqual({
      target: "container",
      image: "img",
      keep: false,
    });
    expect(spec("/move attach docker:box --rm")).toEqual({
      target: "attach",
      workload: { engine: "docker", name: "box" },
      keep: false,
    });
  });

  test("/move cancel is its own answer, not a target", () => {
    expect(parseHopCommand("/move cancel")).toEqual({ kind: "cancel" });
    expect(parseHopCommand("/move cancel --rm")).toEqual({ kind: "cancel" });
  });
});

describe("parseHopCommand: refusals (one line, nothing built)", () => {
  test("no argument and an unknown target are the usage", () => {
    expect(error("/move")).toBe(HOP_USAGE);
    expect(error("/move ")).toBe(HOP_USAGE);
    expect(error("/move sideways")).toBe(HOP_USAGE);
  });

  test("a malformed workload is named, never guessed", () => {
    // Mutation: accept a bare name as docker → both rows pass silently.
    expect(error("/move attach box")).toContain("docker:<name>");
    expect(error("/move attach aws:box")).toContain("docker:<name>");
    expect(error("/move attach aws:box/x")).toBe(HOP_ATTACH_USAGE);
    expect(error("/move attach docker:")).toContain("a name");
    expect(error("/move attach kubernetes:web-0/")).toContain("a name");
  });

  test("docker and podman have no /container part; k8s takes at most three segments", () => {
    expect(error("/move attach docker:box/sidecar")).toContain("no container");
    expect(error("/move attach kubernetes:a/b/c/d")).toBe(HOP_USAGE);
  });

  test("extra arguments and unknown flags are refused, not ignored", () => {
    expect(error("/move local --keep --rm")).toBe(HOP_USAGE);
    expect(error("/move local --force")).toBe(HOP_USAGE);
    expect(error("/move container a b")).toBe(HOP_USAGE);
    expect(error("/move local extra")).toBe(HOP_USAGE);
  });

  test("the usage line names every target it accepts, and the k8s namespace form", () => {
    for (const word of ["local", "container", "attach", "cancel"]) {
      expect(HOP_USAGE).toContain(word);
    }
    // No message may still teach `kubernetes:<pod>/<container>` (OD1).
    expect(HOP_USAGE).toContain("kubernetes:<namespace>/<pod>[/<container>]");
  });

  test("a name that is not a plain engine name is refused, not passed on", () => {
    // The SAME validator the proposed tool path uses (finding 2 of the H1
    // review): a ':' or a control byte never reaches a badge or an engine call.
    expect(error("/move attach docker:box:x")).toBe(HOP_NAME_USAGE);
    expect(error("/move attach kubernetes:web-0/app:1")).toBe(HOP_NAME_USAGE);
    expect(error("/move attach docker:b\u001bx")).toBe(HOP_NAME_USAGE);
    expect(error(`/move attach docker:${"a".repeat(HOP_WORKLOAD_PART_MAX + 1)}`)).toBe(
      HOP_NAME_USAGE,
    );
  });
});

describe("hopWorkload: the ONE validator both paths share", () => {
  test("docker and podman have no container part; a k8s pod takes exactly one", () => {
    expect(hopWorkload("docker", "box", "x")).toEqual({ kind: "bad", problem: "container" });
    expect(hopWorkload("podman", "box", "x")).toEqual({ kind: "bad", problem: "container" });
    expect(hopWorkload("kubernetes", "web-0", "app")).toEqual({
      kind: "ok",
      workload: { engine: "kubernetes", name: "web-0", container: "app" },
    });
    expect(hopWorkload("kubernetes", "web-0", "app", "ns1")).toEqual({
      kind: "ok",
      workload: { engine: "kubernetes", namespace: "ns1", name: "web-0", container: "app" },
    });
    // OD1/OD2: a namespace belongs to kubernetes alone, and is a DNS-1123 LABEL
    // (a pod name may hold '.', a namespace may not).
    expect(hopWorkload("docker", "box", undefined, "ns1")).toEqual({
      kind: "bad",
      problem: "namespace",
    });
    expect(hopWorkload("podman", "box", undefined, "ns1")).toEqual({
      kind: "bad",
      problem: "namespace",
    });
    expect(hopWorkload("kubernetes", "web-0", undefined, "Bad_NS")).toEqual({
      kind: "bad",
      problem: "namespaceChars",
    });
    expect(hopWorkload("kubernetes", "web-0", undefined, "a".repeat(64))).toEqual({
      kind: "bad",
      problem: "namespaceChars",
    });
    expect(hopWorkload("kubernetes", "web-0", undefined, "a".repeat(63)).kind).toBe("ok");
    expect(hopWorkload("kubernetes", "web-0", undefined, "")).toEqual({
      kind: "bad",
      problem: "namespaceChars",
    });
    expect(hopWorkload("kubernetes", "web-0", undefined, "ns-1.2")).toEqual({
      kind: "bad",
      problem: "namespaceChars",
    });
  });

  test("an unknown engine, an empty part and a stray character are all bad", () => {
    expect(hopWorkload("aws", "box")).toEqual({ kind: "bad", problem: "engine" });
    expect(hopWorkload("docker", "")).toEqual({ kind: "bad", problem: "name" });
    expect(hopWorkload("kubernetes", "web-0", "")).toEqual({
      kind: "bad",
      problem: "containerName",
    });
    expect(hopWorkload("docker", "bo:x")).toEqual({ kind: "bad", problem: "chars" });
    expect(hopWorkload("kubernetes", "we b")).toEqual({ kind: "bad", problem: "chars" });
    expect(hopWorkload("docker", "-box")).toEqual({ kind: "bad", problem: "chars" });
  });

  test("a plain name resolves, with keep left to the caller", () => {
    expect(hopWorkload("docker", "box")).toEqual({
      kind: "ok",
      workload: { engine: "docker", name: "box" },
    });
    expect(hopWorkload("docker", "box.v2_x-1")).toEqual({
      kind: "ok",
      workload: { engine: "docker", name: "box.v2_x-1" },
    });
  });
});

// OD1: ONE label function, so the prompt, the live row, the outcome, the wake-up
// line and the badge cannot print a workload differently — and so a k8s pod is
// NEVER printed as `kubernetes:<pod>/<container>`, which now reads as ns/pod.
describe("workloadText", () => {
  test("docker/podman: engine:name", () => {
    expect(workloadText({ engine: "docker", name: "box" })).toBe("docker:box");
    expect(workloadText({ engine: "podman", name: "box" })).toBe("podman:box");
  });

  test("kubernetes: ns/pod[/container] once the namespace is known, pod[/c] before", () => {
    expect(workloadText({ engine: "kubernetes", name: "web-0" })).toBe("kubernetes:web-0");
    expect(workloadText({ engine: "kubernetes", namespace: "ns1", name: "web-0" })).toBe(
      "kubernetes:ns1/web-0",
    );
    expect(
      workloadText({ engine: "kubernetes", namespace: "ns1", name: "web-0", container: "app" }),
    ).toBe("kubernetes:ns1/web-0/app");
    // Before the namespace is pinned, the container is the only `/part`: shown,
    // never hidden (a hop's row says what was asked for).
    expect(workloadText({ engine: "kubernetes", name: "web-0", container: "app" })).toBe(
      "kubernetes:web-0/app",
    );
  });

  test("a pod-supplied name is one line and control/bidi-clean (AGENTS §7)", () => {
    const hostile: HopWorkload = { engine: "kubernetes", namespace: "ns1", name: "web\u001b0" };
    expect(workloadText(hostile)).toBe("kubernetes:ns1/web 0");
  });
});
