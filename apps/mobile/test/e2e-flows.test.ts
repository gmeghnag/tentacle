/**
 * Flow guards (docs/feat/mobile-app-shell.md "Tests", extended by
 * docs/feat/mobile-session-view.md 12c; AGENTS §9): an e2e flow whose last
 * assertion is on a container that is on screen in EVERY state proves nothing.
 * Review round 1 finding 2 was exactly that — flow 05 "checked" a recovery by
 * asserting `sessions-list` (the ScrollView), so it passed while the list still
 * said "Reconnecting…".
 *
 * 12c adds the other half of the rule: every NEW flow must end on DAEMON truth
 * (a `runScript` whose body throws unless a hook says so), because RN's new
 * architecture exposes no text to XCUITest (plan P9) — an id on screen can only
 * say what the app DREW, never what the daemon DID.
 *
 * A line scan, not a YAML parse: the flows are flat and the guard only needs the
 * assertion ids, where a `runScript` sits among them, and what each script asserts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FLOWS } from "../e2e/run.ts";

const FLOWS_DIR = join(import.meta.dir, "..", "e2e", "flows");

/** The flows this task owns (11a's are checked for the weaker rule only). */
const NEW_FLOWS = [
  "06-session-open",
  "07-prompt",
  "08-permission",
  "08b-permission-deny",
  "08c-permission-reply",
  "09-foreign-turn",
  "10-background-ask",
  "11-disconnect-mid-turn",
] as const;

/** 13d's compose flows: the same daemon-truth rule, plus their own list. */
const COMPOSE_FLOWS = [
  "12-steer",
  "13-send-now",
  "14-returned-mine",
  "15-returned-other",
  "16-offline-outbox",
  "17-outbox-changed",
  "18-photos",
] as const;

/** The flows 11b.1 owns: they pair through their own steps, not the shared prefix. */
const PAIRING_FLOWS = [
  "12-pair-declined",
  "13-pair-expired",
  "14-pair-bad-text",
  // R6's relay-only flow (docs/feat/mobile-relay.md): it opens its own window
  // (`pair-start-relay-only.js`, over a `--no-relay` record) rather than the
  // shared `_pair` prefix — it must, or the QR it proves would carry a direct
  // address too. Same "no `computer-<id>` from a shared prefix" consequence.
  "22-relay-only",
] as const;

/**
 * One assertion: `- assertVisible:` / `- assertNotVisible:`, or the `visible:` /
 * `notVisible:` block of an `extendedWaitUntil` (a WAIT is an assertion too — a
 * flow that only waits for its container asserts nothing about the content).
 */
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
    const kind =
      /^- (assertVisible|assertNotVisible):$/.exec(line)?.[1] ??
      (/^(visible|notVisible):$/.exec(line)?.[1] === "visible"
        ? "assertVisible"
        : /^(visible|notVisible):$/.exec(line)?.[1] === "notVisible"
          ? "assertNotVisible"
          : undefined);
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
    // Any other structural line ends a pending wait (an id belongs to the key
    // directly above it, and `timeout:`/`optional:` close the block).
    if (line !== "" && !line.startsWith("#") && !line.startsWith("- ")) {
      pending = undefined;
    }
  }
  return out;
}

function readFlow(name: string): readonly Assertion[] {
  return assertions(readFileSync(join(FLOWS_DIR, `${name}.yaml`), "utf8"));
}

