# feat/models-map-pod — `models` in pod runs: a name on the tunnel, a laptop allowlist

> **Status:** Execution done (owner answers Q1 (c), Q2 (a), Q3 (b)); Review not started
> **Branch:** `feat/models-map-pod`, stacked on `feat/models-map` (task 3, review PASS, not merged)
> **Size:** L · **Blast:** load-bearing · **Suited:** AGENTS §10 rule for load-bearing or L: a stronger executor (the owner assigns it) + mandatory fresh-context Review that red-teams the laptop gate

Type: feat · Size: L · Blast: load-bearing · Suited: strong model + mandatory fresh-context Review

Size is L because the change crosses five packages (protocol, config, daemon, client, cli) with cross-cutting tests, although each file's diff is small. It is not XL: there is one seam and one new pure module.

Vocabulary (owner): **agent** = the main model the user chats with; **subagent** = the child started by an `agent_task` call; **entry** = one `models.<name>` block. In this doc **published** = a name the laptop itself offers to pods.

## Context

*— claude-opus-5-5, 2026-11-08*

**Why.** Task 4/9 of `docs/eval/subagent-live.md` (C4, C5, L3). Task 3 built `models`, per-type models and `selectableModels` for local and `serve` runs only. In a pod every child runs on the laptop's main model: the pod daemon has no way to say which model it wants (`packages/cli/src/wiring.ts:463-475`), and the laptop prints `[models] … not applied on run/attach yet` (`packages/cli/src/main.ts:838-842`).

**Binding decisions (owner; not reopened):**
- The pod asks for a model BY NAME on `model/stream*`. The laptop answers only for names it published itself, with its own keys. Keys never leave the laptop. A pod can never pick an arbitrary endpoint, URL or key (AGENTS §7).
- The allowlist is the union of the `subagents.types.*.model` values and `subagents.selectableModels` (`docs/eval/subagent-live.md` C4, L3; owner addition: "the laptop checks the name against the same list before using a key").
- `models` itself does NOT travel: only what the pod needs to choose (C5).
- Precedence is task 3's: the call's `model` › `subagents.types.<t>.model` › the `agents/*.md` `model` › the top-level `model`.
- No slots: `model/slots` was removed by task 3. The only sub-agent concurrency limit is the user's `subagents.maxParallel` (Owner decision, 2026-11-08). `PROTOCOL_VERSION` is 18 here.
- R-Q1 (a) of task 3 is a default "until feat/models-map-pod decides": a detached relay skips entry key commands (`packages/cli/src/relay.ts:672-673`). This task decides (Owner Q2 below).

**Repro** (capability missing, and what a pod can do today). `bun .tentacle/tmp/models-map-pod/probe.ts`, on `feat/models-map` @ `74a1d70`, 2026-11-08, before any edit. No source file touched.

```ts
// .tentacle/tmp/models-map-pod/probe.ts
import { spawn } from "node:child_process";
import { RemoteClient } from "@tentacle/client";
import { type ChatRequest, type ModelProvider, PermissionBroker, type StreamEvent } from "@tentacle/core";
import { Method, type SessionSettings, type SessionSettingsReport } from "@tentacle/protocol";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { settingsNotices } from "../../../packages/cli/src/carried-settings.ts";

const seen: Array<{ via: string; keys: string[] }> = [];
const main: ModelProvider = {
  id: "MAIN",
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    seen.push({ via: "stream", keys: Object.keys(request).sort() });
    yield { type: "text", delta: "served-by-MAIN" };
    yield { type: "done" };
  },
  async countTokens(request: ChatRequest): Promise<number | undefined> {
    seen.push({ via: "count", keys: Object.keys(request).sort() });
    return 7;
  },
};
const [daemonCh, clientCh] = createChannelPair();
const errors: string[] = [];
const client = new RemoteClient(clientCh, new PermissionBroker(), main, {
  onError: (e: Error) => errors.push(e.message),
});
const daemon = new RpcPeer(daemonCh);

const hostileRequest = {
  messages: [{ role: "user", content: "hi" }],
  model: "gpt-evil",
  baseURL: "http://evil.example/v1",
  apiKey: "stolen",
  provider: "anthropic",
};
const hostile = { request: hostileRequest, model: "claude", baseURL: "http://evil.example/v1", apiKey: "x" };

async function attempt(label: string, run: () => Promise<unknown>): Promise<void> {
  const before = seen.length;
  try {
    const result = await run();
    console.log(`${label}: OK ${JSON.stringify(result)} · provider saw ${JSON.stringify(seen.slice(before))}`);
  } catch (error) {
    const e = error as { code?: number; message?: string };
    console.log(`${label}: REFUSED code=${e.code} "${e.message}" · provider saw ${JSON.stringify(seen.slice(before))}`);
  }
}

console.log("--- A. a pod names a model and an endpoint on protocol 18 (today)");
await attempt("model/stream + {model:claude, baseURL, apiKey}", () => daemon.request(Method.ModelStream, hostile));
const frames: unknown[] = [];
await attempt("model/streamChunked + the same", () =>
  daemon.request(Method.ModelStreamChunked, hostile, { onProgress: (value) => frames.push(value) }),
);
console.log(`   chunked frames: ${JSON.stringify(frames)}`);
await attempt("model/countTokens + the same", () => daemon.request(Method.ModelCountTokens, hostile));

console.log("--- B. params are validated BEFORE the handler: a bad enum never reaches the provider");
await attempt("model/stream + purpose:nonsense", () =>
  daemon.request(Method.ModelStream, { request: { messages: [] }, purpose: "nonsense" }),
);
await attempt("model/streamChunked + purpose:nonsense", () =>
  daemon.request(Method.ModelStreamChunked, { request: { messages: [] }, purpose: "nonsense" }),
);
daemon.close();
client.close();

console.log("--- C. a structured value in SessionSettings, equal on both sides");
const value = (): unknown => ({ types: { explore: "fast" } });
const mine = { agentTaskDescription: value() } as unknown as SessionSettings;
const report = { carried: { agentTaskDescription: value() }, overridden: {} } as unknown as SessionSettingsReport;
console.log(JSON.stringify(settingsNotices(mine, report)));

console.log("--- D. key commands with no terminal (as the relay: detached, stdin ignored)");
function detached(command: string, killAfterMs: number): Promise<string> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("/bin/sh", ["-c", command], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr?.on("data", (d) => {
      err += String(d);
    });
    const timer = setTimeout(() => {
      process.kill(-(child.pid as number), "SIGKILL");
    }, killAfterMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(`exit=${code} signal=${signal} after ${Date.now() - started}ms stderr=${JSON.stringify(err.trim())}`);
    });
  });
}
console.log(`reads /dev/tty: ${await detached("read x < /dev/tty; echo got", 3000)}`);
console.log(`reads stdin:    ${await detached("read x; echo \"[$x]\"", 3000)}`);
console.log(`blocks (a GUI pinentry stand-in), killed by the probe at 1500ms: ${await detached("sleep 30", 1500)}`);
```

Observed:

```
--- A. a pod names a model and an endpoint on protocol 18 (today)
model/stream + {model:claude, baseURL, apiKey}: OK {"events":[{"type":"text","delta":"served-by-MAIN"},{"type":"done"}]} · provider saw [{"via":"stream","keys":["messages"]}]
model/streamChunked + the same: OK {"chunks":2} · provider saw [{"via":"stream","keys":["messages","signal"]}]
   chunked frames: [[{"type":"text","delta":"served-by-MAIN"}],[{"type":"done"}]]
model/countTokens + the same: OK {"tokens":7} · provider saw [{"via":"count","keys":["messages","signal"]}]
--- B. params are validated BEFORE the handler: a bad enum never reaches the provider
model/stream + purpose:nonsense: REFUSED code=-32602 "invalid params for model/stream" · provider saw []
model/streamChunked + purpose:nonsense: REFUSED code=-32602 "invalid params for model/streamChunked" · provider saw []
--- C. a structured value in SessionSettings, equal on both sides
[{"text":"Session settings: { \"subagents.agentTaskDescription\": \"(text differs)\" }","hint":"(/settings sync to use this terminal's values, or /clear)"}]
--- D. key commands with no terminal (as the relay: detached, stdin ignored)
reads /dev/tty: exit=0 signal=null after 34ms stderr="/bin/sh: /dev/tty: Device not configured"
reads stdin:    exit=0 signal=null after 25ms stderr=""
blocks (a GUI pinentry stand-in), killed by the probe at 1500ms: exit=null signal=SIGKILL after 1502ms stderr=""
```

