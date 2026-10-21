# eval/hooks-project-trust — project hooks in `.agents/hooks.json`, one-time trust (local), per-session (pod)

> **Status:** eval. Owner decisions D3–D6 in the umbrella; **P1–P3 decided 2026-10-21**. Implementation drafted below, approved at promotion.
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10). Promote to `feat/hooks-project-trust`.
> **Type:** eval → feat · **Size:** M · **Blast:** load-bearing (§7 trust model, the single broker, laptop-side persistence, a new daemon→client method) · **Suited:** §10: a **strong model executes**; mandatory fresh-context Review that red-teams §7
> **Umbrella:** [`extensibility.md`](./extensibility.md) (child 4 of 5) · **Needs:** `hooks-core` and `hooks-turn` merged

## Context

*— claude-opus-5-5, 2026-10-21*

### The question

Load hooks that a repository brings (`.agents/hooks.json`) safely. A project
hook is **code execution brought by a cloned repo**: it runs at every
matching tool call and may return `allow`. Without a trust step, a repo
grants itself permissions.

### Decisions

- **D3**: loaded from `.agents/hooks.json` (next to `.agents/skills`), after
  an explicit **one-time** trust.
- **D4**: trust key = folder + **hash of the hook definitions**; a changed
  definition asks again. Script *contents* are not tracked. Stored on the
  laptop, asked through the single broker. Non-interactive → not loaded, with
  a notice.
- **D5**: in a pod (`run`/`attach`), asked **every session, never stored**.
- **D6**: a trusted project hook may `allow` in local only, **never** in a
  pod.
- **P1 — DECIDED (2026-10-21)**: a **new request kind**, not a pseudo-tool
  `PermissionRequest`. Realised as a new **daemon→client method**
  `hooks/trust`, the same direction as `model/stream`. An old laptop answers
  `MethodNotFound`, which is clean and catchable (§7: an additive method
  keeps the version).
- **P2 — DECIDED (owner, 2026-10-21): yes.** a "Never for this folder" answer is stored, so a
  declined repo stops asking (local only).
- **P3 — DECIDED (owner, 2026-10-21): yes.** `tentacle hooks trust --list` / `--revoke <folder>`
  to inspect and revoke stored decisions.

### State today (verified against `main` @ 399ea0b)

