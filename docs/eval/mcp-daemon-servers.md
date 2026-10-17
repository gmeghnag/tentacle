# eval/mcp-daemon-servers — `runOn: "daemon"`: MCP servers started in the pod, without shipping secrets

> **Status:** eval (Context + Review; Implementation/Execution empty until promoted)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10). Promote to `feat/mcp-daemon-servers`.
> **Type:** eval → feat · **Size:** M · **Blast:** load-bearing (config schema, the pod daemon's lifecycle, the "never creds in a pod" invariant) · **Suited:** a strong model executes; mandatory fresh-context Review.
> **Umbrella:** [`remote-execution-model.md`](./remote-execution-model.md) (piece 4 of 4).
> **Needs:** the `runOn` config field (introduced by [`mcp-client-tools.md`](./mcp-client-tools.md), or here if this goes first). Independent of the tunnel work: `mcp/start` is a small request.

## Context

*— claude-opus-5-5, 2026-10-17*

**The question being decided:** for MCP servers that act on the *workspace*
(linters, a DB client for the app's database, language servers exposed as MCP),
can tentacle start them **inside the pod** from the laptop's config, so they
see the pod's files and network? How is that done without breaking "never put
provider creds in a pod/image" (AGENTS §7), and without leaving processes
behind in a user-owned pod?

### Today (verified)

- The pod daemon never starts MCP servers (`cli/src/serve.ts:53-110`; see
  `mcp-client-tools.md`, "Today").
- **An MCP server spec** is `{ command, args?, env?, cwd? }`, `.strict()`,
  stdio only (`config/src/schema.ts:42-53`). Remote HTTP transports are a
  separate eval (`docs/eval/mcp-remote-transport.md`).
- **The pod can be someone else's:** with `attach` it is user-owned, and
  leave-no-trace matters (`docs/eval/pod-ephemeral-binary.md`). With `run`,
  tentacle creates it from an image that usually has no `node`/`npx`/`python`.
- **Prior defect on process trees:** `shell_kill` leaves grandchildren running
  (TODO Block 8). An MCP server started via `npx` is exactly such a tree.

## Implementation

*(empty until promoted)*

## Execution

*(empty until promoted)*

## Review

*— claude-opus-5-5, 2026-10-17 (author; a different model must review before promotion)*

**Verdict: PROMOTE after `mcp-client-tools`** (or before it, if the owner
wants workspace MCP first; it does not depend on the tunnel work). Design:

### 1. Shipping the spec

- The laptop sends **`mcp/start { servers: { name: spec } }`** (a new method,
  laptop → daemon) right after `initialize`, with only the `runOn: "daemon"`
  servers.
- The daemon starts them with the existing `connectMcpServers` and registers
  their tools directly. They act in the pod, so the daemon-side gate is the
  right gate here, and the prompt still reaches the laptop TUI via
  `request_permission`.
- **The result reports errors per server** (`{ errors: { name: message } }`).
  The laptop shows them in the status line. They are not fatal to the session.
- An old daemon answers `MethodNotFound`, and the laptop says "the pod daemon
  is too old for runOn: daemon".

### 2. Secrets (owner decision pending)

- **Proposal (strict):** for `runOn: "daemon"` servers, every `env` value must
  be a `${VAR}` **placeholder**, expanded **pod-side** from the pod's own
  environment: a k8s Secret via `envFrom` in the `run` pod spec, or whatever
  env an `attach`ed pod already has.
- A literal value in a daemon server is a **config error on the laptop**, and
  it is never shipped. There is no reliable way to tell a harmless literal from
  a secret, so the rule has to be blunt.
- **The alternative the owner may choose:** an explicit per-server
  `"shipEnv": true`, which sends literals and warns once per session that
  credentials are entering the pod. This weakens the invariant by explicit
  opt-in only.

### 3. Runtime preflight

A stdio server needs its runtime in the image. The daemon reports a precise
error per server ("eslint: `npx` not found in pod"), never a crash, and never a
silent absence.

### 4. Lifecycle, the robustness-critical part

- **Dispose on detach:** on stdin end (`finish()` in `serve.ts`), the daemon
  calls `dispose()` on the MCP clients and **kills each server's process
  group**, not just the direct child (the `shell_kill` grandchild lesson).
  With `attach` this is leave-no-trace.
- **Idempotent `mcp/start`:** on reconnect (`pod-attach-resilience`) the laptop
  resends it, and a server that is already running with an identical spec is
  reused, not restarted.

### 5. Telling the model

The tool description gets "(runs in the workspace)". This is symmetric with
the client suffix, so the model always knows where a tool acts.

### 6. Config compatibility

`runOn` is a new field in a `.strict()` schema. A `config.jsonc` copied into a
pod with an *old* binary would fail to load there. That is an edge case; note
it in the release notes.

### Failure modes

- a missing runtime in the image;
- a literal secret: refused on the laptop;
- an unset placeholder in the pod: a per-server error naming the variable
  (never the value);
- a server crashing mid-session: its tools disappear, and a call in flight
  errors;
- detach with servers running, which must leave no orphan processes;
- reconnect: no double start;
- an old daemon.

### Tests

- a fake spawner (the existing pattern) starts the servers in the daemon;
- a literal env value in a daemon server is rejected before sending;
- placeholder expansion uses pod env only;
- dispose kills the whole process group: a test with a grandchild;
- reconnect does not double-start;
- a per-server error is not fatal;
- **non-vacuity mutation:** kill only the direct child; the grandchild test must
  turn red.

### Review #2 — fresh-context, different model

*— claude-fable-5-1, 2026-10-17*

**Verdict: APPROVE-WITH-NITS → PROMOTE after `mcp-client-tools`** (or before it,
as the eval allows). The secrets policy is consistent with §7, the lifecycle
design addresses the right risks, and the process-group-kill test is the correct
non-vacuity hook. Findings are implementation-feasibility cautions.

**Condensed premise table:**

| Premise | Cite | Verdict |
|---|---|---|
| Pod daemon never starts MCP servers | `cli/src/serve.ts:53-110` | TRUE |
| MCP server spec is `{command,args?,env?,cwd?}`, `.strict()`, stdio only | `config/src/schema.ts:42-53` | TRUE |
| `shell_kill` leaves grandchildren (process-tree lesson) | TODO Block 8 | TRUE (recorded in `TODO.md:314`) |

**Attacks tried:**
1. *Does the strict placeholder-only secret rule actually hold the "never creds
   in a pod" invariant?* — Yes. Literal `env` values are a laptop-side config
   error and never shipped; `${VAR}` placeholders expand pod-side from the pod's
   own env (Secret via `envFrom`). The blunt "can't tell a secret from a harmless
   literal, so refuse all literals" is defensible. The `shipEnv: true` opt-in is
   correctly flagged as *weakening* the invariant, which is the owner's call.
   Consistent with §7.
2. *Is process-group kill feasible in Bun, or is it a hope?* — Bun can spawn
   detached and signal a pgid, but the existing `shell_kill` grandchild defect
   (Block 8) shows the codebase has NOT yet solved tree-kill. The feat must
   confirm Bun's spawn API exposes the pgid it needs (and that an `npx`→node
   wrapper is in the killed group) before committing. The non-vacuity test (kill
   only the direct child → grandchild test goes red) is the right guard.
3. *Is idempotent restart well-defined?* — "reuse a server already running with
   an identical spec" needs a stable identity key (name + spec hash). Reasonable
   and enumerated; the feat should specify the key.

**Findings:**
1. MEDIUM — process-group kill is the robustness-critical, least-proven part;
   gate promotion on a Bun spawn/kill feasibility check, not just a design note.
2. NIT — the `.strict()` `runOn` config-compat edge (an old pod binary fails to
   load a config.jsonc carrying `runOn`) is correctly noted. In the shipped
   design the pod does not parse `runOn` from a file (servers arrive via
   `mcp/start` from the laptop, and the pod reads its own config at
   `main.ts:180`), so the edge only bites someone who hand-copies the laptop
   config into the pod — exactly the case the note calls out. Consistent.

**What holds:** the secrets policy and its alternative, the per-server non-fatal
error reporting, the runtime preflight (fail-loud, never silent absence), the
dispose-on-detach leave-no-trace goal, the idempotent-restart intent, the
symmetric "(runs in the workspace)" model suffix, and the full failure-mode list.
