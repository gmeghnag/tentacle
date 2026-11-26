/**
 * docs/feat/a2a-client.md slice a2c-2 (C2, C11 network rules): the A2A client
 * adapter against a fake remote that is the SDK's real server behind an
 * in-memory `fetch` (`support/fake-a2a.ts`) — no socket, no DNS (an injected
 * resolver). Each security test names the mutation that turns it red.
 */
import { describe, expect, test } from "bun:test";
import {
  type A2AAdapterOptions,
  A2APolicyError,
  createA2AAdapter,
  pinnedFetch,
} from "../src/harness/a2a.ts";
import { runHarnessChild } from "../src/harness/child.ts";
import type { HarnessEvent, HarnessRun } from "../src/harness/types.ts";
import { SessionGrants } from "../src/session-grants.ts";
import type { AgentType } from "../src/subagent.ts";
import { type FakeA2A, createFakeA2A } from "./support/fake-a2a.ts";

const TOKEN = "s3cret-token-value";
const never = new AbortController().signal;
const spec = (prompt: string) => ({ prompt, mode: "remote" as const, runId: "r1" });

function adapterFor(fake: FakeA2A, over: Partial<A2AAdapterOptions> = {}) {
  return createA2AAdapter({
    name: "fake",
    cardUrl: fake.cardUrl,
    fetch: fake.fetch,
    tokenCommand: "print-token",
    runCommand: async () => `${TOKEN}\n`,
    ...over,
  });
}

