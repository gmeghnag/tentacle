import { describe, expect, test } from "bun:test";
import { HOP_USAGE, type HopParse, type HopSpec, parseHopCommand } from "../src/hop-command.ts";

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
      workload: { engine: "kubernetes", name: "web-0", container: "guard" },
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
    expect(error("/move attach docker:")).toContain("a name");
    expect(error("/move attach kubernetes:web-0/")).toContain("a name");
  });

  test("docker and podman have no /container part; k8s allows at most one", () => {
    expect(error("/move attach docker:box/sidecar")).toContain("no container");
    expect(error("/move attach kubernetes:a/b/c")).toContain("one /container");
  });

  test("extra arguments and unknown flags are refused, not ignored", () => {
    expect(error("/move local --keep --rm")).toBe(HOP_USAGE);
    expect(error("/move local --force")).toBe(HOP_USAGE);
    expect(error("/move container a b")).toBe(HOP_USAGE);
    expect(error("/move local extra")).toBe(HOP_USAGE);
  });

  test("the usage line names every target it accepts", () => {
    for (const word of ["local", "container", "attach", "cancel"]) {
      expect(HOP_USAGE).toContain(word);
    }
  });
});
