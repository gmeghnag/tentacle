/**
 * Flow guards (docs/feat/mobile-app-shell.md "Tests"; AGENTS §9): an e2e flow
 * whose last assertion is on a container that is on screen in EVERY state
 * proves nothing. Review round 1 finding 2 was exactly that — flow 05 "checked"
 * a recovery by asserting `sessions-list` (the ScrollView), so it passed while
 * the list still said "Reconnecting…".
 *
 * A line scan, not a YAML parse: the flows are flat and the guard only needs
 * the assertion ids and where a `runScript` sits among them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FLOWS = join(import.meta.dir, "..", "e2e", "flows");

/** One assertion line: `- assertVisible:` / `- assertNotVisible:` + its id. */
interface Assertion {
  readonly kind: "assertVisible" | "assertNotVisible";
  readonly id: string;
  /** The `file:` of the `runScript` before it, if any (the step it follows). */
  readonly afterScript?: string;
}

function assertions(flow: string): readonly Assertion[] {
  const out: Assertion[] = [];
  let lastScript: string | undefined;
  let pending: Assertion["kind"] | undefined;
  for (const raw of flow.split("\n")) {
    const line = raw.trim();
    const kind = /^- (assertVisible|assertNotVisible):$/.exec(line)?.[1];
    if (kind !== undefined) {
      pending = kind as Assertion["kind"];
      continue;
    }
    const script = /^file: "(.+)"$/.exec(line)?.[1];
    if (script !== undefined) {
      lastScript = script;
      pending = undefined;
      continue;
    }
    const id = /^id: "(.+)"$/.exec(line)?.[1];
    if (id !== undefined && pending !== undefined) {
      out.push({
        kind: pending,
        id,
        ...(lastScript === undefined ? {} : { afterScript: lastScript }),
      });
      pending = undefined;
    }
    if (line !== "" && !line.startsWith("#") && !line.startsWith("- ")) {
      pending = undefined;
    }
  }
  return out;
}

function readFlow(name: string): readonly Assertion[] {
  return assertions(readFileSync(join(FLOWS, `${name}.yaml`), "utf8"));
}

describe("flow 05: the daemon-down recovery is actually asserted", () => {
  const flow = readFlow("05-daemon-down");
  const afterRestart = flow.filter((a) => a.afterScript === "05-start-serve.js");

  test("it asserts a seeded session row again, not just the ScrollView", () => {
    // `sessions-list` is on screen in every state: asserting it alone is vacuous.
    expect(afterRestart.some((a) => a.id.startsWith("session-"))).toBe(true);
  });

  test("it asserts the stale notice is GONE (a successful page clears it)", () => {
    expect(
      afterRestart.some((a) => a.kind === "assertNotVisible" && a.id === "sessions-stale"),
    ).toBe(true);
  });

  test("its last assertion is not the always-visible container", () => {
    const last = flow[flow.length - 1];
    expect(last?.id).not.toBe("sessions-list");
  });
});

describe("every flow asserts something narrower than the list container", () => {
  test("no flow's only assertion is `sessions-list`", () => {
    for (const name of [
      "01-shell",
      "02-session-list",
      "03-refresh",
      "04-session-placeholder",
      "05-daemon-down",
    ]) {
      const ids = new Set(readFlow(name).map((a) => a.id));
      expect(ids.size).toBeGreaterThan(1);
    }
  });
});
