/**
 * `app_publish` / `app_unpublish` (docs/feat/session-apps-publish.md): the ask
 * is the gate — built by a pure function, raised on the injected broker only,
 * and nothing is published without a yes.
 */
import { describe, expect, test } from "bun:test";
import {
  type AppsLink,
  type PermissionRequest,
  type PermissionRequestOptions,
  type PermissionResponse,
  type PreparedPublish,
  type ToolContext,
  autoApproves,
  onceOnlyAsk,
} from "@tentacle/core";
import type { AppRow, ArtifactMeta } from "@tentacle/protocol";
import { appPublishAsk, createAppPublishTool, createAppUnpublishTool } from "../src/app-publish.ts";

const meta: ArtifactMeta = {
  artifactId: "demo",
  version: 2,
  sha256: "0123456789abcdef".repeat(4),
  size: 2048,
  mimeType: "text/html",
  kind: "html",
  title: "Demo page",
  callId: "c0",
  createdAt: 1,
};
const URL_ = "https://abcdefghijklmnop.apps.example.so/";
const ROW: AppRow = {
  app: "abcdefghijklmnop",
  url: URL_,
  artifactId: "demo",
  version: 2,
  title: "Demo page",
  state: "up",
  since: 1,
  publishedAt: 1,
};
const create: PreparedPublish = {
  ok: true,
  kind: "create",
  domain: "apps.example.so",
  meta,
  bytes: new Uint8Array([1]),
  findings: [],
};
const update: PreparedPublish = { ...create, kind: "update", app: ROW.app, url: URL_ };
const findings = [
  { rule: "github-token", line: 3 },
  { rule: "assignment", line: 9 },
];

describe("appPublishAsk", () => {
  test("a create: its own kind, once-only, never auto-accepted", () => {
    const ask = appPublishAsk(create);
    expect(ask).toMatchObject({ kind: "app_publish", tool: "app_publish", level: "ask" });
    expect(autoApproves(ask, true)).toBe(false);
    expect(onceOnlyAsk(ask)).toBe(true);
    expect(ask.suggestion).toBeUndefined();
    expect(ask.title).toBe('Publish "Demo page" as a public web page?');
    expect(ask.detail?.split("\n")).toEqual([
      "URL: a new random address under https://*.apps.example.so",
      "Artifact: demo v2 · 2.0 KiB · sha256 0123456789ab",
      "Anyone with the link can open it until this session ends",
      "Network is blocked inside the page",
    ]);
    expect(ask.input).toEqual({ artifact: "demo", version: 2, sha256: meta.sha256 });
  });

  test("an update names the URL it replaces", () => {
    const ask = appPublishAsk(update);
    expect(ask.title).toBe(`Update the public page ${URL_}?`);
    expect(ask.detail).toContain(`URL: ${URL_}`);
  });

  test("findings change the title and are listed by rule and line", () => {
    const one = appPublishAsk({ ...create, findings: findings.slice(0, 1) });
    expect(one.title).toBe('Publish "Demo page" as a public web page despite 1 possible secret?');
    const two = appPublishAsk({ ...update, findings });
    expect(two.title).toBe(`Update the public page ${URL_} despite 2 possible secrets?`);
    expect(two.detail?.split("\n").slice(-2)).toEqual([
      "possible github-token on line 3",
      "possible assignment on line 9",
    ]);
    const many = Array.from({ length: 20 }, (_, i) => ({ rule: "jwt", line: i + 1 }));
    expect(appPublishAsk({ ...create, findings: many }).title).toContain("20+ possible secrets");
  });

  test("model text is flattened: no line can be forged in the ask", () => {
    const hostile = { ...meta, title: "ok\u001b[2J\nNetwork is allowed‮" };
    const ask = appPublishAsk({ ...create, meta: hostile });
    expect(ask.title).toBe('Publish "ok [2J Network is allowed" as a public web page?');
    expect(ask.detail?.split("\n")).toHaveLength(4);
  });
});

class Link implements AppsLink {
  readonly calls: string[] = [];
  prepared: PreparedPublish | { ok: false; reason: string } = create;
  result: Awaited<ReturnType<AppsLink["publish"]>> = { ok: true, row: ROW };
  async prepare(input: { artifact: string; version?: number | undefined }) {
    this.calls.push(`prepare ${input.artifact} ${input.version ?? "-"}`);
    return this.prepared;
  }
  async publish() {
    this.calls.push("publish");
    return this.result;
  }
  async unpublish(app: string) {
    this.calls.push(`unpublish ${app}`);
    return app === ROW.app ? { ok: true } : { ok: false, reason: "no such app" };
  }
  list() {
    return [ROW];
  }
}

