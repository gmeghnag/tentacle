import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonSessionStore } from "@tentacle/agent";
import {
  DISMISSED,
  type ModelProvider,
  PermissionBroker,
  type PermissionRequest,
  type PermissionResponse,
} from "@tentacle/core";
import { Method, PROTOCOL_VERSION } from "@tentacle/protocol";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { ARGS, cliMode, parseArgs } from "../src/flags.ts";
import {
  type HooksTrustStore,
  type TrustEntry,
  createHooksTrustResolver,
  fileTrustStore,
  hooksTrustCommand,
  hooksTrustDetail,
  projectHooksWireProblem,
  trustOutcome,
  trustPrecheck,
} from "../src/hooks-trust.ts";
import { createLocalRuntime } from "../src/local-runtime.ts";
import { SessionSaver } from "../src/session-saver.ts";

const PARAMS = {
  sessionId: "s1",
  folder: "/repo",
  hash: "h1",
  files: [".agents/hooks.json"],
  hooks: [{ event: "tool_call", matcher: "shell", command: "./guard.sh" }],
  canAllow: true,
};

const ONCE: PermissionResponse = { allowed: true, scope: "once" };
const ALWAYS: PermissionResponse = { allowed: true, scope: "session" };
const NO: PermissionResponse = { allowed: false };
const NEVER: PermissionResponse = { allowed: false, scope: "session" };

function memoryStore(initial: Record<string, TrustEntry> = {}) {
  const data = new Map(Object.entries(initial));
  const writes: [string, TrustEntry][] = [];
  const store: HooksTrustStore = {
    get: (f) => data.get(f),
    set: (f, e) => {
      writes.push([f, e]);
      data.set(f, e);
    },
    delete: (f) => data.delete(f),
    list: () => [...data.entries()],
  };
  return { store, writes };
}

/** A broker whose requester answers `response` and records each request. */
function spyBroker(response: PermissionResponse) {
  const seen: PermissionRequest[] = [];
  const broker = new PermissionBroker(async (req) => {
    seen.push(req);
    return response;
  });
  return { broker, seen };
}

describe("trustPrecheck", () => {
  test("never → declined, whatever the hash (P2)", () => {
    expect(trustPrecheck({ hash: "old", decision: "never" }, "h1", true)).toBe("declined");
    expect(trustPrecheck({ hash: "h1", decision: "never" }, "h1", true)).toBe("declined");
  });
  test("trusted with the same hash → trusted (even non-interactive)", () => {
    expect(trustPrecheck({ hash: "h1", decision: "trusted" }, "h1", false)).toBe("trusted");
  });
  test("trusted with another hash (a changed definition) → ask", () => {
    expect(trustPrecheck({ hash: "old", decision: "trusted" }, "h1", true)).toBe("ask");
  });
  test("no entry → ask; non-interactive → declined", () => {
    expect(trustPrecheck(undefined, "h1", true)).toBe("ask");
    expect(trustPrecheck(undefined, "h1", false)).toBe("declined");
    expect(trustPrecheck({ hash: "old", decision: "trusted" }, "h1", false)).toBe("declined");
  });
});

describe("trustOutcome", () => {
  test("menu answers", () => {
    expect(trustOutcome(ONCE)).toEqual({ trusted: true });
    expect(trustOutcome(ALWAYS)).toEqual({ trusted: true, store: "trusted" });
    expect(trustOutcome(NO)).toEqual({ trusted: false });
    expect(trustOutcome(NEVER)).toEqual({ trusted: false, store: "never" });
    expect(trustOutcome(DISMISSED)).toEqual({ trusted: false });
  });
  test("a scope-less allow (a headless allowAll requester, not a human) never trusts", () => {
    expect(trustOutcome({ allowed: true })).toEqual({ trusted: false });
  });
});

