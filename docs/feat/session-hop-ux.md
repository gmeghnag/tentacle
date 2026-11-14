# feat/session-hop-ux — Hop UX from the OpenShift live test: k8s namespace, one live progress line, auto-accept

> **Status:** implementation (awaiting owner answers — NOT approved)
> **Branch:** `feat/session-hop-ux`
> **Size:** M (three S–M slices) · **Blast:** load-bearing (slice 3 changes what auto-accept may answer on the single broker, AGENTS §7 "a pod is not trusted"; slice 1 changes what a pod-supplied proposal can target) · **Suited:** slices 1–2 DeepSeek; slice 3 a strong model or DeepSeek + **mandatory fresh-context Opus review** red-teaming §7 (single broker, pod not trusted)
> **Changelog:** `changelog.d/session-hop-ux.fixed.md` (namespace + one progress line) and `changelog.d/session-hop-ux.changed.md` (auto-accept answers a move toward a workload; survives the hop — per Q4/Q5)

## Context

*— claude-opus-5-5, 2026-11-14*

The owner's live test of session-hop on a real OpenShift 4.19 cluster
(2026-11-14 ~17:20, `oc` context namespace `openshift-etcd`) moved a session into
a pod and worked end to end (proposal UI, attach to `etcd-…/etcdctl`, x64 binary,
commands in the pod). Two defects, and one owner addendum:

1. **No namespace.** The agent called
   `move_session {"target":"attach","workload":{"engine":"kubernetes","name":"etcd-sharedocp419-qqq5p-master-0","container":"etcdctl"}}`.
   The hop printed `[pod] attaching to etcd-… in namespace default…` and failed:
   `not moved: pod … not found in namespace "default" — … pass --namespace <ns>`.
   The tool has no namespace field, `/move attach` has no namespace syntax, and
   the error advises a CLI flag that does not exist in a hop. A retry (“ritenta”)
   then attached `in namespace openshift-etcd`, so the two tries looked like they
   used different defaults.
2. **Progress in pieces.** The injection printed ~14 separate transcript lines
   (`resolving…`, `using …`, `injecting …`, `transfer ▓▓░ 10%` … `100%`,
   `verifying…`, `attached…`). The owner wants ONE live line, and at most one
   summary line in the transcript.
3. **Owner addendum (2026-11-14).** With auto-accept ON, a `move_session`
   proposal toward a container or pod (local → workload, workload → another
   workload) must be auto-accepted like any other tool: no prompt, allow-once,
   logged. A hop TOWARD LOCAL asked from the pod/container side is ALWAYS
   confirmed on the laptop, never auto-accepted (AGENTS §7). Also revisit D9
   (“auto-accept goes off with the move”): turning it off contradicts the owner's
   intent.

**Repro 1 — which namespace a hop resolves** (2026-11-14,
`.tentacle/tmp/session-hop-ux/ns/kc.ts`). It calls the hop's exact builder,
`buildEngineHost("kubernetes", {})` (what `hopEngineHost` calls, `main.ts:1222`),
against a scratch kubeconfig:

```ts
import { writeFileSync } from "node:fs";
import { buildEngineHost, defaultEngineHostIO } from "../../../worktrees/session-hop-ux/packages/cli/src/engine-select.ts";
const kc = (ns?: string) => `apiVersion: v1
current-context: c
contexts:
- name: c
  context: {cluster: k, user: u${ns ? `, namespace: ${ns}` : ""}}
clusters:
- name: k
  cluster: {server: "https://127.0.0.1:1", insecure-skip-tls-verify: true}
users:
- name: u
  user: {token: t}
`;
const dir = import.meta.dir;
const io = { ...defaultEngineHostIO(), kubeClient: () => ({}) as never };
const run = (label: string, env: Record<string, string> = {}) => {
  process.env.KUBECONFIG = `${dir}/a.yaml`;
  const b = buildEngineHost("kubernetes", {}, { ...io, env });
  console.log(label.padEnd(46), "->", b.namespace, "|", b.host.where);
};
writeFileSync(`${dir}/a.yaml`, kc("openshift-etcd")); run("(a) ctx ns=openshift-etcd");
writeFileSync(`${dir}/a.yaml`, kc());                 run("(b) ctx has no namespace");
writeFileSync(`${dir}/a.yaml`, kc("openshift-etcd")); run("(c) ctx ns set + TENTACLE_K8S_SERVER", { TENTACLE_K8S_SERVER: "https://x" });
writeFileSync(`${dir}/a.yaml`, kc());                 run("(d1) hop 1, before oc project");
writeFileSync(`${dir}/a.yaml`, kc("openshift-etcd")); run("(d2) hop 2, after oc project openshift-etcd");
```

```
(a) ctx ns=openshift-etcd                      -> openshift-etcd | namespace openshift-etcd
(b) ctx has no namespace                       -> default | namespace default
(c) ctx ns set + TENTACLE_K8S_SERVER           -> default | namespace default
(d1) hop 1, before oc project                  -> default | namespace default
(d2) hop 2, after oc project openshift-etcd    -> openshift-etcd | namespace openshift-etcd
```

