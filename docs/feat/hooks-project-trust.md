# feat/hooks-project-trust — project hooks in `.agents/hooks.json`, one-time trust (local), per-session (pod)

> **Status:** feat — promoted 2026-10-22. Owner decisions D3–D6 in the umbrella; P1–P3 decided 2026-10-21. Implementation approved.
> **Branch:** `feat/hooks-project-trust`
> **Type:** eval → feat · **Size:** M · **Blast:** load-bearing (§7 trust model, the single broker, laptop-side persistence, a new daemon→client method) · **Review:** mandatory fresh-context, red-teams §7
> **Umbrella:** [`extensibility.md`](../eval/extensibility.md) (child 4 of 5) · **Needs:** `hooks-core` and `hooks-turn` merged ✓

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

*— claude-opus-5-5, 2026-10-22*

**Repro (before any edit, branch @ 467605c)** — `.tentacle/tmp/hooks-project-trust/repro.ts`
(a temp repo with `.git` + `.agents/hooks.json`, then `loadConfig`):

```
projectHooks: undefined
hooks: []
Method.HooksTrust: undefined
(no hooks.json reader)        # git grep -n "hooks.json" -- 'packages/*/src'
```

**As built, in plan order:**

1. Protocol — `protocol/src/hooks.ts` (new: `HooksTrustParams/ResultSchema`),
   `methods.ts` (`Method.HooksTrust` + schemas), `index.ts`, `schema/protocol.json`
   (`schema:export`), JSON-schema fixtures in `protocol/test/json-schema.test.ts`.
   `PROTOCOL_VERSION` stays **9** (additive method).
2. `core/src/permission.ts`: `PermissionRequest.kind?: "tool" | "hooks_trust"`.
3. `config/src/hooks-scan.ts` (new): `parseProjectHooksFile`, `projectHooksHash`
   (sha256 over canonical, key-sorted JSON), `projectHooksFiles` (the `skillRoots`
   walk), `discoverProjectHooks`. `load.ts`: `TentacleConfig.projectHooks?` +
   `projectHooksDiagnostics`, printed as `[hooks] …` in `cli/main.ts` before Ink
   (same place/guard as `[skills]`).
4. `agent/src/hooks.ts`: `HookRunnerOptions.project` / `projectTrust`; a shared
   `ProjectTrustState` (passed on by `forAgent`, so sub-agents share the session's
   decision); `needsProjectTrust`, `projectTrustRequest`, `resolveProjectTrust`
   (declined on no asker / rejection / cancel, each logged); project specs join
   only when `"trusted"`, after the user's; pure `projectVote` (D6).
   `agent.ts`: `RunOptions.askHooksTrust`, `AgentConfig.askHooksTrust` (fallback),
   the ask before a fresh turn's first hook/tool. `session.ts`: forwards it.
5. `daemon/src/connection.ts` (`prompt` passes an asker bound to the PROMPTING
   connection's peer, with the turn's signal), `hosted-session.ts` (forwards it).
6. `client/src/remote-client.ts`: `RemoteClientOptions.hooksTrust(params, signal)`;
   `onRequest` serves `hooks/trust` (no option → `{trusted:false}`).
7. `cli/src/hooks-trust.ts` (new): `trustPrecheck`, `trustOutcome`,
   `hooksTrustDetail`, `fileTrustStore` (temp+rename, 0600, corrupt → empty +
   reported), `createHooksTrustResolver`, `hooksTrustCommand` (P3).
   `local-runtime.ts`: `createLocalRuntime` builds the resolver on
   `deps.permissions`; `startWorkerRuntime` passes `hooksTrustStore`.
   `connect.ts`: resolver without a store. `wiring.ts`: project hooks into the
   `HookRunner` (`canAllow: modelOverride === undefined`); `inProcessAgents`
   gives its agents an asker on its one broker + the file store.
   `flags.ts`/`main.ts`: `tentacle hooks trust --list | --revoke <folder>`.
8. `tui/src/permission-ui.ts`: `autoApproves` (false for `hooks_trust`) checked
   in BOTH auto-accept paths (requester and Shift+Tab with a prompt on screen),
   the 4/2-choice trust menu, `permissionDetailLines`;
   `components/PermissionPrompt.tsx` + `App.tsx` render/size multi-line detail.
