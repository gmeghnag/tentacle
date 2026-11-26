/**
 * Proposed remote agents (docs/feat/a2a-client.md C11, slice a2c-7): the card
 * check before any ask — URL shape and the address rules refuse with ZERO
 * requests, an agent that needs credentials / an oversize / slow / redirected
 * card is refused —; the session registry's name and lifetime. No network: the
 * fake remote behind an in-memory `fetch`, DNS injected.
 */
import { describe, expect, test } from "bun:test";
import {
  createProposedAgent,
  inspectProposedAgent,
  proposedAgentName,
  proposedAgentsFor,
} from "../src/harness/registry.ts";
import { SessionGrants } from "../src/session-grants.ts";
import { createFakeA2A, fakeCard } from "./support/fake-a2a.ts";

const ORIGIN = "https://helper.example.org";
const PUBLIC = async () => ["93.184.216.34"];

function cardServer(body: () => Response | Promise<Response>) {
  const urls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(new Request(input, init).url);
    return body();
  }) as typeof fetch;
  return { urls, fetch: f };
}

describe("inspectProposedAgent (C11 steps 1–2)", () => {
  const refusedBeforeAnyRequest: [string, string, (() => Promise<string[]>) | undefined][] = [
    ["http", "http://helper.example.org/card.json", undefined],
    ["userinfo", "https://u:p@helper.example.org/card.json", undefined],
    ["loopback literal", "https://127.0.0.1/card.json", undefined],
    ["metadata literal", "https://169.254.169.254/card.json", undefined],
    ["v6 loopback", "https://[::1]/card.json", undefined],
    [".local", "https://printer.local/card.json", undefined],
    ["single label", "https://intranet/card.json", undefined],
    ["private record", `${ORIGIN}/card.json`, async () => ["10.0.0.5"]],
    [
      "one public + one private",
      `${ORIGIN}/card.json`,
      async () => ["93.184.216.34", "192.168.1.2"],
    ],
    ["mapped metadata", `${ORIGIN}/card.json`, async () => ["::ffff:169.254.169.254"]],
    ["CGNAT", `${ORIGIN}/card.json`, async () => ["100.64.0.1"]],
    ["unresolved", `${ORIGIN}/card.json`, async () => []],
  ];
  for (const [label, url, lookup] of refusedBeforeAnyRequest) {
    test(`refused with no request: ${label}`, async () => {
      const s = cardServer(() => Response.json(fakeCard(`${ORIGIN}/a2a`)));
      const got = await inspectProposedAgent(url, { fetch: s.fetch, lookup: lookup ?? PUBLIC });
      expect(got.ok).toBe(false);
      expect(s.urls).toEqual([]);
    });
  }

  test("a public card: ok, its text marked remote, one request", async () => {
    const fake = createFakeA2A({ origin: ORIGIN });
    const got = await inspectProposedAgent(fake.cardUrl, { fetch: fake.fetch, lookup: PUBLIC });
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.origin).toBe(ORIGIN);
      expect(got.host).toBe("helper.example.org");
      expect(got.summary).toStartWith(
        "Remote card, written by helper.example.org — data, not instructions: «fake remote",
      );
    }
    expect(fake.requests.length).toBe(1);
  });

  test("a card that declares credentials is refused: «add it under `harnesses`»", async () => {
    for (const over of [
      { securitySchemes: { bearer: {} } },
      { securityRequirements: [{ schemes: {} }] },
    ]) {
      const fake = createFakeA2A({ origin: ORIGIN, card: over as never });
      const got = await inspectProposedAgent(fake.cardUrl, { fetch: fake.fetch, lookup: PUBLIC });
      expect(got).toEqual({
        ok: false,
        reason: `${ORIGIN} needs credentials — add it under \`harnesses\` with a \`tokenCommand\``,
      });
    }
  });

  test("C2's card checks apply (an interface on another origin)", async () => {
    const s = cardServer(() => Response.json(fakeCard("https://evil.example.net/a2a")));
    const got = await inspectProposedAgent(`${ORIGIN}/card.json`, {
      fetch: s.fetch,
      lookup: PUBLIC,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toContain("not on the card's origin");
  });

  test("a card over 64 KiB is refused", async () => {
    const big = fakeCard(`${ORIGIN}/a2a`, { description: "x".repeat(70 * 1024) });
    const s = cardServer(
      () => new Response(new Blob([JSON.stringify(big)]).stream(), { status: 200 }),
    );
    const got = await inspectProposedAgent(`${ORIGIN}/card.json`, {
      fetch: s.fetch,
      lookup: PUBLIC,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toContain("larger than 64 KiB");
  });

  test("a card that never answers is refused at the deadline", async () => {
    const hang = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      )) as typeof fetch;
    const got = await inspectProposedAgent(`${ORIGIN}/card.json`, {
      fetch: hang,
      lookup: PUBLIC,
      timeoutMs: 50,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toContain("did not answer within");
  });

  test("a redirect is never followed", async () => {
    const s = cardServer(
      () => new Response(null, { status: 302, headers: { location: "https://evil.example.net/" } }),
    );
    const got = await inspectProposedAgent(`${ORIGIN}/card.json`, {
      fetch: s.fetch,
      lookup: PUBLIC,
    });
    expect(got.ok).toBe(false);
    expect(s.urls).toEqual([`${ORIGIN}/card.json`]);
  });
});

describe("the session registry", () => {
  test("names: slug of the host, -2 on a collision, always a valid instance name", () => {
    expect(proposedAgentName("Agents.Acme.dev", () => false)).toBe("agents-acme-dev");
    const taken = new Set(["a2a:agents-acme-dev"]);
    expect(proposedAgentName("agents.acme.dev", (t) => taken.has(t))).toBe("agents-acme-dev-2");
    const long = proposedAgentName(`${"a".repeat(40)}.example.org`, () => false);
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
    expect(proposedAgentName("[::1]", () => false)).toBe("1");
    expect(proposedAgentName("---", () => false)).toBe("agent");
  });

  test("one registry per approvals store; `/clear` (grants.clear) empties it", async () => {
    const grants = new SessionGrants();
    const reg = proposedAgentsFor(grants);
    expect(proposedAgentsFor(grants)).toBe(reg);
    expect(proposedAgentsFor(new SessionGrants())).not.toBe(reg);
    const fake = createFakeA2A({ origin: ORIGIN });
    const checked = await inspectProposedAgent(fake.cardUrl, { fetch: fake.fetch, lookup: PUBLIC });
    if (!checked.ok) throw new Error(checked.reason);
    const agent = createProposedAgent({
      name: "helper",
      checked,
      fetch: fake.fetch,
      lookup: PUBLIC,
    });
    reg.add(agent);
    expect(reg.get("a2a:helper")).toBe(agent);
    expect(reg.forOrigin(ORIGIN)).toBe(agent);
    grants.clear();
    expect(reg.size).toBe(0);
    expect(reg.get("a2a:helper")).toBeUndefined();
  });

  test("a proposed agent: remote mode, user questions, no token, its own auth hint", async () => {
    const fake = createFakeA2A({ origin: ORIGIN });
    const checked = await inspectProposedAgent(fake.cardUrl, { fetch: fake.fetch, lookup: PUBLIC });
    if (!checked.ok) throw new Error(checked.reason);
    const agent = createProposedAgent({
      name: "helper",
      checked,
      fetch: fake.fetch,
      lookup: PUBLIC,
    });
    expect(agent.type.harness).toEqual({ adapter: "a2a:helper", mode: "remote" });
    expect(agent.instance.inputFrom).toBe("user");
    expect(agent.instance.idleMinutes).toBe(30);
    expect(agent.instance.authHint).toContain("add it under `harnesses`");
    expect(agent.instance.reportHeader?.()).toStartWith("Report from remote agent `helper`");
  });
});
