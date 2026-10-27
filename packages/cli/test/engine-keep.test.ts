import { describe, expect, test } from "bun:test";
import { attachCommand, resolveKeep } from "../src/engine-select.ts";
import { ARGS, parseArgs } from "../src/flags.ts";

// `run --keep[=bool]` (docs/feat/docker-engine-cli.md, owner 2026-10-27).
describe("attachCommand carries every flag needed to reconnect", () => {
  test("--insecure-docker-tcp is repeated when the run needed it", () => {
    expect(attachCommand("docker", "c1", { insecureTcp: true })).toBe(
      "tentacle attach --engine docker --insecure-docker-tcp c1",
    );
    expect(attachCommand("podman", "c1", { context: "r", insecureTcp: true })).toBe(
      "tentacle attach --engine podman --context r --insecure-docker-tcp c1",
    );
    expect(attachCommand("docker", "c1", { insecureTcp: false })).toBe(
      "tentacle attach --engine docker c1",
    );
  });

  test("--bin-dir is repeated when the run had one", () => {
    expect(attachCommand("docker", "c1", { binDir: "/tmp" })).toBe(
      "tentacle attach --engine docker --bin-dir /tmp c1",
    );
    expect(attachCommand("kubernetes", "p1", { namespace: "dev", binDir: "/tmp" })).toBe(
      "tentacle attach --engine kubernetes -n dev --bin-dir /tmp p1",
    );
  });
});

describe("resolveKeep: flag > profile > user config > true", () => {
  test("bare --keep, --keep=true and --keep=false", () => {
    expect(resolveKeep({ bare: true, configured: false })).toEqual({ ok: true, keep: true });
    expect(resolveKeep({ value: "true", configured: false })).toEqual({ ok: true, keep: true });
    expect(resolveKeep({ value: "false", configured: true })).toEqual({ ok: true, keep: false });
  });

  test("no flag: the configured value, else true", () => {
    expect(resolveKeep({ configured: true })).toEqual({ ok: true, keep: true });
    expect(resolveKeep({ configured: false })).toEqual({ ok: true, keep: false });
    expect(resolveKeep({})).toEqual({ ok: true, keep: true });
  });

  test("any other --keep value is a loud error naming the value", () => {
    expect(resolveKeep({ value: "yes" })).toEqual({
      ok: false,
      error: '--keep takes true or false, got "yes"',
    });
  });
});

describe("parseArgs: run --keep takes an optional value (=v or the next word true/false)", () => {
  const parse = (...args: string[]) => parseArgs(args, ARGS.run);
  test("--keep true / --keep false (space form) is the value, not the name", () => {
    const on = parse("--image", "x", "--keep", "true");
    expect(on.ok && on.flags.get("keep")).toBe("true");
    expect(on.ok && on.positional).toEqual([]);
    const off = parse("--keep", "false", "--image", "x", "myname");
    expect(off.ok && off.flags.get("keep")).toBe("false");
    expect(off.ok && off.positional).toEqual(["myname"]);
  });
  test("any other next word stays positional: --keep myname, myname --keep", () => {
    const a = parse("--image", "x", "--keep", "myname");
    expect(a.ok && a.bools.has("keep")).toBe(true);
    expect(a.ok && a.positional).toEqual(["myname"]);
    const b = parse("--image", "x", "myname", "--keep");
    expect(b.ok && b.bools.has("keep")).toBe(true);
    expect(b.ok && b.positional).toEqual(["myname"]);
  });
  test("bare, =true, =false; the following word stays positional", () => {
    const bare = parse("--image", "x", "--keep", "box");
    expect(bare.ok && bare.bools.has("keep")).toBe(true);
    expect(bare.ok && bare.positional).toEqual(["box"]);
    const off = parse("--image", "x", "--keep=false");
    expect(off.ok && off.flags.get("keep")).toBe("false");
    const on = parse("--image", "x", "--keep=true");
    expect(on.ok && on.flags.get("keep")).toBe("true");
  });
  test("attach has no --keep", () => {
    expect(parseArgs(["--keep", "p"], ARGS.attach).ok).toBe(false);
  });
});