**Why “default” first and `openshift-etcd` on the retry.** Both tries took the
SAME code path. There are not two hop paths. Every hop calls `hopEngineHost`
(`main.ts:1221-1228`), which calls `buildEngineHost(engine, {})`, which calls
`loadKubeClientOptions({})` (`engine-select.ts:513-516`). That re-reads the
kubeconfig on every call (`kube-auth.ts:116-121`) and applies
`options.namespace ?? context.namespace ?? "default"` (`kubeconfig.ts:123`).
Nothing is cached between hops. So in one process, the namespace can only change
if the kubeconfig (or `KUBECONFIG`) changed between the two tries: repro (d1)→(d2).
The likeliest trigger is `oc`. `oc login` sets the context's project (a
cluster-admin gets `Using project "default"`), and `oc project openshift-etcd`
rewrites the current context. One of them ran after the failure. **Unverified:**
the repro shows the mechanism, not the owner's sequence. That needs Q3.

**Where hop and `tentacle attach` really differ.** `tentacle attach`/`run` pass
`namespace: flags.get("namespace") ?? process.env.TENTACLE_POD_NAMESPACE`
(`main.ts:1199-1202`). The hop passes `{}` (`main.ts:1222`), so it **ignores
`TENTACLE_POD_NAMESPACE`**. Both then share the same tail: the server override
gives `"default"` (`engine-select.ts:509`); otherwise the context's namespace,
else `"default"` (`kubeconfig.ts:123`). `tentacle attach <name>` with no
location flags also looks the name up in the kept index (`main.ts:1672-1680`).
That is a lookup for kept workloads, not a namespace default. The help text says
the rule outright: `TENTACLE_POD_NAMESPACE namespace (overridden by --namespace;
else the context's)` (`main.ts:469`).

**Repro 2 — progress in pieces** (2026-11-14,
`.tentacle/tmp/session-hop-ux/progress/inject.ts`). It runs `injectAgentBinary`
with a fake host that transfers 8 MB in 64 KB chunks. First the hop's piped
mode, then the status mode:

```ts
import { injectAgentBinary } from "../../../worktrees/session-hop-ux/packages/cli/src/pod-binary.ts";
const N = 8 * 1048576;
const host = { runExec: async (target, input, options) => {
  if (input !== undefined) for (let w = 65536; w <= N; w += 65536) options?.onProgress?.(w);
  const cmd = target.command.join(" ");
  return { exitCode: 0, stdout: cmd.endsWith("--version") ? "tentacle 9.9.9\n" : "", stderr: "" };
} };
const base = { host, name: "etcd-0", noun: "pod", probe: async () => ({ status: "ok", arch: "x86_64" }), resolveBinary: async () => new Uint8Array(N) };
const piped: string[] = [];
await injectAgentBinary({ ...base, log: (l) => piped.push(l.trimEnd()) });
// … then again with onStatus, counting calls
```

```
PIPED (the hop today, HOP_TERM tty:false): 13 log lines
  | [etcd-0] resolving bun-linux-x64 binary…
  | [etcd-0] injecting tentacle (8.0 MB)
  | [etcd-0] transfer ▓▓░░░░░░░░░░░░░░░░░░░░░░ 10% 0.8/8.0 MB
  | … (20% … 90%)
  | [etcd-0] transfer ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 100% 8.0/8.0 MB
  | [etcd-0] verifying…
STATUS (onStatus set): 0 log lines, 130 onStatus calls (118 distinct texts, 103 distinct when keyed by whole percent)
  last: [etcd-0] verifying…
```

Thirteen lines, plus `[pod] attaching to … in namespace …`, the resolver's
`using …` and the final `attached …`, makes the owner's ~14 fragments. **Root
cause:** the hop builds every runtime with `HOP_TERM = { tty: false }`
(`hop-targets.ts:49`, passed at `:302` and `:397`). `statusLineFor` therefore
returns `null` (`engine-runtime.ts:207-210`). That selects the PIPED contract:
each phase goes to `info` (`:801-807`), the transfer goes to `TransferProgress`,
one line per 10% (`pod-binary.ts:294-300`, `transfer-progress.ts:49-80`), and the
resolver's verbose log goes to `log` (`:992`). The hop routes both `log` and
`info` to `deps.notify` (`hop-targets.ts:398,401`), which makes one transcript
notice per line. The interactive contract, a single line updated in place,
already exists in the same functions (`status.set`, `onStatus`). The hop just
has no way to select it without a TTY.