9. README `### Hooks`: a "Project hooks" bullet.

**Drift from Implementation (and why):**

- Protocol strings are bounded and control-character-free (as `skills/list`):
  the daemon may be a pod and these strings reach the prompt. Too many hooks
  (>100) fail validation → the ask rejects → declined.
- Config: `discoverProjectHooks(launchCwd, home)` instead of
  `loadProjectHooks(files)` (the folder needs the walk); diagnostics are a
  separate `projectHooksDiagnostics` field, not appended to `skillDiagnostics`
  (those feed the `/skills` panel's problems).
- D6 is a pure `projectVote` applied to project votes inside
  `HookRunner.toolCall`, instead of a `scope` field threaded through
  `combineToolCallVotes` (same effect, smaller diff). A project `modify` keeps
  its rewrite but loses a forced `allow`.
- The trust ask sits before the user-skill round and `turn_start` (before any
  hook or tool of a fresh turn), not only before `turn_start`. The asker gets
  the turn's signal, so a cancel also cancels the daemon request and withdraws
  the laptop prompt.
- In-process TUI fallback (no RPC): `AgentConfig.askHooksTrust` fallback, wired
  in `inProcessAgents` on its single broker.
- The store choice lives in `createLocalRuntime`: the store is used only when
  `!deps.modelProvider`, so a pod runtime never gets one even if a caller
  passed it (the load-bearing test drives this).
- `interactive` is `true` on every RPC runtime (all of them drive the TUI). The
  non-interactive paths (`--plain`, one-shot) build agents with no asker →
  declined, logged as `[hook] …` on stderr (no Ink there).
- Extra guard (Review Q3): `trustOutcome` trusts only a menu answer with a scope;
  a bare `{allowed:true}` (a headless `allowAll` requester) never trusts.
- `client/mapping.ts` unchanged: `hooks/trust` is a request, not a
  `session/update` variant.
- `tentacle hooks …` was a one-shot prompt before; it is now a subcommand.

**Tests (each shown red on its assertion before green, or by mutation):**

- `config/test/hooks-scan.test.ts` (9). Mutations: no `.git` stop → walk test
  fails; no key sort → key-order hash test fails.
- `agent/test/hooks-project.test.ts` (10). Mutations: `projectVote` identity
  (2 fail); ignore trust state (4); no abort race (cancel test fails); trust not
  shared with `forAgent` (1); agent ignores the turn's asker (4).
- `client/test/remote.test.ts` "hooks/trust" (5): no resolver → `{trusted:false}`;
  resolver gets params + a signal the link drop aborts; control characters are
  schema-rejected (mutation: drop the regex → fails); daemon integration: an old
  laptop's `MethodNotFound` → turn runs without project hooks; asked once per
  session on the prompting connection. Red: client `onRequest` reverted (3
  fail); daemon asker removed (2 fail).
- `cli/test/hooks-trust.test.ts` (23): precheck rows, answer mapping, store
  effects, no-store, non-interactive, allowAll, withdrawal, file store, P3, and
  the wiring test "pod runtime: NEVER stored". Mutations: pod gets the store (1
  fail); bare allow trusts (2); never asks again (2); signal ignored (1); hash
  ignored (3).
- `cli/test/wiring.test.ts` (+2): D6 `canAllow` false over the model tunnel
  (mutation `canAllow: true` → fails); in-process trust goes to the ONE broker.
- `tui/test/auto-approve.test.tsx` (+2): with auto-accept on, a trust request
  still prompts; Shift+Tab with a trust prompt on screen does not grant it.
  Red: `autoApproves` → `true` (both fail).

**Gate:** `bun run check` green — typecheck clean, lint 0 errors / 0 warnings, tests 1767 pass / 2 skip (the opt-in ones) / 0 fail. After post-review fixes: 1773 pass / 2 skip / 0 fail, lint 0/0.

**Post-review fixes** (*— claude-opus-5-5, 2026-10-22*; each new test red under the named mutation, then green):

1. Pinned the daemon's answer mapping: "the laptop answers `{trusted:false}` →
   the project hook never runs" (`client/test/remote.test.ts`). Red under
   `.then(() => true)` in `daemon/src/connection.ts`.
2. The control-character test now sends a **raw** `hooks/trust` frame (no
   daemon-side peer validation), asserts `-32602` and an uncalled resolver.
   Red with the inbound params check in `transport/src/peer.ts` disabled.
3. `client/src/remote-client.ts` `onHooksTrust`: `{trusted:false}` for a session
   this client did not open (or is closing), and at most one trust prompt in
   flight per session. Red: each check removed (1 fail each). The cli wiring
   rig now opens a session before asking (the pod "never stored" mutation
   still fails it).
4. `protocol/src/hooks.ts`: also rejects bidi/format controls (U+200E/F,
   U+202A–E, U+2066–9). U+202E test red without them.
5. `agent/src/hooks.ts`: a cancel while asked is no decision — state stays
   `"unknown"`, the next turn asks again (logged "not run this turn"). Red when
   the cancel records a decline.
6. `cli/src/hooks-trust.ts` `projectHooksWireProblem`: project hooks whose
   `hooks/trust` request would fail the wire schema (too many, control chars,
   too long) print a startup `[hooks] …` line in `main.ts`, on the same
   pre-Ink stderr path and guard as the other `[hooks]`/`[skills]` lines
   (config-schema rejections already printed there). Red with the check off.
7. `PermissionPrompt.tsx`: no "writes confined here" row for a trust request
   (`permissionShowsCwd`; `permissionPromptRows` sizes it). Red when shown.
8. `--revoke` resolves the folder's real path (relative, `..`, symlinks; a
   missing folder by its resolved path). Red without `realpathSync`.
