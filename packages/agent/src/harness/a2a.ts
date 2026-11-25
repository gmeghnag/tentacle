/**
 * The A2A client adapter (docs/feat/a2a-client.md C2, slice a2c-2): a remote
 * A2A agent is one more `HarnessAdapter` (`kind: "remote"`), driven by the
 * `@a2a-js/sdk` client over a `fetch` THIS file builds — the security boundary:
 *
 * - every request goes to the PINNED origin (the configured card's) or nowhere;
 * - the bearer token is added only by us, only on the transport (never on the
 *   card fetch), and never follows a redirect (`redirect: "error"`, a 3xx refused);
 * - a `proposed` agent (C11) passes the public-address rules on EVERY request;
 * - the token comes from a command, run lazily at the probe, held in memory,
 *   and scrubbed from every message this file emits.
 *
 * The frame → event mapping is pure (`a2a-map.ts`); this file owns the I/O.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import type { AgentCard, StreamResponse, Task } from "@a2a-js/sdk";
import { Role, TaskState } from "@a2a-js/sdk";
import {
  type Client,
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from "@a2a-js/sdk/client";
import { anySignal } from "@tentacle/core";
import { redactText } from "../redact.ts";
import {
  type MapState,
  addressRefusal,
  buildOutboundText,
  checkCard,
  classifyAddress,
  mapStreamResponse,
  newMapState,
  oneLine,
  proposedUrlRefusal,
  streamClosedEvent,
} from "./a2a-map.ts";
import type {
  HarnessAdapter,
  HarnessCaps,
  HarnessDecision,
  HarnessEvent,
  HarnessHandle,
  HarnessProbe,
  HarnessRun,
  HarnessRunSpec,
} from "./types.ts";

/** `configured`: any address the owner typed. `proposed`: C11's public-address rules. */
export type A2ANetworkPolicy = "configured" | "proposed";
/** Host → every address it resolves to (injected in tests: no DNS). */
export type A2ALookup = (host: string) => Promise<readonly string[]>;
/** Same shape as `@tentacle/config`'s `CommandRunner`. */
export type A2ACommandRunner = (command: string, signal?: AbortSignal) => Promise<string>;

export const A2A_CAPS: HarnessCaps = {
  permissionAsks: false,
  inputRequired: true,
  steer: false,
  usage: false,
  cost: false,
  quota: false,
  structuredResult: false,
  workspace: "none",
};

/** A request this file refused before it reached the network. */
export class A2APolicyError extends Error {
  override readonly name = "A2APolicyError";
}

const defaultLookup: A2ALookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((r) => r.address);

/** `sh -c` under the caller's signal; a failure carries the exit code only (never output). */
const defaultRunner: A2ACommandRunner = async (command, signal) => {
  const proc = Bun.spawn(["/bin/sh", "-c", command], {
    stdout: "pipe",
    stderr: "ignore",
    ...(signal ? { signal } : {}),
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`exit ${code}`);
  return out;
};

async function checkProposed(href: string, lookup: A2ALookup): Promise<void> {
  const shape = proposedUrlRefusal(href);
  if (shape !== undefined) throw new A2APolicyError(`refused: ${shape}`);
  const host = new URL(href).hostname.replace(/^\[|\]$/g, "");
  if (classifyAddress(host) !== "invalid") return; // an IP literal: judged by its shape above
  let addresses: readonly string[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new A2APolicyError(`refused: ${host} did not resolve`);
  }
  const bad = addressRefusal(addresses);
  if (bad !== undefined) throw new A2APolicyError(`refused: ${host} ${bad}`);
}

export interface PinnedFetchOptions {
  /** The only origin a request may go to. */
  readonly origin: string;
  readonly policy: A2ANetworkPolicy;
  readonly lookup: A2ALookup;
  readonly base: typeof fetch;
  /** The token for THIS fetch, or none (the card fetch never carries one). */
  readonly token?: () => string | undefined;
  /** Every response status from the pinned origin (401/403 → `ask{auth}`). */
  readonly onStatus?: (status: number) => void;
  /** A refusal, before it is thrown (the run reports it instead of reconnecting). */
  readonly onRefused?: (reason: string) => void;
  /** Combined with the request's own signal. */
  readonly signal?: AbortSignal;
}

/** The `fetch` the SDK is given: the whole outbound policy of this adapter. */
export function pinnedFetch(o: PinnedFetchOptions): typeof fetch {
  const refuse = (reason: string): never => {
    o.onRefused?.(reason);
    throw new A2APolicyError(reason);
  };
  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = URL.canParse(raw) ? new URL(raw) : undefined;
    if (url === undefined) return refuse("refused: not a valid request URL");
    if (url.origin !== o.origin) {
      return refuse(`refused: ${url.origin} is not the agent's origin ${o.origin}`);
    }
    if (o.policy === "proposed") {
      try {
        await checkProposed(url.href, o.lookup);
      } catch (err) {
        return refuse(err instanceof Error ? err.message : String(err));
      }
    }
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.delete("authorization"); // only this file decides who gets a credential
    const token = o.token?.();
    if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
    const signals = [init?.signal, o.signal].filter((s): s is AbortSignal => s != null);
    const res = await o.base(input, {
      ...init,
      headers,
      redirect: "error",
      ...(signals.length > 0 ? { signal: anySignal(signals) } : {}),
    });
    // A fetch that ignored `redirect: "error"` still never hands a 3xx on.
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      return refuse(`refused: ${o.origin} answered with a redirect`);
    }
    o.onStatus?.(res.status);
    return res;
  };
  return wrapped as typeof fetch;
}