**What `tentacle attach` does outside a hop** (the consistency target). On a
terminal, a single `StatusLine` spinner holds every phase and the transfer bar
(`engine-runtime.ts:801-807`, `onStatus` at `:995`). It is cleared by `finish()`
before Ink mounts, and **no success line is printed**: “the TUI opening IS the
confirmation” (`:1061-1067`). Warnings (cwd moved, binary replaced, resident
skew) go only to `notify`, so they are in-TUI notices (`:836-841`, `:1024-1060`).
For a hop, the matching shape is one live line (the hop status row, D3/D6),
those same warnings as notices, and the hop's existing outcome line (`Moved to …`,
`hopMovedNotice`, `hop-status.ts:61-67`) as the one summary. A hop opens no new
TUI, so that line is its confirmation.

## Implementation

*— claude-opus-5-5, 2026-11-14*

### Load-bearing assumption

**Every auto-accept decision for a laptop-side prompt is taken in ONE place: the
requester the TUI installs on the single `PermissionBroker`. A daemon (a pod)
cannot raise a `session_hop` request or set any field that predicate reads.** All
of slice 3 depends on this. Slices 1–2 depend only on facts cited in Preconditions.

Proof:
- The ONE broker for a hop-capable TUI is built at `main.ts:2072`
  (`new PermissionBroker(undefined, { holdUntilSet: true })`). The same instance
  goes to the worker runtime, to every runtime a hop builds
  (`shared: { permissions, saver }`), to the hop feed (`main.ts:2121`) and to
  `startTui` (`main.ts:2140`).
- A proposal is asked on that broker: `hop-feed.ts:96-100` →
  `hopAskAtTurnEnd(…, (request) => broker.request(request))` →
  `hop-turn.ts:162` `ask(hopPromptRequest(spec, shown))`.
- The TUI's requester is installed with `permissions.setRequester`
  (`permission-ui.ts:417`). The auto-accept decision is
  **`permission-ui.ts:424`**: `if (autoApproveRef.current && autoApproves(req, own))
  return { allowed: true, scope: "once" }`. The predicate is **`autoApproves`,
  `permission-ui.ts:59-61`**, and today it excludes `session_hop` outright.
- A daemon's ask never carries `kind` or any laptop-internal field.
  `toPermissionRequest` rebuilds it from an allowlist (`tool`, `title`,
  `explanation`, `suggestion`, `reply`; `permission-router.ts:76-86`), and
  `PermissionRequest.kind` is documented as laptop-internal and never on the wire
  (`core/permission.ts:27-34`). The only producers of `session_hop` are the
  laptop's `hopPromptRequest` (`hop-turn.ts:58-69`) and `mountAsk`
  (`hop-targets.ts:517-531`).
- An answer's extra fields never reach the wire. The router's `send` carries
  only `optionId` and `message` (`permission-router.ts:180-186`).

### Preconditions

- **Namespace rule.** Context namespace, else `"default"`: `kubeconfig.ts:123`.
  The server override gives `"default"`: `engine-select.ts:509`.
  `TENTACLE_POD_NAMESPACE` is applied only by the CLI's `engineHost`
  (`main.ts:1201`), not by `hopEngineHost` (`main.ts:1222`).
- **Grammar.** `HopWorkload` is `{engine, name, container?}` (`hop-command.ts:12-17`).
  The two-part form `kubernetes:<pod>/<container>` already has a meaning
  (`hop-command.ts:264-277`). `readFlags` refuses every `--` word except
  `--keep`/`--rm` (`:164-183`). The tool's `workloadSchema`
  (`move-session.ts:44-53`) and the laptop's `hopProposalSchema`
  (`hop-proposal.ts:22-41`) both strip unknown fields. `hopSpecOf` re-checks the
  workload through the SAME `hopWorkload` the typed path uses
  (`hop-proposal.ts:143-150`).
- **Not-found wording.** `WorkloadNotFoundError` is typed and carries `noun` and
  `place` (`engine-host.ts:89-97`). Its k8s text advises `--namespace`
  (`engine-k8s.ts:179-182`).
- **Status row.** `deps.status` feeds the hop row (`main.ts:2100,2108`, then
  `hop-feed.ts:71`, `useHop.ts:150-153`, `hopStatusRow` `hop-status.ts:23-33`).
  The row is truncated to the terminal width, and its listener is unsubscribed
  at settle (`useHop.ts:154-156`). So a line that arrives after the run settled
  reaches nobody.
- **D6 drift note** (`hop-targets.ts:304-310`): `info` stays the NOTICE sink
  because `quitReport` rides it at dispose (`engine-runtime.ts:1099`). That stays
  as is. Only the phases move.
- **Origin of a proposal.** The hop feed knows the current place
  (`hop-feed.ts:38`, `main.ts:2113`). A `workload` place means the turn ran in
  a pod/container daemon, so its `move_session` arguments are pod-supplied (§7).
- **D9 today.** `useHop.ts:168-176` clears auto-accept on every committed hop.
  `hop-proposal.ts:271` and `move-session.ts:109` say so to the owner and the
  model.
- **No protocol change.** The tool input schema is not in `@tentacle/protocol`.
  `PermissionRequest`/`PermissionResponse` are process-internal (above). So there
  is no `protocol.d/` note.

### Design

