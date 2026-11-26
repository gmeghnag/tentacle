/**
 * Remote agents the MODEL proposed and the owner approved, for one session
 * (docs/feat/a2a-client.md C11): a per-session registry the sub-agent runner
 * resolves types from, next to the configured ones. Never in config, never
 * written to disk: it lives as long as the session's approvals (`SessionGrants`
 * — kept across a settings rebuild, dropped by `/clear`), and a restart loses it.
 */
import type { SessionGrants } from "../session-grants.ts";
import type { AgentType } from "../subagent.ts";
import { cardBlurb, checkCard, oneLine, proposedUrlRefusal, reportHeader } from "./a2a-map.ts";
import {
  type A2AAgentCard,
  type A2ALookup,
  A2APolicyError,
  createA2AAdapter,
  fetchA2ACard,
} from "./a2a.ts";
import type { HarnessInstance } from "./child.ts";

/** C11: the card read for a proposed agent — at most this many bytes, in this long. */
export const PROPOSED_CARD_MAX_BYTES = 64 * 1024;
export const PROPOSED_CARD_TIMEOUT_MS = 10_000;

/** One approved agent: its `a2a:<name>` type and the instance it runs on. */
export interface ProposedAgent {
  /** The instance name (`a2a:<name>` is the type). */
  readonly name: string;
  readonly type: AgentType;
  readonly instance: HarnessInstance;
  readonly origin: string;
  /** The card's text, marked remote (C5's blurb without the type name). */
  readonly summary: string;
}

export class ProposedAgents {
  private readonly byType = new Map<string, ProposedAgent>();

  /** By type name (`a2a:<name>`). */
  get(typeName: string): ProposedAgent | undefined {
    return this.byType.get(typeName);
  }

  /** The agent already added for this origin, if any (a second proposal asks nothing). */
  forOrigin(origin: string): ProposedAgent | undefined {
    for (const agent of this.byType.values()) if (agent.origin === origin) return agent;
    return undefined;
  }

  add(agent: ProposedAgent): void {
    this.byType.set(agent.type.name, agent);
  }

  clear(): void {
    this.byType.clear();
  }

  get size(): number {
    return this.byType.size;
  }
}

const registries = new WeakMap<SessionGrants, ProposedAgents>();

/** The session's registry: ONE per approvals store, emptied when it is (`/clear`). */
export function proposedAgentsFor(grants: SessionGrants): ProposedAgents {
  let reg = registries.get(grants);
  if (reg === undefined) {
    const created = new ProposedAgents();
    grants.onClear(() => created.clear());
    registries.set(grants, created);
    reg = created;
  }
  return reg;
}

const NAME_MAX = 32;

/**
 * `<slug(host)>`, `-2`, `-3`… on a collision with a type that exists
 * (configured or proposed). Always a valid instance name `[a-z0-9][a-z0-9-]{0,31}`.
 */