What it shows:
- **A.** A named call is served by MAIN, silently, with `model`, `baseURL` and `apiKey` gone. That is safe on the endpoint side. It is also why this task must bump the protocol: an older laptop would answer a named call with the wrong model and no error.
- **B.** Params are validated before any handler.
- **C.** A structured setting that is EQUAL on both sides reports drift: every comparison in the carry code is `!==`.
- **D.** A command that opens `/dev/tty` fails at once with no terminal (the `exit=0` is the probe's trailing `echo`, not the read). A command that blocks stays blocked: the current key runner has no deadline.

## Implementation

*— claude-opus-5-5, 2026-11-08*

Written against `74a1d70`. The steps tagged **[Q1]** and **[Q2]** follow the recommended answers below. If the owner answers otherwise, drop the tagged part as the question says.

**Owner answered Q1 (c): every step tagged [Q1] is DROPPED** (no `model-gate.ts`, no `maxConcurrent`, no queue, no `maxTokens` drop, no Tests 5 nor the [Q1] bullets of Test 4). They are left struck below only as the record of what was decided against. **Q3 (b)** changes D5's `tunnelSubagentResolver` (no `frontmatterModel`) and F16. See *Owner answers* at the end.

### Load-bearing assumption

**Every model call a pod can cause enters the laptop through ONE function, `RemoteClient.servingModel`, and only with fields the schema kept. So one allowlist check there is a complete gate: a name that does not pass it can reach no provider, and nothing the pod sends can name an endpoint or a key.**

Proof, by execution (Repro A and B) and by source:
- `servingModel` has exactly three callers, one per tunnel method (`packages/client/src/remote-client.ts:2343`, `:2361`, `:2488`), and it is the only reader of `this.modelProvider` (`:2459`; `:531` is the assignment).
- The three methods are the only model methods the client's request handler routes (`remote-client.ts:1464-1480`); any other is `MethodNotFound` (`:1484`).
- The peer parses params with the method's schema before the handler runs, and refuses on failure (`packages/transport/src/peer.ts:337-340`). Repro B: `purpose: "nonsense"` → `-32602`, the provider saw nothing. Repro A: with `model`, `baseURL`, `apiKey`, `provider` on the params and inside `request`, the provider saw only `messages` (+ `signal`).
- A provider is built from the laptop's config only (`packages/cli/src/model-provider.ts:25-74`). A `ChatRequest` has no endpoint or key field to fill.

Second assumption: **a child's model is chosen in one place (`SubagentDeps.modelFor`), and returning a different provider there is enough.** `packages/agent/src/subagent.ts:246-250` (the only pick). Task 3's mutation "give `modelFor` to the tunnel path" turned the pod test red, so the seam is live on the tunnel path (`docs/feat/models-map.md` Execution).

### Preconditions

- The tunnel: `tunnelFor(purpose)` (`packages/cli/src/serve.ts:430-443`), the only production `modelOverride` (`serve.ts:448`; `wiring.ts:343`, `:568` read it).
- `ready()` looks the link up per call (`serve.ts:423-429`); the link is the most recently attached serving connection (`packages/daemon/src/hosted-session.ts:1112`).
- `ModelLink` is a `Pick<Connection, …>` (`packages/daemon/src/connection.ts:94-95`), so a new optional parameter does not break a fake with fewer parameters.
- Children never count tokens: `contextUsage` is reached only from a session's agent (`packages/agent/src/session.ts:172-176`, `packages/daemon/src/hosted-session.ts:1281`, `session-host.ts:309`). So `model/countTokens` needs no name, and a named tunnel passes no count sender (`packages/daemon/src/proxy-model.ts:180-183` returns `undefined`).
- Requests carry a `maxTokens` a pod sets (`packages/protocol/src/model.ts:36`) and it beats the configured value (`packages/providers/src/openai-provider.ts:274`, `anthropic-provider.ts:417`). Only the title call sets it (`packages/daemon/src/session-title.ts:97`); nothing in `packages/agent/src` does.
- Carry: `CARRIED` is keyed by the wire schema's keys, so a new key does not compile until classified (`packages/cli/src/carried-settings.ts:38-42`). `carriedSettings` reads it from the laptop's config (`:199-208`), `applyCarried` overlays it (`:223-275`). Sent on `session/open` and on `/settings sync` (`packages/protocol/src/session.ts:512,562`), which rebuilds the agent through the same factory (`packages/daemon/src/session-host.ts:959-994`).
- A bare `session/open` (no `settings`) returns early (`carried-settings.ts:227-229`).
- Comparisons are by identity: `carried-settings.ts:246,253,257,349,358`, `packages/cli/src/settings-view.ts:82,115` (Repro C).
- T6 needs each `CARRIED.configKey` to be a registry path with the same class, and the reverse (`packages/cli/test/key-docs-carried.test.ts:67-85`).
- Pod runs get their laptop models from `laptopModels(config)`, spread at both call sites (`packages/cli/src/engine-runtime.ts:99-112,614,1009`) into `createLocalRuntime` (`packages/cli/src/local-runtime.ts:558-560,614`). `attachEngineRuntime` is what the relay uses (`relay.ts:39`), so the relay shares this path.
- The relay has no terminal: `detached: true`, stdin ignored, stdout and stderr on `relay.log` (`relay.ts:703-708`). The launcher waits 60 s for it (`relay.ts:90,767`).
- The launcher itself runs every entry command strictly, with a terminal (`main.ts:729`, `packages/config/src/load.ts:720-723`).
- `defaultRunner` has no deadline and awaits stdout to EOF (`load.ts:480-484`). Probe 2 (below) shows why that matters.
- Handshake: `initialize` refuses any other protocol number with a worded `VersionMismatch` (`packages/daemon/src/connection.ts:360-375`); `attach` guards a binary replacement against a run still in use (`engine-runtime.ts:878-886`, `packages/cli/src/pod-resident.ts:661`).
- Requests are dispatched concurrently (`packages/transport/src/peer.ts:322`), so a wait inside one handler blocks no other request (AGENTS §7).
- Pod daemons store nothing durable (AGENTS §7), so nothing this task carries reaches a disk.

**Probe 2** (`bun .tentacle/tmp/models-map-pod/probe2.ts`, 2026-11-08): how to bound a key command. It decides D6.

```ts
// .tentacle/tmp/models-map-pod/probe2.ts
async function runner(command: string, deadlineMs: number, race: boolean): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const proc = Bun.spawn(["/bin/sh", "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
    signal: controller.signal,
  });
  const read = (async () => {
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout;
  })();
  try {
    if (!race) {
      return await read;
    }
    const aborted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener("abort", () => reject(new Error("timed out"))),
    );
    return await Promise.race([read, aborted]);
  } finally {
    clearTimeout(timer);
  }
}

async function timed(label: string, run: () => Promise<string>, capMs: number): Promise<void> {
  const started = Date.now();
  const cap = new Promise<string>((resolve) => setTimeout(() => resolve("STILL BLOCKED at the probe's cap"), capMs));
  const outcome = await Promise.race([
    run().then(
      (out) => `resolved ${JSON.stringify(out)}`,
      (error: Error) => `rejected: ${error.message}`,
    ),
    cap,
  ]);
  console.log(`${label}: ${outcome} after ${Date.now() - started}ms`);
}

const CHILD_HOLDS_PIPE = "sleep 4; echo key";
await timed("signal only, sh exec'd sleep ('sleep 4')", () => runner("sleep 4", 300, false), 2000);
await timed(`signal only, a grandchild holds the pipe ('${CHILD_HOLDS_PIPE}')`, () => runner(CHILD_HOLDS_PIPE, 300, false), 2000);
await timed(`signal + race, the same command`, () => runner(CHILD_HOLDS_PIPE, 300, true), 2000);
await timed("a fast command is untouched", () => runner("echo key", 300, true), 2000);
process.exit(0);
```

```
signal only, sh exec'd sleep ('sleep 4'): resolved "" after 303ms
signal only, a grandchild holds the pipe ('sleep 4; echo key'): STILL BLOCKED at the probe's cap after 2003ms
signal + race, the same command: rejected: timed out after 302ms
a fast command is untouched: resolved "key\n" after 45ms
```

Killing `sh` is not enough: a grandchild keeps the pipe open and the read never ends. The deadline needs the kill AND a race. Note the first line: a killed command can also *resolve* with empty output, so the deadline must be checked as a failure, and an empty key is already one.

### Design

```
laptop config ──publishedModels()──► session/open.settings.publishedModels ──► pod: applyCarried → buildAgent
   (names, windows, selectable descriptions; no id, URL or key)                     │ pickSubagentModel
                                                                                    ▼
laptop: servingModel(name) ◄── model/stream{model:"fast"} ◄── a ProxyModelProvider per name
   allowlist = publishedModelNames(laptop config), never what the pod says
```

#### D1. Wire (`protocol`)

`packages/protocol/src/model.ts`:

```ts
/** A `models` name on the tunnel: never an id, an endpoint or a key. The config's own shape (MODEL_NAME). */
export const ModelNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
```

- `ModelStreamParamsSchema` and `ModelStreamChunkedParamsSchema` gain `model: ModelNameSchema.optional()`. Doc comment: "Absent → the laptop's main model. A name the laptop did not publish is refused there. Exclusive with `purpose`." `ModelCountTokensParamsSchema` is unchanged (Preconditions).
- There is no name for the main model. A pod reaches the main model only by sending no name.

`packages/protocol/src/session.ts`, before `SessionSettingsSchema`, and a new key in it:

```ts
/** What a laptop publishes to a pod (docs/feat/models-map-pod.md): names and numbers. Never an id, a URL or a key. */
export const PublishedModelSchema = z.object({
  name: ModelNameSchema,
  contextWindow: z.number().int().positive(),
  description: z.string().min(1).max(300).optional(),
});
export const PublishedTypeModelSchema = z.object({ type: z.string().min(1), model: ModelNameSchema });
export const PublishedModelsSchema = z.object({
  /** Every published name: the window a child counts against; a description only if selectable. Sorted by name. */
  models: z.array(PublishedModelSchema),
  /** `subagents.types.<type>.model`, sorted by type. */
  types: z.array(PublishedTypeModelSchema),
  /** `subagents.selectableModels`, in order. */
  selectable: z.array(ModelNameSchema),
});
export type PublishedModels = z.infer<typeof PublishedModelsSchema>;
// In SessionSettingsSchema:
/** Absent → no named model: every child uses the laptop's main model. */
publishedModels: PublishedModelsSchema.optional(),
```

Arrays, not `z.record`: the protocol's JSON Schema export refuses a record on purpose (`packages/protocol/src/json-schema.ts:70-76`; corrected during Execution, this plan first said record).

`ModelNameSchema` must be declared where `session.ts` can import it. `model.ts` has no dependency on `session.ts`: import it from there.

`version.ts`: `PROTOCOL_VERSION = 19`, with the comment `// 19: a model name on model/stream* and settings.publishedModels (docs/feat/models-map-pod.md): an older laptop would serve a named call with its main model, silently.` Then `bun run schema:export`.

#### D2. What is published (`config`, pure)

In `packages/config/src/models.ts`:

```ts
export interface PublishedModels {
  readonly models: readonly { readonly name: string; readonly contextWindow: number; readonly description?: string }[];
  readonly types: readonly { readonly type: string; readonly model: string }[];
  readonly selectable: readonly string[];
}
/** The names a pod may ask for: the values of `subagentModels` ∪ `selectableModels`, sorted, only entries that exist. */
export function publishedModelNames(config: ModelsView): string[];
/** What travels; `undefined` when nothing is published. Sorted, so equal configs give equal JSON. */
export function publishedModels(config: ModelsView): PublishedModels | undefined;
```

`ModelsView` is a local type holding the three existing fields `models`, `subagentModels` and `selectableModels`. Build `models` and `types` with sorted keys (Repro C's comparison relies on it, D3). A `description` is copied only for a selectable name. `models` in `pickSubagentModel`'s `config` is narrowed to `Readonly<Record<string, Pick<ResolvedModel, "contextWindow">>>`, so the pod can call the same pick.

`TentacleConfig` (`load.ts:159-161` area) gains `readonly publishedModels?: PublishedModels`. `loadConfig` never sets it: only `applyCarried` does. Remove `modelsPodNotice` (`models.ts:200-212`).

The source of truth for the allowlist is `publishedModelNames`, on the laptop. `publishedModels` calls it, and D4 calls it. The pod's copy is only a hint for what to ask.

#### D3. Carry (`carried-settings.ts`, `settings-view.ts`)

New row, class P:

```ts
publishedModels: {
  class: "P",
  configKey: "models",
  read: (c) => publishedModels(c),
  write: (c, v) => ({ ...c, publishedModels: v }),
  // The laptop published nothing: every child is the main tunnel, never the pod's own.
  absent: ({ publishedModels: _dropped, ...c }) => c,
},
```

- `Row.source` becomes optional for this row only: `readonly source?: SourceKey`. `overlay` computes `set = row.source !== undefined && config.sources[row.source] !== "default"`, and stamps only with a source. There is no env form, and adding a `sources` key would have to satisfy the provenance test (`packages/config/test/key-docs.test.ts:297`). The pod's own `models` being ignored is said by the D5 notice instead of `pinnedOver`.
- `export function sameSetting(a: unknown, b: unknown): boolean` — `a === b`, or both objects and `JSON.stringify(a) === JSON.stringify(b)`. Key order is deterministic by D2. A hostile reorder only gives a false notice, which is already the accepted worst case (`carried-settings.ts:10-14`).
- Replace the identity comparison by `sameSetting` at `carried-settings.ts:349,358` and `settings-view.ts:82,115`. Lines `:246,253,257` need no change: W only, or guarded by `set`, which is false for this row.
- `carried-settings.ts:360`: `|| key === "agentTaskDescription"` becomes `|| OPAQUE.has(key)`, with `OPAQUE = new Set<Key>(["agentTaskDescription", "publishedModels"])`, so a laptop that dropped its published names still sees drift.
- `settings-view.ts:56-58,92`: the `DESCRIPTION` test becomes `OPAQUE.has(key)` and uses `sameSetting`. `/settings` prints `"models": "(same text)"` or `"(text differs)"`. Never its content (a report comes from a pod).
- Registry (`key-docs.ts:280`): section `models` becomes `carried: "pinned"` (T6). Its `models.*` children stay `carried: "no"`.

#### D4. The laptop gate (`client`, `cli`)

`RemoteClient` options (`remote-client.ts:261` area) and the deps of `createLocalRuntime` (`local-runtime.ts:558-560`, forwarded at `:614`) gain:

```ts
/** The named models this laptop serves to a pod; absent → every name is refused. */
export interface NamedModels {
  /** A provider; "unavailable" = published, but its key could not be obtained here; undefined = not published. */
  resolve(name: string): ModelProvider | "unavailable" | undefined;
  /** At most this many named calls at once: the user's `subagents.maxParallel` [Q1]. */
  readonly maxConcurrent: number;
}
```

`servingModel(method, purpose, name?)`, after the existing "no local model" check:

```ts
if (name !== undefined) {
  if (purpose !== undefined) {
    throw new RpcError(JsonRpcErrorCode.InvalidRequest, "a title call names no model");
  }
  const served = this.namedModels?.resolve(name);
  if (served === "unavailable") {
    throw this.refusedName(name, `model "${name}" is unavailable on this laptop: its key command did not succeed here`);
  }
  if (served === undefined) {
    throw this.refusedName(name, `model "${name}" is not published by this laptop`);
  }
  return served;
}
```

The name is safe to echo: the schema restricted it. `refusedName` builds an `RpcError(InvalidRequest, text)` and reports the first refusal per name to `onError` (the laptop's log; at most 16 distinct names remembered). Without that a hostile pod's attempts would leave no trace on the laptop.

`onModelStream` and `onModelStreamChunked`, for a call with `params.model`:
- pass the name to `servingModel`;
- **[Q1]** drop `request.maxTokens`: `const { maxTokens: _pod, ...request } = params.request`, so `models.<n>.maxTokens` (or the provider default) holds. An honest pod never sets it on a child's call;
- **[Q1]** `const release = await this.namedGate.enter(context?.signal)` before the provider is called, and `release()` in a `finally`.

**[Q1]** New pure module `packages/client/src/model-gate.ts`:

```ts
export interface CallGate {
  /** Resolves with a release once a slot is free. Rejects when the queue is full, on abort, or after `close`. */
  enter(signal?: AbortSignal): Promise<() => void>;
  close(reason: Error): void;
}
export function createCallGate(limit: number, maxWaiting: number): CallGate;
```

`NAMED_MODEL_MAX_QUEUED = 32` in `remote-client.ts`. Past it: `RpcError(InvalidRequest, "too many queued calls to named models")`. One gate per link generation: `onLinkClosed` (`remote-client.ts:1627`) closes it and makes a new one, so a queued batch call never runs for a dead link. One gate for all names, so N names do not multiply the limit. The main model and titles are not gated. The wait is inside a handler, on named calls only: the peer stays concurrent (`peer.ts:322`).

`laptopModels` (`engine-runtime.ts:99-112`) gains a `create: ProviderFactory = createModelProvider` parameter (the test seam) and returns `namedModels` when `publishedModelNames(config)` is not empty:

```ts
const names = new Set(publishedModelNames(config));
const providers = createModelProviders(config, create);
const namedModels: NamedModels = {
  maxConcurrent: config.subagentMaxParallel,
  resolve(name) {
    if (!names.has(name)) return undefined;
    const entry = config.models[name];
    if (entry?.apiKeySource === "command" && entry.apiKey === undefined) return "unavailable";
    return providers.forEntry(name);
  },
};
```

The last check matters: without it a relay whose command failed would send the prompt to the endpoint with no key. `Set.has` needs no `hasOwn` care. `forEntry` is the function task 3 already pinned for key routing (`model-provider.ts:37-56`).

#### D5. The pod side (`daemon`, `cli`)

`connection.ts:160-172`: `requestModelStream(request, purpose?, model?)` and `requestModelStreamChunked(request, handlers, purpose?, model?)`, sending `...(model ? { model } : {})`.

`serve.ts:430-443`:

```ts
const tunnelFor = (purpose?: ModelPurpose, name?: string): ProxyModelProvider =>
  new ProxyModelProvider(
    (request) => ready().requestModelStream(request, purpose, name),
    (request, handlers) => ready().requestModelStreamChunked(request, handlers, purpose, name),
    // A named tunnel never counts: only a session's own agent does.
    name !== undefined ? undefined : (request, signal) => { /* as today */ },
  );
const named = new Map<string, ProxyModelProvider>();
const namedTunnel = (name: string): ProxyModelProvider => { /* one per name */ };
```

and passes `namedModelOverride: namedTunnel` to `buildAgent`.

`model-provider.ts`, new:

```ts
/** `SubagentDeps.modelFor` over the tunnel: only an entry the laptop published gets a name. */
export function tunnelSubagentResolver(
  published: PublishedModels,
  tunnel: (name: string) => ModelProvider,
): (type: AgentType, requested: string | undefined) => SubagentModel | undefined {
  return (type, requested) => {
    const choice = pickSubagentModel(
      { requested, typeName: type.name, frontmatterModel: type.model, frontmatterWindow: type.contextWindow },
      {
        models: Object.fromEntries(published.models.map((m) => [m.name, m])),
        subagentModels: Object.fromEntries(published.types.map((t) => [t.type, t.model])),
        selectableModels: published.selectable,
      },
    );
    return choice.kind === "entry"
      ? { provider: tunnel(choice.name), contextWindow: choice.contextWindow, modelId: choice.name }
      : undefined;
  };
}
```

`id` and `default` return `undefined`: the child is the main tunnel with the type's own window, exactly today's pod behaviour. A frontmatter model id is never sent. `modelId` is the NAME: hooks in a pod do not learn the laptop's model id.

`wiring.ts`:
- `BuildAgentOptions.namedModelOverride?: (name: string) => ModelProvider`, documented next to `modelOverride` (`:292-297`, whose "ignored over the tunnel" text goes).
- `:476-485`: `modelFor` is `tunnelSubagentResolver(config.publishedModels, options.namedModelOverride)` when tunnelled and both exist; absent when tunnelled without them; task 3's resolver otherwise.
- `:504-509`: tunnelled → `config.publishedModels?.selectable.map(…)` with the published descriptions, or `[]`.
- `:468-475`: the notice becomes, when the pod's OWN config has per-type or selectable models: `models: this pod's own models, subagents.types and selectableModels are ignored; the laptop's published models apply`.
- Daemon log, once per `buildAgent` when tunnelled: `unknownTypeModelWarnings(config.publishedModels.types, knownTypes)`, through `options.notice`. Task 3 said this cannot be warned on the laptop (the pod's types are not the laptop's). The pod can.

`main.ts:838-842`: remove the `[models]` notice.

#### D6. The detached relay (R-Q1 follow-up) **[Q2]**

A relay now serves named calls, so it needs the published entries' keys. It runs their commands itself, with no terminal.

`LoadOptions.skipModelsKeyCommands` is REPLACED by:

```ts
/**
 * A process with no terminal (the detached relay). The main key as usual. Of the
 * entries, only PUBLISHED ones run their command, each bounded; a failure makes
 * that entry unavailable instead of failing the load.
 */
readonly modelKeysNoTerminal?: {
  readonly report: (name: string, line: string) => void;
  readonly timeoutMs?: number; // default NO_TERMINAL_KEY_TIMEOUT_MS = 10_000
};
```

`resolveModelKeys` under this option:
- only names in `publishedModelNames` run; distinct commands once, in parallel, as today;
- `CommandRunner` becomes `(command: string, signal?: AbortSignal) => Promise<string>`, and `defaultRunner` passes `signal` to `Bun.spawn`. The deadline is the abort AND a `Promise.race` (Probe 2);
- non-zero exit, a deadline, or an empty output → the entry keeps no `apiKey` (so `"unavailable"`, D4), and `report` receives one line per affected entry;
- the deadline's text is `models.<name>.apiKeyCommand did not finish within 10s (it may need a terminal)`. The others are the existing texts.

`relayMain` (`relay.ts:669-675`) passes `modelKeysNoTerminal: { report: (name, line) => writeErr(`[relay] ${line} — "${name}" is unavailable to this detached run until a terminal attaches\n`) }`. `relay.log` is the relay's stderr (`relay.ts:703-708`).

How each kind of command behaves in a relay:

| Command | What happens |
|---|---|
| Works without a terminal (`cat file`, an unlocked `pass`, a gpg-agent with a cached passphrase) | Normal. The launcher ran it first with a terminal (`main.ts:729`), so a gpg-agent cache is usually warm. |
| Opens `/dev/tty` | Fails at once (Repro D): the entry is unavailable. |
| Blocks (a GUI pinentry nobody answers) | Killed at 10 s: the entry is unavailable. The launcher waits 60 s, so a 10 s parallel bound does not fail the launch. |
| Exits 0 with junk (a script that read an empty stdin) | Not detectable: the key is wrong, the endpoint answers 401, the child ends in error. Same as the main key. |
| Fails or is empty | The entry is unavailable, and a line goes to `relay.log`. |
| The main key command fails | The relay exits, as today: it cannot serve anything. |

The run keeps going in every entry case. Calls to other names and to the main model are unaffected; a call to the unavailable name ends that child with the D4 text, which the agent and the user see. When a TUI attaches it becomes the model link (with its own strict load), so the entry works again.

The main key's own command is left unbounded: a pre-existing shape, unchanged here (see Notes).

#### D7. Docs and texts

`key-docs.ts`: `:288` (`models` details), `:580` (`subagents.types.*.model`), `:590` (`selectableModels`) lose "not applied yet" and say: on `run`/`attach` the names, windows and selectable descriptions travel; keys, URLs and model ids never do; a detached run needs each entry's command to work without a terminal. `models.*.description` details: "Sent to the model, and to a pod: never put a secret here." `CHANGELOG.md`. `TODO.md:456` (drops `slots`, links this doc). Details are not in the README table (`docs/feat/models-map.md` Round 2), but run `bun run docs:config` anyway.

### Files

In dependency order.

1. `packages/protocol/src/model.ts` — `ModelNameSchema`, `model` on two params.
2. `packages/protocol/src/session.ts` — `PublishedModelsSchema`, the settings key.
3. `packages/protocol/src/version.ts` — 19. `packages/protocol/schema/protocol.json` regenerated.
4. `packages/config/src/models.ts` — `PublishedModels`, `publishedModelNames`, `publishedModels`; narrowed pick; `modelsPodNotice` removed.
5. `packages/config/src/load.ts` — `publishedModels?` on `TentacleConfig`; `modelKeysNoTerminal` replaces `skipModelsKeyCommands`; runner signal **[Q2]**.
6. `packages/config/src/key-docs.ts` — `models` `carried: "pinned"`, D7 texts.
7. `packages/daemon/src/connection.ts` — the `model` parameter.
8. `packages/client/src/model-gate.ts` (new) **[Q1]**.
9. `packages/client/src/remote-client.ts` — `NamedModels`, `servingModel`, handlers, gate, `refusedName`.
10. `packages/cli/src/model-provider.ts` — `tunnelSubagentResolver`.
11. `packages/cli/src/carried-settings.ts` — row, `sameSetting`, `OPAQUE`, optional `source`.
12. `packages/cli/src/settings-view.ts` — `sameSetting`, `OPAQUE`.
13. `packages/cli/src/engine-runtime.ts` — `laptopModels`.
14. `packages/cli/src/local-runtime.ts` — forward `namedModels`.
15. `packages/cli/src/serve.ts` — `tunnelFor(purpose, name)`, `namedTunnel`.
16. `packages/cli/src/wiring.ts` — `namedModelOverride`, `modelFor`, task-tool list, notices.
17. `packages/cli/src/relay.ts` — the D6 option.
18. `packages/cli/src/main.ts` — the `[models]` notice removed.
19. `CHANGELOG.md`, `TODO.md:456`, this doc's Execution.

Existing tests that must change (each for a stated reason):
- `toBe(18)` pins: `packages/daemon/test/session-settings.test.ts:152`, `packages/daemon/test/version-mismatch.test.ts:184`, `packages/protocol/test/session-settings.test.ts:89`, `packages/protocol/test/update-settings.test.ts:48`, `packages/protocol/test/no-slots.test.ts:18`.
- `packages/protocol/test/session-titles.test.ts:92-93` pins "an unknown `model` field is stripped". It becomes: a valid name is KEPT, and a value that is not a name (`"a/b"`, 65 chars) is refused at parse.
- Row counts and lists: `packages/cli/test/carried-settings.test.ts:228-235,244`, `packages/cli/test/key-docs-carried.test.ts:102` (21 → 22). `:321,331,342`: a `source` cast for W rows.
- `packages/cli/test/carried-settings.test.ts:251-262`: "nothing of `models` travels" becomes the D2 pin (Tests 3).
- `packages/cli/test/models-wiring.test.ts:162-180`: rewritten (Tests 6).
- `packages/cli/test/main.test.ts:347`, `packages/config/test/models.test.ts:397`: the removed notice.
- `packages/cli/test/relay.test.ts` and `packages/config/test/models-load.test.ts`: the `skipModelsKeyCommands` cases follow the new option (Tests 8).

Callers to re-check with `rg` before editing: `skipModelsKeyCommands`, `modelsPodNotice`, `requestModelStream`, `laptopModels(`.

### Failure modes

| # | Case | What happens / how it converges |
|---|---|---|
| F1 | Hostile pod asks a name the laptop did not publish (an entry only used elsewhere, or invented) | `InvalidRequest "model … is not published by this laptop"` from `servingModel`; no provider is built or called. First refusal per name goes to the laptop's log. |
| F2 | Hostile pod sends a URL, a key or an id as the name (`http://…`, `sk-…`, `a/b`, 65 chars, `""`) | Refused at parse by `ModelNameSchema` (`-32602`), before any handler (Repro B). |
| F3 | The main name spoofed: `model: "main"`, the main model's id, `"__proto__"`, `"constructor"` | There is no name for the main model, so each is an ordinary name and is not published (`Set.has`, no prototype). A user entry literally called `main` is an ordinary published entry. An id that equals a published NAME resolves to that entry, as any published name does. |
| F4 | `purpose: "title"` + a name, to reach an entry through the title path | `InvalidRequest "a title call names no model"`. |
| F5 | Extra fields in `request` or params (`baseURL`, `apiKey`, `provider`) | Stripped (Repro A); the provider sees `messages` and the known options. |
| F6 | The pod's published map lies or is widened | Irrelevant: the laptop never reads it. `publishedModelNames(laptop config)` is the only allowlist. Pinned by a test that publishes nothing and asks anyway. A hostile pod may still use a published name for a type it was not assigned to: accepted, it chooses only among what the user published (C4). |
| F7 | A huge stream of requests to an expensive entry | **Owner Q1 (c): out of scope.** A pod's named calls have the same exposure as its main-model calls today: no laptop-side limit, the request (`maxTokens` included) as sent. Pinned by tests (40 concurrent published calls all start; `maxTokens` reaches the entry). *Dropped plan text:* At most `subagents.maxParallel` named calls run at once and 32 wait; past that, an error. This matters because a config with a local main model and a paid entry would otherwise give a pod a new way to spend. `maxTokens` from the pod is dropped on named calls. It bounds the RATE, not the total: a budget is a separate feature (Notes). An honest single session never queues, because children are capped at the same number. Several sessions on one laptop may queue: slower, correct. |
| F8 | Version skew, laptop 19 ↔ pod 18, or the reverse | `initialize` refuses with the worded `VersionMismatch`. Without the bump a laptop 18 would serve a named call with main, silently (Repro A). Pinned 18 ↔ 19. |
| F9 | `attach` to a pod with an older tentacle | Today's path, unchanged: the worded mismatch, the binary replaced at `attach`, `residentGuard` protecting a run still in use (`engine-runtime.ts:878-886`). A replaced daemon has no old session to keep. |
| F10 | A detached relay | Needs the published keys. Runs them with no terminal, bounded: D6's table. A failure makes one entry unavailable; the run goes on. |
| F11 | Hand-over between relay and TUI | The link is looked up per call (`serve.ts:423-429`), so the next named call goes to the new laptop process, with its own keys and gate. A batch call queued on the closed link is rejected (D4). |
| F12 | `--resume` (a new session from the laptop's copy) | `open{messages, settings}` carries the CURRENT publication. History's `agent_task` `model` arguments are only history. A name no longer published applies to no new call: an unknown `model` in a new call is the tool's error (task 3 B1). |
| F13 | Re-attach to a live session after the laptop's config changed | `settings` apply only on create, so the session keeps its old routing. A name still asked but no longer published is refused (F1), and the child errors. The drift notice appears (`"models": "(text differs)"`), and `/settings sync` rebuilds the agent. |
| F14 | Two laptops on one pod | The most recent serving connection is the link. It serves with ITS allowlist and keys: a name it lacks is refused (F1), a same-named entry is that laptop's. |
| F15 | `settings` absent (a bare open) or nothing published | No `publishedModels`, no `modelFor`, an empty selectable list: every child on the main tunnel, as today. `namedModels` absent on the laptop: every name refused. |
| F16 | The pod's own `agents/*.md` names a model | **Owner Q3 (b): ignored for picking an entry**, even a published name: the main tunnel, with the type's own `contextWindow`; nothing is sent to the entry. Differs from a local run (said in `explain` and the CHANGELOG). A hostile pod can still send a published name on the wire: the allowlist bounds that (F6). |
| F17 | A `subagents.types.<t>` the pod has no type for | Never used. One line in the pod daemon's log (D5). |
| F18 | The pod's own config has `models` / keys | Ignored over the tunnel, with a daemon-log notice. No entry command runs there (`podDaemon`, `load.ts:723`). |
| F19 | The tunnel drops during a child's named call | As for the main model: the call fails, the child ends in error, and the next call uses the new link. |
| F20 | A key or endpoint reaching the pod in an error | Refusal texts hold only the name. A provider error goes through the existing opaque path (`connectionLost`, `remote-client.ts:2381-2417`). Provider errors on a named call use the same code. |
| F21 | Empty or missing key at relay start for an entry | `"unavailable"`, never an unauthenticated call (D4). |
| F22 | A hostile pod's report echoes `publishedModels` | Validated by the schema, printed only as `(same text)` / `(text differs)` (D3). |

### Tests

Run narrow files while iterating (AGENTS §4). Every new test is first shown RED on an assertion, not on an import error (use a stub export), then GREEN. Fakes: `rawDaemon` (`packages/client/test/remote.test.ts:344`), `ScriptedProvider`, `createChannelPair`, the `createProvider` spy (`models-wiring.test.ts`).

0. **Re-run** `probe.ts` and `probe2.ts` before any edit. If A, B or the race line differ, STOP and fix this plan.
1. `packages/protocol/test/published-models.test.ts` (new): `model` kept on both stream params and absent from `model/countTokens`; a URL, `a/b`, 65 chars and `""` refused; `publishedModels` round-trips and an unknown field in it is stripped; version 19.
2. `packages/config/test/models.test.ts`: `publishedModelNames` is the union, sorted, de-duplicated, without an entry only referenced nowhere; `publishedModels` has only `models/types/selectable`, a description only for a selectable name, and `undefined` when empty; the pick works on the narrowed type.
3. `packages/cli/test/carried-settings.test.ts`: `JSON.stringify(carriedSettings(config))` holds the entry's name and window, and NEITHER `s3cret-entry`, `only-laptop.example`, `secret-model-id`, nor an unpublished entry's name. **Mutation:** publish the whole entry → must fail. Drift: equal publications → no notice (red on `!==`, Repro C); different → the `(text differs)` line; absent on the session, present here → drift. A pod's own `models` with `settings` absent → no `publishedModels`.
4. `packages/client/test/named-models.test.ts` (new), over `rawDaemon`, for BOTH `model/stream` and `model/streamChunked`:
   - a published name reaches ITS provider and not main, and no name reaches main;
   - an unpublished name → `InvalidRequest`, no provider called (spy on `resolve` and the main provider);
   - `main`, the main id, `__proto__`, `constructor` → refused;
   - `purpose: "title"` + a name → refused; title path unchanged;
   - `"unavailable"` → the unavailable text, no provider called;
   - no `namedModels` option → every name refused;
   - a name refused twice logs once; a 17th distinct name logs nothing more;
   - **[Q1]** `maxTokens` from the pod is not seen by the named provider and IS seen by main (titles keep theirs);
   - **[Q1]** with a limit of 2 and gated providers, the third call waits, the 35th is refused, and a release lets the next run; the main model is never gated; closing the link rejects the queued calls and a named call afterwards works on the new generation.
   **Mutation:** skip the allowlist (`resolve` returns any entry) → must fail.
5. `packages/client/test/model-gate.test.ts` (new) **[Q1]**: limit, FIFO, the queue cap, abort while waiting removes the waiter, `close` rejects all and later `enter` too, double release is a no-op.
6. `packages/cli/test/models-wiring.test.ts` (rewrite `:162-180`), with a spy `namedModelOverride`, `modelOverride` and `publishedModels`: an `explore` child runs on the named tunnel and counts against the published window; a call's selectable `model` beats the type; an `agents/*.md` published name is used; a frontmatter id stays on the main tunnel and no name is sent; the task description lists published selectable names; the hook gets the NAME; nothing published → every child on the main tunnel, no list; the pod's own `models` is ignored, notice once; `f.made` is empty in every case (no provider is built in a pod). **Mutation:** return `undefined` for `entry` → must fail.
7. `packages/cli/test/models-pod.test.ts` (new): end to end over a channel pair, real `tunnelledAgent` + real `RemoteClient` + `laptopModels` with a `create` spy: a child's request reaches the entry's provider with the entry's `baseURL` and key, the main key does not; `settingsReport` is honest; `/settings sync` after a config change routes the next child by the new publication (real `updateSettings`). `carried-settings` proves nothing of the key crossed; this one proves the routing.
8. `packages/config/test/models-load.test.ts` + `packages/cli/test/relay.test.ts` **[Q2]**: under `modelKeysNoTerminal`: only published entries' commands run (a spy runner; an unpublished entry's marker file is never created); the main command is required; a failing, empty or deadline-exceeded command → no `apiKey`, one report line per entry, and the load succeeds (a runner that ignores the signal still ends at the deadline: the race); a command shared by two entries runs once and reports both. Real `relayMain`: a failing entry command leaves the relay past the load, and its line is in the stderr sink. **Mutation:** no race → the deadline test must hang past its timeout and fail. Without the option: today's strict failure, unchanged.
9. `laptopModels`, in `packages/cli/test/models-providers.test.ts`: unpublished → `undefined`, a command entry with no key → `"unavailable"`, a published entry → its own provider, `maxConcurrent` = `subagentMaxParallel`, nothing published → no `namedModels`.
10. `packages/daemon/test/version-mismatch.test.ts`: an 18 ↔ 19 pair refused, in both directions, worded.

Gate before "done": `bun test` (baseline: all pass except the three opt-in skips), `bun run typecheck`, `bun run lint`, `bun run docs:config` clean. AGENTS §6.

**Live check (Execution, cannot be unit-tested):** one `run` on docker with `explore` on a second fake endpoint, a selectable entry, and one `run --detach` with a failing entry command: confirm routing by each endpoint's log, the key in each request, and the relay.log line.

### Notes / debt

- A spending budget per entry or per run (tokens or money) is out of scope: it needs accounting and a new config surface. [Q1] bounds only the rate.
- The main key's command in a relay has no deadline (`load.ts:714-715`): a blocked main command stalls the relay until the launcher's 60 s pass. It predates this task and the main key is required anyway. A small fix if wanted.
- A killed key command's grandchild can survive the deadline (Probe 2) until it ends by itself. Accepted: it holds no terminal and writes nowhere we read.

### Owner questions

**Q1. A laptop-side limit on named calls (F7).** (a) A concurrency gate at `subagents.maxParallel` across all names (no new key), a bounded queue, and the pod's `maxTokens` dropped on named calls; (b) only `maxTokens` dropped, no gate; (c) neither: the same exposure as the main model today. **Recommend (a).** With a local main model and a paid entry, this feature gives a compromised pod a way to spend that it does not have today. The gate costs one small pure module, uses the number you already set, and never delays an honest single session. It limits the rate, not the total spend. With (b) or (c), remove the steps tagged [Q1]: `model-gate.ts`, `maxConcurrent`, Tests 5 and the [Q1] bullets of Test 4 (and, for (c), the `maxTokens` drop).

**Q2. A detached relay and the entry keys (R-Q1 follow-up).** (a) The relay runs the PUBLISHED entries' commands, no terminal, 10 s each, in parallel; a failure makes only that entry unavailable, logged in `relay.log`; the run continues; (b) the same, but any failure ends the relay at start (strict); (c) the launcher, which has a terminal, passes the keys to the relay through a pipe. **Recommend (a).** A launcher that succeeded should not yield a dead run because of one entry (that was review finding F-2), and the agent sees a clear error on that entry only. (c) avoids re-running the commands, but it opens a new path for secrets between processes, and the relay's env is inherited by what it spawns. With (b) or (c), D6 and Tests 8 change accordingly; both still need the "unavailable" check to be reconsidered.

**Q3. A pod's own `agents/*.md` naming a published model.** (a) Allowed: your rule "a `models` name first" applies in the pod too; (b) ignored in a pod: only the laptop's `subagents.types` and the agent's selectable call can pick a name. **Recommend (a).** The allowlist already bounds it (F6), a hostile pod can send the name anyway, and (b) would make the same file behave differently in a pod. With (b): in `tunnelSubagentResolver` pass no `frontmatterModel`.

### Owner answers (binding, 2026-11-08)

- **Q1 → (c)**, no laptop-side limit and no `maxTokens` drop. A pod's named calls have the same exposure as its main-model calls today. Every [Q1] step is removed.
- **Q2 → (a) confirmed.** The relay runs only the published entries' key commands, no terminal, 10 s each; a failure makes only that entry unavailable.
- **Q3 → (b)**, against the recommendation. In a pod, the pod's own `agents/*.md` `model` is IGNORED for picking a `models` entry; only the laptop's `subagents.types.<t>.model` and the agent's selectable `model` argument pick a name. Documented as a difference from local runs (CHANGELOG, `explain models`, `explain subagents.types.*.model`).

## Execution

*— claude-opus-5-5, 2026-11-08*

Two sessions. The first (Opus, stopped by quota) is the WIP commit `e69a954` on top of the plan commit `191600e`. The second (this one) applied the owner answers, finished the missing parts, and ran the gate. Nothing committed.

**From the stopped session (`e69a954`), kept as built:** D1 (`ModelNameSchema`, `model` on both stream params, `PublishedModelsSchema` as ARRAYS, the settings key, `PROTOCOL_VERSION = 19`, `protocol.json` regenerated); D2 (`publishedModelNames`, `publishedModels`, narrowed pick, `modelsPodNotice` removed); D3 (carry row with optional `source`, `sameSetting`, `OPAQUE`, `settings-view` comparisons); D4 (`NamedModels.resolve`, `servingModel(name)`, `refusedName` with a 16-name log bound, `laptopModels` with the `create` seam and the `"unavailable"` check); D5 (`requestModelStream*` `model` param, `namedTunnel` per name with no count sender, `namedModelOverride`, the tunnelled `modelFor`, published task-tool list, notices, `unknownTypeModelWarnings` in the pod); D6 (`modelKeysNoTerminal` replacing `skipModelsKeyCommands`, `runBounded` = abort + race, relay option and its `relay.log` line); D7 key-docs texts; the `main.ts` notice removed; most tests.

**This session:**
1. **Q1 (c), removed:** `packages/client/src/model-gate.ts` and its test (deleted); `NamedModels.maxConcurrent`, `NAMED_MODEL_MAX_QUEUED`, `namedGate`, `enterNamedGate`, `dropWaiting` in `onLinkClosed`, and `servedRequest` (the `maxTokens` drop) from `remote-client.ts`; `maxConcurrent` from `laptopModels`; the "at most `subagents.maxParallel`" sentence in `key-docs.ts` `models`. Tests: the gate/queue/flood-limit tests in `named-models.test.ts` and `models-pod.test.ts` were replaced by tests of the decided behaviour (below).
2. **Q3 (b):** `tunnelSubagentResolver` (`packages/cli/src/model-provider.ts`) passes no `frontmatterModel`. Tests: `models-providers.test.ts` (the old Q3 (a) test inverted), a new `models-wiring.test.ts` case (pod `agents/scout.md` with `model: fast` → main tunnel, `named` empty, no provider built), and an end-to-end `models-pod.test.ts` case (pod frontmatter `model: claude` → "from the MAIN model", the claude entry never built or served, no `"model":"claude"` frame). Texts: `key-docs.ts` `models` and `subagents.types.*.model`, CHANGELOG.
3. **Fixed tests the stopped session left failing or unrun:** the `/settings sync` re-route test in `models-pod.test.ts` passed `{ servesModel: true }` as the 3rd `Connection` argument (it is the 4th), so the link was never set ("model proxy transport not ready"). The `engine-runtime.test.ts` and `engine-docker.test.ts` partial-config fixtures lacked `models`/`subagentModels`/`selectableModels`, which `laptopModels` now reads (14 failures in the first full run); the fixtures gained the three empty fields (production configs always have them).
4. **Hostile-pod tests added:** a 200-call flood of unpublished names over both methods (all `InvalidRequest`, no provider reached, ≤ 16 log lines); a 120-call flood mixing unpublished, the main id, `main`, `__proto__` and entry model ids against the REAL `laptopModels` (no provider built or served, main untouched); a provider error carrying a URL and a key reaches the pod opaque (both methods).
5. **Q1 (c) pinned:** `maxTokens` from the pod reaches the named entry and main alike; 40 concurrent calls to one published entry all start, and a main call is served meanwhile.
6. CHANGELOG: the task-3 entry's "not applied on run/attach yet" and "the relay runs only the main one" now point to a new entry "Named models work on run/attach too" (protocol 19: update the pods). `bun run docs:config`: README up to date.

**Drift from Implementation:** arrays instead of `z.record` (stopped session, recorded in D1: the JSON-Schema export refuses records). [Q1] removed per owner. `NamedModels` has only `resolve`. The relay's report line includes the command's stderr (the existing `ConfigError` text of `defaultRunner`, as in the strict path; it goes to the laptop-local `relay.log`, never to the pod); a non-`ConfigError` failure is reported as `apiKeyCommand failed` with no detail. TODO.md not touched (orchestrator's instruction), so `TODO.md:456` of D7 is left for the merge.

**Red before green** (each by copying the file from `git show 191600e:<path>` over the current one, running, then restoring from `.tentacle/tmp/models-map-pod/bak/` and checking shasums):
- `remote-client.ts` @191600e → `named-models.test.ts` **21 fail / 2 pass** (the 2 are the schema-level `InvalidParams` cases, which belong to the protocol change). E.g. a published name served by main (`[0,1]` vs `[1,0]`), unpublished name `code: undefined`.
- `wiring.ts` @191600e → `models-wiring.test.ts` **6 fail** (child on "parent model" instead of `tunnel:fast`, no published list, old notice, no unknown-type line).
- `load.ts` @191600e → `models-load.test.ts` **8 fail** (the unpublished command ran; failing/empty commands threw; the deadline test timed out at 5 s; the real runner's grandchild held the load 3063 ms).
- `version.ts` @191600e → `published-models.test.ts` + `version-mismatch.test.ts` **3 fail** (18 ≠ 19; "initialize succeeded" for an 18 ↔ 19 pair).
- Q3: the new `models-wiring` case failed (`from tunnel:fast`) before the `model-provider.ts` change, then passed.
- `carried-settings.ts` @191600e cannot run (the tests import `OPAQUE`): replaced by mutation M5 below.

**Non-vacuity by mutation** (each reverted, shasum-checked):
- M1a, laptop allowlist: `laptopModels.resolve` also accepts any `config.models` name → 6 fail (`hidden` served, `__proto__` → `-32603`, the flood test, the providers test builds `keyless`).
- M1b, the gate in `servingModel`: an unpublished name returns the main provider → 14 fail across `named-models` and `models-pod`.
- M2, version: covered by the 191600e `version.ts` run above.
- M3, relay deadline: `runBounded` without the race (abort only) → the deadline test times out at 5 s and the real-runner test takes 3065 ms > 2000 → 2 fail.
- M4, relay key path: `relayMain` without `modelKeysNoTerminal` (strict load) → 2 `relay.test.ts` fail (the relay dies at the entry's command instead of continuing).
- M5, carry leak: `publishedModels` spreads the whole entry → 5 fail (`models-published.test.ts` sees `s3cret-entry`, the URL and the model id; `carried-settings.test.ts` sees the key in the carried JSON).
- M6, Q3: `frontmatterModel: type.model` put back → 3 fail (providers, wiring, the end-to-end pod test: "from claude-id").
- `sameSetting` → identity only → the "equal publications are no drift" test fails (Repro C).

**Secrets:** no key on argv (key commands run as `/bin/sh -c <command>`, unchanged; keys are read from stdout); nothing new in a pod's env or mounts (`namedModels` lives only in the laptop's `RemoteClient`); the carried publication holds names, windows and selectable descriptions only (M5); refusal texts hold only the schema-shaped name; provider errors on named calls stay opaque (test). Fake keys and scratch dirs only; `~/.config/tentacle` never touched.

**Gate** (2026-11-08, this worktree): `bunx tsc --noEmit` clean; `bunx biome check .` 767 files, no fixes; `bun test packages` **5868 pass, 3 skip (the opt-in three), 0 fail**; `bun run docs:config` up to date.

**Not verified:** `tsc -p apps/mobile` (the mobile half of `bun run typecheck`; the command needed an approval this session did not get. The protocol change is additive for the app's imports, but run it). The live check (docker `run` with two fake endpoints, a selectable entry, a `run --detach` with a failing entry command) was not run: verify routing by each endpoint's log, the key per request and the `relay.log` line.

### Fix round 1

*— claude-sonnet-5-5, 2026-11-09*

Review round 1 (F1–F5) applied as specified; owner decisions Q1 (c), Q2 (a), Q3 (b) untouched. Not committed.

- **F1.** `attachEngineRuntime` (`engine-runtime.ts`, `onPeerError`) sends the `[laptop rpc]` line to `deps.log` when there is no log file. Drift: only when also `deps.interactive === false` (the relay), so a TUI whose `daemon.log` cannot be opened never writes to the terminal Ink owns (AGENTS §7). Tests: `engine-runtime.test.ts` "F1" (relay-shaped deps: refused name reaches `log` once; an interactive attach writes nothing) and `relay.test.ts` "F1" (`runRelay` hands `attach` its own log, no `daemonLogPath`, `interactive: false`, and a `deps.log` line lands in `relay.log`). CHANGELOG sentence corrected (`daemon.log`, or `relay.log` for a detached run). RED: with `onPeerError` back to `stderr.onStderr` only, the engine-runtime F1 test fails; with the relay's `interactive: true`, the relay F1 test fails.
- **F2.** `ResolvedModel.modelInherited` (set by `resolveModelEntry` when the entry has no `model`) + ONE pure helper `withRunModel(config, model)` (`config/src/models.ts`) that sets `config.model` and every inheriting entry; used at the relay (`relay.ts`) and the `attach` (`main.ts`) sites, replacing both `{ ...config, model }` patches. Tolerates a config with no `models` (partial test fixtures). Tests: `models.test.ts` (flag on/off, helper sets only inheriting entries, no mutation, repeated move, same object when unchanged, stale entry under an equal `config.model`). RED: helper that copies entries without re-pointing the id → 3 fail.
- **F3.** `engine-runtime.test.ts` "named models at the production sites": real `startEngineRuntime` (run) and `attachEngineRuntime` (attach/relay) over the fake `TunnelCluster`, real providers over HTTP to two local servers; a named `model/stream` is served by the entry's endpoint with `Bearer fast-key` and main sees nothing. RED by mutation: `namedModels: undefined` after the spread at line 645 (run) and at line 1040 (attach) → one failure each, reverted. **The live docker check is PENDING** (the orchestrator runs it after the build); nothing in this round ran it.
- **F4.** `KeyCarried` gains `"published"`; `subagents.types.*.model` and `subagents.selectableModels` use it; `explain` prints "published by the laptop: a pod's own value is ignored"; `appliesToText` and `carriedDocPaths` handle it; T6 (`key-docs-carried.test.ts`) excludes it from the CARRIED comparison and a new test pins exactly those two keys. `explain.test.ts` pins the text. RED: one key back to `no` → both new tests fail.
- **F5.** `defaultRunner` throws `KeyCommandExit` (a `ConfigError` with `code`); in the no-terminal path the relay line is `apiKeyCommand exited with code N` (no stderr); the strict path's message (with stderr) is unchanged. Comment fixed. Tests: `models-load.test.ts` (real runner: stderr marker absent; strict load keeps it), `relay.test.ts` and `models-pod.test.ts` expectations updated. RED: the new real-runner test fails with the exit branch disabled.

Gate (2026-11-09): `bunx tsc --noEmit` clean; `bunx biome check .` 767 files, no fixes; `bun test packages` 5882 pass, 3 skip (opt-in), 0 fail; `bun run docs:config` up to date. Still not run: `tsc -p apps/mobile`, the live check.

## Review

*— claude-opus-5-5, 2026-11-08*

**Reviewer disclosure.** Same model as the executor, fresh context only: shared blind spots survive both passes. AGENTS §10 prefers a different model for a load-bearing task.

### Verdict: REQUEST-CHANGES

The security core holds: no hostile frame reached an unpublished entry, and no key, URL or model id reached the pod. Q1, Q2 and Q3 are implemented as decided. Three things must be fixed before merge: F1 (the relay loses the trace of a refused name), F2 (a silently different model in a detached or re-attached run) and F3 (nothing pins the production wiring, and the live check was never run). There are no owner questions: each fix below is mechanical.

### Findings

**Major**

- **F1. In a relay, a hostile pod's refused names leave no trace, and the CHANGELOG says they do.** `relayMain` → `runRelay` calls `attachEngineRuntime` with no `daemonLogPath` (`packages/cli/src/relay.ts:361-372`). So `openDaemonLog(undefined, …)` (`packages/cli/src/engine-runtime.ts:821`) "keeps nothing" (`packages/cli/src/pod-stderr-log.ts:46-47`), and `onPeerError` (`engine-runtime.ts:1067`) writes to it. Trace E2E-F: `path=undefined hasContent=false`. The relay is the unattended case, which is where the plan's F1 ("First refusal per name goes to the laptop's log") matters most. `CHANGELOG.md:45` promises "or in `relay.log`". It also says "a `[laptop rpc]` line once the TUI closes", but for a TUI the line goes straight to the run's `daemon.log` and nothing is printed on close unless the run faulted (`engine-runtime.ts:1054-1056`). **Fix:** in `attachEngineRuntime`, send `onPeerError` to `deps.log` when there is no log file (the relay's `log` is `createRelayLog`), add a `relayMain`/`runRelay` test that a refused name reaches it, and correct the CHANGELOG sentence.

- **F2. An entry with no `model` of its own silently changes model id in a detached relay and on re-attach.** `resolveModelEntry` copies the main id at load (`packages/config/src/models.ts:60`). The relay reloads without `--model` and patches only the top level (`relay.ts:161-162`), and `attach` does the same (`packages/cli/src/main.ts:1478`). So `config.models.<n>.model` keeps the file's id. Trace E2E-E, with `models.inherit: { contextWindow: 1000 }` and `run --model flag-X`: `launcher main=flag-X inherit→flag-X` but `relay main=flag-X inherit→main-id`. `explain models` promises "the main model's EFFECTIVE value (after the profile, env and `--model`)". This is new here: before this task a relay or a pod never served an entry. **Fix:** have `resolveModelEntry` record that the id was inherited, and replace the two patches with one helper that sets the run's model on `config` and on every inheriting entry (one pure function, unit-tested at both sites' shape).

- **F3. Nothing pins the named models at the two production sites, and the live check did not run.** Replacing `...laptopModels(config)` by the same spread minus `namedModels` at the attach/relay site (`engine-runtime.ts:1040`) or the run site (`engine-runtime.ts:645`) leaves the whole CLI suite green: **SURVIVED, 0 fail / 1824 pass, both** (table below). Every named-model test calls `laptopModels` directly, and `relay.test.ts` injects `deps.attach`. One lost spread would turn the feature off in every real run while the gate stays green. Execution's live check (docker, `run --detach`) is listed as not run, and this review could not run it either (`docker info` needs an approval this session did not get). **Fix:** one test per site with the existing fake host (`engine-runtime.test.ts` already drives both) asserting a named `model/stream` is served by the entry, then run the live check of the plan and paste it into Execution.

**Minor**

- **F4. `tentacle explain` states the opposite of the behaviour for the two keys that drive the allowlist.** Real CLI, `explain subagents.selectableModels`: `carried  not carried: a pod uses its own value`, while F18 and the CHANGELOG say the pod's own value is ignored. Same row for `subagents.types.*.model` (`packages/config/src/key-docs.ts:578,588`). T6 forces `carried: "no"` because only `models` is a `CARRIED` row (`packages/cli/test/key-docs-carried.test.ts:67-78`). **Fix:** a registry value such as `carried: "published"` printing "published by the laptop: a pod's own value is ignored", excluded from T6's comparison.

- **F5. A key command's stderr goes into `relay.log`, and the comment says it does not.** `load.ts:647` reads "Only our own text: another error could quote what the command printed", but the `ConfigError` it keeps carries the stderr (`load.ts:504-506`). Trace: `models.cmdbad.apiKeyCommand exited with code 3: oops-from-stderr`. The file is 0600 and on the laptop, and it never reaches the pod. It is still a command's arbitrary output in a log, written with no terminal to notice it. **Fix:** in the no-terminal path report only the exit code, or correct the comment if the stderr is wanted.

**Nits**

- A title call with a name is refused without a log line (`packages/client/src/remote-client.ts:2501-2503`), unlike the other refusals.
- The agent sees `tool agent_task failed: RpcError: model "cmdbad" is unavailable…`: the class name is noise.
- This doc's header is stale ("Review not started", "not merged"). `TODO.md:456` still says `slots`, left for the merge as Execution states.

### Gate (this worktree, unmodified HEAD `a453298`)

| Command | Result |
|---|---|
| `bunx tsc --noEmit` | clean |
| `bunx biome check .` | 767 files, no fixes |
| `bun test packages` | **5868 pass, 3 skip (the opt-in three), 0 fail**, 63440 expects, 397 files |
| `tsc -p apps/mobile` | **not run**: needs an approval this session did not get (same as Execution). Still open. |
| `protocol.json` freshness | pinned by `packages/protocol/test/json-schema.test.ts:39` (green) |

### Mutation non-vacuity

Script: backup, apply, narrow tests, restore, sha256 compare. All restored; `git status` clean afterwards.

| Mutation | Result |
|---|---|
| R1 `resolve` serves any config entry | KILLED, 4 fail |
| R2 `"unavailable"` check removed | KILLED, 2 fail |
| R3 title + name allowed | KILLED, 2 fail |
| R4 chunked handler ignores the name | KILLED, 17 fail |
| R5 Q3: `frontmatterModel` passed in a pod | KILLED, 3 fail |
| R6 relay runs every entry's command | KILLED, 6 fail |
| R7 pod side drops the name (chunked) | KILLED, 3 fail |
| R8 schema: any string is a name | KILLED, 4 fail |
| R9 publication carries the model id | KILLED, 5 fail |
| R12 relay back to a strict load | KILLED, 2 fail |
| R13 named tunnel carries no name | KILLED, 3 fail |
| R10′ attach/relay site drops only `namedModels` (whole CLI suite) | **SURVIVED, 1824 pass (F3)** |
| R11′ run site drops only `namedModels` (whole CLI suite) | **SURVIVED, 1824 pass (F3)** |

### Premise table

| Premise | Status |
|---|---|
| Context symptom: on `main` a named call is silently served by MAIN. Re-run: `probe.ts` with `main`'s `model.ts`, `session.ts`, `version.ts`, `remote-client.ts`, `carried-settings.ts` | TRUE: output A–D identical to the Repro |
| `servingModel` has three callers and is the only reader of `modelProvider` (`remote-client.ts:2363,2383,2546`; `:2497,2517`) | TRUE |
| Params parsed before the handler (`peer.ts:338`); dispatch concurrent (`peer.ts:322`) | TRUE |
| One pick of the child's model (`subagent.ts:246-250`) | TRUE |
| A named tunnel never counts: `sendCount` absent → `undefined` (`proxy-model.ts:180-183`); only a session counts (`session.ts:172-176`, `hosted-session.ts:1281`, `session-host.ts:309`) | TRUE |
| A request's `maxTokens` beats the configured one (`openai-provider.ts:274`, `anthropic-provider.ts:417`); only titles set it (`session-title.ts:97`) | TRUE |
| `defaultRunner` had no deadline; Probe 2's race is needed | TRUE (R6 area, `runBounded`) |
| Relay has no terminal, log 0600 (`relay.ts:703-714`); relay uses `attachEngineRuntime` (`relay.ts:361`) | TRUE |
| Schema export refuses a record (`json-schema.ts:70`, `SUPPORTED_KINDS`) | TRUE |
| Implementation line numbers | Written against `74a1d70`; those re-opened had shifted only by this diff (e.g. `engine-runtime.ts:614,1009` → `:645,1040`) |

Not every premise was opened: the handshake lines, `carried-settings.ts:38-42,199-275` and the `key-docs` T6 citations were covered through their tests and the diff.

### Attacks tried

End-to-end trace: real `loadConfig` with real commands, real `laptopModels`, real `RemoteClient`, the real OpenAI provider over HTTP to a fake server logging path and `Authorization`, against a raw-frame pod. Then the real `tunnelledAgent` for the child path. Script: `.tentacle/tmp/models-map-pod/review/e2e.ts` (gitignored). Fake keys only; `TENTACLE_CONFIG_DIR` under the review folder.

| # | Attack (both `model/stream` and `model/streamChunked`) | Result |
|---|---|---|
| 1 | An entry not published (`hidden`), `main`, `main-id`, `fast-id`, `__proto__`, `constructor`, `toString` | `-32600`, 0 HTTP hits. **Holds** |
| 2 | URL, `a/b`, `""`, 65 chars, `"fast\n"`, `null`, `["fast"]` as the name | `-32602` at parse, 0 hits. **Holds** |
| 3 | `fast` with `baseURL`/`apiKey`/`provider` on params and in `request` | Served at `/fast/v1`, `Bearer fake-FAST-key`, `fast-id`. **Holds** |
| 4 | Key routing: `fast`, `cmdok`, `inherit`, no name | Each hit its own path with its own key; `inherit` and no name used the main key by design. **Holds** |
| 5 | `fast` + `purpose:"title"` | `-32600`. **Holds** |
| 6 | Relay key commands: failing, `sleep 30` (700 ms bound), unpublished with a marker file | Two reports; the marker never appeared; load in 707 ms; both names `unavailable`, 0 hits, no key-less request. **Holds (Q2)** |
| 7 | Secrets over the wire: all frames to the pod and `carriedSettings`, searched for every key, URL and id | Carried: none. Frames: only `fast-id`/`main-id`, the attacker's own names echoed in the refusal. **Holds** |
| 8 | Real pod child on `cmdbad` | Tool result names the entry as unavailable; one laptop `onError`. **Holds** (see nit on the prefix) |
| 9 | `agent_task` asking `hidden` | Tool error listing the selectable names, 0 hits. **Holds** |
| 10 | Q1 leftovers: `rg` for gate, `maxConcurrent`, queue, `model-gate`, `maxTokens` drop | None; the request is passed as sent (`remote-client.ts:2381-2383`). **Holds** |
| 11 | Q3: `tunnelSubagentResolver` frontmatter | No `frontmatterModel` (`model-provider.ts:125-130`), pinned by 3 tests (R5). **Holds** |
| 12 | Daemon-side check relied on as security | None: the allowlist is `publishedModelNames(laptop config)` in `laptopModels`; `config.publishedModels` is read only pod-side. A hostile `settings.publishedModels` to a `serve` daemon is ignored (`wiring.ts`, `tunnelled ? … : undefined`). **Holds** |
| 13 | Protocol 19: both ends, no new update kind, `UPDATE_CLASS` untouched, 18↔19 refused | Wired on `model.ts`, `connection.ts`, `remote-client.ts`; R4 and R7 kill either end; `version-mismatch.test.ts` green. **Holds** |
| 14 | Non-`RpcError` from `resolve`/provider creation | Goes to the peer's opaque default: `exposeInternalErrors` only on the worker (`worker.ts:147`). **Holds** |
| 15 | `publishedModels` refused at `session/open` for a legal config (window, description, name bounds) | Config and wire bounds identical (`schema.ts:46,60,66`, env by `parsePositiveInt`). **Holds** |
| 16 | `--model` with an inheriting entry, relay and attach | **Fails: F2** |
| 17 | Trace of a refusal in an unattended relay | **Fails: F1** |
| 18 | `tentacle explain` truthfulness | **Fails: F4** (the `models` section's own text is right) |

### What holds

The allowlist is built only on the laptop, in one place, and is complete for both streaming methods; `model/countTokens` has no name and reaches only main. Keys stay on the laptop. Q1 (c), Q2 (a) and Q3 (b) are followed. A relay key-command failure degrades only that entry, and a key-less request is never made. Hand-over and re-attach use the per-call link lookup, unchanged for named calls; this rests on reading the code and on F3's missing test, not on a live run.

### How the executor behaved

Honest. Execution discloses the unrun mobile typecheck and live check, the stderr in the relay line, and the drift from the plan, and its red-before-green and mutation claims match what was re-run here. Its gap is scope of proof: every load-bearing test exercises `laptopModels` in isolation, so the two call sites that make the feature real were never pinned, and the "laptop's log" claim was tested only at `RemoteClient.onError`, one layer short of where a relay's line is lost.
