import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineHost } from "../src/engine-host.ts";
import { armExitNet, armSharedExitNet } from "../src/engine-runtime.ts";
import { attachCommand, resolveRm } from "../src/engine-select.ts";
import { ARGS, USAGE, parseArgs } from "../src/flags.ts";
import { attachers, laptopProc, writePresence } from "../src/run-state.ts";

describe("L22 armExitNet (docs/feat/detached-relay-lifecycle.md)", () => {
  const armed = (before: readonly unknown[]) =>
    process.listeners("exit").filter((l) => !before.includes(l));
  const hostOf = (removed: string[]) =>
    ({ removeBestEffort: (name: string) => removed.push(name) }) as unknown as EngineHost;

  test("an exit fires `removeBestEffort` once", () => {
    const before = process.listeners("exit");
    const removed: string[] = [];
    const disarm = armExitNet(hostOf(removed), "box", () => true);
    const [listener, ...rest] = armed(before);
    expect(rest).toEqual([]);
    listener?.(0);
    expect(removed).toEqual(["box"]);
    disarm();
    expect(armed(before)).toEqual([]);
  });

  test("disarm removes the listener: a normal exit deletes nothing", () => {
    // Mutation: a no-op disarm → the relay's own exit fires a second, unverified delete.
    const before = process.listeners("exit");
    const removed: string[] = [];
    armExitNet(hostOf(removed), "box", () => true)();
    expect(armed(before)).toEqual([]);
    expect(removed).toEqual([]);
  });

  test("R6 (D4): not confirmed saved, or it cannot be told: the exit keeps the workload", () => {
    // Mutation: fire without asking `saved` → a relay's second SIGTERM mid-turn deletes the only copy.
    const before = process.listeners("exit");
    const removed: string[] = [];
    let saved = false;
    let kept = 0;
    const disarm = armExitNet(
      hostOf(removed),
      "box",
      () => saved,
      () => {
        kept += 1;
      },
    );
    const [listener] = armed(before);
    listener?.(130);
    expect(removed).toEqual([]);
    expect(kept).toBe(1); // said in the record
    disarm();
    armExitNet(hostOf(removed), "box", () => {
      throw new Error("unreadable");
    });
    armed(before)[0]?.(1);
    expect(removed).toEqual([]);
    for (const l of armed(before)) process.off("exit", l as () => void);
    saved = true;
    armExitNet(
      hostOf(removed),
      "box",
      () => saved,
      () => {
        throw new Error("never asked");
      },
    );
    armed(before)[0]?.(130);
    expect(removed).toEqual(["box"]);
    for (const l of armed(before)) process.off("exit", l as () => void);
  });
});

describe("H16 armSharedExitNet (docs/feat/detached-handover.md)", () => {
  const armed = (before: readonly unknown[]) =>
    process.listeners("exit").filter((l) => !before.includes(l));
  const hostOf = (removed: string[]) =>
    ({ removeBestEffort: (name: string) => removed.push(name) }) as unknown as EngineHost;

  test("fires only with no other TUI of the run alive (a real child as the other); disarm works", async () => {
    // Mutation: fire unconditionally → one TUI's crash deletes the workload under another.
    const dir = mkdtempSync(join(tmpdir(), "shared-net-"));
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const pid = child.pid ?? 0;
    // Its start time as `laptopProc` reads it, once `ps` sees it.
    while (laptopProc(pid) === undefined) await new Promise((r) => setTimeout(r, 5));
    writePresence(dir, pid, laptopProc);
    const others = () => attachers(dir, laptopProc).some((a) => a.pid !== process.pid);
    const before = process.listeners("exit");
    const removed: string[] = [];
    const disarm = armSharedExitNet(hostOf(removed), "box", others, () => true);
    const [listener, ...rest] = armed(before);
    expect(rest).toEqual([]);
    listener?.(0);
    expect(removed).toEqual([]); // the other TUI lives
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await exited;
    listener?.(0);
    expect(removed).toEqual(["box"]); // the last one, its save confirmed
    disarm();
    expect(armed(before)).toEqual([]);
  });

  test("R6 (D4): the last TUI's SIGTERM / SIGHUP / crash, not confirmed saved: the workload stays", () => {
    // Mutation: drop the `saved` check → the last TUI's crash mid-turn deletes the only copy.
    const before = process.listeners("exit");
    const removed: string[] = [];
    let kept = 0;
    let others = true;
    const disarm = armSharedExitNet(
      hostOf(removed),
      "box",
      () => others,
      () => false,
      () => {
        kept += 1;
      },
    );
    armed(before)[0]?.(143);
    expect(kept).toBe(0); // not the last: its record is the others'
    others = false;
    armed(before)[0]?.(143);
    expect(removed).toEqual([]);
    expect(kept).toBe(1);
    disarm();
    armSharedExitNet(
      hostOf(removed),
      "box",
      () => false,
      () => {
        throw new Error("unreadable");
      },
    );
    armed(before)[0]?.(1);
    expect(removed).toEqual([]);
    for (const l of armed(before)) process.off("exit", l as () => void);
  });
});

