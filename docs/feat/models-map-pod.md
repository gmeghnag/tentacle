# feat/models-map-pod — `models` in pod runs: a name on the tunnel, a laptop allowlist

> **Status:** implementation written; owner questions open (end of Implementation); Execution not started
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
| F7 | A huge stream of requests to an expensive entry | **In scope, narrowly [Q1].** At most `subagents.maxParallel` named calls run at once and 32 wait; past that, an error. This matters because a config with a local main model and a paid entry would otherwise give a pod a new way to spend. `maxTokens` from the pod is dropped on named calls. It bounds the RATE, not the total: a budget is a separate feature (Notes). An honest single session never queues, because children are capped at the same number. Several sessions on one laptop may queue: slower, correct. |
| F8 | Version skew, laptop 19 ↔ pod 18, or the reverse | `initialize` refuses with the worded `VersionMismatch`. Without the bump a laptop 18 would serve a named call with main, silently (Repro A). Pinned 18 ↔ 19. |
| F9 | `attach` to a pod with an older tentacle | Today's path, unchanged: the worded mismatch, the binary replaced at `attach`, `residentGuard` protecting a run still in use (`engine-runtime.ts:878-886`). A replaced daemon has no old session to keep. |
| F10 | A detached relay | Needs the published keys. Runs them with no terminal, bounded: D6's table. A failure makes one entry unavailable; the run goes on. |
| F11 | Hand-over between relay and TUI | The link is looked up per call (`serve.ts:423-429`), so the next named call goes to the new laptop process, with its own keys and gate. A batch call queued on the closed link is rejected (D4). |
| F12 | `--resume` (a new session from the laptop's copy) | `open{messages, settings}` carries the CURRENT publication. History's `agent_task` `model` arguments are only history. A name no longer published applies to no new call: an unknown `model` in a new call is the tool's error (task 3 B1). |
| F13 | Re-attach to a live session after the laptop's config changed | `settings` apply only on create, so the session keeps its old routing. A name still asked but no longer published is refused (F1), and the child errors. The drift notice appears (`"models": "(text differs)"`), and `/settings sync` rebuilds the agent. |
| F14 | Two laptops on one pod | The most recent serving connection is the link. It serves with ITS allowlist and keys: a name it lacks is refused (F1), a same-named entry is that laptop's. |
| F15 | `settings` absent (a bare open) or nothing published | No `publishedModels`, no `modelFor`, an empty selectable list: every child on the main tunnel, as today. `namedModels` absent on the laptop: every name refused. |
| F16 | The pod's own `agents/*.md` names a model | A published name: used (Owner Q3). Anything else: the main tunnel, as today, and the id is not sent. |
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

## Execution

*Not started.*

## Review

*Not started.*