9. "Old laptop" is now a raw `RpcPeer` client with no `hooks/trust` handler:
   the daemon gets a real `MethodNotFound` response.

**Unverified:** a real `run`/`attach` session against a cluster (the pod path is
covered by the `createLocalRuntime` wiring test with a raw daemon peer, not a
live pod); the trust dialog in a real terminal (covered by ink-testing-library frames).

## Review

*— claude-opus-5-5, 2026-10-22 — fresh-context adversarial review. **Same model as the executor** (only the context is fresh): shared blind spots can survive both passes; a load-bearing task would ideally get a second review from a different model (AGENTS §10).*

### Verdict: **REQUEST-CHANGES** (test-only; the code's trust model holds)

Every §7 property I attacked holds in the code, and I confirmed it end to end.
Two load-bearing properties have no test that pins them, though: a mutation in
one and a mutation under the other leave the suite green. AGENTS §9 makes
non-vacuity mandatory for a load-bearing task. The fixes are small and
change tests only.

**Must-fix**

1. **The daemon's answer mapping is unpinned.** It lives at
   `daemon/src/connection.ts:307-311` (`.then((r) => r.trusted === true)`).
   Mutation: `.then(() => true)`, so the daemon trusts whatever the laptop
   says. Result: **55 pass / 0 fail** in `client/test/remote.test.ts`. No
   test drives a laptop that answers `{trusted:false}` through the real
   `Connection`. The integration tests answer `true` or throw. If this line
   regresses, the local worker runs a repository's hooks that the user
   declined. *Change:* in `client/test/remote.test.ts`, next to
   `projectDaemon()` (≈:1730), add "the laptop declines → the turn runs, and
   the project hook never runs" (`hooksTrust: async () => ({ trusted: false })`,
   then `ran` must equal `[]`). Show it red under the mutation above.
2. **The control-character test is vacuous.** It is at
   `client/test/remote.test.ts:1710`. It sends the frame with
   `RpcPeer.request`, which validates params **outbound**
   (`transport/src/peer.ts:151-157`), so the bad frame never leaves the fake
   daemon. Mutation: I disabled the **inbound** validation
   (`peer.ts:325-326`, the only defence against a hostile pod that writes raw
   frames). The test still passed (**1 pass / 0 fail**). *Change:* send a raw
   JSON-RPC frame with `daemonCh.send(JSON.stringify({jsonrpc:"2.0",id:1,method:"hooks/trust",params:{…folder:"/r\u001b[2J"}}))`
   and assert a `-32602` error and that the resolver was never called. I ran
   that exact raw-frame probe against the current code: rejected with
   `-32602`, resolver not called. So the code is right; only the test is not.

**Nits (do not block)**