class Broker {
  readonly seen: { req: PermissionRequest; options: PermissionRequestOptions | undefined }[] = [];
  constructor(private readonly answer: PermissionResponse) {}
  readonly request = async (req: PermissionRequest, options?: PermissionRequestOptions) => {
    this.seen.push({ req, options });
    return this.answer;
  };
}

const signal = new AbortController().signal;
const ctx = { toolCallId: "call-7", signal } as unknown as ToolContext;
const run = (link: Link | null, broker: Broker) =>
  createAppPublishTool({ link: () => link, ask: broker.request }).execute(
    { artifact: "demo" },
    ctx,
  );

describe("app_publish", () => {
  test("asks on the injected broker, once per publish, then publishes", async () => {
    const link = new Link();
    const session = new Broker({ allowed: true });
    const other = new Broker({ allowed: true });
    const result = await run(link, session);
    expect(session.seen).toHaveLength(1);
    expect(other.seen).toHaveLength(0);
    expect(session.seen[0]?.req).toEqual(appPublishAsk(create));
    expect(session.seen[0]?.options).toEqual({
      toolCallId: "call-7",
      origin: "call",
      signal,
    });
    expect(link.calls).toEqual(["prepare demo -", "publish"]);
    expect(result).toEqual({
      content: `Published "Demo page" at ${URL_} — live while this session is open`,
    });
  });

  test("it raises no generic tool ask", () => {
    const tool = createAppPublishTool({
      link: () => null,
      ask: new Broker({ allowed: true }).request,
    });
    expect(tool.permission).toBe("none");
    expect(typeof tool.concurrency === "function" && tool.concurrency({})).toEqual([
      { mode: "write", resource: "apps" },
    ]);
  });

  test("declined: nothing published, the reply passed on", async () => {
    const link = new Link();
    const result = await run(link, new Broker({ allowed: false, message: "not yet" }));
    expect(link.calls).toEqual(["prepare demo -"]);
    expect(result.isError).toBe(true);
    expect(result.content).toBe("not published: the user declined — they said: not yet");
  });

  test("no one to ask: nothing published, the reason said", async () => {
    const link = new Link();
    const result = await run(
      link,
      new Broker({ allowed: false, reason: "no client attached" } as PermissionResponse),
    );
    expect(link.calls).not.toContain("publish");
    expect(result.content).toContain("no one could be asked (no client attached)");
  });

  test("a refusal of the checks asks nobody", async () => {
    const link = new Link();
    link.prepared = { ok: false, reason: `already live at ${URL_}` };
    const broker = new Broker({ allowed: true });
    const result = await run(link, broker);
    expect(broker.seen).toHaveLength(0);
    expect(link.calls).toEqual(["prepare demo -"]);
    expect(result.content).toBe(`not published: already live at ${URL_}`);
  });

  test("no link: an error, nothing asked", async () => {
    const broker = new Broker({ allowed: true });
    const result = await run(null, broker);
    expect(result).toEqual({
      content: "publishing apps is not available in this session",
      isError: true,
    });
    expect(broker.seen).toHaveLength(0);
  });

  test("a host refusal comes back as the tool's error", async () => {
    const link = new Link();
    link.result = { ok: false, reason: "publishing is paused by the operator" };
    const result = await run(link, new Broker({ allowed: true }));
    expect(result).toEqual({
      content: "not published: publishing is paused by the operator",
      isError: true,
    });
  });
});

describe("app_unpublish", () => {
  test("stops this session's app without asking; an unknown one is an error", async () => {
    const link = new Link();
    const tool = createAppUnpublishTool(() => link);
    expect(tool.permission).toBe("none");
    expect(await tool.execute({ app: ROW.app }, ctx)).toEqual({ content: `Stopped ${ROW.app}` });
    expect(await tool.execute({ app: "zzz" }, ctx)).toEqual({
      content: "not stopped: no such app",
      isError: true,
    });
    const none = createAppUnpublishTool(() => null);
    expect((await none.execute({ app: ROW.app }, ctx)).isError).toBe(true);
  });
});
