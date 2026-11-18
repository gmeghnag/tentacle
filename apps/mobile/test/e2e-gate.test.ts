/**
 * The e2e gate's pure decisions (docs/feat/mobile-e2e-gate.md): tags and their
 * reasons, the one retry, the verdict and the summary — and, over the REAL flow
 * files, that every tag a flow carries has its reason and its TODO line.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type FlowMeta,
  type FlowResult,
  finalStatus,
  flowMetaErrors,
  majorOfDevice,
  parseFlowMeta,
  shouldRetry,
  summaryText,
  verdictOf,
} from "../e2e/gate.ts";
import { hookFor } from "../e2e/hooks.ts";
import { FLOWS, flowMetas, parseArgs } from "../e2e/run.ts";

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
