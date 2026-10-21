# eval/extensibility — users extend tentacle themselves: hooks + packages (umbrella)

> **Status:** eval (umbrella). Owner decisions D1–D12 and every child sub-decision recorded 2026-10-21. Each child is its own eval with a drafted Implementation, promoted separately, in order.
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval → feat ×5 · **Size:** L → split · **Blast:** load-bearing (agent loop, `PermissionGate`, result pipeline, protocol, §7 trust model) · **Suited:** per child (below); every load-bearing child needs a strong model + fresh-context Review (§10)

## Context

*— claude-opus-5-5, 2026-10-21*

### The question

How do we make tentacle **extensible by its users**: let them add policy,
notifications, pre/post processing of tool calls, context injection and turn
control, without patching tentacle?

**Principle (owner, 2026-10-21):** the goal is *tentacle's* extensibility,
**not compatibility** with Claude Code, pi or anything else. A pattern from
another tool is adopted only when it is good design on its own merits, never
to make someone else's scripts or packages run unchanged.

### Why: measured demand

Pi (pi.dev) exposes an in-process extension API and has ~12,400 npm packages
with the `pi-package` keyword (registry search, 2026-10-21). A static scan of
239 of them (top-120 by downloads + 120 random; 216 contain extensions)
shows what users build. Counts are out of the 108 top extensions:

| What extensions do | Packages | tentacle today (`main` @ 399ea0b) |
|---|---|---|
| slash commands | 79 | skills + `/skill-name` |
| new tools | 67 | MCP (`config/src/schema.ts:105`) |
| context at session/turn start | 89 / 60 | AGENTS.md + skills; **no hook** |
| gate tool calls (block / rewrite input) | 35 | `PermissionGate`, **closed** (`agent/src/permission-gate.ts:63-79`) |
| transform tool results | 28 | `ResultTransform` pipeline, **internal** (`cli/src/wiring.ts:111-129`) |
| UI | 75 / 51 / 37 | out of scope |

Tools and commands are covered by MCP and skills. What is missing is **loop
hooks**. Method caveat: regex over sources, not execution. The signal is
robust, the percentages are not.

### Shape decided

1. **Hooks = external processes.** A command run on agent-loop events, JSON
   on stdin, JSON decision on stdout. Any language, no internal API exposed.
   Hooks plug into the **existing seams**:
   - `PermissionGate`: one `authorize` call site, `agent/src/agent.ts:754`;
   - the `ResultTransform` pipeline: one `transformResult` method,
     `agent/src/agent.ts:718`.

   No parallel path (§7 "one session path").
2. **Packages = declarative bundles** of skills, agent definitions, MCP
   servers and hooks, installed with one command.

### Owner decisions (2026-10-21)

| # | Decision |
|---|---|
| D1 | Direction approved: out-of-process hooks + declarative packages. **No** in-process TS API, **no** pi-extension compatibility (see *Alternatives rejected*) |
| D2 | Events: `tool_call`, `tool_result`, `turn_start`, `turn_end`, **plus `model_request`** (notification-only, read-only, only where the daemon calls the provider itself) |
| D3 | **Project hooks are loaded**, from `.agents/hooks.json` (next to `.agents/skills`), after an **explicit one-time trust** prompt |
| D4 | Trust key = folder + hash of the hook definitions (a changed definition asks again). Stored on the laptop, asked through the single broker. Non-interactive → project hooks not loaded (notice) |
| D5 | In a pod (`run`/`attach`) project-hook trust is asked **every session, never stored** (§7: no lasting approval for pod-supplied input) |
| D6 | A hook may return `allow`: user hooks always; trusted project hooks **in local only**, never in a pod |
| D7 | Hook input on **stdin, added to the core** (`ExecOptions` has none today, `core/src/execution.ts:15-20`) |
| D8 | Own wire format; native tentacle tool names in matchers. Semantics adopted on merit: exit 2 = block (stderr = reason), other non-zero = non-blocking error unless `onFailure: "block"`, `turn_end` may continue the turn (bounded), default timeout **600 s** |
| D9 | Hook input: common fields (session id, cwd, event, tool name / input / call id, sub-agent identity). No transcript path, no foreign env aliases |
| D10 | Tool **names in code stay** (`shell`, `fs_read`, `fs_edit`, …: model-facing, used by hook matchers and agent-defs). Only the **display** gets CamelCase labels (`Bash`, `Read`, `Edit`, `MultiEdit`, …), from one shared map. A full rename was considered and dropped: its claimed model benefit did not hold up ([`tool-naming.md`](../feat/tool-naming.md)) |
| D11 | Packages: **tentacle's own format**; sources local path + git in v1, npm later; **not** shipped to the pod in v1 |
| D12 | Model-request hooks that *modify* or *block*, and any laptop-side ("identity") hook: **out of scope**, a follow-up eval |
| R2 | (`hooks-turn`) at most **3** `turn_end` continues per turn |
| P1 | (`hooks-project-trust`) the trust ask is a **new request kind**: a daemon→client method `hooks/trust` |