/** Read events until `stop` matches (inclusive) or the stream ends; throws after `ms`. */
async function take(
  run: HarnessRun,
  stop: (ev: HarnessEvent) => boolean = () => false,
  ms = 3000,
): Promise<HarnessEvent[]> {
  const it = run.events[Symbol.asyncIterator]();
  const out: HarnessEvent[] = [];
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const r = await Promise.race([
      it.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no event within ${ms} ms: ${JSON.stringify(out)}`)),
          ms,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (r.done) return out;
    out.push(r.value);
    if (stop(r.value)) return out;
  }
}

/** Poll the condition the next assertion reads; throws on timeout (AGENTS §9). */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const kinds = (evs: readonly HarnessEvent[]) => evs.map((e) => e.kind);
const a2aPosts = (fake: FakeA2A) => fake.requests.filter((r) => r.method === "POST");

describe("A2A adapter — stream", () => {
  test("work → started / progress / output / end; the token only on the transport, never on the card fetch", async () => {
    const fake = createFakeA2A({ token: TOKEN });
    const adapter = adapterFor(fake);
    expect(adapter.kind).toBe("remote");
    expect(adapter.id).toBe("a2a:fake");
    const probe = await adapter.probe(never);
    expect(probe).toEqual({ ok: true, version: "9.9.9" });
    const run = await adapter.start(spec("work"), never);
    const evs = await take(run);
    expect(kinds(evs)).toEqual(["started", "progress", "output", "end"]);
    expect(evs[2]).toEqual({ kind: "output", text: "done: 42", fromArtifact: "r" });
    expect(evs.at(-1)).toEqual({ kind: "end", status: "completed" });
    // mutation: add the token on every request → the card GET carries it → red.
    const card = fake.requests.filter((r) => r.method === "GET");
    expect(card.map((r) => [r.url, r.auth])).toEqual([[fake.cardUrl, null]]);
    expect(a2aPosts(fake).every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(a2aPosts(fake).length).toBeGreaterThan(0);
  });

  test("what leaves is redacted, and every call is a NEW remote conversation", async () => {
    const fake = createFakeA2A({ token: TOKEN });
    const adapter = adapterFor(fake);
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";
    await take(await adapter.start(spec(`use ${secret} please`), never));
    await take(await adapter.start(spec("second"), never));
    expect(fake.received).toHaveLength(2);
    expect(fake.received[0]?.text).not.toContain(secret);
    expect(fake.received[0]?.text).toContain("please");
    expect(fake.received[0]?.contextId).not.toBe("");
    expect(fake.received[0]?.contextId).not.toBe(fake.received[1]?.contextId);
  });

  test("INPUT_REQUIRED → answer → the SAME task completes; the stale snapshot never re-asks (F-b)", async () => {
    const fake = createFakeA2A({ token: TOKEN });
    const run = await adapterFor(fake).start(spec("ask"), never);
    const first = await take(run, (e) => e.kind === "ask");
    const ask = first.at(-1);
    expect(ask?.kind === "ask" && ask.ask).toEqual({ type: "input", question: "which branch?" });
    const started = first[0];
    if (started?.kind !== "started" || ask?.kind !== "ask") throw new Error("no started/ask");
    // The remote closes the stream on INPUT_REQUIRED; a person answers LATER.
    // The pause is that person, not a synchronisation point: the assertion
    // holds whatever it lasts (it only gives the client time to see the close).
    // mutation: treat that close as a disconnect → `disconnected` first → red.
    await until(() => fake.openStreams() === 0);
    await new Promise((r) => setTimeout(r, 50));
    await run.answer(ask.askId, { allow: true, input: "main" });
    const rest = await take(run);
    expect(kinds(rest)).toEqual(["output", "end"]);
    expect(rest[0]).toEqual({ kind: "output", text: "got: main", fromArtifact: "r" });
    expect(fake.received[1]).toEqual({
      text: "main",
      taskId: started.handle.id,
      contextId: started.handle.extra?.contextId ?? "?",
    });
  });

  test("AUTH_REQUIRED with the stream left OPEN → ask{auth} at once (F-a); cancel ends it", async () => {
    const fake = createFakeA2A({ token: TOKEN });
    const run = await adapterFor(fake).start(spec("auth"), never);
    // mutation: act on "stream closed" instead of the status → never arrives → red (timeout).
    const evs = await take(run, (e) => e.kind === "ask", 1500);
    const ask = evs.at(-1);
    expect(ask?.kind === "ask" && ask.ask.type).toBe("auth");
    expect(await run.cancel()).toBe("confirmed");
    expect(kinds(await take(run))).toEqual(["end"]);
    fake.release();
  });

  test("steering is refused (caps.steer false)", async () => {
    const fake = createFakeA2A();
    const adapter = adapterFor(fake, { tokenCommand: undefined });
    expect(adapter.caps.steer).toBe(false);
    const run = await adapter.start(spec("work"), never);
    await expect(run.send("more")).rejects.toThrow("does not accept steering");
    await take(run);
  });
});

describe("A2A adapter — cancel, drop, reattach", () => {
  test("cancel on a running task → confirmed → end cancelled; the stream is closed", async () => {
    const fake = createFakeA2A();
    const run = await adapterFor(fake, { tokenCommand: undefined }).start(spec("hang"), never);
    await take(run, (e) => e.kind === "progress");
    expect(await run.cancel()).toBe("confirmed");
    expect(await take(run)).toEqual([{ kind: "end", status: "cancelled" }]);
    expect(fake.requests.some((r) => /cancel/i.test(r.rpc ?? ""))).toBe(true);
    fake.release();
  });

  test("cancel that never answers → unconfirmed within the bound; the events end", async () => {
    const fake = createFakeA2A();
    fake.cancelHangs = true;
    const run = await adapterFor(fake, { tokenCommand: undefined, cancelTimeoutMs: 50 }).start(
      spec("hang"),
      never,
    );
    await take(run, (e) => e.kind === "progress");
    expect(await run.cancel()).toBe("unconfirmed");
    expect(await take(run)).toEqual([]);
    fake.release();
  });

  test("the run's own signal stops its stream (no event after it, until cancel says how it ended)", async () => {
    const fake = createFakeA2A();
    const ctl = new AbortController();
    const run = await adapterFor(fake, { tokenCommand: undefined }).start(spec("hang"), ctl.signal);
    await take(run, (e) => e.kind === "progress");
    ctl.abort();
    expect(await run.cancel()).toBe("confirmed");
    expect(await take(run)).toEqual([{ kind: "end", status: "cancelled" }]);
    expect(fake.openStreams()).toBe(0);
    fake.release();
  });

  test("a dropped stream → disconnected → reattach (resubscribe) → the task finishes", async () => {
    const fake = createFakeA2A({ token: TOKEN });
    const adapter = adapterFor(fake);
    const run = await adapter.start(spec("hang"), never);
    const head = await take(run, (e) => e.kind === "progress");
    const started = head[0];
    if (started?.kind !== "started") throw new Error("no started");
    fake.dropStreams();
    const dropped = await take(run);
    expect(kinds(dropped)).toEqual(["disconnected"]);
    const again = await adapter.reattach(started.handle, never);
    fake.release();
    const tail = await take(again);
    expect(kinds(tail)).toEqual(["output", "end"]); // no second `started`
    expect(tail[0]).toEqual({ kind: "output", text: "done: late", fromArtifact: "r" });
    const resub = a2aPosts(fake).filter((r) => /subscribe/i.test(r.rpc ?? ""));
    expect(resub.length).toBe(1);
    expect(resub[0]?.auth).toBe(`Bearer ${TOKEN}`);
  });

  test("reattach to a task that already ended → one getTask → its artifacts + end", async () => {
    const fake = createFakeA2A();
    const first = adapterFor(fake, { tokenCommand: undefined });
    const evs = await take(await first.start(spec("work"), never));
    const started = evs[0];
    if (started?.kind !== "started") throw new Error("no started");
    // A fresh adapter object (nothing seen yet): the artifacts come from the read.
    const fresh = adapterFor(fake, { tokenCommand: undefined });
    const tail = await take(await fresh.reattach(started.handle, never));
    expect(tail).toEqual([
      { kind: "output", text: "done: 42", fromArtifact: "r" },
      { kind: "end", status: "completed" },
    ]);
    expect(fake.requests.some((r) => /gettask/i.test(r.rpc ?? ""))).toBe(true);
    // The same adapter already showed that artifact: only the end.
    expect(await take(await first.reattach(started.handle, never))).toEqual([
      { kind: "end", status: "completed" },
    ]);
  });
});

describe("A2A adapter — the outbound boundary", () => {
  test("a redirect is never followed: start fails, nothing reaches the other origin", async () => {
    const fake = createFakeA2A({ token: TOKEN });
    fake.redirectA2A = "http://evil.example/steal";
    const adapter = adapterFor(fake);
    // mutation: drop `redirect: "error"` → the fetch follows with the bearer → red.
    await expect(adapter.start(spec("work"), never)).rejects.toThrow("unreachable");
    expect(fake.requests.filter((r) => !r.url.startsWith(fake.origin))).toEqual([]);
  });

  test("a request to any other origin is refused before the network", async () => {
    const fake = createFakeA2A();
    const refused: string[] = [];
    const f = pinnedFetch({
      origin: fake.origin,
      policy: "configured",
      lookup: async () => [],
      base: fake.fetch,
      token: () => TOKEN,
      onRefused: (r) => refused.push(r),
    });
    // mutation: drop the origin lock → the request (with the token) reaches the fetch → red.
    await expect(f("http://evil.example/a2a", { method: "POST" })).rejects.toBeInstanceOf(
      A2APolicyError,
    );
    expect(fake.requests).toEqual([]);
    expect(refused).toHaveLength(1);
    // A caller-supplied credential is never forwarded.
    const g = pinnedFetch({
      origin: fake.origin,
      policy: "configured",
      lookup: async () => [],
      base: fake.fetch,
    });
    await g(fake.cardUrl, { headers: { authorization: "Bearer injected" } });
    expect(fake.requests.at(-1)?.auth).toBeNull();
  });

  test("a card whose interface sits on another origin is refused at the probe; nothing is sent", async () => {
    const fake = createFakeA2A({
      card: {
        supportedInterfaces: [
          {
            url: "http://evil.example/a2a",
            protocolBinding: "JSONRPC",
            tenant: "",
            protocolVersion: "1.0",
          },
        ],
      },
    });
    const adapter = adapterFor(fake);
    const probe = await adapter.probe(never);
    expect(probe.ok).toBe(false);
    expect(probe.reason).toContain("origin");
    expect(a2aPosts(fake)).toEqual([]);
  });

  test("the task goes to the interface the checks accepted, not the card's first one", async () => {
    const fake = createFakeA2A({
      token: TOKEN,
      card: {
        supportedInterfaces: [
          {
            url: "http://remote.example/a2a",
            protocolBinding: "JSONRPC",
            tenant: "",
            protocolVersion: "1.0",
          },
          {
            url: "http://evil.example/a2a",
            protocolBinding: "JSONRPC",
            tenant: "",
            protocolVersion: "1.0",
          },
        ],
      },
    });
    // The SDK keeps the LAST 1.0 interface per binding (`createFromNormalizedAgentCard`).
    // mutation: hand the SDK the whole card → it picks evil.example → refused → red.
    const evs = await take(await adapterFor(fake).start(spec("work"), never));
    expect(evs.at(-1)).toEqual({ kind: "end", status: "completed" });
    expect(fake.requests.filter((r) => !r.url.startsWith(fake.origin))).toEqual([]);
  });

  test("401 → ask{auth}; the token never appears in an event or an error", async () => {
    const fake = createFakeA2A({ token: "the-right-one" });
    const run = await adapterFor(fake).start(spec("work"), never);
    const evs = await take(run, (e) => e.kind === "ask");
    const ask = evs.at(-1);
    expect(ask?.kind === "ask" && ask.ask.type).toBe("auth");
    expect(JSON.stringify(evs)).not.toContain(TOKEN);
    expect(await run.cancel()).toBe("unconfirmed"); // no task was created
  });

  test("an error body echoing the bearer is scrubbed from the failure", async () => {
    const fake = createFakeA2A({ token: TOKEN });
    fake.failA2A = { status: 500, body: "boom, you sent {auth}" };
    const adapter = adapterFor(fake);
    // mutation: no token scrub in the error text → the message holds the token → red.
    const err = await adapter.start(spec("work"), never).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("unreachable");
    expect(msg).toContain("a task may have been created remotely");
    expect(msg).not.toContain(TOKEN);
  });
});

describe("A2A adapter — the token command", () => {
  test("runs lazily, once, at the probe — not at construction", async () => {
    const fake = createFakeA2A({ token: TOKEN });
    let runs = 0;
    const adapter = adapterFor(fake, {
      runCommand: async () => {
        runs += 1;
        return TOKEN;
      },
    });
    expect(runs).toBe(0);
    await adapter.probe(never);
    await take(await adapter.start(spec("work"), never));
    await take(await adapter.start(spec("work"), never));
    expect(runs).toBe(1);
  });

  test("a failing, empty or slow command → probe not ok, nothing sent, its output never shown", async () => {
    const cases: [A2AAdapterOptions["runCommand"], string][] = [
      [async () => Promise.reject(new Error(`leaked ${TOKEN}`)), "tokenCommand failed"],
      [async () => "  \n", "no usable token"],
      [() => new Promise<string>(() => {}), "did not finish"],
    ];
    for (const [runCommand, why] of cases) {
      const fake = createFakeA2A({ token: TOKEN });
      const probe = await adapterFor(fake, { runCommand, tokenTimeoutMs: 30 }).probe(never);
      expect(probe.ok).toBe(false);
      expect(probe.reason).toContain(why);
      expect(probe.reason).toContain("harnesses.fake.tokenCommand");
      expect(probe.reason).not.toContain(TOKEN);
      expect(a2aPosts(fake)).toEqual([]);
    }
  });
});

describe("A2A adapter — a proposed agent's network rules (C11)", () => {
  const ORIGIN = "https://agent.example";
  const proposed = (fake: FakeA2A, lookup: (host: string) => Promise<readonly string[]>) =>
    createA2AAdapter({
      name: "agent-example",
      cardUrl: fake.cardUrl,
      fetch: fake.fetch,
      policy: "proposed",
      lookup,
    });

  test("a host resolving to a private address (or ANY private record) is refused before any request", async () => {
    for (const addrs of [
      ["10.0.0.5"],
      ["93.184.216.34", "192.168.1.2"],
      ["::ffff:169.254.169.254"],
    ]) {
      const fake = createFakeA2A({ origin: ORIGIN });
      const probe = await proposed(fake, async () => addrs).probe(never);
      expect(probe.ok).toBe(false);
      expect(probe.reason).toContain("refused");
      expect(fake.requests).toEqual([]);
    }
  });

  test("re-checked on EVERY request: a host that turns private after the probe gets nothing", async () => {
    const fake = createFakeA2A({ origin: ORIGIN });
    let addr = "93.184.216.34";
    const adapter = proposed(fake, async () => [addr]);
    expect((await adapter.probe(never)).ok).toBe(true);
    addr = "10.0.0.5";
    // mutation: check only the first request → SendMessage reaches the fake → red.
    await expect(adapter.start(spec("work"), never)).rejects.toThrow("refused");
    expect(a2aPosts(fake)).toEqual([]);
  });

  test("a refusal mid-run (the reply's request) ends the run failed — never a reconnect loop", async () => {
    const fake = createFakeA2A({ origin: ORIGIN });
    let addr = "93.184.216.34";
    const run = await proposed(fake, async () => [addr]).start(spec("ask"), never);
    const ask = (await take(run, (e) => e.kind === "ask")).at(-1);
    if (ask?.kind !== "ask") throw new Error("no ask");
    await until(() => fake.openStreams() === 0);
    const posts = a2aPosts(fake).length;
    addr = "169.254.169.254";
    await run.answer(ask.askId, { allow: true, input: "main" });
    // mutation: a mid-run refusal → `disconnected` (the runner would reattach) → red.
    const tail = await take(run);
    expect(tail).toHaveLength(1);
    const end = tail[0];
    expect(end?.kind === "end" && end.status).toBe("failed");
    expect(end?.kind === "end" && end.error).toContain("refused");
    expect(a2aPosts(fake).length).toBe(posts);
  });

  test("http, a literal private IP and a token are refused for a proposed agent", async () => {
    const http = createFakeA2A({ origin: "http://agent.example" });
    expect((await proposed(http, async () => ["93.184.216.34"]).probe(never)).reason).toContain(
      "https",
    );
    const literal = createFakeA2A({ origin: "https://10.1.2.3" });
    expect((await proposed(literal, async () => ["93.184.216.34"]).probe(never)).ok).toBe(false);
    expect(http.requests).toEqual([]);
    expect(literal.requests).toEqual([]);
    expect(() =>
      createA2AAdapter({
        name: "x",
        cardUrl: `${ORIGIN}/c.json`,
        policy: "proposed",
        tokenCommand: "t",
      }),
    ).toThrow("never has a token");
  });
});

describe("A2A adapter through the runner (load-bearing: one seam carries it)", () => {
  test("runHarnessChild + the real adapter + the fake: the report and the task footer", async () => {
    const fake = createFakeA2A({ token: TOKEN });
    const adapter = adapterFor(fake);
    const type = {
      name: "a2a:fake",
      description: "fake",
      harness: { adapter: "a2a:fake", mode: "remote" },
    } as unknown as AgentType;
    const result = await runHarnessChild(
      type,
      { prompt: "work" } as Parameters<typeof runHarnessChild>[1],
      undefined,
      {
        instances: new Map([["a2a:fake", { adapter, idleMinutes: 1, origin: fake.origin }]]),
        cwd: "/",
      },
      { requester: async () => ({ allowed: true }), grants: new SessionGrants(), sessionId: "s" },
    );
    expect(result.stopReason).toBe("end_turn");
    expect(result.report).toContain("done: 42");
    const started = fake.received[0];
    expect(started?.text).toBe("work");
    expect(result.report).toMatch(/task [0-9a-f-]{8,}/);
  });
});