describe("createHooksTrustResolver", () => {
  test("asks through THE broker as a hooks_trust request, store-backed when a store exists", async () => {
    const { broker, seen } = spyBroker(ONCE);
    const { store } = memoryStore();
    const resolve = createHooksTrustResolver({ broker, interactive: true, store });
    expect(await resolve(PARAMS)).toEqual({ trusted: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("hooks_trust");
    expect((seen[0]?.input as { storeBacked: boolean }).storeBacked).toBe(true);
    expect(seen[0]?.detail).toContain("tool_call shell → ./guard.sh");
    expect(seen[0]?.detail).toContain("can approve tool calls");
    expect(seen[0]?.detail).toContain("not the contents of the files");
  });

  const rows: [string, PermissionResponse, boolean, TrustEntry["decision"] | undefined][] = [
    ["Trust for this session", ONCE, true, undefined],
    ["Always trust this project", ALWAYS, true, "trusted"],
    ["Don't trust", NO, false, undefined],
    ["Never for this project", NEVER, false, "never"],
    ["dismissed / withdrawn", DISMISSED, false, undefined],
  ];
  for (const [label, response, trusted, stored] of rows) {
    test(`with a store: ${label}`, async () => {
      const { broker } = spyBroker(response);
      const { store, writes } = memoryStore();
      const resolve = createHooksTrustResolver({ broker, interactive: true, store });
      expect(await resolve(PARAMS)).toEqual({ trusted });
      expect(writes).toEqual(stored ? [["/repo", { hash: "h1", decision: stored }]] : []);
    });
  }

  test("no store (pod, connect): never writes, whatever the answer; the 2-choice menu", async () => {
    for (const response of [ONCE, ALWAYS, NO, NEVER]) {
      const { broker, seen } = spyBroker(response);
      const resolve = createHooksTrustResolver({ broker, interactive: true });
      await resolve(PARAMS);
      expect((seen[0]?.input as { storeBacked: boolean }).storeBacked).toBe(false);
    }
  });

  test("a stored decision answers without asking; a changed hash asks again", async () => {
    const { broker, seen } = spyBroker(NO);
    const { store } = memoryStore({ "/repo": { hash: "h1", decision: "trusted" } });
    const resolve = createHooksTrustResolver({ broker, interactive: true, store });
    expect(await resolve(PARAMS)).toEqual({ trusted: true });
    expect(seen).toHaveLength(0);
    expect(await resolve({ ...PARAMS, hash: "h2" })).toEqual({ trusted: false });
    expect(seen).toHaveLength(1);
  });

  test("never → declined without asking", async () => {
    const { broker, seen } = spyBroker(ONCE);
    const { store } = memoryStore({ "/repo": { hash: "x", decision: "never" } });
    const resolve = createHooksTrustResolver({ broker, interactive: true, store });
    expect(await resolve(PARAMS)).toEqual({ trusted: false });
    expect(seen).toHaveLength(0);
  });

  test("non-interactive → declined without asking, with a notice", async () => {
    const { broker, seen } = spyBroker(ONCE);
    const notices: string[] = [];
    const resolve = createHooksTrustResolver({
      broker,
      interactive: false,
      notify: (l) => notices.push(l),
    });
    expect(await resolve(PARAMS)).toEqual({ trusted: false });
    expect(seen).toHaveLength(0);
    expect(notices).toHaveLength(1);
  });

  test("a headless (allowAll) broker never silently trusts", async () => {
    const resolve = createHooksTrustResolver({ broker: new PermissionBroker(), interactive: true });
    expect(await resolve(PARAMS)).toEqual({ trusted: false });
  });

  test("the signal withdraws the prompt (a dropped link) → declined", async () => {
    const broker = new PermissionBroker(undefined, { holdUntilSet: true }); // no TUI yet
    const resolve = createHooksTrustResolver({ broker, interactive: true });
    const controller = new AbortController();
    const pending = resolve(PARAMS, controller.signal);
    controller.abort();
    expect(await pending).toEqual({ trusted: false });
  });
});

describe("fileTrustStore", () => {
  test("round-trips, 0600, delete; a corrupt file reads as empty and is reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "hooks-trust-"));
    const errors: string[] = [];
    const store = fileTrustStore(dir, (m) => errors.push(m));
    expect(store.get("/repo")).toBeUndefined();
    store.set("/repo", { hash: "h1", decision: "trusted" });
    store.set("/other", { hash: "h2", decision: "never" });
    expect(fileTrustStore(dir).get("/repo")).toEqual({ hash: "h1", decision: "trusted" });
    expect(statSync(join(dir, "hooks-trust.json")).mode & 0o777).toBe(0o600);
    expect(store.delete("/repo")).toBe(true);
    expect(store.delete("/repo")).toBe(false);
    expect(store.list()).toEqual([["/other", { hash: "h2", decision: "never" }]]);
    writeFileSync(join(dir, "hooks-trust.json"), "{ corrupt");
    expect(store.list()).toEqual([]);
    expect(errors).toHaveLength(1);
    store.set("/repo", { hash: "h3", decision: "trusted" });
    expect(JSON.parse(readFileSync(join(dir, "hooks-trust.json"), "utf8"))).toEqual({
      "/repo": { hash: "h3", decision: "trusted" },
    });
  });
});

/**
 * The load-bearing assumption: the laptop picks the resolver per runtime. A
 * pod runtime (it tunnels the model through us) never writes the store,
 * whatever the request says and whatever the human answers.
 */
describe("createLocalRuntime wiring (hooks/trust)", () => {
  const unusedModel: ModelProvider = {
    id: "unused",
    // biome-ignore lint/correctness/useYield: never called
    async *stream() {
      throw new Error("unused");
    },
  };

  async function rig(modelProvider: ModelProvider | undefined, answer: PermissionResponse) {
    const [daemonCh, clientCh] = createChannelPair();
    let opened: string | undefined;
    const daemon = new RpcPeer(daemonCh, {
      onRequest: (method, params) => {
        const p = params as { sessionId?: string; turnId?: string };
        if (method === Method.Open) {
          opened = p.sessionId ?? "s1";
          return { sessionId: opened, epoch: "e", created: true, resync: false };
        }
        if (method === Method.Prompt) {
          return { turnId: p.turnId }; // the turn never ends: only the session matters
        }
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { tools: true, permissions: true },
        };
      },
    });
    const { store, writes } = memoryStore();
    const { broker, seen } = spyBroker(answer);
    const dir = mkdtempSync(join(tmpdir(), "hooks-trust-rt-"));
    const runtime = await createLocalRuntime({
      channel: clientCh,
      disposeTransport: () => daemon.close(),
      permissions: broker,
      saver: new SessionSaver(new JsonSessionStore(dir), () => {}),
      cwd: "/tmp/work",
      model: "m",
      resume: null,
      hooksTrustStore: store,
      ...(modelProvider ? { modelProvider } : {}),
    });
    // The laptop answers `hooks/trust` only for a session it opened: open one.
    const iterator = runtime.createSession().send("hi")[Symbol.asyncIterator]();
    void iterator.next().catch(() => {});
    const start = Date.now();
    while (opened === undefined && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const params = { ...PARAMS, sessionId: opened ?? "none" };
    return { daemon, runtime, writes, seen, params };
  }

  test("local worker: the human's 'Always trust' is stored", async () => {
    const { daemon, runtime, writes, seen, params } = await rig(undefined, ALWAYS);
    expect(await daemon.request(Method.HooksTrust, params)).toEqual({ trusted: true });
    expect(seen).toHaveLength(1);
    expect(writes).toEqual([["/repo", { hash: "h1", decision: "trusted" }]]);
    runtime.dispose();
  });

  test("pod runtime: asked through the same broker, NEVER stored (D5)", async () => {
    for (const answer of [ALWAYS, NEVER]) {
      const { daemon, runtime, writes, seen, params } = await rig(unusedModel, answer);
      await daemon.request(Method.HooksTrust, { ...params, canAllow: true });
      expect(seen).toHaveLength(1);
      expect((seen[0]?.input as { storeBacked: boolean }).storeBacked).toBe(false);
      expect(writes).toEqual([]);
      runtime.dispose();
    }
  });
});

describe("tentacle hooks trust (P3)", () => {
  test("`hooks` is a subcommand; --list and --revoke conflict", () => {
    expect(cliMode(["hooks", "trust", "--list"])).toBe("hooks");
    expect(parseArgs(["trust", "--list", "--revoke", "/x"], ARGS.hooks).ok).toBe(false);
    expect(parseArgs(["trust", "--revoke", "/x"], ARGS.hooks).ok).toBe(true);
  });

  test("--list prints each decision; --revoke deletes one", () => {
    const { store } = memoryStore({ "/repo": { hash: "abcdef0123456789", decision: "trusted" } });
    const out: string[] = [];
    expect(
      hooksTrustCommand(store, { positional: ["trust"], list: true }, (l) => out.push(l)),
    ).toBe(0);
    expect(out).toEqual(["trusted\tabcdef012345\t/repo\n"]);
    expect(
      hooksTrustCommand(store, { positional: ["trust"], list: false, revoke: "/repo" }, () => {}),
    ).toBe(0);
    expect(store.get("/repo")).toBeUndefined();
    expect(
      hooksTrustCommand(store, { positional: ["trust"], list: false, revoke: "/repo" }, () => {}),
    ).toBe(1);
    expect(hooksTrustCommand(store, { positional: ["nope"], list: true }, () => {})).toBe(1);
  });
});

describe("revoke and startup diagnostics", () => {
  test("--revoke resolves the folder's real path (`.`, `..`, a symlinked tmpdir)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hooks-revoke-"));
    mkdirSync(join(dir, "sub"));
    const real = realpathSync(dir);
    const { store } = memoryStore({ [real]: { hash: "h", decision: "never" } });
    const out: string[] = [];
    const code = hooksTrustCommand(
      store,
      { positional: ["trust"], list: false, revoke: join(dir, "sub", "..") },
      (l) => out.push(l),
    );
    expect(code).toBe(0);
    expect(store.get(real)).toBeUndefined();
  });

  test("project hooks the hooks/trust request could never carry → a startup diagnostic", () => {
    const base = {
      folder: "/repo",
      hash: "h1",
      files: [".agents/hooks.json"],
      hooks: [{ event: "turn_start" as const, command: "./a.sh" }],
    };
    expect(projectHooksWireProblem(base)).toBeUndefined();
    const bad = projectHooksWireProblem({
      ...base,
      hooks: [{ event: "turn_start" as const, command: "./a.sh\u001b[2J" }],
    });
    expect(bad).toContain("cannot be offered for trust");
    expect(bad).toContain("hooks.0.command");
    const many = Array.from({ length: 101 }, () => base.hooks[0] as (typeof base.hooks)[0]);
    expect(projectHooksWireProblem({ ...base, hooks: many })).toContain("hooks");
  });
});

describe("hooksTrustDetail", () => {
  test("shows a hook's judge model when present, nothing when absent", () => {
    const detail = hooksTrustDetail({
      ...PARAMS,
      hooks: [
        { event: "tool_call", matcher: "shell", command: "./judge.sh", model: "judge" },
        { event: "turn_start", command: "./a.sh" },
      ],
    });
    expect(detail).toContain("tool_call shell → ./judge.sh (model: judge)");
    expect(detail).toContain("turn_start → ./a.sh\n");
    expect(detail).not.toContain("turn_start → ./a.sh (model");
  });
});