**Slice 1 — namespace (one rule, named, shown, pinned).**

1. **One rule, one function.** Add `kubeNamespace(options, io)` in
   `engine-select.ts`. It returns `options.namespace ??
   io.env.TENTACLE_POD_NAMESPACE ?? (server ? "default" : contextNamespace(kubeconfig,
   options.kubeContext))`. `contextNamespace` is extracted from
   `resolveContext`, which then uses it (`kubeconfig.ts:123`), so the k8s package
   keeps one copy of “context ns, else default”. `buildEngineHost` uses it
   (`:500-517`), so `engineHost` (`main.ts:1201`) stops applying the env itself,
   and `hopEngineHost` inherits the env step it lacks today. Kept-entry dials pass
   `entry.namespace` explicitly (`hostOptionsFor`, `:290-298`), so the env never
   overrides them. The rule is **explicit > `TENTACLE_POD_NAMESPACE` > kubeconfig
   current context's namespace > `"default"`**, for `run`, `attach` and every hop
   (Q2). It is resolved per call (no cache), as today.
2. **Naming it (Q1).** `HopWorkload.namespace?: string`, kubernetes only.
   Typed: `/move attach kubernetes:<pod>[/<container>] -n <ns>` (also
   `--namespace <ns>`), the same spelling as `tentacle attach -n` and kubectl.
   Tool: `workload.namespace`. One validator: `hopWorkload(engine, name,
   container, namespace)` gains the problems `namespace` (not kubernetes) and
   `namespaceChars` (a DNS-1123 label `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`, ≤ 63).
   The tool's regex mirrors it, exactly as `WORKLOAD_PART` mirrors
   `HOP_WORKLOAD_PART` today. A second `-n`, `-n` with no value, or `-n` on
   docker/podman gives the usage line, never a silently ignored word.
   *Rejected:* `kubernetes:<ns>/<pod>[/<container>]`. `a/b` already means
   pod/container (`hop-command.ts:264-277`), so this would silently re-target a
   command typed the old way. It would also need a 3-part form `a/b/c` that the
   grammar deliberately refuses today, and a model fills a named field more
   reliably than positional slashes.
3. **Pinned, then shown (the approved place is the built place).** For a
   PROPOSAL, `hop-feed` resolves the namespace at turn end, before asking. A new
   dep `pinNamespace(spec)` is injected from `main.ts` and calls `kubeNamespace`
   with the spec's explicit value. The resolved value is written into
   `spec.workload.namespace`, and THAT spec is both shown and returned as
   `approved`. A kubeconfig that changes between the prompt and the build (the
   repro (d) mechanism) can no longer move the target the owner approved.
   `hopPromptDetail` gains `namespace: <ns>` under the attach line, and
   `proposalNotice` shows `kubernetes:<pod>/<c> in <ns>`. For a typed `/move`
   (no prompt), the build resolves once. The engine's own phase
   `[pod] attaching to X in namespace Y…` (now on the live row, slice 2) and the
   summary line name it.
4. **Built where named.** `HopTargetDeps.host` becomes `(engine, where?: {
   namespace?: string })`. `attachTarget` passes `workload.namespace`, and
   `hopEngineHost(engine, where)` forwards it to `buildEngineHost`. The place
   (`HopPlace` and its view) carries `namespace?`. The moved notice and the model's
   guide line (`moveGuideLine`) name it (`kubernetes:etcd-…/etcdctl in
   openshift-etcd`). The badge stays `kubernetes:<pod>/<c>`, because width is
   scarce there.
5. **Hop wording for a miss.** In `attachTarget`'s catch, a
   `WorkloadNotFoundError` from k8s becomes: `not moved: no pod "<name>" in
   namespace "<ns>" — name its namespace: /move attach kubernetes:<name> -n <ns>`.
   It is built from the typed error's fields. The CLI's `--namespace` advice is
   never shown inside a hop. The same applies to the multi-container exec hint
   (`engine-k8s.ts:85`): in a hop it reads `kubernetes:<pod>/<container>`.
6. **The model learns why (Q6).** A PROPOSED move that FAILED leaves
   `[move failed: <the not-moved text>]` for the next prompt. It takes the same
   `pendingLine` slot as `[move declined]` (`hop-feed.ts:110-118`) and is
   sanitized. Then the model can retry with `workload.namespace` instead of
   needing the owner to say “ritenta”.

**Slice 2 — one live progress line.**

7. **A live-line seam in the engine runtimes.** Add
   `liveLine?: { set(text: string): void; finish(): void }` to `EngineRuntimeDeps`
   and `EngineAttachRuntimeDeps`. `statusLineFor` returns it when present, before
   the TTY test (`engine-runtime.ts:207-210`). Everything already keyed on
   `status` then takes the interactive contract with no further edit:
   - phases go to `set`;
   - the injection's `onStatus` gets the bar;
   - the resolver's verbose log is dropped;
   - no `attached…`/`ready in…` line;
   - warnings go to `notify` only.
   `run`/`attach` (no `liveLine`) are unchanged.