/** The `runScript` file names of a flow, in order (indented under `runScript:`). */
function scripts(name: string): readonly string[] {
  const flow = readFileSync(join(FLOWS_DIR, `${name}.yaml`), "utf8");
  return [...flow.matchAll(/^\s*file: "(.+)"$/gm)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/** A script's body, for the daemon-truth rules below. */
function scriptBody(file: string): string {
  return readFileSync(join(FLOWS_DIR, file), "utf8");
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

describe("every flow asserts something narrower than its container", () => {
  test("no flow's only assertion is its own list/screen container", () => {
    for (const name of FLOWS) {
      const ids = new Set(readFlow(name).map((a) => a.id));
      expect(ids.size).toBeGreaterThan(1);
    }
  });

  test("no flow ENDS on the container it starts on", () => {
    // A flow that closes with `assertVisible: sessions-list` proves only that the
    // list is still on screen — the review's finding 2. Ending on a container is
    // allowed ONLY when a `runScript` follows it (a daemon-truth check is the real
    // last step then: `06-session-open`'s back-navigation case).
    const containers = new Set(["sessions-list", "computers-list", "session-view", "transcript"]);
    for (const name of FLOWS) {
      const flow = readFlow(name);
      const last = flow[flow.length - 1];
      if (last === undefined || !containers.has(last.id)) {
        continue;
      }
      const files = scripts(name);
      if (files.length === 0) {
        // 01-shell has no hook to end on: its two ids are its own observable.
        continue;
      }
      const body = readFileSync(join(FLOWS_DIR, `${name}.yaml`), "utf8");
      const idAt = body.lastIndexOf(`id: "${last.id}"`);
      const scriptAt = Math.max(...files.map((file) => body.lastIndexOf(`file: "${file}"`)), -1);
      expect(scriptAt).toBeGreaterThan(idAt);
    }
  });
});

describe("every 12c flow ends on DAEMON truth (plan P9: an id only says what was drawn)", () => {
  test("each new flow's last step is a runScript whose body asserts a hook's answer", () => {
    for (const name of NEW_FLOWS) {
      const files = scripts(name);
      expect(files.length).toBeGreaterThan(0);
      const last = files[files.length - 1] as string;
      const body = scriptBody(last);
      // A daemon-truth script reads a hook and THROWS when the answer is wrong:
      // an `output.x = "true"` with no check would be a vacuous last step.
      expect(body).toContain("http.get");
      expect(body).toMatch(/throw new Error/);
      expect(body).toMatch(/MAESTRO_HOOKS/);
    }
  });

  test("each 13d compose flow ends the same way (13d: its own last step is a hook)", () => {
    for (const name of COMPOSE_FLOWS) {
      const files = scripts(name);
      expect(files.length).toBeGreaterThan(0);
      const last = files[files.length - 1] as string;
      const body = scriptBody(last);
      expect(body).toContain("http.get");
      expect(body).toMatch(/throw new Error/);
      expect(body).toMatch(/MAESTRO_HOOKS/);
    }
  });

  test("the daemon-truth hooks the 12c flows read are the ones the harness serves", () => {
    const served = readFileSync(join(import.meta.dir, "..", "e2e", "hooks.ts"), "utf8");
    for (const name of [...NEW_FLOWS, ...COMPOSE_FLOWS]) {
      for (const file of scripts(name)) {
        const body = scriptBody(file);
        for (const match of body.matchAll(/\$\{MAESTRO_HOOKS\}\/([a-z-]+)/g)) {
          const hook = match[1];
          expect(hook).toBeDefined();
          expect(served).toContain(`"${hook}"`);
        }
      }
    }
  });
});

describe("13d's compose flows (docs/feat/mobile-compose.md)", () => {
  test("every one opens the session screen and asserts something INSIDE the compose bar", () => {
    // `session-view` alone is on screen whatever happens (12c's round-1 finding).
    const inside = (id: string): boolean =>
      id.startsWith("composer-") ||
      id.startsWith("chip-") ||
      id.startsWith("queued-row-") ||
      id.startsWith("returned-") ||
      id.startsWith("take-") ||
      id.startsWith("outbox-") ||
      id.startsWith("waiting-network") ||
      id.startsWith("banner-");
    for (const name of COMPOSE_FLOWS) {
      const ids = new Set(readFlow(name).map((a) => a.id));
      expect(ids.has("session-view")).toBe(true);
      expect([...ids].some(inside)).toBe(true);
    }
  });

  test("flow 12 asserts the QUEUE cleared the field, not that it kept the text", () => {
    // D1: the tap queues the text and clears the field in the same step (a double
    // tap must not queue twice). The first run asserted `composer-filled` here and
    // failed — correctly, because queueing empties the field. Mutation: flip this
    // assertion back → red.
    const ids = readFlow("12-steer").map((a) => `${a.kind}:${a.id}`);
    expect(ids).toContain("assertVisible:composer-queue");
    expect(ids).toContain("assertNotVisible:composer-filled");
  });

  test("each uses its OWN session, created for it just before it runs", () => {
    // A shared session would leak a queued/returned row from one flow into the next
    // one's screen (12c's permission-flow lesson). And they are NOT seeded up front:
    // eight extra rows pushed the earlier flows' sessions off the visible list (the
    // first iOS 26 run: flows 02/05/06/07/08 failed) — so `run.ts` creates each one
    // lazily through `COMPOSE_SESSION_VARS`.
    const vars = new Set<string>();
    for (const name of COMPOSE_FLOWS) {
      const body = readFileSync(join(FLOWS_DIR, `${name}.yaml`), "utf8");
      for (const match of body.matchAll(/session-\$\{([A-Z0-9_]+)\}/g)) {
        vars.add(match[1] as string);
      }
    }
    // Seven flows, seven distinct ids, none of them the list's own rows.
    expect(vars.size).toBe(COMPOSE_FLOWS.length);
    expect(vars.has("ALPHA_ID")).toBe(false);
    expect(vars.has("CHARLIE_ID")).toBe(false);
    const runner = readFileSync(join(import.meta.dir, "..", "e2e", "run.ts"), "utf8");
    for (const variable of vars) {
      expect(runner).toContain(`"${variable}"`);
    }
  });
});

describe("the flows the task replaced are gone, and its ids exist", () => {
  test("11a's placeholder flow is deleted (the placeholder screen is gone)", () => {
    expect(() => readFileSync(join(FLOWS_DIR, "04-session-placeholder.yaml"), "utf8")).toThrow();
    // And no flow still asserts the placeholder's id.
    for (const name of FLOWS) {
      expect(readFlow(name).some((a) => a.id === "session-placeholder")).toBe(false);
    }
  });

  test("11b.1: every flow pairs through `_pair`, and no flow names the dev computer", () => {
    // The app has no build-time computer any more: a flow that still expected
    // `computer-dev` would pass only against a build that cannot be shipped.
    for (const name of FLOWS) {
      const body = readFileSync(join(FLOWS_DIR, `${name}.yaml`), "utf8");
      expect(body).not.toContain("computer-dev");
      // The pairing prefix, or the pairing path the flow itself asserts.
      const pairs =
        body.includes("- runFlow: _pair.yaml") ||
        (PAIRING_FLOWS as readonly string[]).includes(name) ||
        body.includes("pair-start.js");
      expect({ name, pairs }).toEqual({ name, pairs: true });
      // A flow that ends BEFORE a computer is paired (the refusal/expiry/paste
      // flows, and `_pair` itself) has no id to name — the rest must.
      const pairsFirst = (PAIRING_FLOWS as readonly string[]).includes(name);
      if (!pairsFirst) {
        expect(body).toContain("${output.computerId}");
      }
    }
  });

  test("11b.1: `_pair` asserts BOTH ends' compare code (the security property)", () => {
    const body = readFileSync(join(FLOWS_DIR, "_pair.yaml"), "utf8");
    // The code the terminal shows comes from the hook; the phone's own testID
    // must be asserted against exactly it.
    expect(body).toContain('file: "pair-confirm.js"');
    expect(body).toContain("pair-sas-${output.sas}");
    // `y` is answered only after that comparison: the order is the property.
    const confirmAt = body.indexOf("pair-confirm.js");
    const sasAt = body.indexOf("pair-sas-${output.sas}");
    const answerAt = body.indexOf("pair-answer.js");
    expect(confirmAt).toBeGreaterThan(-1);
    expect(sasAt).toBeGreaterThan(confirmAt);
    expect(answerAt).toBeGreaterThan(sasAt);
    // F-H2: `clearState` does not wipe the Keychain on iOS, so the flow clears it.
    expect(body).toContain("- clearKeychain");
  });

  test("the flow list is the files that exist: no flow is silently not run", () => {
    for (const name of FLOWS) {
      expect(() => readFileSync(join(FLOWS_DIR, `${name}.yaml`), "utf8")).not.toThrow();
    }
    expect(FLOWS).toContain("06-session-open");
    expect(FLOWS).not.toContain("04-session-placeholder");
  });

  test("every 12c flow opens the session screen and asserts something INSIDE it", () => {
    // The screen's own frame is on screen whatever happens: a flow that only
    // asserts `session-view` cannot tell a working screen from a dead one.
    const inside = (id: string): boolean =>
      id.startsWith("row-") ||
      id.startsWith("tool-") ||
      id.startsWith("banner-") ||
      id.startsWith("diff-") ||
      id === "turn-running" ||
      id === "turn-idle" ||
      id === "perm-sheet" ||
      id === "composer-send";
    for (const name of NEW_FLOWS) {
      const ids = new Set(readFlow(name).map((a) => a.id));
      expect(ids.has("session-view")).toBe(true);
      expect([...ids].some(inside)).toBe(true);
    }
  });
});

describe("R6's relay-only flow (docs/feat/mobile-relay.md)", () => {
  const RELAY_FLOW = "22-relay-only";
  const body = readFileSync(join(FLOWS_DIR, `${RELAY_FLOW}.yaml`), "utf8");

  test("it is run: in the harness's list, and its files exist", () => {
    expect(FLOWS).toContain(RELAY_FLOW);
    for (const file of scripts(RELAY_FLOW)) {
      expect(() => scriptBody(file)).not.toThrow();
    }
  });

  test("it pairs over the relay-only window, not the shared `_pair` prefix", () => {
    // `_pair` opens its window against the shared daemon, whose record also has a
    // direct address: reusing it would prove nothing about a relay-only QR.
    expect(body).toContain('file: "pair-start-relay-only.js"');
    expect(body).not.toContain("- runFlow: _pair.yaml");
  });

  test("it ends on DAEMON truth, and the LAST step is the relay-only QR", () => {
    const files = scripts(RELAY_FLOW);
    expect(files.length).toBeGreaterThan(1);
    expect(files[files.length - 1]).toBe("22-relay-qr.js");
    // Every step it ends on reads a hook and THROWS when the answer is wrong: an
    // `output.x = …` with no check would be a vacuous last step.
    for (const file of files) {
      const script = scriptBody(file);
      expect(script).toContain("http.get");
      expect(script).toMatch(/throw new Error/);
      expect(script).toMatch(/MAESTRO_HOOKS/);
    }
  });

  test("the hooks it reads are the ones the harness serves", () => {
    // The 12c/13d guard covers those flows' scripts; this flow's own are added
    // here so a renamed hook is red rather than a flow that silently 404s.
    const served = readFileSync(join(import.meta.dir, "..", "e2e", "hooks.ts"), "utf8");
    for (const file of scripts(RELAY_FLOW)) {
      for (const match of scriptBody(file).matchAll(/\$\{MAESTRO_HOOKS\}\/([a-z-]+)/g)) {
        expect(served).toContain(`"${match[1]}"`);
      }
    }
  });

  test("`relay-qr` asserts exactly one address AND its relay shape", () => {
    // The property, not a weaker correlate: "one address" alone would pass on a
    // truncated QR, and "the relay shape" alone on a QR that also carries a
    // direct address (the loopback bind's, which R5b must NOT contribute).
    const script = scriptBody("22-relay-qr.js");
    expect(script).toContain("addresses.length !== 1");
    expect(script).toContain("/d/");
    expect(script).toContain("/e2e");
  });

  test("the harness runs a LOCAL relay, points `serve` at it, and keeps its own loopback address", () => {
    // Without the first two, the flow would pair over `relay.tentacle.so`: a test
    // reaching real infra (forbidden), and a QR whose address no local daemon
    // registers. The third is what makes the QR relay-ONLY: `pair` is given no
    // `--address` for this flow, and a loopback bind contributes none by itself.
    const runner = readFileSync(join(import.meta.dir, "..", "e2e", "run.ts"), "utf8");
    expect(runner).toContain("relay/src/server.ts");
    expect(runner).toContain("startRelay({");
    expect(runner).toContain('"--relay"');
    expect(runner).toContain("startRelayOnly");
    const pairing = readFileSync(join(import.meta.dir, "..", "e2e", "pairing.ts"), "utf8");
    // The design of `relayOnly` is the ABSENCE of the harness's own address: a
    // future edit that always injects one again would quietly un-prove the flow.
    expect(pairing).toContain("relayOnly === true ? {} : { extraAddresses: [deps.address] }");
  });
});