// ── the run ─────────────────────────────────────────────────────────

/** What the run's own `fetch` saw (per run: concurrent runs never share it). */
interface RunFlags {
  authStatus?: number;
  refused?: string;
}

interface RunCtx {
  readonly id: string;
  readonly client: Client;
  readonly flags: RunFlags;
  readonly scrub: (err: unknown) => string;
  readonly cancelTimeoutMs: number;
  /** The task id became known (the adapter keeps the state for `reattach`). */
  readonly onTask: (taskId: string, state: MapState) => void;
}

class EventQueue implements AsyncIterable<HarnessEvent> {
  private readonly items: HarnessEvent[] = [];
  private readonly waiters: ((r: IteratorResult<HarnessEvent>) => void)[] = [];
  closed = false;

  push(ev: HarnessEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: ev, done: false });
    else this.items.push(ev);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
    return {
      next: (): Promise<IteratorResult<HarnessEvent>> => {
        const value = this.items.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function textOf(parts: readonly { content?: { $case: string; value?: unknown } }[]): string {
  return parts.map((p) => (p.content?.$case === "text" ? String(p.content.value) : "")).join("\n");
}

/** A task snapshot's artifacts already streamed in full are not repeated (reattach → `getTask`). */
function dedupeTask(resp: StreamResponse, state: MapState): StreamResponse {
  const p = resp.payload;
  if (p?.$case !== "task" || state.artifacts.size === 0) return resp;
  const artifacts = (p.value.artifacts ?? []).filter(
    (a) => state.artifacts.get(a.artifactId) !== textOf(a.parts),
  );
  return { ...resp, payload: { $case: "task", value: { ...p.value, artifacts } } };
}

function isTerminal(task: Task): boolean {
  const s = task.status?.state;
  return (
    s === TaskState.TASK_STATE_COMPLETED ||
    s === TaskState.TASK_STATE_FAILED ||
    s === TaskState.TASK_STATE_CANCELED ||
    s === TaskState.TASK_STATE_REJECTED
  );
}

function messageParams(text: string, taskId: string, contextId: string) {
  return {
    tenant: "",
    configuration: undefined,
    metadata: {},
    message: {
      messageId: crypto.randomUUID(),
      contextId,
      taskId,
      role: Role.ROLE_USER,
      parts: [
        {
          content: { $case: "text" as const, value: text },
          mediaType: "text/plain",
          filename: "",
          metadata: {},
        },
      ],
      metadata: {},
      extensions: [],
      referenceTaskIds: [],
    },
  };
}

type StreamOpener = (signal: AbortSignal) => AsyncGenerator<StreamResponse, void, undefined>;

class A2ARun implements HarnessRun {
  readonly events = new EventQueue();
  /** The stream whose end counts (a follow-up supersedes the one before it). */
  private gen = 0;
  /** An `input` ask is out: its stream closing is expected, not a disconnect. */
  private waitingAnswer = false;
  /** Aborts every stream of this run (the run's signal, an end, a cancel). */
  private readonly stop = new AbortController();

  constructor(
    private readonly ctx: RunCtx,
    readonly state: MapState,
    signal: AbortSignal,
  ) {
    if (signal.aborted) this.stop.abort();
    else signal.addEventListener("abort", () => this.stop.abort(), { once: true });
  }

  /**
   * Read one stream into the queue. `opener`: resolves at the first frame (or
   * the stream's end) and rejects on an error before any frame — so `start`
   * can throw «unreachable». Otherwise never rejects: errors become events.
   */
  open(stream: StreamOpener, opener: boolean): Promise<void> {
    const g = ++this.gen;
    return new Promise<void>((resolve, reject) => {
      let before = true;
      void (async () => {
        let error: unknown;
        try {
          for await (const resp of stream(this.stop.signal)) {
            if (this.stop.signal.aborted || this.events.closed) break;
            this.accept(resp);
            if (before) {
              before = false;
              resolve();
            }
            if (this.state.ended) break;
          }
        } catch (err) {
          error = err ?? new Error("stream failed");
        }
        const pre = opener && before;
        before = false;
        const startError = this.streamDone(g, error, pre);
        if (startError !== undefined) reject(startError);
        else resolve();
      })();
    });
  }

  accept(resp: StreamResponse): void {
    for (const ev of mapStreamResponse(dedupeTask(resp, this.state), this.state)) {
      if (ev.kind === "ask" && ev.ask.type === "input") this.waitingAnswer = true;
      this.emit(ev);
    }
    if (this.state.taskId !== undefined) this.ctx.onTask(this.state.taskId, this.state);
  }

  /** A stream ended. Returns the error `start` must throw, when it must. */
  private streamDone(g: number, error: unknown, pre: boolean): unknown {
    const flags = this.ctx.flags;
    if (this.events.closed || this.state.ended || g !== this.gen || this.stop.signal.aborted) {
      return pre ? (error ?? new Error("stopped")) : undefined;
    }
    if (error !== undefined) {
      if (flags.authStatus !== undefined) {
        // 401/403: the same path as a remote AUTH_REQUIRED (the token never in the text).
        this.state.askSeq += 1;
        this.emit({
          kind: "ask",
          askId: `${this.state.taskId ?? "task"}:${this.state.askSeq}`,
          ask: { type: "auth", explanation: `HTTP ${flags.authStatus} from the agent` },
        });
        return undefined;
      }
      if (flags.refused !== undefined) {
        if (pre) return new A2APolicyError(flags.refused);
        // Never a reconnect loop against a refused destination.
        this.state.ended = true;
        this.emit({ kind: "end", status: "failed", error: flags.refused });
        return undefined;
      }
      if (pre) return error;
      this.emit({ kind: "disconnected", reason: this.ctx.scrub(error) });
      return undefined;
    }
    if (this.waitingAnswer) return undefined; // INPUT_REQUIRED closes the stream: wait for `answer`
    const closed = streamClosedEvent(this.state);
    if (closed !== undefined) this.emit(closed);
    return undefined;
  }

  private emit(ev: HarnessEvent): void {
    this.events.push(ev);
    if (ev.kind === "end" || ev.kind === "disconnected") {
      this.events.close();
      this.stop.abort();
    }
  }

  async answer(_askId: string, decision: HarnessDecision): Promise<void> {
    if (this.events.closed || this.state.ended) return;
    if (!decision.allow) {
      await this.cancel();
      return;
    }
    const taskId = this.state.taskId;
    if (taskId === undefined) {
      this.state.ended = true;
      this.emit({ kind: "end", status: "failed", error: "the agent asked outside a task" });
      return;
    }
    const input = decision.input;
    const text = buildOutboundText(
      typeof input === "string" ? input : (JSON.stringify(input) ?? ""),
    );
    this.waitingAnswer = false;
    this.state.answerOutstanding = true; // F-b: the follow-up opens with the stale snapshot
    const contextId = this.state.contextId ?? "";
    void this.open(
      (signal) =>
        this.ctx.client.sendMessageStream(messageParams(text, taskId, contextId), { signal }),
      false,
    );
  }

  async send(): Promise<void> {
    throw new Error(`${this.ctx.id} does not accept steering`);
  }

  async cancel(): Promise<"confirmed" | "unconfirmed"> {
    if (this.state.ended) return "confirmed";
    if (this.events.closed) return "unconfirmed";
    const id = this.state.taskId;
    let confirmed = false;
    if (id !== undefined) {
      try {
        const task = await this.ctx.client.cancelTask(
          { tenant: "", id, metadata: {} },
          { signal: AbortSignal.timeout(this.ctx.cancelTimeoutMs) },
        );
        confirmed = task.status?.state === TaskState.TASK_STATE_CANCELED;
      } catch {
        confirmed = false; // not cancelable / timed out / network: "unconfirmed"
      }
    }
    if (this.state.ended) return "confirmed"; // the stream ended it meanwhile
    this.stop.abort();
    if (confirmed) {
      this.state.ended = true;
      this.emit({ kind: "end", status: "cancelled" });
      return "confirmed";
    }
    this.events.close();
    return "unconfirmed";
  }
}

// ── the adapter ─────────────────────────────────────────────────────

export interface A2AAdapterOptions {
  /** The instance name (`harnesses.<name>`); the adapter id is `a2a:<name>`. */
  readonly name: string;
  /** The agent card's full URL; its origin is the pinned origin. */
  readonly cardUrl: string;
  /** Prints the bearer token (never a literal). Refused for a `proposed` agent. */
  readonly tokenCommand?: string;
  readonly policy?: A2ANetworkPolicy;
  /** Default: the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly runCommand?: A2ACommandRunner;
  readonly lookup?: A2ALookup;
  /** Default 10 s. */
  readonly tokenTimeoutMs?: number;
  /** How long `cancel` waits for `CANCELED`. Default 5 s. */
  readonly cancelTimeoutMs?: number;
}

export interface A2AAdapter extends HarnessAdapter {
  readonly reattach: NonNullable<HarnessAdapter["reattach"]>;
  /** The configured card URL's origin: where every request goes. */
  readonly origin: string;
  /** The LIVE card the last good probe read (C5: compared with the frozen blurb). */
  card(): AgentCard | undefined;
}

export function createA2AAdapter(o: A2AAdapterOptions): A2AAdapter {
  const id = `a2a:${o.name}`;
  const policy = o.policy ?? "configured";
  if (policy === "proposed" && o.tokenCommand !== undefined) {
    throw new Error(`${id}: a proposed agent never has a token`);
  }
  let origin: string;
  try {
    origin = new URL(o.cardUrl).origin;
  } catch {
    throw new Error(`${id}: the card URL is not a valid URL`);
  }
  const base = o.fetch ?? ((input, init) => fetch(input, init));
  const lookup = o.lookup ?? defaultLookup;
  const cancelTimeoutMs = o.cancelTimeoutMs ?? 5_000;
  let token: string | undefined;
  let live: { readonly card: AgentCard; readonly url: string } | undefined;
  /** Per task id, for `reattach` (artifacts already shown, ask sequence). */
  const states = new Map<string, MapState>();

  const scrub = (err: unknown): string => {
    let text = err instanceof Error ? err.message : String(err);
    if (token) text = text.split(token).join("[redacted]");
    return oneLine(redactText(text), 300);
  };

  const readToken = async (signal: AbortSignal): Promise<void> => {
    if (o.tokenCommand === undefined || token !== undefined) return;
    const run = o.runCommand ?? defaultRunner;
    const limit = o.tokenTimeoutMs ?? 10_000;
    const ctl = new AbortController();
    const onAbort = (): void => ctl.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
        reject(new Error("timeout"));
      }, limit);
    });
    let out: string;
    try {
      out = await Promise.race([run(o.tokenCommand, ctl.signal), deadline]);
    } catch {
      // Never the command's output or error text: it may hold the secret.
      throw new Error(
        timedOut
          ? `tokenCommand did not finish within ${Math.max(1, Math.round(limit / 1000))}s`
          : "tokenCommand failed",
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    const value = out.trim();
    const unusable =
      value === "" || [...value].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127);
    if (unusable) throw new Error("tokenCommand printed no usable token");
    token = value;
  };

  const probe = async (signal: AbortSignal): Promise<HarnessProbe> => {
    // The card is public metadata: fetched WITHOUT the token.
    const cardFetch = pinnedFetch({ origin, policy, lookup, base, signal });
    let card: AgentCard;
    try {
      card = await new DefaultAgentCardResolver({ fetchImpl: cardFetch }).resolve(o.cardUrl, "");
    } catch (err) {
      return { ok: false, reason: `${id}: card not readable (${scrub(err)})` };
    }
    const check = checkCard(card, o.cardUrl);
    if (!check.ok) return { ok: false, reason: `${id}: ${check.reason}` };
    try {
      await readToken(signal);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `${id}: ${why} — check harnesses.${o.name}.tokenCommand` };
    }
    live = { card, url: check.url };
    return { ok: true, ...(card.version ? { version: card.version } : {}) };
  };

  const ready = async (signal: AbortSignal): Promise<{ card: AgentCard; url: string }> => {
    if (live === undefined) {
      const p = await probe(signal);
      if (!p.ok || live === undefined) throw new Error(p.reason ?? `${id} is not usable`);
    }
    return live;
  };

  const newRun = async (
    signal: AbortSignal,
    state: MapState,
  ): Promise<{ run: A2ARun; client: Client; flags: RunFlags }> => {
    const pinned = await ready(signal);
    const flags: RunFlags = {};
    const fetchImpl = pinnedFetch({
      origin,
      policy,
      lookup,
      base,
      token: () => token,
      onStatus: (status) => {
        if (status === 401 || status === 403) flags.authStatus = status;
      },
      onRefused: (reason) => {
        flags.refused = reason;
      },
    });
    // Only the interface the checks accepted: the SDK cannot pick another one.
    const iface = pinned.card.supportedInterfaces.find(
      (i) =>
        i.url === pinned.url &&
        i.protocolBinding === "JSONRPC" &&
        /^1(\.|$)/.test(i.protocolVersion),
    );
    const factory = new ClientFactory({
      ...ClientFactoryOptions.default,
      transports: [new JsonRpcTransportFactory({ fetchImpl })],
    });
    const client = await factory.createFromAgentCard({
      ...pinned.card,
      supportedInterfaces: iface ? [iface] : [],
    });
    const run = new A2ARun(
      {
        id,
        client,
        flags,
        scrub,
        cancelTimeoutMs,
        onTask: (taskId, s) => {
          if (!states.has(taskId)) states.set(taskId, s);
        },
      },
      state,
      signal,
    );
    return { run, client, flags };
  };

  return {
    id,
    kind: "remote",
    caps: A2A_CAPS,
    origin,
    card: () => live?.card,
    probe,
    async start(spec: HarnessRunSpec, signal: AbortSignal): Promise<HarnessRun> {
      if (spec.mode !== "remote") throw new Error(`${id} accepts only mode "remote"`);
      const { run, client, flags } = await newRun(signal, newMapState(id, o.cardUrl));
      const text = buildOutboundText(spec.prompt);
      // Q3 a: a NEW remote conversation per call.
      const contextId = crypto.randomUUID();
      try {
        await run.open(
          (s) => client.sendMessageStream(messageParams(text, "", contextId), { signal: s }),
          true,
        );
      } catch (err) {
        if (flags.refused !== undefined) throw new Error(`${id} ${flags.refused}`);
        throw new Error(`${id} unreachable: ${scrub(err)} — a task may have been created remotely`);
      }
      return run;
    },
    async reattach(handle: HarnessHandle, signal: AbortSignal): Promise<HarnessRun> {
      let state = states.get(handle.id);
      if (state === undefined || state.ended) {
        // Fresh, or a run that already ended: a new state that only remembers
        // which artifacts were shown (an ended state would map nothing).
        const seen = state?.artifacts;
        state = newMapState(id, o.cardUrl);
        for (const [k, v] of seen ?? []) state.artifacts.set(k, v);
        state.taskId = handle.id;
        if (handle.extra?.contextId) state.contextId = handle.extra.contextId;
        state.started = true;
        states.set(handle.id, state);
      }
      // A resubscribe's snapshot is CURRENT: an interrupted one is a question still open.
      state.answerOutstanding = false;
      const { run, client, flags } = await newRun(signal, state);
      try {
        await run.open(
          (s) => client.resubscribeTask({ tenant: "", id: handle.id }, { signal: s }),
          true,
        );
        return run;
      } catch (err) {
        if (flags.refused !== undefined) throw new Error(`${id} ${flags.refused}`);
        // A terminal task refuses a resubscribe: one read for its artifacts.
        const task = await client.getTask(
          { tenant: "", id: handle.id, historyLength: 0 },
          { signal },
        );
        if (!isTerminal(task)) throw new Error(`${id}: task ${handle.id}: ${scrub(err)}`);
        run.accept({ payload: { $case: "task", value: task } } as StreamResponse);
        return run;
      }
    },
  };
}