8. **The hop wires it to its row.** In `hop-targets.ts` both builds drop
   `logTerm: HOP_TERM` and pass `liveLine: createHopLiveLine({ emit: deps.status })`
   from a new pure module `cli/src/hop-live-line.ts`:
   - it emits the first text at once, then at most one text per 100 ms, and the
     latest text always lands (trailing timer);
   - an identical text is dropped;
   - `finish()` clears the timer and latches closed, so every later `set` is
     ignored.
   Timers and the clock are injected. This bounds the ~1 400 `onProgress` calls of
   an 89 MB transfer to ≤ ~10/s of React renders (`useHop.ts:150-153` renders
   and flushes per line). `HOP_TERM` is deleted: the new seam is the only way a
   hop's runtime knows it has a row. `log`/`info` stay `notify`, for errors,
   warnings and dispose's `quitReport` (D6 drift note unchanged).
9. **Transcript budget for a hop:**
   - the warnings the engine already sends to `notify` (cwd moved, binary
     replaced, resident skew; they are warnings, not progress);
   - the outcome line, `Moved to <place>[ in <ns>] …` or `not moved: …`.
   No phase and no progress tick reaches the transcript. Nothing is written to
   the terminal raw: the row is an Ink element, so the §7 Ink invariant holds as
   before.

**Slice 3 — auto-accept answers a move toward a workload (owner addendum).**

10. **The decision stays at the one gate.** `autoApproves` (`permission-ui.ts:59-61`)
    becomes `own && req.kind !== "hooks_trust" && (req.kind !== "session_hop" ||
    req.hopAuto === true)`. `PermissionRequest.hopAuto?: true` is laptop-internal
    and set ONLY by `hopPromptRequest`. A daemon cannot set it (load-bearing
    assumption). `mountAsk` never sets it. The auto branch at `:424-425` returns
    `{ allowed: true, scope: "once", auto: true }`. `PermissionResponse.auto?:
    true` is process-internal like `onAnswerLost`, and is never on the wire
    (`permission-router.ts:180-186`).
11. **Eligibility is a pure rule** in `hop-turn.ts`:
    `hopAutoAcceptable(spec, origin, facts)`.
    - **Never** for `target: "local"`, on any origin. This is the §7 line: a
      pod-side request to bring the agent onto the laptop is always confirmed by
      a human.
    - **Never** when the prompt merges a mount-gate `ask` (`facts.gate` from an
      `ask`). That is a safety warning about the owner's folder, and `run`
      requires an explicit `--confirm-mount` for it.
    - `attach` → eligible from any origin.
    - `container` → eligible from a **local** origin, and **not** from a workload
      origin (Q4).
    `hopAskAtTurnEnd` receives the origin (`deps.place()`), and
    `hopPromptRequest` sets `hopAuto` from the rule. Scope stays `once`, and
    `hopProposalOutcome` still coerces any answer to a one-time yes. Nothing is
    remembered.
12. **Logged.** An approved outcome whose response has `auto` carries
    `autoAccepted: true`. The moved notice says `Moved to … (auto-accepted) …`,
    and a failure says `not moved (auto-accepted): …`. The owner sees in the
    transcript that no prompt was shown.
13. **D9 revisited (Q5).** Recommended: auto-accept **survives** a hop into a
    workload, and goes **off** when a hop lands on local. In that case
    `useHop.ts:168-176` clears only on `place.kind === "local"`;
    `hopPromptDetail`'s reset line (`hop-proposal.ts:271`), the tool description
    (`move-session.ts:109`) and `hopMovedNotice` say exactly that; and D9's text
    in `docs/feat/session-hop.md` gets a dated amendment. Session-scoped
    approvals are still reset: they live daemon-side and the daemon changes.

### Files

In dependency order:

| Slice | File | Change |
|---|---|---|
| 1 | `packages/k8s/src/kubeconfig.ts` | export `contextNamespace`, used by `resolveContext` |
| 1 | `packages/tools/src/move-session.ts` | `workload.namespace` (k8s only, DNS-1123 label); description |
| 1 | `packages/tui/src/hop-command.ts` | `HopWorkload.namespace`, `hopWorkload(…, namespace)`, `-n/--namespace` in `readFlags`/`parseHopCommand`, `HOP_USAGE` |
| 1 | `packages/tui/src/hop-status.ts`, `app-types.ts` | place view `namespace?`; moved notice names it |
| 1 | `packages/cli/src/engine-select.ts` | `kubeNamespace`; `buildEngineHost` uses it |
| 1 | `packages/cli/src/hop-plan.ts` | `HopPlace.namespace?` |
| 1 | `packages/cli/src/hop-proposal.ts` | schema field; `hopSpecOf`; `proposalNotice`/`hopPromptDetail` namespace line |
| 1 | `packages/cli/src/hop-targets.ts` | `host(engine, where)`; attach passes ns; not-found / exec hop wording |
| 1 | `packages/cli/src/hop-feed.ts`, `hop-turn.ts` | `pinNamespace` before asking; `[move failed: …]` (Q6) |
| 1 | `packages/cli/src/main.ts` | `engineHost` drops its own env step; `hopEngineHost(engine, where)`; `pinNamespace` dep |
| 2 | `packages/cli/src/engine-runtime.ts` | `liveLine` dep; `statusLineFor` prefers it |
| 2 | `packages/cli/src/hop-live-line.ts` (new) | throttled, latching live line (pure, injected clock/timers) |
| 2 | `packages/cli/src/hop-targets.ts` | `liveLine` instead of `HOP_TERM` (deleted) |
| 3 | `packages/core/src/permission.ts` | `PermissionRequest.hopAuto?`, `PermissionResponse.auto?` (process-internal) |
| 3 | `packages/tui/src/permission-ui.ts` | `autoApproves` reads `hopAuto`; auto branch returns `auto: true` |
| 3 | `packages/cli/src/hop-turn.ts`, `hop-feed.ts` | `hopAutoAcceptable`; origin in; `autoAccepted` out |
| 3 | `packages/tui/src/useHop.ts`, `hop-status.ts` | D9 per Q5; `(auto-accepted)` in the notices |
| 3 | `packages/cli/src/hop-proposal.ts`, `packages/tools/src/move-session.ts` | reset wording per Q5 |
| all | `docs/feat/session-hop.md` | dated D9 amendment; `changelog.d/session-hop-ux.{fixed,changed}.md` |

### Failure modes

| Case | What happens / how it converges |
|---|---|
| **No current context** (kubeconfig without `current-context`, unreadable, or no kubeconfig and no server override) | `kubeNamespace`/`buildEngineHost` throw the existing message (`kubeconfig.ts:102-104`). Proposal: `pinNamespace` fails at turn end, so there is **no prompt** (nothing locatable to approve): `not moved: kubeconfig has no current-context…`, plus `[move failed: …]` for the model. Typed `/move`: the build fails the same way (`hop-targets.ts:381-383`). Nothing is dialled. Session unchanged. |
| **Namespace does not exist** | A GET of a pod in a missing namespace is a 404, so it is the same as “pod not found” below. Nothing is created (attach never creates). |
| **Pod not found in the resolved ns** | `WorkloadNotFoundError` gives the hop wording with `-n <ns>` (design 5). The model is told (Q6). The status row clears at settle, and no progress line is left behind. |
| **RBAC forbidden** (403 on get/exec) | The API's message (it names the namespace and verb) is passed through as `not moved: …` (`engine-k8s.ts:174-186` rewrites only a 404; a 403 keeps its text). Nothing was injected: the 403 comes on `getPod`, before any exec. |
| **Pod in another ns than the one assumed** (the same pod name in two namespaces; the model names the pod and container but not the namespace) | The default namespace is resolved ONCE, pinned and shown: in the prompt (`namespace: X`), in the live row (`attaching to … in namespace X`) and in the summary (`in X`). Under auto-accept (slice 3) there is no prompt, so the row and the summary are the record, and the badge plus `/move local` undo it. The container name implies no namespace, so nothing is inferred from it. |
| **Kubeconfig changes between prompt and build** | Design 3: the approved spec carries the pinned namespace, so the build dials what was shown. |
| **Invalid namespace** (uppercase, `/`, > 63, on docker) | Typed: a usage line, nothing built. Tool: a schema error the model sees. Laptop `hopSpecOf`: `null`, which raises the existing `HOP_PROPOSAL_INVALID` notice. |
| **Version skew**: an older resident pod daemon offers the tool without `namespace` | The model cannot name one, so the laptop default applies, pinned and shown. An older laptop with a newer pod: the laptop injects its own build, and a resident of another build is replaced or flagged (`residentSkewWarning`). If skew happened anyway, the old laptop's strip drops `namespace`. Accepted, and noted. |
| **Progress after failure** | Every exit path of the runtimes already calls `status?.finish()` (`engine-runtime.ts:817,823,852,913,1061,1134`). With `liveLine`, finish latches it closed, so a late `onProgress` is ignored and its pending timer is cleared. Even a leaked call reaches no listener after settle (`useHop.ts:154-156`). The transcript gets only `not moved: …`. |
| **Progress after `/move cancel`** | The cancel settles the run at its next boundary. Until then ticks only update the row, and after settle they reach nobody. Today they become transcript notices after the cancel, so this row is fixed by slice 2. |
| **Flood** (1 400 ticks) | Throttled to ≤ 1/100 ms with the latest text guaranteed (design 8). |
| **Auto-accept ON, proposal toward local from a pod** | `hopAutoAcceptable` gives false, so the dialog is shown. A mutation test pins this (Tests). |
| **Auto-accept ON, proposal whose prompt carries a mount-gate `ask`** | Not eligible: asked. |
| **Auto-accept ON, foreign turn** | `own` is false, so the proposal is never asked here at all (`hop-feed.ts:89-94`), unchanged. |
| **Auto-accept toggled between proposal and turn end** | The gate reads `autoApproveRef` at request time (`permission-ui.ts:424`). That is the same rule every tool has. |
| **A forged `session_hop`/`hopAuto` from a daemon** | Impossible: `toPermissionRequest` allowlist (load-bearing assumption). The test asserts it. |