| Fact | Evidence |
|---|---|
| Project-scope discovery exists for skills: `.agents/skills` from the launch folder up to the repo root (the folder holding `.git`), never past home | `config/src/skills-scan.ts:42-68` |
| A per-project config file was **rejected** (profiles instead), so hooks get their own file | `docs/eval/project-config.md` (status line) |
| Config (including skills) is loaded where the daemon's config is loaded: the laptop main thread for the local worker (posted to it), **inside the pod** for `run`/`attach` (`serve --stdio --model-proxy` loads its own) | `cli/src/local-runtime.ts:306-307` (`postMessage(config)`); `cli/src/pod-runtime.ts:328`; `cli/src/serve.ts:221-262` |
| The laptop builds one `RemoteClient` per runtime through `createLocalRuntime` (worker **and** pod runtimes) or in `connect` | `cli/src/local-runtime.ts:196-200`; `cli/src/connect.ts:112` |
| The laptop already tells "the daemon proxies the model through me" apart: `LocalRuntimeDeps.modelProvider` is set for pod runtimes only | `cli/src/local-runtime.ts:186-187` |
| `RemoteClient` serves daemon→client requests in `onRequest` (today `model/stream[Chunked]`, else `MethodNotFound`) | `client/src/remote-client.ts:518-529` |
| The daemon sends a daemon→client request through its `Connection` (`requestModelStream`) | `daemon/src/connection.ts:115-124` |
| `session/prompt` reaches the session via `Connection.prompt` → `hosted.prompt(turnId, content, skill)` | `daemon/src/connection.ts:160-161,289-291`; `daemon/src/hosted-session.ts:631` |
| Exactly one `PermissionBroker`, shared by runtime and TUI; on the RPC path it **holds** requests until the TUI installs its requester | AGENTS §7; `core/src/permission.ts:71-80` (`holdUntilSet`) |
| `PermissionRequest` is tool-shaped (`tool`, `level`, `title`, `detail?`, `input`, `suggestion?`); scopes are `once` / `session` | `core/src/permission.ts:16-45` |
| The TUI builds the menu from the request (`buildPermissionChoices`: Yes / Yes-always / No) and has an **auto-approve** mode (Shift+Tab) that grants prompts without asking | `tui/src/permission-ui.ts:1-60` |
| The laptop keeps no grant cache today (the daemon's gate does) | `client/src/permission-router.ts:12-14` |
| Methods are registered once with their schemas | `protocol/src/methods.ts:36-80` |

**Repro (2026-10-21, `main` @ 399ea0b):** nothing reads `.agents/hooks.json`,
and the client refuses any daemon→client request other than the model ones.

```
$ git grep -n "hooks.json" main -- 'packages/*/src'
(no output)
$ git show main:packages/client/src/remote-client.ts | sed -n 518,529p
      onRequest: async (method, params, context) => {
        if (method === Method.ModelStream) {
        ...
        throw new RpcError(JsonRpcErrorCode.MethodNotFound, `unexpected request: ${method}`);
```

## Implementation

*— claude-opus-5-5, 2026-10-21 (draft; approved at promotion)*

### Load-bearing assumption

**The laptop decides, and it alone stores.** The pod daemon asks; the laptop
answers from what *it* knows (its runtime kind, its store, the human). A pod
cannot create a stored approval, because the laptop picks the resolver per
runtime (store-backed only for the local worker), never per what the daemon
claims. Prove it with the test "a pod runtime's resolver never writes the
store, whatever the request says".

### Preconditions

- `hooks-core`: `HookRunner`, `HookSpecSchema`. `hooks-turn`: turn-start
  ordering.
- The single broker exists in `cli/src/main.ts` and is passed to every
  runtime (AGENTS §7). The resolver **must** use that same instance.

### Design

#### 1. The file and its discovery (config, pure + I/O)

`.agents/hooks.json`:

```json
{ "hooks": [ { "event": "tool_call", "matcher": "shell", "command": "./scripts/hooks/guard.sh" } ] }
```

Each entry uses `HookSpecSchema` from `hooks-core`. The wrapper object is
`.strict()`.

`config/src/hooks-scan.ts` (new):
- `projectHooksFiles(launchCwd, home)`: the same walk as `skillRoots`
  (`skills-scan.ts:42-68`): from `launchCwd` up to the folder holding `.git`,
  stop before `home`, and return every existing `<dir>/.agents/hooks.json`,
  nearest first.
- `loadProjectHooks(files)` → `{ folder, hash, hooks, files, diagnostics }`:
  - `folder`: the realpath of the repo root (the `.git` folder's parent), or
    of `launchCwd` when there is no `.git`;
  - `hooks`: the concatenation in walk order; a malformed file → a
    diagnostic, and that file contributes nothing;
  - `hash`: `sha256` hex of `JSON.stringify` over
    `[{ file: <path relative to folder>, hooks: <parsed, keys sorted> }, …]`,
    so a reformatted file with the same content keeps its hash.
- `TentacleConfig.projectHooks?: { folder; hash; hooks: HookSpec[]; files: string[] }`
  (absent when no file). Diagnostics are appended to the startup notices, the
  same way `skillDiagnostics` is (`load.ts:249-262`).

#### 2. Protocol: `hooks/trust` (daemon → client)

`protocol/src/hooks.ts` (new):

```ts
export const HooksTrustParamsSchema = z.object({
  sessionId: SessionIdSchema,
  folder: z.string(),
  hash: z.string(),
  files: z.array(z.string()),
  hooks: z.array(z.object({ event: z.string(), matcher: z.string().optional(), command: z.string() })),
  /** Whether these hooks may `allow` here (false in a pod, D6). Display only. */
  canAllow: z.boolean(),
}).strict();
export const HooksTrustResultSchema = z.object({ trusted: z.boolean() }).strict();
```

`methods.ts`: `Method.HooksTrust = "hooks/trust"` + its `RequestSchemas`
entry. No `PROTOCOL_VERSION` bump (additive method, §7). `hooks-turn`'s bump
to 8 precedes it anyway.

#### 3. Daemon: ask once per session, at the first turn

- `Connection.prompt` (`daemon/src/connection.ts:289`) passes a bound asker to
  `hosted.prompt(…, askTrust)`, where
  `askTrust = (p) => this.peer.request(Method.HooksTrust, p)`. The asker is
  the **prompting** connection, the client that has a human behind this turn.
- `HostedSession.prompt` forwards it to the turn: `session.send(…, { …, askHooksTrust })`
  → `RunOptions.askHooksTrust?: (p: HooksTrustRequest) => Promise<boolean>`.
- `HookRunner` gets the project hooks as a second list
  (`projectSpecs`, `projectFolder`, `projectHash`, `projectCanAllow`) and a
  per-runner state `"unknown" | "trusted" | "declined"`. Project hooks run
  only when `"trusted"`, **after** user hooks for the same event.
- In `Agent.runMessages`, **before** the `turn_start` hooks (and not on
  `resumeFrom`): if the runner has project hooks and the state is `"unknown"`,
  then `state = (await opts.askHooksTrust?.(req)) ? "trusted" : "declined"`.
  The ask resolves to `false` on:
  - no asker;
  - the request rejecting (an old laptop's `MethodNotFound`, a disconnect);
  - the turn being aborted.

  Each of these is logged. Asked **once per runner**, i.e. once per daemon
  session.
- `projectCanAllow` = `options.modelOverride === undefined` in `buildAgent`
  (a pod proxies the model, so it is the pod case, D6). With `false`, a
  project hook's `allow` vote is downgraded to `none` in
  `combineToolCallVotes` (add a `scope` field to votes).

#### 4. Laptop: the resolver (pure decision + I/O)

`cli/src/hooks-trust.ts` (new):

```ts
export type TrustEntry = { readonly hash: string; readonly decision: "trusted" | "never" };
/** Pure: what to do before asking anyone. */
export function trustPrecheck(entry: TrustEntry | undefined, hash: string, interactive: boolean):
  "trusted" | "declined" | "ask";
// never → declined (any hash, P2); trusted with the same hash → trusted;
// otherwise interactive ? ask : declined.

export interface HooksTrustStore { get(folder: string): TrustEntry | undefined; set(folder: string, e: TrustEntry): void; delete(folder: string): void; list(): [string, TrustEntry][] }
/** File-backed: `<configDir>/hooks-trust.json`, written atomically (temp + rename), 0600. */
export function fileTrustStore(configDir: string): HooksTrustStore;

export function createHooksTrustResolver(opts: {
  readonly broker: PermissionBroker;   // THE single broker
  readonly interactive: boolean;
  readonly store?: HooksTrustStore;    // local worker runtime ONLY
  readonly notify?: (line: string) => void;
}): (p: HooksTrustParams) => Promise<{ trusted: boolean }>;
```

Flow: `precheck` (with `store?.get(p.folder)`, and `undefined` when there is
no store) → `"ask"` → `broker.request({ kind: "hooks_trust", tool: "hooks",
level: "ask", title: "Trust the hooks of this project?", detail, input: p })`.
`detail` lists `folder`, every `event matcher → command`, the files, and,
when `canAllow`, "These hooks can approve tool calls without asking you." It
also says: "This trusts these commands, not the contents of the files they
run."

Answer mapping:

| Menu choice | Response | Store (only when a store exists) | Result |
|---|---|---|---|
| Trust for this session | `{allowed:true, scope:"once"}` | — | trusted |
| Always trust this project | `{allowed:true, scope:"session"}` | `set(folder, {hash, "trusted"})` | trusted |
| Don't trust | `{allowed:false}` | — | declined |
| Never for this project | `{allowed:false, scope:"session"}` | `set(folder, {hash, "never"})` | declined |
| dismissed / withdrawn | `DISMISSED` | — | declined |

Without a store (pod, connect) the menu has only the first and third
choices.

`RemoteClientOptions` gains `hooksTrust?: (p) => Promise<{trusted: boolean}>`.
`onRequest` handles `Method.HooksTrust`: if the option is set, call it; if
not, return `{ trusted: false }`.

Who passes what (`cli/src/main.ts`, where the broker and runtimes are built):

| Runtime | `store` | `interactive` |
|---|---|---|
| local worker (`startWorkerRuntime`) and its in-process fallback | `fileTrustStore(config.configDir)` | true for the TUI, false for prompt/piped modes |
| pod `run` / `attach` (`createLocalRuntime` with `modelProvider`) | **none** (D5) | as above |
| `connect` | **none** (conservative: the folder is on another host) | as above |

#### 5. The broker request kind (laptop-internal, not on the wire)

- `core/src/permission.ts` `PermissionRequest` gains
  `readonly kind?: "tool" | "hooks_trust"` (absent = `"tool"`).
- `tui/src/permission-ui.ts` `buildPermissionChoices`: for `hooks_trust`,
  return the menu from the table above. Show the 4-choice menu when a store
  exists, the 2-choice menu otherwise; carry that as
  `input.storeBacked: boolean` set by the resolver.
- **Auto-approve never answers a `hooks_trust` request**: the auto-accept
  branch in `permission-ui.ts` must check `req.kind !== "hooks_trust"`. This
  is a §7-grade rule. Test it.
- `PermissionPrompt.tsx` renders `detail` as multi-line text (check that it
  already does; if not, a minimal change).

#### 6. P3: `tentacle hooks trust`

`cli/src/flags.ts`: a new subcommand `hooks` (`:364-367` list, the `CliMode`
union `:425`, the dispatch `:437`). It supports `tentacle hooks trust --list`
(prints folder, decision, hash prefix) and
`tentacle hooks trust --revoke <folder>`. It runs before any TUI, so plain
stdout is fine.

### Files (dependency order)

1. `packages/protocol/src/hooks.ts` (new), `methods.ts`, `index.ts`; then `bun run schema:export`
2. `packages/core/src/permission.ts` (`kind`)
3. `packages/config/src/hooks-scan.ts` (new), `load.ts` (`projectHooks`, diagnostics)
4. `packages/agent/src/hooks.ts` (project specs, trust state, scope on votes), `agent.ts` (`RunOptions.askHooksTrust`, ask before `turn_start`), `session.ts` (forward the option; verify the exact `send` signature)
5. `packages/daemon/src/connection.ts`, `hosted-session.ts`
6. `packages/client/src/remote-client.ts` (`hooksTrust` option + `onRequest`)
7. `packages/cli/src/hooks-trust.ts` (new), `wiring.ts` (`projectSpecs`, `projectCanAllow`), `local-runtime.ts` (pass `hooksTrust`), `main.ts` (build resolvers per runtime), `connect.ts`, `flags.ts` (P3)
8. `packages/tui/src/permission-ui.ts`, `components/PermissionPrompt.tsx`
9. tests (below)

### Failure modes

| Case | Convergence |
|---|---|
| `git pull` adds or changes a hook | the hash changes → precheck says `ask` |
| A script referenced by an unchanged `hooks.json` changes | not detected (D4, by design); the prompt says so |
| Non-interactive run (prompt / piped) | `interactive: false` → declined without prompting; a notice through the status line before Ink mounts, or the run's stderr (§7) |
| Auto-approve (Shift+Tab) is on | never answers `hooks_trust` (test) |
| Old laptop (no `hooks/trust`) | `MethodNotFound` → declined + daemon log; the session continues without project hooks |
| Laptop disconnects while asked | the request rejects → declined for this runner; the next session asks again |
| Two clients attached (`serve` + `connect`) | asked on the **prompting** connection only |
| A pod claims `canAllow: true` | display only; the laptop never stores for a pod, and D6 is enforced daemon-side as UX (§7: a pod daemon's check is never security; the gate is daemon-side in a pod anyway) |
| A pod forges `folder` / `hash` | irrelevant: nothing is stored for a pod runtime |
| Malformed `.agents/hooks.json` | that file is skipped with a diagnostic; other files still load; hash over the valid ones |
| The store file is corrupt | treated as empty (and logged); the next `set` rewrites it |
| User and project hooks on the same event | user first, then project (documented) |

### Tests (red before green, §9)

- `cli/test/hooks-trust.test.ts`:
  - `trustPrecheck`: every row (never/any hash, trusted/same, trusted/other
    hash, none, non-interactive).
  - The resolver with a spy broker and an in-memory store: each menu answer
    → result + store effect.
  - **No store → never writes, whatever the answer**. Mutation check: pass
    the store into the pod branch in `main.ts` wiring and see the
    wiring-level test fail.
- `tui/test/auto-approve.test.tsx`: with auto-approve on, a `hooks_trust`
  request still shows the prompt. **Red first**: today auto-approve grants
  every request.
- `config/test/hooks-scan.test.ts`: walk stops at the repo root and before
  home; two files concatenate nearest-first; a reformatted file keeps its
  hash; a changed command changes it; a malformed file → a diagnostic.
- `agent/test/hooks-project.test.ts`: project hooks do not run before trust;
  `askHooksTrust` resolving false → they never run; asked once per runner;
  `projectCanAllow: false` downgrades a project `allow` (the tool prompts).
- `client/test/remote.test.ts`: `hooks/trust` with no option →
  `{trusted:false}`; with an option → its answer.
- `daemon` integration: an old-laptop peer (`MethodNotFound`) → the turn
  runs without project hooks.

Gate: `bun run check` green.

## Execution

*(empty until promoted)*

## Review

*— claude-opus-5-5, 2026-10-21*

Self-review. This is the §7-critical child. The fresh-context Review must
attack:

1. Can a pod-originated answer ever be stored?
2. Can a pod hook's `allow` become a laptop-side approval?
3. Can auto-approve or a non-interactive broker (`allowAll`) silently trust?

The design answers each with a test.
