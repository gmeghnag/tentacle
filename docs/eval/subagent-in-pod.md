# eval/subagent-in-pod — Let the agent delegate a sub-agent task to an ephemeral Kubernetes pod

> **Status:** eval (Context + Review; Implementation/Execution empty until promoted). **Several decisions are open on purpose**, see "Open decisions". Revisit when the use case is clear.
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval → feat · **Size:** M (if D1 = a) · L (if D1 = b/c) · **Blast:** load-bearing (single broker, pod trust, pod lifecycle) · **Suited:** strong model executes; mandatory fresh-context Review.

## Context

*— claude-opus-5-5, 2026-10-19*

**The question being decided:** should the agent have an opt-in way to run a
sub-agent **inside an ephemeral Kubernetes pod**, e.g. a new tool
`run_task_in_kubernetes_pod`, or a `runOn: "pod"` target on the existing
`agent_task`? If yes, what is its scope (D1 below) and what shape keeps the §7
invariants intact?

### Today

- `agent_task` (`packages/tools/src/task.ts:49`) delegates a self-contained
  task (`description`, `prompt`, `subagent_type`) to a sub-agent with an
  isolated context and returns its final report. The runner is
  `createSubagentRunner` (`packages/agent/src/subagent.ts:134`), registered in
  `packages/cli/src/wiring.ts:104-129`. It runs **in-process, in the same daemon
  as the parent**, on the same host.
- Pod mode exists only for the **whole session** (`tentacle run`/`attach`):
  `startPodRuntime` (`packages/cli/src/pod-runtime.ts:186`) does the following.
  - Creates the pod and injects the binary.
  - Runs `serve --stdio --model-proxy` there, so the model is tunnelled back
    and the key never leaves the laptop.
  - Returns a `LocalRuntime` whose `dispose` deletes the pod.
- There is no way for an agent to put *part* of the work in a pod.

### Why it is interesting

- **Compute next to the code** (§7): tasks that belong cluster-side, such as
  debugging a namespace from inside, testing against in-cluster services, heavy
  builds, or an image with a toolchain the laptop lacks.
- **Isolation**: a throwaway pod is a sandbox for a risky or messy task.
- **Parallelism**: combined with `docs/eval/parallel-subagents.md`, N
  sub-agents in N pods gives real, isolated parallelism.
- **Mostly composition, not new machinery.** The sub-agent interface
  (task → report) and the pod runtime (create → inject → daemon → model proxy →
  delete) both exist. The pod sub-agent would be a `RemoteClient` session over
  the pod's exec channel, which is the same session path (§7 "one session
  path"). It does not add a second agent loop.

### Open decisions

Each decision lists its options, a current leaning where there is one, and what
would settle it.

**D1 — What does the pod sub-agent work on? (the decision that shapes everything)**
Today a pod's workspace is its image. Nothing copies the laptop repo in.
- **(a) Only what the pod already has**: image plus cluster access. Fits
  cluster-oriented tasks and needs no file transfer. *Leaning: start here.*
- **(b) Sync the laptop workspace in**: what to send (`.gitignore`-aware?),
  size limits, transfer time over exec (about 1 s/MB measured in
  `rpc-flow-control.md`), and **how changes come back** (patch? report only?).
  Bringing changes back is the expensive part.
- **(c) `git clone` inside the pod**: needs repo credentials in the pod, which
  is identity in an untrusted place (§7). Only with a scoped, short-lived
  token, if ever.
- *Settled by:* the concrete use case. **Unknown today.**

**D2 — Who executes the tool?**
- In the local worker: fine. Same host as the kubeconfig, so cluster identity
  stays on the laptop.