All child sub-decisions (H1–H4, R1–R4, P1–P3, K1–K3) are **decided**
(2026-10-21) and recorded in each child. H1 was changed from the proposed
default: hook interventions **are shown** in the TUI, as
`⎿ hook <name> blocked <Tool>` / `⎿ hook <name> modified <Tool> input`
under the tool call (`hooks-core` §7; no protocol bump). The rest follow the
proposed defaults.

### Trust model (§7), in one place

- **Local worker / plain `serve`**: hooks are the user's own code with the
  user's permissions. Project hooks are code a cloned repo brings, hence
  D3–D4.
- **Pod**: hooks run in the pod (the session's `ExecutionEnvironment`), from
  the pod's own config and workspace. The gate is already daemon-side there
  (`permission-gate.ts:55-58`), so a pod hook adds no power the pod lacks.
  It is UX, never security (§7), hence D5–D6.
- **The laptop decides and stores; the pod only asks.** The trust store is
  used only for the local worker runtime.
- **Laptop config does not travel to the pod** (a pod daemon loads its own:
  `cli/src/pod-runtime.ts:328`, `cli/src/serve.ts:221-262`), the same as
  skills and agents today.

### Children (execution order)

| # | Child eval | What | Size · Blast | Executor per §10 |
|---|---|---|---|---|
| 1 | [`tool-naming.md`](../feat/tool-naming.md) | CamelCase display labels only (names unchanged), shared `toolLabel` in core | S · contained | weaker model OK |
| 2 | [`hooks-core.md`](../feat/hooks-core.md) | config `hooks`, `stdin` in core, `HookRunner`, `tool_call` → `PermissionGate`, `tool_result` → pipeline | M · load-bearing | strong model |
| 3 | [`hooks-turn.md`](../feat/hooks-turn.md) | `turn_start`, `turn_end` (+ continue, max 3), `model_request` notify; **protocol 7 → 8** | M · load-bearing | strong model |
| 4 | [`hooks-project-trust.md`](./hooks-project-trust.md) | `.agents/hooks.json`, `hooks/trust`, laptop resolver + store, auto-approve exclusion | M · load-bearing (§7) | strong model |
| 5 | [`packages.md`](./packages.md) | package layout, `tentacle packages install/list/remove/update`, loading into existing paths | M · cross-module | weaker model OK, standard Review |
| — | *(follow-up, not written)* | laptop identity hooks: deny-only permission policy; `model_request` audit / redaction for pod sessions | — | — |

Child 1 goes **first**: the H1 line in child 2 uses its `toolLabel`. Children 2 → 3 → 4 are
strictly ordered (3 and 4 reuse the runner from 2; 4 asks for trust before
3's `turn_start`). Child 5 needs 2.

The child docs are written step by step (exact files, signatures, outcome
tables, red-first tests) so any executor can follow them mechanically; the
owner assigns executors. The load-bearing children (2, 3, 4) keep the
mandatory fresh-context Review (§10).

### Alternatives rejected

- **In-process TS API (pi-style).** It turns `Agent`, `Tool`, events and
  session internals into a public contract, frozen harder than the protocol.
  It runs with full access to keys. It has no place in the laptop/pod split:
  one module cannot be both workspace-side and identity-side. In pi, ~75% of
  extensions bind to its UI or session internals.
- **pi-extension compatibility.** A minimal adapter covers ~11–15% of pi
  usage by downloads. ~75% would need session emulation (breaking §7
  "persist only `ChatMessage`") and hosting `pi-tui` components across the
  worker↔main RPC.
- **Full tool rename to `Bash`/`Read`/…** and a **`tool_` name prefix**: see
  D10 and [`tool-naming.md`](../feat/tool-naming.md).

## Implementation

*(umbrella — each child carries its own)*

## Execution

*(n/a)*

## Review

*— claude-opus-5-5, 2026-10-21*

Self-review, same context. **Verdict: direction approved by the owner
(D1–D12, R2, P1). Children are promotion-ready one at a time, in order**,
each after its remaining sub-decisions are confirmed.

What holds: every claim about the code is cited against `main` @ 399ea0b
(after the `model-connection-resilience` merge; the cited `wiring.ts` and
`pod-runtime.ts` lines were re-checked after that merge).

Corrections made while writing the children, recorded so they are not lost:
- The first draft said "no protocol change". That holds for tool hooks
  (child 2) but **not** for turn hooks: `context_note.reason` is a closed
  enum (`protocol/src/updates.ts:92-96`), so child 3 bumps
  `PROTOCOL_VERSION` 7 → 8. The trust ask (child 4) is an additive method
  and needs no bump of its own.
- An awaited `turn_end` hook is only safe **before** the late-steering drain
  (`agent/src/agent.ts:459-470`); child 3 places it there and pins it with a
  mutation-checked test.
- `transformResult` has three callers (tool call, `/skill` round, `/compact`
  re-read), not one; child 2 covers all three.
- The TUI's auto-approve mode would silently grant a trust prompt; child 4
  excludes it explicitly.
- Package MCP namespacing must not use `/` (tool-name charset); child 5 uses
  `-`.

Not proven: the demand numbers (static scan); the multi-hook combination
rules (child 2) against real policies; Bun accepting a `Blob` as `stdin`
(child 2's first red test proves or disproves it).
