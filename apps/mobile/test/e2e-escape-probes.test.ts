/**
 * Flow 30's harness half (docs/feat/model-artifacts.md T8.1): the probe listener
 * that is the escape suite's ONLY evidence, the fixture substitution that points
 * the hostile page at it, the mock model's `ESCAPE30` turn that `present`s it, and
 * the flow's own wiring.
 *
 * Why each matters: a listener that drops a nameless probe would read as
 * "blocked"; a fixture that keeps `__PROBE__` would probe a nonexistent host and
 * pass for the wrong reason; a model that never calls `present` leaves the card
 * with nothing to tap; and a flow absent from `FLOWS` is inert (the S8 Execution's
 * PENDING item). Driven over real loopback HTTP and the REAL provider stream, the
 * same way `e2e-mock-activity.test.ts` drives flow 27.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage, StreamEvent, ToolCall } from "@tentacle/core";
// The e2e harness's own concern, imported by path like its other workspace reach-ins.
import { OpenAIProvider } from "../../../packages/providers/src/index.ts";
import { escapeFixture, startProbeListener } from "../e2e/escape-probes.ts";
import { hookFor } from "../e2e/hooks.ts";
import { ESCAPE_ARTIFACT_ID, ESCAPE_PROMPT, startMockModel } from "../e2e/mock-model.ts";
import { FLOWS, parseArgs } from "../e2e/run.ts";

const FLOWS_DIR = join(import.meta.dir, "..", "e2e", "flows");

describe("the probe listener is the evidence (T8.1)", () => {
  const probes = startProbeListener();
  afterAll(() => probes.stop());

  test("it records a probe by name, and starts empty", async () => {
    expect(probes.hits()).toEqual([]);
    await fetch(`${probes.url}?p=fetch`);
    await fetch(`${probes.url}?p=img`);
    expect(probes.hits()).toEqual(["fetch", "img"]);
  });

  const WEBKIT = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15";

  test("a nameless probe FROM A BROWSER ENGINE is still recorded (dropping it would read as blocked)", async () => {
    probes.reset();
    await fetch(probes.url, { headers: { "user-agent": WEBKIT } });
    expect(probes.hits()).toEqual(["unnamed GET /"]);
  });

  test("a nameless request from a NON-browser local client is a stray, never an escape (run 2: `POST /mcp`)", async () => {
    // Another process on the Mac probing localhost ports (an MCP client) reached
    // the listener's ephemeral port in the full suite: a scripts-off WebView cannot
    // send `POST /mcp`, and every WebView request carries WebKit's user agent.
    probes.reset();
    await fetch(`${probes.url}/mcp`, { method: "POST", headers: { "user-agent": "node" } });
    expect(probes.hits()).toEqual([]);
    expect(probes.strays()).toEqual(["POST /mcp ua=node"]);
  });

  test("a NAMED probe counts whatever its user agent (the fixture's own probes)", async () => {
    probes.reset();
    await fetch(`${probes.url}?p=img`, { headers: { "user-agent": "node" } });
    expect(probes.hits()).toEqual(["img"]);
  });

  test("reset forgets what an earlier open saw (each open is its own)", async () => {
    probes.reset();
    await fetch(`${probes.url}?p=xhr`);
    probes.reset();
    expect(probes.hits()).toEqual([]);
  });

  test("the fixture substitutes EVERY placeholder, and the file stays port-free", () => {
    const html = readFileSync(join(FLOWS_DIR, "..", "fixtures", "escape.html"), "utf8");
    // The on-disk fixture names no host: the port is the run's, not the repo's.
    expect(html).toContain("__PROBE__");
    const filled = escapeFixture(html, probes.url);
    expect(filled).not.toContain("__PROBE__");
    expect(filled.split(probes.url).length - 1).toBeGreaterThan(5);
  });
});

describe("the mock model presents the escape fixture (flow 30's card)", () => {
  const mock = startMockModel({ childStepMs: 1 });
  afterAll(() => mock.stop());
  const provider = new OpenAIProvider({ baseURL: mock.baseUrl, model: "mock" });

  async function round(messages: ChatMessage[]): Promise<ToolCall[]> {
    const calls: ToolCall[] = [];
    for await (const event of provider.stream({ messages }) as AsyncIterable<StreamEvent>) {
      if (event.type === "tool_call") {
        calls.push(event.toolCall);
      }
    }
    return calls;
  }

  test("`ESCAPE30` presents `escape.html` under the id the flow taps", async () => {
    const calls = await round([{ role: "user", content: ESCAPE_PROMPT }]);
    expect(calls).toHaveLength(1);
    const call = calls[0] as ToolCall;
    expect(call.name).toBe("present");
    expect(JSON.parse(call.arguments)).toEqual({
      title: "escape probes",
      path: `project/${ESCAPE_ARTIFACT_ID}.html`,
      id: ESCAPE_ARTIFACT_ID,
    });
  });
});

describe("flow 30 is wired, not inert", () => {
  test("it is in FLOWS (a flow outside the list never runs)", () => {
    expect(FLOWS).toContain("30-artifact-escape");
    // And it gets its own session, or its card could leak into another flow.
    expect(FLOWS.filter((flow) => flow === "30-artifact-escape")).toHaveLength(1);
  });

  test("it exercises the safe default AND the scripts tap AND the network tap", () => {
    const flow = readFileSync(join(FLOWS_DIR, "30-artifact-escape.yaml"), "utf8");
    for (const id of [
      "artifact-card-escape",
      "artifact-scripts-off",
      "artifact-scripts-run",
      "artifact-network-off",
      "artifact-network-allow",
      "artifact-network-on",
    ]) {
      expect({ id, found: flow.includes(`id: "${id}"`) }).toEqual({ id, found: true });
    }
    // The tap on the confirm dialog's own button (the Alert's "Run"/"Allow").
    expect(flow).toContain('tapOn: "Run"');
    // "Allow" is also the bar's own link: the dialog's is the one under its title.
    expect(flow).toMatch(/text: "Allow"\n\s+below:\n\s+text: "Allow network\\\\\?"/);
    // Three daemon-truth checks: inert, scripts-on, and the non-vacuous one.
    expect(flow.match(/30-escape-hits\.js/g) ?? []).toHaveLength(3);
    expect(flow.match(/EXPECT: none/g) ?? []).toHaveLength(2);
    expect(flow.match(/EXPECT: fetch/g) ?? []).toHaveLength(1);
  });

  test("the hooks server routes /escape-hits (it answered 404: sweep run 4)", () => {
    expect(hookFor("/escape-hits")).toBe("escape-hits");
  });

  test("`present` reads the fixture where the harness writes it, relative to the session cwd", () => {
    // The daemon's cwd (= every session's cwd) is the run dir; the fixture is
    // written under `project/`. A bare `escape.html` was "no such file" (sweep run 2).
    const run = readFileSync(join(import.meta.dir, "..", "e2e", "run.ts"), "utf8");
    const mock = readFileSync(join(import.meta.dir, "..", "e2e", "mock-model.ts"), "utf8");
    expect(run).toContain('join(runDir, "project", "escape.html")');
    expect(run).toMatch(/\n\s+cwd: runDir,\n\s+env: \{/);
    expect(mock).toContain("path: `project/${ESCAPE_ARTIFACT_ID}.html`");
  });

  test("the flow's own session is passed to Maestro (or `${ESCAPE_ID}` is empty)", () => {
    const run = readFileSync(join(import.meta.dir, "..", "e2e", "run.ts"), "utf8");
    expect(run).toMatch(/"30-artifact-escape": "ESCAPE_ID"/);
    expect(run).toContain("escapeHits: () => ({ hits: probes.hits(), strays: probes.strays() })");
    // `--only` still resolves it (the flag's names are checked against FLOWS).
    expect(parseArgs(["--only", "30-artifact-escape"]).flows).toBe("30-artifact-escape");
  });
});