3. A pod can raise trust prompts **out of turn, for any `sessionId`, without
   limit**. My e2e A1/A3: an unknown session gets a prompt, and 3 concurrent
   requests produce 3 prompts. Nothing durable happens, but each prompt can
   take the dialog over: `tui/src/permission-ui.ts:167` overwrites
   `resolveRef`, which orphans a pending tool prompt. The orphaning predates
   this task, but this task gives the pod a new out-of-band trigger.
   *Suggest:* in `client/src/remote-client.ts:574`, answer `{trusted:false}`
   when `params.sessionId` is not a session this client has open, plus at
   most one trust request in flight per session.
4. `NO_CONTROL` (`protocol/src/hooks.ts:17`) lets bidi overrides through.
   U+202E passed in e2e A2, which allows display spoofing in the prompt.
   *Suggest:* also reject `‎‏‪-‮⁦-⁩`.
5. A cancel while the trust prompt is up declines **for the rest of the
   session** (`agent/src/hooks.ts:457,467`). The user then has to `/clear`
   to be asked again. The plan allowed this, but an Esc is not a decision.
   *Suggest:* leave the state `"unknown"` on cancel.
6. A local definition that the protocol schema rejects is **silently never
   trustable**: a multi-line `command`, more than 4096 chars, or more than
   100 hooks. The worker's outbound validation fails, which counts as
   "declined", and that appears only in the daemon log. *Suggest:* report it
   as a startup `[hooks]` diagnostic from `discoverProjectHooks`.
7. The trust dialog still shows the `cwd · writes confined here` row
   (`PermissionPrompt.tsx:53`), which means nothing for a trust question.
8. `tentacle hooks trust --revoke <folder>` matches the stored string
   exactly (`cli/src/hooks-trust.ts:223`), so `--revoke .` or a symlinked
   path does not match. *Suggest:* `realpath` the argument (fall back to the
   literal).
9. The "old laptop" integration test (`remote.test.ts:1770`) fakes
   `MethodNotFound` by throwing from a new resolver. A real old client
   answers from `peer.ts:321-322` ("unknown method"). The daemon treats both
   rejections the same, so the convergence still holds.

### Gate (re-run by the reviewer)

`bun run check`: typecheck clean · lint `Checked 369 files … No fixes applied`
(0/0) · **1767 pass / 2 skip (the opt-in ones) / 0 fail**, 1769 tests in 152
files. This matches the Execution. No session-reaper flake this run.

### Premise table

| Premise (Context/Implementation) | Verdict |
|---|---|
| Symptom: nothing reads `.agents/hooks.json` and there is no `hooks/trust` on `main` | TRUE: `git grep hooks.json main -- 'packages/*/src'` → 0, and `HooksTrust` → 0 |
| `skills-scan.ts:42-68` walk (stop after `.git`, before home) | TRUE; reused 1:1 in `projectHooksFiles` |
| `local-runtime.ts:186-187`: `modelProvider` is set only for pods (@399ea0b) | TRUE: only `pod-runtime.ts:355,543` pass it |
| `remote-client.ts:518-529` `onRequest` (@399ea0b) | TRUE |
| `connection.ts:289-291` `prompt` → `hosted.prompt` (@399ea0b) | TRUE |
| `permission.ts:71-80` `holdUntilSet` | TRUE |
| `permission-router.ts:12-14`: no laptop grant cache | TRUE |
| Peer validates inbound params per method | TRUE (`peer.ts:325`); see finding 2 for its test |

Line numbers are cited at 399ea0b. Current `main` has drifted by a few
lines, but the content is unchanged.

### Mutations (all reverted; tree byte-identical, `git diff | md5` checked before and after)

| Mutation | Result |
|---|---|
| Pod gets the store (`local-runtime.ts` drops `&& !deps.modelProvider`) | `hooks-trust.test.ts` 1 fail ✓ |
| `autoApproves` → `true` | `auto-approve.test.tsx` 2 fail ✓ |
| A bare `{allowed:true}` trusts (`trustOutcome`) | `hooks-trust.test.ts` 2 fail ✓ |
| D6: `canAllow: true` over the model tunnel (`wiring.ts`) | `wiring.test.ts` 1 fail ✓ |
| Client with no resolver trusts | `remote.test.ts` 1 fail ✓ |
| Daemon ignores the laptop's answer (`connection.ts`) | **0 fail ✗ (finding 1)** |
| Inbound param validation disabled (`peer.ts`) | **0 fail ✗ (finding 2)** |