- When the parent session is **itself in a pod** (`run`/`attach`): the pod
  daemon has no kube credentials and must not get any (§7 "a pod is not
  trusted"). Options:
  - **(i)** the tool is unavailable in pod mode; *leaning for v1*;
  - **(ii)** it runs laptop-side as a client tool, which depends on
    `docs/eval/mcp-client-tools.md` (Block 10 n. 3) and its laptop-side gate.
- *Settled by:* whether nesting (pod → pod) is a real need.

**D3 — Permission routing (single-broker class of bug)**
The pod sub-agent's daemon will ask `session/request_permission`. That request
must reach the **one** laptop broker. The chain would be: pod daemon → nested
`RemoteClient` in the worker → the worker's connection → main-thread broker.
If any hop defaults to `allowAll`, everything is silently approved (the same
failure mode as the `runPodTui` invariant). Options:
- **(i)** forward every prompt up the chain, labelled as coming from the pod
  sub-agent;
- **(ii)** the sub-agent runs **non-interactive with "deny on ask"** and a
  restricted tool set declared up front;
- **(iii)** approvals granted to the parent are not inherited by the pod
  sub-agent: once-only, never a lasting approval for pod-supplied input (§7).
- *Leaning:* (ii) for v1, (i) later. A regression test with a separate
  daemon-side spy is required either way.

**D4 — Lifecycle, cleanup, cost**
- Every call creates a pod, which costs seconds (image pull, binary injection)
  plus cluster resources. Is that acceptable per call, or is a warm pod reused
  across calls in one session? Reuse adds state; a fresh pod per call is
  simpler.
- **Cleanup when the parent cancels or crashes.** Today's net is
  `registerPodCleanup` → `process.once("exit")` (`pod-runtime.ts:174`), which is
  designed for the main process. Here the pod would be created from the
  **worker thread** (`new Worker`, `local-runtime.ts:186`). Whether that hook
  and the detached-child delete fire correctly from a worker is **unverified**
  and must be tested. A leaked pod is a silent cost.
- Esc on the parent must cancel the remote turn and then delete the pod.
- A concurrency cap (max pods in flight), which matters once parallel
  sub-agents exist.

**D5 — Configuration vs model choice**
Image, namespace, resources, bin dir and allowed sub-agent types come from
**config**. The model chooses only the task. Otherwise the model can create
arbitrary pods with arbitrary images. Open: does the model pick from a named
list of "pod profiles" in config, or is there exactly one?

**D6 — Shape and name**
- **(i)** a separate tool `run_task_in_kubernetes_pod`;
- **(ii)** `runOn: "pod"` (or a profile name) on `agent_task`.
- *Leaning:* (ii). It is the same abstraction (a sub-agent) with a different
  execution target, mirroring `runOn` for MCP servers. Opt-in either way: the
  tool or parameter is absent unless configured.

**D7 — What streams back**
- The parent today sees `agent_task` opaquely plus progress events
  (`ctx.emitProgress`). The pod sub-agent's `session/update` stream can be
  mapped to the same progress events.
- Its final report is the tool result, which is subject to the normal spill.
- Its **session history is not persisted** to the parent's store
  (`startPodRuntime` takes a `store`, `pod-runtime.ts:111`, so this needs a
  no-op or separate store).
- Open: do we keep the sub-agent transcript anywhere for debugging?

**D8 — Terminal safety**
`startPodRuntime` writes startup progress through a `StatusLine` gated on
`process.stdout.isTTY` (`pod-runtime.ts:199`). Called from a tool mid-session,
that would write raw to the terminal while Ink owns it (§7). The pod sub-agent
path must route all startup and stderr output to the tool's progress or log
sink, never to stdout. That means refactoring the startup phases out of
`startPodRuntime` into a reusable, sink-injected function.

### Dependencies and relations

- `docs/eval/parallel-subagents.md`: parallel and background sub-agents. This
  eval works sequentially too, but is most useful with it.
- `docs/eval/mcp-client-tools.md`: needed only if D2 = (ii).
- `docs/eval/rpc-flow-control.md`: needed if D1 = (b) (bulk transfer) or if
  reports get large.
- `docs/feat/pod-attach-resilience.md`: the same keepalive concerns for a
  long-running pod sub-agent.

## Implementation

*(empty until promoted; blocked on D1)*

## Execution

*(empty until promoted)*

## Review

*— claude-opus-5-5, 2026-10-19*

**Verdict: interesting, keep open; do not promote yet.** The idea fits the §7
principle ("compute next to the code, identity with the user") and is mostly a
composition of existing seams. But **D1 (what the sub-agent works on) has no
answer yet**, and it moves the size from M to L. D3 (permissions) and D4
(cleanup from the worker) are where it can break silently.

Before promotion:
1. Name one concrete use case. That settles D1, and D2 follows from it.
2. A cheap experiment for D4: create and delete a pod from the worker thread,
   kill the parent mid-way, and check whether the pod leaks.
3. Decide D3 and pin it with a mutation-checked single-broker test.

Self-review caveat: author's own pass; a fresh-context Review is needed before
promotion.
