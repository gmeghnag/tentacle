/**
 * T2.0 — the LOAD-BEARING property of the whole feature (docs/feat/model-charts.md,
 * "Load-bearing assumption", proven here at runtime rather than by reading):
 *
 * **A chart spec rides a tool call's own arguments to every client — live and
 * after reload — so inline rendering needs no new method, no new update type and
 * no `PROTOCOL_VERSION` bump.**
 *
 * Why it is a test and not a one-off script: every later slice (C3 TUI renderer,
 * C5/C6 phone) draws INLINE from the row's `args` string. If that string ever
 * stops surviving the round trip — a truncation, a re-serialisation that drops
 * a key, a provider that rewrites `rawInput`, a snapshot that rebuilds rows from
 * something else — the charts silently disappear or draw wrong numbers, with no
 * error anywhere. That failure is invisible until someone looks at a transcript.
 *
 * The path asserted is the REAL one (AGENTS §7 "one session path"): a real
 * `SessionHost` + `Connection` + `RemoteClient` over `createChannelPair`, a
 * scripted model calling `chart` with a ~39 KiB spec, then the daemon's own
 * history re-read as both frontends rebuild their rows from it (`messagesToItems`
 * for the TUI, `historyRows` for the phone — the very functions `--resume` and
 * the app's reopen use).
 *
 * Mutations that must turn this red (both applied and reverted, Execution):
 * `daemon/src/mapping.ts` `rawInput: safeParseArgs(event.arguments)` →
 * `undefined` (the arguments never leave), `client/src/mapping.ts` the string
 * branch → `String(update.rawInput)` (the spec becomes `[object Object]`), and
 * `tui/src/resume.ts` `args: call.arguments.slice(0, 4000)` (a reload truncates
 * — the shape of a future "cap the row" change).
 *
 * One mutation that does NOT turn it red, named so nobody re-derives it: the
 * client re-serialising the parsed object (`JSON.stringify` of `rawInput`
 * instead of passing the string through). Byte identity survives it because JS
 * preserves insertion order, and it is lossless for a JSON object — a dropped
 * key would still fail `toEqual`. So this test pins "nothing is lost", not
 * "nobody ever re-serialises", which is the property the renderers need.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { ToolRegistry, chartTool } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import { historyRows } from "../../../apps/mobile/src/transcript-history.ts";
import { messagesToItems } from "../../tui/src/resume.ts";
import type { SessionEvent } from "../src/mapping.ts";
import { RemoteClient } from "../src/remote-client.ts";

const CWD = "/tmp/model-charts-args-roundtrip";

/** A ~39 KiB spec: 8 series × 700 points — well past "a few labels", under the cap. */
const POINTS = 700;
const SPEC = {
  type: "line",
  title: "Ricavi mensili".padEnd(115, " "),
  labels: Array.from({ length: POINTS }, (_, i) => `m${i % 12}-${Math.floor(i / 12)}`),
  datasets: Array.from({ length: 8 }, (_, s) => ({
    label: `Serie ${s}`,
    data: Array.from({ length: POINTS }, (_, i) => Math.round((i + s) * 13.5 * 100) / 100),
  })),
  y: { unit: "€", format: "compact" },
};
const ARGS = JSON.stringify(SPEC);

class ChartCalling implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    if (this.turn++ === 0) {
      yield { type: "tool_call", toolCall: { id: "c1", name: "chart", arguments: ARGS } };
      yield { type: "done" };
      return;
    }
    yield { type: "text", delta: "ecco il grafico" };
    yield { type: "done" };
  }
}

const env: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

function counter(): () => string {
  let n = 0;
  return () => `r${n++}`;
}

/** The same spec, parsed: a KEY dropped or added would show up (byte order would not). */
function expectSameSpec(raw: string): void {
  expect(raw).not.toBe("");
  expect(JSON.parse(raw)).toEqual(SPEC);
}

describe("T2.0 a chart spec survives the tool-call round trip, live and after reload", () => {
  test("every client sees the spec the model sent — and the row's args are byte-identical", async () => {
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(
      daemonCh,
      new SessionHost({
        defaultCwd: CWD,
        createAgent: () => {
          const permissions = new PermissionBroker();
          const agent = new Agent({
            model: new ChartCalling(),
            tools: new ToolRegistry().register(chartTool),
            env,
            requestPermission: (req, options) => permissions.request(req, options),
          });
          return { agent, permissions };
        },
      }),
    );
    const client = new RemoteClient(clientCh, new PermissionBroker());
    await client.initialize();

    // LIVE: one turn through `RemoteSession.send`, the path both frontends use.
    const session = client.newSession();
    const events: SessionEvent[] = [];
    for await (const event of session.send("dammi un grafico")) {
      events.push(event);
    }
    const start = events.find(
      (e): e is Extract<SessionEvent, { type: "tool_start" }> => e.type === "tool_start",
    );
    expect(start?.name).toBe("chart");
    const live = start?.arguments ?? "";
    expectSameSpec(live);

    // RELOAD: the daemon's history, re-read as each frontend rebuilds its rows
    // (`--resume`'s `messagesToItems`, the app's `historyRows`).
    const history = await client.snapshot(session.sessionId ?? "");
    const tui = messagesToItems(history).filter((item) => item.kind === "tool");
    const phone = historyRows(history, counter()).filter((row) => row.kind === "tool");
    expect(tui).toHaveLength(1);
    expect(phone).toHaveLength(1);
    const tuiArgs = tui[0]?.kind === "tool" ? tui[0].args : "";
    const phoneArgs = phone[0]?.kind === "tool" ? phone[0].args : "";
    expectSameSpec(tuiArgs);
    expectSameSpec(phoneArgs);

    // The three are the SAME string: a client that re-serialised would still
    // parse equal, but the row would then differ from what the model wrote —
    // and a renderer keying on identity would re-lay out for nothing.
    expect(tuiArgs).toBe(live);
    expect(phoneArgs).toBe(live);
    expect(ARGS.length).toBeGreaterThan(30_000);
    client.close();
  });
});