### End-to-end trace (`.tentacle/tmp/hooks-project-trust/review/e2e.ts`)

The path: real `loadConfig` on a temp repo → `buildAgent` → `SessionHost` +
`Connection` → real `createLocalRuntime` with a `fileTrustStore`. A pod is
simulated by a raw `RpcPeer` with `modelProvider` set.

```
turn1 prompts: 1 hook ran: true store: { "<realpath>/repo": { "hash": "43e94d…", "decision": "trusted" } }
turn2 (new session, same hash) prompts: 0 ran lines: 2
turn3 (changed def, user says No) prompts: 1 CHANGED ran: false
A1 forged laptop folder, no turn, unknown session, answer=Always -> {"trusted":true} prompted: 1 storeBacked: false pod store file exists: false
A1 … answer=Never -> {"trusted":false} prompted: 1 storeBacked: false pod store file exists: false
A2 spoof /repo\u001b[2J -> rejected · "a\nb" command -> rejected · 5000-char folder -> rejected · extra key -> rejected · /repo‮ -> ACCEPTED (nit 4)
A3 spam x3 -> 3 more prompts (nit 3)
A4 allowAll broker -> {"trusted":false}
raw frame (bypassing outbound validation), ESC in folder -> -32602, resolver calls: 0
```

### Attacks tried (as the pod daemon, which can write raw RPC frames)

- **A lasting trust on the laptop. Holds.** The store reaches only
  `startWorkerRuntime` (`local-runtime.ts:366`), and `createLocalRuntime`
  drops it when `modelProvider` is set. A forged laptop path with "Always" or
  "Never" wrote nothing (A1). `connect` builds its resolver with no store.
  The `modelProvider` discriminator is a second guard, not the primary one.
  The primary guarantee is that only the worker passes a store. It is robust
  today because the model tunnel is exactly what makes a runtime a pod. A
  future runtime that is remote but runs its own model would also need to
  withhold the store, which it does by default because nobody passes one.
- **Auto-approval. Holds.** Auto-accept and Shift+Tab never answer
  `hooks_trust` (mutation-pinned). `allowAll` (the in-process broker before
  Ink mounts, or after `reset()`) returns a scopeless `{allowed:true}`, and
  `trustOutcome` maps that to *not trusted* (A4, mutation-pinned). This
  guard is load-bearing for `inProcessAgents`: its `new PermissionBroker()`
  is not `holdUntilSet`.
- **Prompt spoofing. Mostly holds.** The title is fixed on the laptop. C0
  and C1 controls, newlines, oversize strings and unknown keys are rejected
  inbound (raw-frame probe). Bidi overrides get through (nit 4). In a pod a
  "Trust" answer has no effect on the laptop at all. It only tells the pod
  something it could do anyway.
- **Out-of-turn prompts and spam. Possible** (nit 3). The only effect is a
  nuisance on the laptop or a hung turn of the attacker's own session.
- **Connection, disconnect and cancel. Holds.** The asker is bound to the
  prompting `Connection` (`connection.ts:307`). A link drop aborts the
  client-side signal, so the prompt is withdrawn and resolves DISMISSED,
  which means declined. A cancel aborts the daemon request through
  `$/cancelRequest`. Both are covered by existing tests.
- **TOCTOU. Holds** for the definitions. The hash and the executed specs are
  the same parsed objects (`hooks-scan.ts`, loaded once per config load). A
  change on disk mid-session is not re-read, and a new session re-hashes it
  (turn3). Script *contents* are not covered, by design (D4), and the prompt
  says so.
- **Single broker. Holds.** `createLocalRuntime` and `connectTui` build the
  resolver on the same `permissions` they give `RemoteClient`, and
  `inProcessAgents` uses its one broker (wiring test).
- **Peer serialization. Holds.** `onRequest` awaits only the resolver. The
  peer dispatches inbound requests with `void handleRequest`, so a trust
  prompt does not block `session/enqueue` or `resolve_permission`.
- **Per-project keying of the local store. Holds.** The key is the
  `realpath` of the repo root, together with the hash (turn1 and turn2).
- **Protocol. Holds.** `PROTOCOL_VERSION` stays 9 and the method is
  additive. An old client's peer answers `MethodNotFound` ("unknown
  method"), which the daemon treats as declined and logs. An old daemon
  never sends the request.