export function proposedAgentName(host: string, taken: (typeName: string) => boolean): string {
  const slug =
    host
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, NAME_MAX)
      .replace(/-+$/, "") || "agent";
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const name = `${slug.slice(0, NAME_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken(`a2a:${name}`)) return name;
  }
}

/** The card text the add ask and the tool result show: C5's marked part only. */
function remoteSummary(card: A2AAgentCard, origin: string): string {
  // `cardBlurb` with an empty name reads `a2a:. Remote card, …`: drop the head.
  const head = "a2a:. ";
  const blurb = cardBlurb({ name: "", card, origin });
  return blurb.startsWith(head) ? blurb.slice(head.length) : blurb;
}

export type ProposedCardCheck =
  | {
      readonly ok: true;
      readonly cardUrl: string;
      readonly origin: string;
      readonly host: string;
      readonly card: A2AAgentCard;
      /** C5's marked card text. */
      readonly summary: string;
    }
  | { readonly ok: false; readonly reason: string };

/** A `fetch` that refuses a body larger than `max` bytes (the card read). */
function cappedFetch(base: typeof fetch, max: number): typeof fetch {
  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const res = await base(input, init);
    if (res.type === "opaqueredirect" || res.status < 200 || res.status >= 300 || !res.body) {
      return res; // the caller refuses it (a redirect) or reports the status
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > max) {
      await res.body.cancel().catch(() => {});
      throw new Error(`the card is larger than ${max / 1024} KiB`);
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new Error(`the card is larger than ${max / 1024} KiB`);
      }
      chunks.push(value);
    }
    return new Response(new Blob(chunks), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
  return wrapped as typeof fetch;
}

/**
 * C11 steps 1–2, before any ask: the URL's shape, then the card read through
 * the adapter's own pinned-origin `fetch` with the `proposed` address rules
 * (every request: a DNS lookup, any non-public record refuses), at most 64 KiB
 * in 10 s, never a redirect; then C2's card checks; then refused if the card
 * declares any security requirement (a proposed agent never has a token).
 */
export async function inspectProposedAgent(
  cardUrl: string,
  opts: {
    readonly signal?: AbortSignal;
    readonly fetch?: typeof fetch;
    readonly lookup?: A2ALookup;
    readonly timeoutMs?: number;
    readonly maxBytes?: number;
  } = {},
): Promise<ProposedCardCheck> {
  const shape = proposedUrlRefusal(cardUrl);
  if (shape !== undefined) return { ok: false, reason: shape };
  const url = new URL(cardUrl);
  const timeoutMs = opts.timeoutMs ?? PROPOSED_CARD_TIMEOUT_MS;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = (): void => ctl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let card: A2AAgentCard;
  try {
    card = await fetchA2ACard({
      cardUrl,
      policy: "proposed",
      fetch: cappedFetch(
        opts.fetch ?? ((input, init) => fetch(input, init)),
        opts.maxBytes ?? PROPOSED_CARD_MAX_BYTES,
      ),
      ...(opts.lookup ? { lookup: opts.lookup } : {}),
      signal: ctl.signal,
    });
  } catch (err) {
    if (err instanceof A2APolicyError) return { ok: false, reason: oneLine(err.message, 300) };
    const why =
      ctl.signal.aborted && !opts.signal?.aborted
        ? `it did not answer within ${Math.round(timeoutMs / 1000)}s`
        : oneLine(err instanceof Error ? err.message : String(err), 300);
    return { ok: false, reason: `the card could not be read: ${why}` };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
  const check = checkCard(card, cardUrl);
  if (!check.ok) return { ok: false, reason: check.reason };
  const needsAuth =
    Object.keys(card.securitySchemes ?? {}).length > 0 ||
    (card.securityRequirements ?? []).length > 0;
  if (needsAuth) {
    return {
      ok: false,
      reason: `${url.origin} needs credentials — add it under \`harnesses\` with a \`tokenCommand\``,
    };
  }
  return {
    ok: true,
    cardUrl,
    origin: url.origin,
    host: url.hostname,
    card,
    summary: remoteSummary(card, url.origin),
  };
}

/**
 * The approved agent (C11 step 4): an `a2a` adapter with the `proposed`
 * network policy and NO token, run like a configured one — C3's consent before
 * every send, C4's redaction, C5's frame, C6's questions to the user.
 */
export function createProposedAgent(o: {
  readonly name: string;
  readonly checked: Extract<ProposedCardCheck, { ok: true }>;
  readonly fetch?: typeof fetch;
  readonly lookup?: A2ALookup;
}): ProposedAgent {
  const adapter = createA2AAdapter({
    name: o.name,
    cardUrl: o.checked.cardUrl,
    policy: "proposed",
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.lookup ? { lookup: o.lookup } : {}),
  });
  const header = reportHeader(o.name, adapter.origin);
  return {
    name: o.name,
    origin: adapter.origin,
    summary: o.checked.summary,
    type: {
      name: adapter.id,
      description: o.checked.summary,
      prompt: "",
      tools: [],
      harness: { adapter: adapter.id, mode: "remote" },
    },
    instance: {
      adapter,
      idleMinutes: 30,
      inputFrom: "user",
      origin: adapter.origin,
      reportHeader: () => header,
      authHint:
        "a proposed agent has no credentials: add it under `harnesses` with a `tokenCommand`",
    },
  };
}