// `run --rm[=bool]` (fix/run-rm-flag; was `--keep`, docs/feat/docker-engine-cli.md).
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

describe("resolveRm: flag > profile > user config > false (fix/run-rm-flag)", () => {
  test("bare --rm, --rm=true and --rm=false (which beats a configured true)", () => {
    expect(resolveRm({ bare: true, configured: false })).toEqual({ ok: true, rm: true });
    expect(resolveRm({ value: "true", configured: false })).toEqual({ ok: true, rm: true });
    expect(resolveRm({ value: "false", configured: true })).toEqual({ ok: true, rm: false });
  });

  test("no flag: the configured value, else false (the workload is kept)", () => {
    expect(resolveRm({ configured: true })).toEqual({ ok: true, rm: true });
    expect(resolveRm({ configured: false })).toEqual({ ok: true, rm: false });
    expect(resolveRm({})).toEqual({ ok: true, rm: false });
  });

  test("any other --rm value is a loud error naming the value", () => {
    expect(resolveRm({ value: "yes" })).toEqual({
      ok: false,
      error: '--rm takes true or false, got "yes"',
    });
  });
});

describe("parseArgs: run --rm takes an optional value (=v or the next word true/false)", () => {
  const parse = (...args: string[]) => parseArgs(args, ARGS.run);
  test("--rm true / --rm false (space form) is the value, not the name", () => {
    const on = parse("--image", "x", "--rm", "true");
    expect(on.ok && on.flags.get("rm")).toBe("true");
    expect(on.ok && on.positional).toEqual([]);
    const off = parse("--rm", "false", "--image", "x", "myname");
    expect(off.ok && off.flags.get("rm")).toBe("false");
    expect(off.ok && off.positional).toEqual(["myname"]);
  });
  test("any other next word stays positional: --rm myname, myname --rm", () => {
    const a = parse("--image", "x", "--rm", "myname");
    expect(a.ok && a.bools.has("rm")).toBe(true);
    expect(a.ok && a.positional).toEqual(["myname"]);
    const b = parse("--image", "x", "myname", "--rm");
    expect(b.ok && b.bools.has("rm")).toBe(true);
    expect(b.ok && b.positional).toEqual(["myname"]);
  });
  test("=true, =false", () => {
    const off = parse("--image", "x", "--rm=false");
    expect(off.ok && off.flags.get("rm")).toBe("false");
    const on = parse("--image", "x", "--rm=true");
    expect(on.ok && on.flags.get("rm")).toBe("true");
  });
  test("--rm twice is the usual repeated-flag error", () => {
    const r = parse("--image", "x", "--rm", "--rm=false");
    expect(r.ok).toBe(false);
  });
  test("--keep is gone: a plain unknown option, no hint (owner answer 1)", () => {
    expect(parse("--image", "x", "--keep")).toEqual({ ok: false, error: "unknown option --keep" });
    expect(parse("--image", "x", "--keep=false")).toEqual({
      ok: false,
      error: "unknown option --keep",
    });
  });
  test("attach has neither --rm nor -d", () => {
    expect(parseArgs(["--rm", "p"], ARGS.attach).ok).toBe(false);
    expect(parseArgs(["-d", "p"], ARGS.attach).ok).toBe(false);
  });
});

test("USAGE.run names --rm and -d, never --keep", () => {
  expect(USAGE.run).toContain("[--rm[=true|false]]");
  expect(USAGE.run).toContain("[-d|--detach]");
  expect(USAGE.run).not.toContain("--keep");
});

describe("parseArgs: -d is run's short --detach", () => {
  const parse = (...args: string[]) => parseArgs(args, ARGS.run);
  test("-d ≡ --detach; the prompt stays positional", () => {
    const r = parse("-d", "hi", "--image", "x");
    expect(r.ok && r.bools.has("detach")).toBe(true);
    expect(r.ok && r.positional).toEqual(["hi"]);
  });
  test("-d with --detach is given twice; -d=1 takes no value", () => {
    const twice = parse("-d", "--detach", "--image", "x");
    expect(twice.ok ? "ok" : twice.error).toContain("--detach given more than once");
    const valued = parse("-d=1", "--image", "x");
    expect(valued.ok ? "ok" : valued.error).toContain("takes no value");
  });
});
