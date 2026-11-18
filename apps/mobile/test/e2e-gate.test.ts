/**
 * The e2e gate's pure decisions (docs/feat/mobile-e2e-gate.md): tags and their
 * reasons, the one retry, the verdict and the summary — and, over the REAL flow
 * files, that every tag a flow carries has its reason and its TODO line.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FlowMeta,
  type FlowResult,
  deviceChoice,
  finalStatus,
  flowMetaErrors,
  majorOfDevice,
  parseFlowMeta,
  shouldRetry,
  summaryText,
  verdictOf,
} from "../e2e/gate.ts";
import { hookFor } from "../e2e/hooks.ts";
import { FLOWS, flowMetas, killFlowTree, parseArgs, runAttempt } from "../e2e/run.ts";

const flow = (header: string) => `appId: so.tentacle.app\n${header}---\n- tapOn: "x"\n`;

describe("parseFlowMeta", () => {
  test("reads a block tags list and each tag's reason from the header", () => {
    const meta = parseFlowMeta(
      "f",
      flow("tags:\n  - flaky\n  - smoke\n# flaky: the picker races the keyboard\n"),
    );
    expect(meta.tags).toEqual(["flaky"]);
    expect(meta.otherTags).toEqual(["smoke"]);
    expect(meta.reasons.flaky).toBe("the picker races the keyboard");
  });

  test("reads an inline list", () => {
    expect(parseFlowMeta("f", flow("tags: [known-bug, 'x']\n")).tags).toEqual(["known-bug"]);
  });

  test("ignores everything after the header: a body comment is not a tag reason", () => {
    const meta = parseFlowMeta("f", `${flow("")}# quarantine: not a header line\n`);
    expect(meta.tags).toEqual([]);
    expect(meta.reasons).toEqual({});
  });

  test("a flow with no header has no tags", () => {
    expect(parseFlowMeta("f", "- tapOn: x\n").tags).toEqual([]);
  });
});

describe("flowMetaErrors", () => {
  test("a tag without its reason is an error", () => {
    expect(flowMetaErrors(parseFlowMeta("f", flow("tags:\n  - known-bug\n")))).toEqual([
      "f: tag `known-bug` has no `# known-bug: <reason>` line",
    ]);
  });

  test("a reason without its tag is an error (it would silently not apply)", () => {
    expect(flowMetaErrors(parseFlowMeta("f", flow("# flaky: maybe\n")))).toHaveLength(1);
  });

  test("quarantine excludes every other tag", () => {
    const meta = parseFlowMeta(
      "f",
      flow("tags:\n  - quarantine\n  - flaky\n# quarantine: a\n# flaky: b\n"),
    );
    expect(flowMetaErrors(meta)).toEqual(["f: `quarantine` is not run, so no other tag can apply"]);
  });

  test("a well-formed header has none", () => {
    expect(flowMetaErrors(parseFlowMeta("f", flow("tags:\n  - flaky\n# flaky: r\n")))).toEqual([]);
  });
});

const meta = (tags: FlowMeta["tags"]): FlowMeta => ({
  name: "f",
  tags,
  reasons: {},
  otherTags: [],
});

describe("shouldRetry: one retry, flaky only", () => {
  test("a red flaky flow is retried once", () => {
    expect(shouldRetry(meta(["flaky"]), ["fail"])).toBe(true);
    expect(shouldRetry(meta(["flaky"]), ["timeout"])).toBe(true);
  });
  test("never twice", () => {
    expect(shouldRetry(meta(["flaky"]), ["fail", "fail"])).toBe(false);
  });
  test("a green one is not retried", () => {
    expect(shouldRetry(meta(["flaky"]), ["pass"])).toBe(false);
  });
  test("an untagged or known-bug red flow is NOT retried", () => {
    expect(shouldRetry(meta([]), ["fail"])).toBe(false);
    expect(shouldRetry(meta(["known-bug"]), ["fail"])).toBe(false);
  });
  test("the last attempt decides", () => {
    expect(finalStatus(["fail", "pass"])).toBe("pass");
    expect(finalStatus(["pass"])).toBe("pass");
    expect(finalStatus([])).toBe("fail");
  });
});

const result = (
  name: string,
  status: FlowResult["status"],
  tags: FlowResult["tags"] = [],
  attempts = 1,
): FlowResult => ({ name, status, seconds: 10, attempts, tags, outDir: `/runs/${name}` });

describe("verdictOf", () => {
  test("all green, known bugs red and quarantine skipped → exit 0", () => {
    const v = verdictOf([
      result("a", "pass"),
      result("b", "fail", ["known-bug"]),
      result("c", "quarantined", ["quarantine"], 0),
    ]);
    expect(v.exitCode).toBe(0);
    expect(v.knownBugs.map((r) => r.name)).toEqual(["b"]);
    expect(v.quarantined.map((r) => r.name)).toEqual(["c"]);
  });

  test("one counted red (fail or timeout) → exit 1", () => {
    expect(verdictOf([result("a", "pass"), result("b", "fail")]).exitCode).toBe(1);
    expect(verdictOf([result("b", "timeout")]).exitCode).toBe(1);
    expect(verdictOf([result("b", "fail", ["flaky"], 2)]).exitCode).toBe(1);
  });

  test("a known-bug that passes is reported as fixed, not counted", () => {
    const v = verdictOf([result("b", "pass", ["known-bug"])]);
    expect(v.knownBugsFixed.map((r) => r.name)).toEqual(["b"]);
    expect(v.passed).toEqual([]);
  });

  test("a flaky flow green on its retry is listed as retried", () => {
    const v = verdictOf([result("a", "pass", ["flaky"], 2)]);
    expect(v.exitCode).toBe(0);
    expect(v.retried.map((r) => r.name)).toEqual(["a"]);
  });

  test("an empty run is green (nothing selected), never a crash", () => {
    expect(verdictOf([]).exitCode).toBe(0);
  });
});

describe("summaryText", () => {
  const metas = new Map<string, FlowMeta>([
    [
      "k",
      { name: "k", tags: ["known-bug"], reasons: { "known-bug": "New session" }, otherTags: [] },
    ],
    [
      "q",
      { name: "q", tags: ["quarantine"], reasons: { quarantine: "flow defect" }, otherTags: [] },
    ],
    ["f", { name: "f", tags: ["flaky"], reasons: { flaky: "race" }, otherTags: [] }],
  ]);
  const text = summaryText(
    [
      result("ok", "pass"),
      result("bad", "fail"),
      result("k", "fail", ["known-bug"]),
      result("q", "quarantined", ["quarantine"], 0),
      result("f", "pass", ["flaky"], 2),
    ],
    metas,
  );

  test("one table row per flow, with status and seconds", () => {
    expect(text).toMatch(/^flow\s+result\s+seconds\s+tries$/m);
    expect(text).toMatch(/^ok\s+PASS\s+10\s+1$/m);
    expect(text).toMatch(/^bad\s+FAIL\s+10\s+1$/m);
    expect(text).toMatch(/^k\s+FAIL \(known-bug\)\s+10\s+1$/m);
    expect(text).toMatch(/^q\s+QUARANTINED\s+-\s+-$/m);
  });

  test("the verdict line counts each class", () => {
    expect(text).toContain(
      "GATE FAIL — 2 passed, 1 failed, 1 known-bug, 1 quarantined (of 5; 40 s)",
    );
  });

  test("lists the red flows' output dirs and every tagged flow with its reason", () => {
    expect(text).toContain("  bad — /runs/bad");
    expect(text).toContain("  k — New session");
    expect(text).toContain("  q — flow defect");
    expect(text).toContain("  f — passed on retry — race");
  });
});

describe("majorOfDevice", () => {
  const json = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{ udid: "A", isAvailable: true }],
      "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [
        { udid: "B", isAvailable: true },
        { udid: "C", isAvailable: false },
      ],
    },
  });
  test("names the runtime major of the given simulator", () => {
    expect(majorOfDevice(json, "A")).toBe(26);
    expect(majorOfDevice(json, "B")).toBe(18);
  });
  test("an unknown or unavailable udid is undefined — never another device", () => {
    expect(majorOfDevice(json, "C")).toBeUndefined();
    expect(majorOfDevice(json, "Z")).toBeUndefined();
    expect(majorOfDevice("not json", "A")).toBeUndefined();
  });
});

describe("deviceChoice: a UDID is validated with --ios too (review round 1 F2)", () => {
  const json = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{ udid: "A", isAvailable: true }],
      "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [{ udid: "B", isAvailable: true }],
      "com.apple.CoreSimulator.SimRuntime.iOS-17-2": [{ udid: "OLD", isAvailable: true }],
    },
  });

  test("no udid: the majors the run covers (--ios narrows)", () => {
    expect(deviceChoice(json, undefined, undefined)).toEqual({ kind: "majors", only: undefined });
    expect(deviceChoice(json, undefined, 26)).toEqual({ kind: "majors", only: 26 });
  });

  test("a udid alone names its major", () => {
    expect(deviceChoice(json, "B", undefined)).toEqual({ kind: "device", udid: "B", major: 18 });
  });

  test("--ios N --udid X: X is checked against N, not merely accepted", () => {
    // Same major: fine.
    expect(deviceChoice(json, "A", 26)).toEqual({ kind: "device", udid: "A", major: 26 });
    // A real 18 device asked for as 26: refused, never driven as 26.
    expect(deviceChoice(json, "B", 26)).toMatchObject({ kind: "unknown" });
    // A typo, an unavailable-elsewhere udid, a device of a major the gate does not run.
    expect(deviceChoice(json, "nope", 26)).toMatchObject({ kind: "unknown" });
    expect(deviceChoice(json, "OLD", undefined)).toMatchObject({ kind: "unknown" });
  });

  test("the refusal names the simulator and the accepted majors", () => {
    const choice = deviceChoice(json, "nope", 26);
    expect(choice.kind === "unknown" ? choice.message : "").toBe(
      "e2e:mobile: simulator nope is not an available iOS 18/26 device (simctl list devices)",
    );
    // A real device of the OTHER major says so instead of being driven as 26.
    const mismatched = deviceChoice(json, "B", 26);
    expect(mismatched.kind === "unknown" ? mismatched.message : "").toBe(
      "e2e:mobile: simulator B is an iOS 18 device, not the iOS 26 this run was told (--ios)",
    );
  });
});

describe("run.ts arguments", () => {
  test("--app and --flow-timeout", () => {
    expect(parseArgs(["--app", "/x/tentacle.app", "--flow-timeout", "90"])).toEqual({
      app: "/x/tentacle.app",
      flowTimeoutS: 90,
    });
    expect(() => parseArgs(["--app"])).toThrow();
    expect(() => parseArgs(["--flow-timeout", "0"])).toThrow();
  });
});

describe("the real flows' gate tags", () => {
  const metas = flowMetas(FLOWS);
  const todo = readFileSync(join(import.meta.dir, "..", "..", "..", "TODO.md"), "utf8");

  test("every tag has its reason (the harness refuses to start otherwise)", () => {
    expect([...metas.values()].flatMap(flowMetaErrors)).toEqual([]);
  });

  test("every quarantined or known-bug flow has a TODO.md line naming it", () => {
    for (const m of metas.values()) {
      if (m.tags.includes("quarantine") || m.tags.includes("known-bug")) {
        const listed = todo.includes(`e2e flow \`${m.name}\``);
        expect({ flow: m.name, listed }).toEqual({ flow: m.name, listed: true });
      }
    }
  });
});

describe("runAttempt: a timeout kills the whole attempt tree (review round 1 F3)", () => {
  // Maestro is a launcher: it starts a JVM, which starts the XCTest driver. A
  // leader-only SIGKILL orphans both, and an orphaned driver holds the
  // simulator's driver port — the very hang the timeout exists to bound. So the
  // attempt runs in its OWN process group and the timeout kills the GROUP.
  const markers: string[] = [];
  const alive = (m: string) =>
    Bun.spawnSync(["pgrep", "-f", `sleep ${m}`])
      .stdout.toString()
      .trim()
      .split("\n")
      .filter(Boolean);

  afterEach(() => {
    for (const m of markers.splice(0)) {
      Bun.spawnSync(["pkill", "-9", "-f", `sleep ${m}`]);
    }
  });

  test("nothing of the attempt outlives the timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2e-attempt-"));
    const m = `9${Math.floor(Math.random() * 900000 + 100000)}`;
    markers.push(m);
    // sh = Maestro's launcher, the two sleeps = its JVM and the driver's own child.
    const { code, timedOut } = await runAttempt(["sh", "-c", `sleep ${m} & sleep ${m}`], {
      cwd: dir,
      env: {},
      stdoutPath: join(dir, "out.log"),
      stderrPath: join(dir, "err.log"),
      timeoutMs: 400,
    });
    // 128 + SIGKILL: the leader was killed, not left to run.
    expect({ code, timedOut }).toEqual({ code: 137, timedOut: true });
    // The leader is dead either way; the QUESTION is its children.
    await Bun.sleep(300);
    expect(alive(m)).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  test("an attempt that ends in time keeps its own exit code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2e-attempt-"));
    const result = await runAttempt(["sh", "-c", "exit 3"], {
      cwd: dir,
      env: {},
      stdoutPath: join(dir, "out.log"),
      stderrPath: join(dir, "err.log"),
      timeoutMs: 5000,
    });
    expect(result).toEqual({ code: 3, timedOut: false });
    await rm(dir, { recursive: true, force: true });
  });

  test("killFlowTree never signals pid ≤ 1 or its own process", () => {
    // Never a `kill(-0)` (our own group) or `kill(-1)` (every process we own).
    expect(killFlowTree(undefined)).toBe(false);
    expect(killFlowTree(1)).toBe(false);
    expect(killFlowTree(process.pid)).toBe(false);
  });
});

describe("the hook server routes every hook it declares (the first gate run)", () => {
  // `14-returned-mine` / `15-returned-other` died on `404 unknown hook`: the
  // handlers for `queue-state`, `laptop-enqueue`, `laptop-cancel` existed but
  // `hookFor` never routed their paths.
  const source = readFileSync(join(import.meta.dir, "..", "e2e", "hooks.ts"), "utf8");
  const union = /export type HookName =([\s\S]*?);/.exec(source)?.[1] ?? "";
  const names = [...union.matchAll(/\|\s*"([a-z0-9-]+)"/g)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );

  test("the union is read (non-vacuous)", () => {
    expect(names).toContain("laptop-prompt");
    expect(names.length).toBeGreaterThan(20);
  });

  test("hookFor answers each declared name", () => {
    for (const name of names) {
      const routed: string | undefined = hookFor(`/${name}`);
      expect({ name, routed }).toEqual({ name, routed: name });
    }
  });
});