- **`tentacle hooks` subcommand. Works**, and needs no API key: `--list` in
  an empty HOME prints "no stored…", exit 0. A bare `hooks` exits 1 with
  usage. Breaking: a one-shot prompt that starts with "hooks" now needs
  `--`, which the executor documented. `--plain` and one-shot build agents
  with no asker, so they decline and log `[hook] … (no client to ask)` to
  stderr.

### Drift judged

- **Bounded strings: good**, and needed (see the attacks).
- **`projectVote`:** equivalent to a scoped `combineToolCallVotes` and
  mutation-pinned. Accepted.
- **Trust asked before the `/skill` round:** correct. A skill round can run
  hooks and tools.
- **Pod rule keyed on `modelProvider`:** acceptable, as a second guard (see
  the attacks).
- **A scopeless allow is not trust: required**, not optional (see
  `inProcessAgents`).
- **`hooks` subcommand: fine.**
- **`client/mapping.ts` unchanged: correct.** This is a request, not a
  `session/update` variant.

### Executor behaviour

The Execution is accurate. Every gate number and drift item matched what I
found. The executor took the most dangerous paths seriously: the store
guard, auto-approve, and a scopeless allow are all mutation-pinned. The
over-claim was "each shown red": two of the claimed red checks prove a
weaker property than the one that matters. The control-character mutation
removed the regex from a schema that both ends share, so it could not
detect a missing inbound check (§2's "weaker correlated property" trap).
The executor left mutation backups (`*.bak`) in
`.tentacle/tmp/hooks-project-trust/`. They are harmless because the folder
is gitignored.

### Re-review (after the executor applied findings 1–9)

**Verdict: APPROVE.**

- **Gate:** `bun run check`: typecheck clean · lint 0/0 (369 files) ·
  **1773 pass / 2 skip (opt-in) / 0 fail**.
- **Mutations re-run by me** (all reverted, tree byte-identical):

  | Finding | Mutation | Result |
  |---|---|---|
  | 1 | Daemon ignores the answer (`.then(() => true)`) | `remote.test.ts` 1 fail ✓ |
  | 2 | Inbound validation off (`peer.ts`) | 2 fail ✓; the raw-frame test now bites |
  | 3 | Session check and in-flight check both dropped | 2 fail ✓ |
  | 3 | In-flight check alone dropped | 1 fail ✓ |
  | 4 | Bidi range removed from `NO_CONTROL` | client 1 fail, protocol 1 fail ✓ |
  | 5 | A cancel records "declined" again | `hooks-project.test.ts` 1 fail ✓ |

- **Finding 3 against legitimate flows:**
  - `onHooksTrust` (`remote-client.ts`) declines only when the session is
    missing from `this.sessions`, is `closing`, or already has a trust
    request in flight.
  - A real ask happens only inside a `session/prompt` turn. That turn runs
    after `openSession` has registered the entry. The main-owned uid path
    registers it *before* `open`; the daemon-picked path registers it
    before `whenLive`.
  - `connect` re-attach goes through the same `register`.
  - A reconnect keeps entries (`recover` deletes only `closing` ones).
  - A request still in flight on a dropped link dies with that link's daemon
    `Connection`, which declines daemon-side anyway. The `finally` then
    clears the in-flight mark.
  - I found no legitimate path where a real ask is now wrongly declined. My
    local-worker e2e still prompts once, stores, and runs the hook. A new
    session with the same hash runs without a prompt, and a changed
    definition asks again.
- **Probe re-run (hostile pod over raw frames):**
  - A forged laptop folder or an unknown session gives `{trusted:false}` with
    **0 prompts**. 3 concurrent spam requests give **0 prompts**.
  - ESC, U+202E, a newline, an oversize string and an extra key are all
    rejected, and the raw-frame ESC gets `-32602` with the resolver never
    called.
  - `allowAll` gives `{trusted:false}`. No store file is written for a pod.
- **Findings 6–9:** present. `projectHooksWireProblem` appears in
  `cli/main.ts:276`, `realpathSync` in `--revoke`, `permissionShowsCwd`
  hides the cwd row, and the old-laptop test uses a real peer-shaped
  `MethodNotFound`.
- **Reviewer:** same model as the executor (only the context is fresh); see
  the caveat above.

*— claude-opus-5-5, 2026-10-22*