### Tests

Each test is red-first on today's code. **Slice 1:**
- `cli/test/engine-select.test.ts` — `buildEngineHost("kubernetes", {}, io{env:
  TENTACLE_POD_NAMESPACE=ns1})` gives `namespace === "ns1"`. **Red today:** the
  hop path ignores the env and gives the context's namespace. Add a precedence
  table: explicit > env > server ⇒ `default` > context > `default`.
  **Mutation:** drop the env step from `kubeNamespace` and this test fails.
- `tui/test/hop-command.test.ts` — `/move attach kubernetes:p/c -n openshift-etcd`
  gives `workload.namespace`. Errors: `-n` alone, `-n` twice, `-n` on
  `docker:x`, `-n Bad_NS`, a 64-character label. `kubernetes:a/b` still means
  pod/container.
- `tools/test/move-session.test.ts` and `cli/test/hop-proposal.test.ts` —
  namespace accepted for k8s only. `hopSpecOf` carries it. The prompt detail
  shows `namespace: openshift-etcd`.
- `cli/test/hop-feed-turn.test.ts` — **the pin property:** a proposal without
  namespace, with `pinNamespace` returning `ns-A` at turn end. The request
  detail shows `ns-A` AND the approved spec has `ns-A`. Then make the resolver
  answer `ns-B`: the built spec is still `ns-A`. A resolver that throws gives no
  broker request, plus a `failed` outcome and a `[move failed: …]` line.
- `cli/test/session-hop-targets.test.ts` — the attach build calls
  `host("kubernetes", { namespace: "ns-A" })`. A `WorkloadNotFoundError` gives
  `/move attach … -n`, never `--namespace`.

**Slice 2:**
- `cli/test/hop-live-line.test.ts` (pure, fake clock and timers):
  - the leading emit;
  - ≤ 1 emit per 100 ms;
  - the last text lands via the trailing timer;
  - duplicates dropped;
  - after `finish()`, `set` emits nothing and no timer is left.
- `cli/test/session-hop-targets.test.ts` — an attach that injects (the
  engine-runtime `:1566` preflight-fail pattern) gives **zero `notify` calls on
  a clean attach**, while `statuses` saw `attaching…`, `injecting tentacle
  ▓…` and `verifying…`. **Red today:** ≥ 13 notices. **Mutation:** pass
  `liveLine: undefined` and the test fails.
- `cli/test/engine-runtime.test.ts` — with `liveLine`, `log`/`info` stay empty
  on success, and `finish()` is called on success AND on the 404 path. Without
  `liveLine` and with `tty:false`, the piped lines are unchanged (no regression
  for `run`/`attach`).

**Slice 3:**
- `tui/test/permission-*.test.ts` — `autoApproves({kind:"session_hop"})` stays
  false (the existing H4-M8 row). With `hopAuto: true` it is true. With a
  foreign turn it is false. `hooks_trust` is unchanged.
- `cli/test/hop-turn.test.ts` — the `hopAutoAcceptable` table:
  - local→attach ✓;
  - local→container ✓, ✗ with a gate ask;
  - workload→attach ✓;
  - workload→container ✗ (Q4);
  - any→local ✗.
  **Mutation:** return true for `target: "local"`, and the “toward local is
  always asked” row fails.
- `cli/test/hop-feed-turn.test.ts` — with a broker whose requester applies the
  real `autoApproves` plus an auto flag ON:
  - a local-origin attach proposal is approved with no dialog and
    `autoAccepted`;
  - a workload-origin `local` proposal reaches the dialog (a `SpyBroker` sees
    it).
- `client/test/permission-router.test.ts` — the `send` action has only
  `optionId`/`message`, so `auto` never reaches the wire. `toPermissionRequest`
  never yields `kind` or `hopAuto`.
- `tui/test/session-hop.test.tsx` — per Q5: ON before a hop into a workload
  stays ON (the status bar and the notice say so). It goes OFF after landing
  local. The existing D9 row flips on purpose and is shown red first.

Gate before done: the narrow files per slice, then `bun run check`. Then a live
re-test by the owner on OpenShift, which is the only real cluster:
`move_session` without ns lands in `openshift-etcd`; `-n` works; one live line;
one summary.

### Owner questions

1. **Namespace syntax.** `/move attach kubernetes:<pod>[/<container>] -n <ns>`
   plus the tool field `workload.namespace`, or `kubernetes:<ns>/<pod>[/<container>]`?
   **Rec:** `-n` plus the field. `a/b` already means pod/container, `-n` is
   `tentacle attach`'s and kubectl's spelling, and a named field is what a model
   fills reliably.
2. **Default rule.** One rule for `run`/`attach`/hop: explicit >
   `TENTACLE_POD_NAMESPACE` > the kubeconfig current context's namespace >
   `default`. The hop gains the env step it lacks. **Rec:** yes. Keep
   `tentacle attach <name>`'s kept-index lookup for `attach` only: a hop names
   its place, and the prompt shows it.
3. **Confirm the cause.** Between the failed try and the retry, did `oc login`
   or `oc project openshift-etcd` (or a `KUBECONFIG` switch) run? The code
   re-reads the kubeconfig per hop and has one path (repro (d)). **Rec:** if
   nothing changed, tell me, and the executor adds a one-line debug trace of the
   kubeconfig path and context before slice 1.
4. **Auto-accept scope for a proposal made FROM a workload.** **Rec:**
   auto-accept `attach` from any origin, and `container` only from a local
   origin. Always ask for a hop to local, and for any proposal whose prompt
   carries a mount-gate warning. Reason: a pod-originated `container` proposal
   would create a container on the laptop's engine with the laptop folder
   mounted read-write and a pod-chosen image. That is a laptop effect requested
   by an untrusted pod (§7). Your literal wording (“workload → another
   workload”) would include it, so I need your call.
5. **D9 — does auto-accept survive a hop?** **Rec:** it survives a hop into a
   workload you approved or auto-approved. Turning it off there contradicts your
   intent, and the gate stays laptop-side. It turns off when a hop lands on
   **local**, which is always human-confirmed, and from then on commands hit your
   machine. One Shift+Tab re-enables it. Alternative: it always survives.
6. **Tell the model when a proposed move fails** (`[move failed: <reason>]` in
   the next prompt, like `[move declined]`)? **Rec:** yes. With it, the model
   would have retried with `workload.namespace` itself instead of needing your
   “ritenta”.

## Execution

## Review

#### Owner answers so far (2026-11-14)

- Q1: **`kubernetes:<ns>/<pod>`** (namespace in the name, NOT `-n`); a rule to tell `<pod>/<container>` from `<ns>/<pod>` is still to be decided (owner wanted to clarify Q2).
- Already decided before the plan: auto-accept SURVIVES a hop (reverses D9); hops toward local from a pod always confirmed.
- Q2–Q6: pending (owner was clarifying Q2 when the orchestrator hit its usage limit).

#### Owner decisions — complete set (2026-11-14 23:40), binding; supersede the open questions above

1. **Namespace syntax: `kubernetes:<ns>/<pod>[/<container>]`** (owner Q1; not `-n`). Rule that removes the ambiguity: in the `kubernetes:` form, **one segment = pod** (namespace from the default rule), **two segments = `<ns>/<pod>`**, **three = `<ns>/<pod>/<container>`**. The tool gets the same shape (`workload.namespace` field or the same string — pick one and keep `/move` and the tool identical). The confirmation line always shows `ns/pod[/container]`.
2. **Default namespace (orchestrator, recommended rule)**: explicit > `TENTACLE_POD_NAMESPACE` > the kubeconfig current context's namespace > `default`, the SAME function for `run`, `attach` and hops.
3. Q3 (did `oc project` change between the two tries?): unknown — add the one-line debug trace of kubeconfig path + context + namespace to the hop log before slice 1.
4. **Auto-accept ON ⇒ NO confirmation for a model-invoked `move_session`** (owner): the move runs at the turn boundary with no prompt, logged allow-once. The ONE exception stays (AGENTS §7 "a pod is not trusted"): a move TOWARD LOCAL proposed from a pod/container side is always confirmed on the laptop.
5. **Auto-accept SURVIVES a hop** (owner, earlier): if it was on, it stays on after the move (D9 reversed); session "always" approvals are still re-asked.
6. **Wake-up after a move (owner, NEW):** when a move completes, the session automatically continues with ONE short system message to the model — no user typing needed — e.g. `[session moved to kubernetes:openshift-etcd/etcd-…/etcdctl — host <hostname>, cwd <dir>, folder <shared|not shared>; background jobs and MCP servers were reset; auto-accept <on|off>] Continue the task from here.` The same channel reports a failed or declined move (`[move failed: <reason>]`, `[move declined]`) so the model never has to guess (closes Q6). Only after a model-proposed move (or a user `/move` typed mid-task with a queued turn) — not after a `/move` typed at idle with nothing pending.
7. **Rewrite the `move_session` description** (owner): concise, clear and welcoming to the model — when to use it (multi-step work that needs the workload's tools/files; a one-off check can stay a single `kubectl/oc exec`), the target shapes incl. the namespace form, that it is a proposal applied at the end of the turn (auto-accept: no prompt), that a wake-up message arrives in the new place, what resets (jobs, MCP) — and drop the stale "auto-accept is turned off". Target ≤ 600 characters; pin it with a test.
*— claude-opus-5-5 (orchestrator), 2026-11-14*
