# feat/session-hop-ux — Hop UX from the OpenShift live test: k8s namespace, one live progress line, auto-accept

> **Status:** approved (Implementation revised to the owner's complete decisions, 2026-11-14 23:40)
> **Branch:** `feat/session-hop-ux`
> **Size:** M (slices M · S · M) · **Blast:** load-bearing (slice 3 changes what auto-accept may answer on the single broker and adds an automatic prompt after a move, AGENTS §7 "a pod is not trusted"; slice 1 changes the `kubernetes:` grammar and what a pod-supplied proposal can target) · **Suited:** slices 1–2 DeepSeek; slice 3 a strong model + **mandatory fresh-context Opus review** red-teaming §7 (single broker, pod not trusted)
> **Changelog:** `changelog.d/session-hop-ux.fixed.md` (namespace default + one progress line) and `changelog.d/session-hop-ux.changed.md` (`kubernetes:<ns>/<pod>[/<container>]`; auto-accept answers model moves except toward local from a workload, and survives a hop; the session continues by itself after a move; new `move_session` description)

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

*— claude-opus-5-5, 2026-11-14* (revised to the owner's complete decisions of
2026-11-14 23:40, Review below; they supersede the earlier open questions, which
are removed, and every design that contradicted them)

### Load-bearing assumption

**Every auto-accept decision for a laptop-side prompt is taken in ONE place: the
requester the TUI installs on the single `PermissionBroker`. A daemon (a pod)
cannot raise a `session_hop` request or set any field that predicate reads.**
Slice 3 depends on it: auto-accept now answers most `session_hop` prompts, and
the one exception (toward local, from a workload) must be decided by facts only
the laptop holds. Slices 1–2 depend only on facts cited in Preconditions.

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
  (`permission-ui.ts:417`). The auto-accept decision is `permission-ui.ts:424`:
  `if (autoApproveRef.current && autoApproves(req, own)) return { allowed: true,
  scope: "once" }`. The predicate is `autoApproves` (`permission-ui.ts:59-61`);
  today it excludes `session_hop` outright.
- A daemon's ask never carries `kind` or any laptop-internal field.
  `toPermissionRequest` rebuilds it from an allowlist (`tool`, `title`,
  `explanation`, `suggestion`, `reply`; `permission-router.ts:76-86`), and
  `PermissionRequest.kind` is laptop-internal, never on the wire
  (`core/permission.ts:27-34`). The only producers of `session_hop` are the
  laptop's `hopPromptRequest` (`hop-turn.ts:59-69`) and `mountAsk`
  (`hop-targets.ts:517-531`).
- An answer's extra fields never reach the wire: the router's `send` carries
  only `optionId` and `message` (`permission-router.ts:180-186`).
- The origin of a proposal is a laptop fact: the hop feed's `deps.place()`
  (`hop-feed.ts:38`, wired at `main.ts:2113`). A `workload` place means the
  turn ran in a pod/container daemon, so its `move_session` arguments are
  pod-supplied (§7).

### Preconditions

- **Namespace rule today.** Context namespace, else `"default"`:
  `kubeconfig.ts:123`. The server override gives `"default"`:
  `engine-select.ts:509`. `TENTACLE_POD_NAMESPACE` is applied only by the CLI's
  `engineHost` (`main.ts:1199-1202`), not by `hopEngineHost`
  (`main.ts:1221-1228`, passes `{}`). The kubeconfig is re-read per call
  (`kube-auth.ts:116-121`): no cache.
- **Grammar today.** `HopWorkload` is `{engine, name, container?}`
  (`hop-command.ts:12-17`). `parseWorkload` splits `kubernetes:` on `/`, takes
  two segments as `<pod>/<container>` and refuses a third
  (`hop-command.ts:264-277`). The ONE validator is `hopWorkload`
  (`hop-command.ts:67-80`), reused by the laptop's `hopSpecOf`
  (`hop-proposal.ts:143-150`). The tool's `workloadSchema` mirrors it
  (`move-session.ts:39-53`) and strips unknown fields, as does
  `hopProposalSchema` (`hop-proposal.ts:22-41`).
- **Labels today.** A workload is written `engine:name[/container]` in four
  places: `hopLabel` (`hop-feed.ts:193-202`), `hopPlaceLabel`
  (`hop-feed.ts:205-212`), `workloadLabel` (`hop-targets.ts:551-556`) and the
  TUI's `hopPlaceText`/badge (`hop-status.ts`). `HopPlaceView` has no namespace
  (`app-types.ts:277-283`).
- **Not-found wording.** `WorkloadNotFoundError` is typed and carries `noun` and
  `place` (`engine-host.ts:89-97`); its k8s text advises `--namespace`
  (`engine-k8s.ts:179-182`).
- **Status row.** `deps.status` feeds the hop row (`main.ts:2100,2108` →
  `hop-feed.ts:71` → `useHop.ts:150-153` → `hopStatusRow`,
  `hop-status.ts:23-33`). Its listener is unsubscribed at settle
  (`useHop.ts:154-156`), so a line after settle reaches nobody.
- **D6 drift note** (`hop-targets.ts:304-310`): `info` stays the NOTICE sink
  (dispose's `quitReport`, `engine-runtime.ts:1099`). Only the phases move.
- **D9 today.** `useHop.ts:166-178` clears auto-accept on every committed hop and
  `hopMovedNotice` says so (`hop-status.ts:61-67`); `hopPromptDetail`
  (`hop-proposal.ts:271`) and the tool description (`move-session.ts:109`) say
  so too.
- **The model's next-prompt line today.** `hop-feed.ts` keeps ONE `pendingLine`
  (`:82`): `[move declined]` after a refusal (`:108-111`), `moveGuideLine(place)`
  after a commit (`:150`, `hop-turn.ts:167-169`). A failed run sets nothing
  (`:129-131`). `takeLine` consumes it (`:115-120`), and the turn driver puts it
  in front of the NEXT REAL prompt only (`useTurnDriver.ts:800-816`,
  `hopWithLine` `:112`). Nothing sends a prompt by itself after a hop: the moved
  notice asks the user to "send a message to continue" (`hop-status.ts:65-66`).
- **Turn-end seam.** At the end of an own turn the driver calls
  `hopTurn.end(true)` and starts an `approved` spec through `hopTurn.approved`
  (`useTurnDriver.ts:686-702`); `declined` is not acted on.
  `HopProposalView` is `none | approved | declined` (`app-types.ts:366-370`).
  The approved path enters `startHop` (`App.tsx:425-432` → `useHop.ts:141`),
  the queued typed `/move` enters it from `hopIfQueued` (`useHop.ts:235-249`),
  and an idle typed `/move` from `requestHop` (`useHop.ts:229`). So the three
  origins are distinguishable at the one entry point.
- **A real prompt can be sent without typing.** `run(text, opts)`
  (`useTurnDriver.ts:751-830`) is the one send path; `continuation: true`
  sends `""` with no user bubble (`:768-771`, used by the job wake
  `App.tsx:594,1060-1074`). A continuation takes NO hop line (`:802`), so the
  wake-up must be a real prompt, not a continuation. `planTurnStart` defers or
  refuses during a compaction (`send-now.ts:129-133`, `useTurnDriver.ts:775-783`).
- **Facts for the wake-up message.** After commit the TUI has the place and the
  daemon session's cwd (`HopTargetView.place`, `.cwd`, `app-types.ts:258-271`).
  Whether the folder is shared is decided by the container build's plan
  (`hop-targets.ts:281`, `plan.kind === "mount"`) but is not on `HopBuilt`
  (`session-hop.ts:32-50`). The daemon's **hostname is not known on the laptop**
  (no field in `HopBuilt`, the view, or the protocol).
- **No protocol change.** The tool input schema is not in `@tentacle/protocol`;
  `PermissionRequest`/`PermissionResponse` are process-internal; the wake-up is
  an ordinary `session/prompt`. No `protocol.d/` note.

### Design

Owner decisions 1–7 (Review) are cited as **OD1…OD7**.

**Slice 1 — namespace (OD1, OD2, OD3) and the tool description (OD7).**

1. **Trace first (OD3).** Before the rule changes, the k8s resolution returns its
   provenance: `kubeNamespace` (below) returns `{ namespace, source:
   "explicit" | "env" | "context" | "default" | "server", kubeconfig: <path>,
   context: <name> }`. The hop's FIRST phase on the live row and the prompt
   detail carry `namespace <ns> (from <source>; context <ctx>, <path>)`, and the
   `not moved:` text of a k8s attach repeats it, so the next live test answers
   Q3 from the transcript. (Before slice 2 lands, phases are notices, so the
   trace is visible either way.)
2. **One rule, one function (OD2).** `kubeNamespace(options, io)` in
   `engine-select.ts`: `options.namespace ?? io.env.TENTACLE_POD_NAMESPACE ??
   (server ? "default" : contextNamespace(kubeconfig, options.kubeContext))`.
   `contextNamespace` is extracted from `resolveContext` (`kubeconfig.ts:123`),
   which then uses it — one copy of "context ns, else default". `buildEngineHost`
   (`engine-select.ts:500-517`) uses it, so `engineHost` (`main.ts:1201`) drops
   its own env step and `hopEngineHost` gains it. Kept-entry dials pass
   `entry.namespace` explicitly (`hostOptionsFor`, `engine-select.ts:290-298`),
   so the env never overrides a kept workload's place. Resolved per call, as
   today. The rule is the SAME for `run`, `attach` and every hop.
3. **Syntax (OD1): `kubernetes:<ns>/<pod>[/<container>]` with the 1/2/3 rule.**
   In `parseWorkload` (`hop-command.ts:264-295`), for `kubernetes:` only:
   one segment = `<pod>` (namespace from OD2), two = `<ns>/<pod>`, three =
   `<ns>/<pod>/<container>`, four or more = the usage line. docker/podman keep
   one segment (a second is the existing "no container part" line).
   `HopWorkload.namespace?: string` (kubernetes only). `hopWorkload(engine, name,
   container, namespace)` gains problems `namespace` (set on docker/podman) and
   `namespaceChars` (DNS-1123 label `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`, ≤ 63).
   **Consequence, accepted by the owner (pre-public):** a container can be named
   only together with a namespace — `kubernetes:p/c` now means namespace `p`,
   pod `c`. `HOP_USAGE` and every hint (`hop-command.ts:37-38,271,287,292`) are
   rewritten to the new shape so no message teaches the old one.
4. **The tool has the same shape (OD1 "pick one").** Chosen: the structured
   field `workload.namespace`, not a string. The model already passes a
   structured `workload`; the identity OD1 asks for holds where it matters —
   both paths produce the same `HopWorkload` through the same `hopWorkload`
   validator (`hopSpecOf`, `hop-proposal.ts:143-150`), and every label prints
   the same `kubernetes:<ns>/<pod>[/<container>]`. The tool regex mirrors
   `namespaceChars` exactly as `WORKLOAD_PART` mirrors `HOP_WORKLOAD_PART`; a
   `namespace` on docker/podman is a refine error the model sees.
5. **Pinned and shown — ns/pod[/container] always (OD1).** For a PROPOSAL,
   `hop-feed` resolves the namespace at turn end, before deciding/asking, via a
   new dep `pinNamespace(spec)` injected from `main.ts` (calls `kubeNamespace`
   with the spec's explicit value). The resolved value is written into
   `spec.workload.namespace`; THAT spec is shown, auto-accepted or asked, and
   returned as `approved`. A kubeconfig that changes between turn end and build
   (repro (d)) can no longer move the target. For a typed `/move` the build
   resolves once and writes it into the built place. ONE label function,
   `workloadText(w)` in `@tentacle/tui` (`hop-command.ts`), replaces the four
   copies (`hopLabel`, `hopPlaceLabel`, `workloadLabel`, `hopPlaceText`): for
   k8s it always prints `kubernetes:<ns>/<pod>[/<container>]` once the
   namespace is known (prompt detail, live row, moved/failed notice, wake-up
   line, badge — the badge too, because `kubernetes:<pod>/<c>` would now READ as
   ns/pod; it is truncated to width as today). `HopPlace`/`HopPlaceView` carry
   `namespace?`.
6. **Built where named.** `HopTargetDeps.host` becomes `(engine, where?: {
   namespace?: string })`; `attachTarget` passes `workload.namespace`;
   `hopEngineHost(engine, where)` forwards it to `buildEngineHost`.
7. **Hop wording for a miss.** In `attachTarget`'s catch, a k8s
   `WorkloadNotFoundError` becomes `not moved: no pod "<pod>" in namespace
   "<ns>" (from <source>) — name its namespace: /move attach
   kubernetes:<namespace>/<pod>`, built from the typed error's fields. The
   CLI's `--namespace` advice never appears in a hop; the multi-container hint
   (`engine-k8s.ts:85`) reads `kubernetes:<ns>/<pod>/<container>` in a hop.
8. **Tool description rewritten (OD7), ≤ 600 chars, pinned.**
   `MOVE_SESSION_DESCRIPTION` (`move-session.ts:105-109`) becomes (538 chars as
   drafted; the executor may polish, the test pins ≤ 600 and the key facts):
   > Move this session to another place; the move is applied when this turn
   > ends. Use it for multi-step work that needs a workload's tools or files; a
   > one-off check can stay a single kubectl/oc exec. Targets: "attach" an
   > existing workload (kubernetes: namespace, pod, optional container;
   > docker/podman: name), "container" (a new container with your folder
   > mounted), "local" (the user's machine). The user confirms it unless
   > auto-accept is on. A message in the new place tells you where you are;
   > background jobs and MCP servers are reset there.
   The stale "auto-accept is turned off" goes. Field-level detail (`keep`,
   `image`, `namespace`) moves to the schema's `.describe()` strings, which do
   not count toward the 600. `MOVE_SESSION_PROPOSED` (`:93-94`) is reworded to
   match: "Proposed; it is applied when this turn ends. Do not assume it
   happened: a message at the start of the next turn tells you the result."
   The module comment (`:1-17`) is updated: auto-accept may now answer it
   (slice 3), still only through the laptop's broker.

**Slice 2 — one live progress line** (unchanged by the owner decisions).

9. **A live-line seam in the engine runtimes.** `liveLine?: { set(text): void;
   finish(): void }` on `EngineRuntimeDeps` and `EngineAttachRuntimeDeps`.
   `statusLineFor` returns it when present, before the TTY test
   (`engine-runtime.ts:207-210`). Everything keyed on `status` then takes the
   interactive contract with no further edit: phases → `set`; the injection's
   `onStatus` gets the bar; the resolver's verbose log is dropped; no
   `attached…`/`ready in…` line; warnings → `notify` only. `run`/`attach` (no
   `liveLine`) are unchanged.
10. **The hop wires it to its row.** In `hop-targets.ts` both builds drop
    `logTerm: HOP_TERM` (`:49,302,397`) and pass `liveLine:
    createHopLiveLine({ emit: deps.status })` from a new pure module
    `cli/src/hop-live-line.ts`: first text at once, then ≤ 1 per 100 ms, the
    latest always lands (trailing timer), identical text dropped, `finish()`
    clears the timer and latches closed. Clock and timers injected. `HOP_TERM`
    is deleted. `log`/`info` stay `notify` (errors, warnings, `quitReport`).
11. **Transcript budget for a hop:** the engine's warnings (cwd moved, binary
    replaced, resident skew) and ONE outcome line (`Moved to …` / `not moved:
    …`). No phase, no progress tick. The row is an Ink element (§7 Ink
    invariant holds).

**Slice 3 — auto-accept (OD4, OD5) and the wake-up (OD6).**

12. **The decision stays at the one gate (OD4).** `autoApproves`
    (`permission-ui.ts:59-61`) becomes `own && req.kind !== "hooks_trust" &&
    (req.kind !== "session_hop" || req.hopAuto === true)`.
    `PermissionRequest.hopAuto?: true` is laptop-internal, set ONLY by
    `hopPromptRequest`; `mountAsk` (typed `/move`'s gate) never sets it. The
    auto branch (`:424-425`) returns `{ allowed: true, scope: "once", auto: true
    }`; `PermissionResponse.auto?: true` is process-internal (never on the wire,
    `permission-router.ts:180-186`).
13. **Eligibility is one pure rule** in `hop-turn.ts`:
    `hopAutoAcceptable(spec, origin) = !(spec.target === "local" &&
    origin.kind === "workload")`. That is OD4 literally: every model-proposed
    move is auto-acceptable EXCEPT a move toward local proposed from a
    pod/container. (A `local` proposal from a local origin is eligible: OD4
    excepts only a workload origin, and such a move brings nothing onto the
    laptop that is not already there.) This
    supersedes the earlier recommendations to exclude a pod-originated
    `container` proposal and a prompt carrying a mount-gate `ask`: under OD4
    those are auto-accepted too (the merged prompt is answered as one, so
    `gateAnswered` holds as today, `hop-turn.ts:86-88`). `hopAskAtTurnEnd`
    receives the origin (`deps.place()`) and `hopPromptRequest` sets `hopAuto`
    from the rule. Scope stays `once`; `hopProposalOutcome` still coerces any
    yes to one-time. Nothing is remembered.
14. **Logged allow-once (OD4).** An approved outcome whose response has `auto`
    carries `autoAccepted: true`; the outcome line reads `Moved to … 
    (auto-accepted) …` or `not moved (auto-accepted): …`, so the transcript
    shows that no prompt was shown.
15. **Auto-accept survives every hop (OD5, D9 reversed).** `useHop.ts:166-175`
    stops calling `clearAutoApprove`; `hopMovedNotice` drops the
    "auto-accept is off" variant; `hopPromptDetail`'s reset line
    (`hop-proposal.ts:271`) becomes "background jobs, MCP servers and
    session approvals are reset". Session "always" approvals are still re-asked
    (they live daemon-side, and the daemon changes). D9 in
    `docs/feat/session-hop.md` gets a dated amendment.
16. **The wake-up channel (OD6).** The pending line becomes a typed fact,
    rendered late:
    - `hop-feed.ts` keeps `pending: HopWakeFact | null` instead of
      `pendingLine`: `{ kind: "moved", place, cwd?, folder: "shared" |
      "not shared" | "local" }`, `{ kind: "failed", reason }` (a proposed
      move whose pin, build or commit failed — closes the old Q6),
      `{ kind: "declined" }`. `folder` comes from a new `HopBuilt.folder`
      set by the builds (`hop-targets.ts:281` mount ⇒ `shared`; attach ⇒
      `not shared`; local ⇒ `local`).
    - `takeLine(ctx: { autoAccept: boolean })` renders it through ONE pure
      function `hopWakeLine(fact, ctx)` in `hop-turn.ts` (replacing
      `moveGuideLine`): `[session moved to kubernetes:openshift-etcd/etcd-…/etcdctl
      — cwd <dir>, folder <shared|not shared>; background jobs and MCP servers
      were reset; auto-accept <on|off>]`, `[move failed: <reason>]`,
      `[move declined] …` (the existing hint). Every pod-reachable text goes
      through `untrustedText`, as `moveGuideLine` does today. Auto-accept is
      read at render time (the TUI's live value), so the line never states a
      stale mode. **Host:** not included — the laptop does not know the
      daemon's hostname (Preconditions) and adding it needs a protocol field;
      the place names the workload, which is enough (Notes).
    - **When to wake: one pure rule** `hopWakeStep` in a new
      `tui/src/hop-wake.ts`: input `{ origin: "proposal" | "queued" | "idle",
      outcome: "moved" | "failed" | "declined", chain: number }` → `wake` |
      `hold`. `proposal` (moved/failed/declined) ⇒ wake; `queued` (a `/move`
      typed mid-task, D4) moved/failed ⇒ wake; `idle` ⇒ hold (the line waits
      for the user's next prompt, today's behaviour). `chain ≥
      HOP_WAKE_CHAIN_MAX` (3 consecutive wake turns with no user prompt
      between) ⇒ hold, with one notice `_auto-continue paused after 3 moves —
      send a message to continue_`; a real user prompt resets `chain`.
    - **Origin plumbing.** `startHop(spec, opts)` gains `origin`
      (`hopTurnPort.approved` ⇒ `proposal`, `hopIfQueued` ⇒ `queued`,
      `requestHop` ⇒ `idle`). The driver's turn-end handler
      (`useTurnDriver.ts:686-702`) also handles `declined` and the new
      `HopProposalView` kind `failed` (pin failed, no prompt) by asking
      `hopWakeStep`.
    - **Firing.** A wake is a REAL prompt: `run(HOP_WAKE_TEXT, { hopWake: true
      })` with `HOP_WAKE_TEXT = "Continue the task from here."`; `run` sends
      `hopWithLine(takeLine({autoAccept}), HOP_WAKE_TEXT)` and renders one dim
      row (`↻ continuing after the move`) instead of a user bubble; it is
      saved as conversation like today's line. It fires only at a true idle
      (`hopReady`, `hop-command.ts:215-217`) after the hop settled and the view
      swapped; if not idle (a foreign turn, queued rows, a compaction), it
      holds and the line rides the next real prompt — converges, never lost,
      never doubled (`takeLine` consumes). A pending job wake
      (`App.tsx:1060-1074`) runs after it through the existing wake gate.
    - **Notices.** `hopMovedNotice` says `— continuing` when a wake fires, `—
      send a message to continue` when it holds.

### Files

In dependency order:

| Slice | File | Change |
|---|---|---|
| 1 | `packages/k8s/src/kubeconfig.ts` | export `contextNamespace`, used by `resolveContext` |
| 1 | `packages/tools/src/move-session.ts` | `workload.namespace` (k8s, DNS-1123); OD7 description + `PROPOSED` + module comment |
| 1 | `packages/tui/src/hop-command.ts` | `HopWorkload.namespace`; `hopWorkload(…, namespace)`; 1/2/3-segment `parseWorkload`; `workloadText`; `HOP_USAGE`/hints |
| 1 | `packages/tui/src/hop-status.ts`, `app-types.ts` | `HopPlaceView.namespace?`; labels via `workloadText` |
| 1 | `packages/cli/src/engine-select.ts` | `kubeNamespace` (+ provenance); `buildEngineHost` uses it |
| 1 | `packages/cli/src/hop-plan.ts` | `HopPlace.namespace?` |
| 1 | `packages/cli/src/hop-proposal.ts` | schema field; `hopSpecOf`; prompt detail `ns/pod[/c]` + trace |
| 1 | `packages/cli/src/hop-targets.ts` | `host(engine, where)`; built place ns; not-found / exec hop wording; `workloadText` |
| 1 | `packages/cli/src/hop-feed.ts` | `pinNamespace` before asking; labels via `workloadText` |
| 1 | `packages/cli/src/main.ts` | `engineHost` drops its env step; `hopEngineHost(engine, where)`; `pinNamespace` dep |
| 2 | `packages/cli/src/engine-runtime.ts` | `liveLine` dep; `statusLineFor` prefers it |
| 2 | `packages/cli/src/hop-live-line.ts` (new) | throttled, latching live line |
| 2 | `packages/cli/src/hop-targets.ts` | `liveLine` instead of `HOP_TERM` (deleted) |
| 3 | `packages/core/src/permission.ts` | `PermissionRequest.hopAuto?`, `PermissionResponse.auto?` |
| 3 | `packages/tui/src/permission-ui.ts` | `autoApproves` reads `hopAuto`; auto branch returns `auto: true` |
| 3 | `packages/cli/src/session-hop.ts`, `hop-targets.ts` | `HopBuilt.folder` |
| 3 | `packages/cli/src/hop-turn.ts` | `hopAutoAcceptable`; `hopWakeLine` (replaces `moveGuideLine`); origin in; `autoAccepted` out |
| 3 | `packages/cli/src/hop-feed.ts`, `hop-proposal.ts` | `HopWakeFact` pending; `takeLine(ctx)`; `failed` on proposal; reset wording |
| 3 | `packages/tui/src/hop-wake.ts` (new) | `hopWakeStep`, `HOP_WAKE_TEXT`, `HOP_WAKE_CHAIN_MAX` |
| 3 | `packages/tui/src/app-types.ts`, `useTurnDriver.ts`, `useHop.ts`, `App.tsx`, `hop-status.ts` | `HopProposalView.failed`; `takeLine(ctx)`; origin; wake firing; no D9 clear; notices |
| all | `docs/feat/session-hop.md`, `changelog.d/session-hop-ux.{fixed,changed}.md` | dated D9 amendment; fragments |

### Slices (S/M, dependency order)

| # | Slice | Size | Blast | Suited |
|---|---|---|---|---|
| 1 | namespace: trace, rule, 1/2/3 syntax, pin, wording, labels, tool description | M | cross-module (grammar change is user-visible; no wire/persistence change) | DeepSeek; standard review |
| 2 | one live progress line | S | contained (hop path only; `run`/`attach` pinned unchanged) | DeepSeek |
| 3 | auto-accept answers moves, survives hops; wake-up channel | M | load-bearing (single broker, "a pod is not trusted") | strong model; **mandatory fresh-context Opus review** red-teaming §7 |

### Failure modes

| Case | What happens / how it converges |
|---|---|
| **No current context** (no `current-context`, unreadable, no kubeconfig and no server override) | `kubeNamespace` throws the existing message (`kubeconfig.ts:102-104`). Proposal: `pinNamespace` fails at turn end ⇒ no prompt, no auto-accept; outcome `failed`, line `[move failed: kubeconfig has no current-context…]`, wake (OD6). Typed: the build fails the same way (`hop-targets.ts:381-383`). Nothing dialled. |
| **Namespace missing / pod not found** | 404 ⇒ `WorkloadNotFoundError` ⇒ hop wording with `kubernetes:<ns>/<pod>` and the ns provenance (design 7). Proposal: `[move failed: …]` + wake, so the model retries with `namespace` itself. Row cleared at settle. |
| **RBAC forbidden** (403) | The API's text is passed through (`engine-k8s.ts:174-186` rewrites only 404). Nothing injected (403 is on `getPod`). Proposal: failed line + wake. |
| **Old 2-segment habit** (`kubernetes:pod/container` typed the old way) | Now read as ns=`pod`, pod=`container` ⇒ almost always a 404 whose text names namespace `pod` and shows the right shape. Never a silent wrong success unless a namespace literally named like the pod holds a pod named like the container; accepted (pre-public, OD1). |
| **Same pod name in two namespaces** | The resolved namespace is pinned and shown everywhere as `ns/pod[/c]` (prompt, row, outcome, wake line). Under auto-accept there is no prompt, so outcome + wake line are the record; `/move local` undoes it (always asked from a workload). |
| **Kubeconfig changes between turn end and build** | Pinned spec (design 5): the build dials what was resolved and shown. |
| **Invalid namespace** (uppercase, > 63, on docker) | Typed: usage line. Tool: schema error the model sees. `hopSpecOf`: `null` ⇒ existing `HOP_PROPOSAL_INVALID`. |
| **Version skew** (older resident pod daemon offers the tool without `namespace`) | The model cannot name one ⇒ OD2 default, pinned and shown. Older laptop drops `namespace` by strip. Accepted. |
| **Progress after failure / cancel / flood** | Every runtime exit calls `status?.finish()` (`engine-runtime.ts:817,823,852,913,1061,1134`); `liveLine.finish` latches. Late ticks reach no listener after settle (`useHop.ts:154-156`). Throttle ≤ 1/100 ms, last text guaranteed. |
| **Auto-accept ON, proposal toward local from a workload** | `hopAutoAcceptable` false ⇒ `hopAuto` unset ⇒ dialog. Mutation-tested. |
| **Auto-accept ON, pod-originated `container` proposal / mount-gate warning** | Auto-accepted per OD4 (residual risk: a pod-chosen image on the laptop engine with the folder mounted; logged `(auto-accepted)`). Recorded in Notes, not designed out — owner's call. |
| **Auto-accept ON, foreign turn** | `own` false ⇒ never asked here (`hop-feed.ts:93-94`); `autoApproves(…, false)` false. |
| **Auto-accept toggled between proposal and turn end** | The gate reads `autoApproveRef` at request time (`permission-ui.ts:424`), like every tool. |
| **Forged `session_hop`/`hopAuto` from a daemon** | Impossible: `toPermissionRequest` allowlist; test asserts it. |
| **Wake loop** (model proposes → fails/declined → wake → proposes again …) | `HOP_WAKE_CHAIN_MAX = 3` consecutive wakes without a user prompt ⇒ hold + one notice; the line rides the next real prompt. The declined hint still says not to repeat. |
| **Wake when not idle** (foreign turn, queued rows, compaction, user prompt sent during the hop) | `hopReady` false ⇒ hold; the line is consumed by the next real prompt. Never two copies (`takeLine` consumes once). |
| **Wake after quit / during `/clear`** | `exitPendingRef` path wakes nothing (`useTurnDriver.ts:672-676`); a `/clear` drops the session view ⇒ the pending fact is cleared with it (`takeLine` on the new session would carry a stale place — the executor clears `pending` on swap-by-clear; test). |
| **Wake prompt fails to send** (link down) | Same as any prompt: an error row; the line was consumed into that failed prompt's text — the executor must restore it on a send failure, as `restoreChips` does for images (test). |

### Tests

Each red-first on today's code; **mutation** named where it proves non-vacuity.

**Slice 1:**
- `cli/test/engine-select.test.ts` — env `TENTACLE_POD_NAMESPACE=ns1` with `{}`
  ⇒ `ns1` (**red**: hop path ignores env). Precedence table explicit > env >
  server⇒`default` > context > `default`, and `source` per row. **Mutation:**
  drop the env step ⇒ fails.
- `tui/test/hop-command.test.ts` — `kubernetes:p` ⇒ pod p, no ns;
  `kubernetes:n/p` ⇒ ns n, pod p (**red**: today pod/container);
  `kubernetes:n/p/c` ⇒ all three (**red**: refused today); 4 segments, `Bad_NS`,
  64-char ns, `docker:n/p` ⇒ usage lines; `workloadText` round-trips.
- `tools/test/move-session.test.ts` — `namespace` accepted for k8s only;
  description ≤ 600 chars and contains `kubectl`, `namespace`, `auto-accept`,
  `end of`/`ends`, `reset`, NOT `turned off` (**red**: today 1 100+ chars and says
  "turned off"). **Mutation:** append the old paragraph ⇒ fails.
- `cli/test/hop-proposal.test.ts` — `hopSpecOf` carries ns; detail shows
  `kubernetes:openshift-etcd/etcd-0/etcdctl` and the provenance.
- `cli/test/hop-feed-turn.test.ts` — **pin property:** `pinNamespace` returns
  `ns-A` at turn end ⇒ request detail AND approved spec have `ns-A`; resolver
  then says `ns-B` ⇒ built spec still `ns-A`. Throwing resolver ⇒ no broker
  request.
- `cli/test/session-hop-targets.test.ts` — attach calls `host("kubernetes",
  { namespace: "ns-A" })`; a `WorkloadNotFoundError` ⇒ `kubernetes:<ns>/<pod>`
  advice, never `--namespace`.

**Slice 2:**
- `cli/test/hop-live-line.test.ts` (fake clock/timers): leading emit; ≤ 1 per
  100 ms; trailing last text; duplicates dropped; after `finish()` nothing and
  no timer.
- `cli/test/session-hop-targets.test.ts` — an injecting attach ⇒ zero `notify`
  on a clean attach while `statuses` saw `attaching…`, `injecting…▓`,
  `verifying…` (**red**: ≥ 13 notices). **Mutation:** `liveLine: undefined` ⇒
  fails.
- `cli/test/engine-runtime.test.ts` — with `liveLine`, `log`/`info` empty on
  success; `finish()` on success and on 404. Without it and `tty:false`, piped
  lines unchanged.

**Slice 3:**
- `tui/test/permission-*.test.ts` — `autoApproves({kind:"session_hop"})` false
  (existing H4-M8 row); with `hopAuto: true` true (**red**); foreign ⇒ false;
  `hooks_trust` unchanged.
- `cli/test/hop-turn.test.ts` — `hopAutoAcceptable` table: local→attach ✓,
  local→container ✓, workload→attach ✓, workload→container ✓ (OD4),
  workload→local ✗. **Mutation:** return `true` always ⇒ the workload→local row
  fails. `hopWakeLine` renders the three facts, sanitizes a bidi/control byte in
  place and cwd, and states `auto-accept on|off` from `ctx`.
- `tui/test/hop-wake.test.ts` — `hopWakeStep` table: proposal×{moved, failed,
  declined} ⇒ wake; queued×{moved, failed} ⇒ wake; idle×any ⇒ hold; chain 3 ⇒
  hold. **Mutation:** wake on `idle` ⇒ fails.
- `cli/test/hop-feed-turn.test.ts` — broker whose requester applies the real
  `autoApproves` with auto ON: a local-origin attach proposal ⇒ approved, no
  dialog, `autoAccepted`; a workload-origin `local` proposal ⇒ reaches the
  dialog (`SpyBroker` sees it). A failed proposed run ⇒ `takeLine` yields
  `[move failed: …]` (**red**: today null).
- `client/test/permission-router.test.ts` — `send` has only
  `optionId`/`message` (`auto` never on the wire); `toPermissionRequest` never
  yields `kind`/`hopAuto`.
- `tui/test/session-hop.test.tsx` (ink-testing-library):
  - auto-accept ON before a hop stays ON after it, status bar and notice agree
    (the existing D9 row flips on purpose, shown red first);
  - after an approved proposal moves, the session's `send` is called ONCE with
    text starting `[session moved to kubernetes:` and ending `Continue the task
    from here.`, with no user typing and no user bubble (**red**: no send today);
  - an idle typed `/move` ⇒ no send; the line rides the next typed prompt;
  - declined proposal ⇒ one wake send starting `[move declined]`;
  - a wake whose send fails ⇒ the line is carried by the next prompt.

Gate before done: the narrow files per slice, then `bun run check`. Then a live
re-test by the owner on OpenShift: `move_session` without ns lands in the
context's namespace and the trace says why; `kubernetes:openshift-etcd/etcd-…/etcdctl`
works; one live line; one summary; auto-accept ON ⇒ no prompt and it stays ON;
the model continues by itself after the move.

### Notes / debt

- **Host in the wake line** (OD6 example) is omitted: the laptop has no source
  for the daemon's hostname without a protocol field. If wanted, a follow-up
  adds it to `session/open`'s result (a `protocol.d/` note) — not worth a
  breaking change in this task.
- **OD4 residual risk**: with auto-accept ON a pod-originated `container`
  proposal (pod-chosen image, laptop engine, folder mounted read-write) and a
  mount-gate warning are answered without a human. Owner's explicit decision;
  logged `(auto-accepted)`; revisit if the threat model tightens.
- **Breaking grammar** (`kubernetes:a/b` = ns/pod) is user-visible: the
  `changed` fragment states it.

## Execution

*— claude-sonnet-4-5 (executor), 2026-11-15*

### Load-bearing check (re-run first, as the brief requires): PASSED

Every citation in Implementation → *Load-bearing assumption* was re-read on this
branch and holds:

- the ONE broker at `main.ts:2072` (`new PermissionBroker(undefined, {holdUntilSet: true})`)
  is the same instance handed to the worker runtime, to every hop-built runtime
  (`shared: { permissions, saver }`, `hopBuilder`, `createHopRuntime`), to the hop
  feed (`permissions`, `createHopFeed`) and to `startTui`;
- the TUI's requester is installed at `permission-ui.ts:425` (`permissions.setRequester`),
  and the auto-accept decision is the branch at `:435` reading `autoApproveRef`;
- `toPermissionRequest` (`permission-router.ts:76-86`) rebuilds a request from a
  fixed allowlist (`tool`, `level`, `title`, `explanation`, `suggestion`,
  `reply`) — no `kind`, no `hopAuto`, so a daemon cannot forge either;
- an answer's `send` (`permission-router.ts:180-186`) carries only `optionId`
  and `message` — `auto` cannot travel back;
- the only producers of `kind: "session_hop"` in the tree are the laptop's own
  `hopPromptRequest` (`hop-turn.ts:61`) and `mountAsk` (`hop-targets.ts:520`);
- a proposal is raised through the single broker from `hop-feed.ts` →
  `hopAskAtTurnEnd` → `ask(hopPromptRequest(…))`.

Repros 1 and 2 (Context) were also re-run unmodified in
`.tentacle/tmp/session-hop-ux/{ns,progress}`, on this branch: the namespace table
prints exactly as recorded (`(a) openshift-etcd … (c) default`), and the injection
still produces **13** piped log lines / 130 `onStatus` calls. Both defects were
real before this task.

### As built, in dependency order

**Slice 1 — namespace, grammar, labels, tool description.** `contextNamespace`
extracted in `k8s/src/kubeconfig.ts` (used by `resolveContext`), `kubeNamespace`
(+`KubeNamespace` provenance) added in `cli/src/engine-select.ts` and used by
`buildEngineHost`; `main.ts`'s `engineHost` dropped its own env step, `hopEngineHost`
gained `(engine, where?)`, and a `pinNamespace` dep was wired into `createHopFeed`.
Grammar: `HopWorkload.namespace?`, `hopWorkload(engine, name, container?, namespace?)`
with the `namespace`/`namespaceChars` problems, `parseWorkload`'s 1/2/3 rule, and
ONE `workloadText` label in `tui/src/hop-command.ts` (exported from `index.ts`)
replacing the four copies in `hop-plan.ts`, `hop-feed.ts`, `hop-targets.ts`,
`hop-status.ts`, `hop-proposal.ts`. `hopProposalSchema`/`moveSessionSchema` take the
structured `namespace`; `hopPromptDetail` prints `ns/pod[/c]` + `namespaceTrace`;
`attachMissNotice` replaces a k8s 404's `--namespace` advice with the hop grammar.
Tool description rewritten (538 chars) with the schema's field descriptions
carrying the detail that no longer fits; `MOVE_SESSION_PROPOSED` reworded; module
comment updated. `HopBuilt.folder` and `HopPlaceView.namespace` were added here
where the type forced them (they are slice-3 facts, added early — see drift).

**Slice 2 — one live line.** `liveLine?: HopLiveLine` on `EngineRuntimeDeps` and
`EngineAttachRuntimeDeps`; `statusLineFor` returns it before the TTY test. New
`cli/src/hop-live-line.ts` (`createHopLiveLine`: leading emit, ≤1/100 ms, trailing
last-text-wins, duplicates dropped, `finish()` latches). `hop-targets.ts` deleted
`HOP_TERM` and passes `liveLine: hopLiveLine(deps)` to both builds.

**Slice 3 — auto-accept, its survival, and the wake-up.**
`PermissionRequest.hopAuto?` / `PermissionResponse.auto?` (core);
`autoApproves` reads `hopAuto`, and the auto branch answers `auto: true`;
`hopAutoAcceptable` + `opts.auto` on `hopPromptRequest` + `autoAccepted` on the
outcome (cli); `hop-feed` passes `deps.place()` as the origin and forwards
`autoAccepted`; `hopMovedNotice` gained the `(auto-accepted)` marker and states the
mode instead of "off"; `useHop` no longer clears auto-accept. OD6: `HopBuilt.folder`,
`HopWakeFact`/`hopeWakeLine` (replacing `moveGuideLine`), `hop-feed`'s typed
`pending` + `takeLine({autoAccept})` + `clearPending`, new `tui/src/hop-wake.ts`
(`hopWakeStep`, `HOP_WAKE_TEXT`, `HOP_WAKE_ROW`, `HOP_WAKE_CHAIN_MAX`,
`HOP_WAKE_PAUSED_NOTICE`), `HopProposalView.failed`, `startHopState` in
`state.ts`, and the plumbing: `startHop` → `hopWakeStep` → `sendWake`
(`run(HOP_WAKE_TEXT, { hopWake: true })`), the origin ref set by the three entry
points, `noteUserPrompt` on a typed prompt, `/clear` → `clearPending`.

### Drift from Implementation (and why)

1. **`HopBuilt.folder`/`HopPlaceView.namespace` landed in slice 1**, not slice 3:
   the do-notation of `builtOf`/`HopPlace` made every existing test fixture fail
   the typecheck otherwise, and splitting the type change from its call sites would
   have meant two type-breaking edits. Behaviour is still slice 3's.
2. **`takeLine` took a context in slice 3, and the two rules it needed
   (`HOP_WAKE_PAUSED_NOTICE`, the `failed` view) were added there too** — the plan
   put `hopWakeStep` and the fact plumbing in one slice, so they could not be
   separated without a second breaking pass over `app-types.ts`.
3. **`hopWakeStep` holds on `queued + declined`** (the plan said "queued moved/failed
   ⇒ wake", silent on declined): a user's own refusal of a mid-task `/move` is
   theirs to answer, and waking would resume a task they just stopped. Documented
   in the module.
4. **`run`'s `permission` is in its dep array** rather than a `permissionRef`:
   `app-turn-driver-structure.test.ts` pins that the hook creates no refs of its own
   (the S8/M10 rule), and `permission` is a live render object, so the rebuilt
   closure reads the current mode.
5. **The pin-failure line IS raised** (failure mode 1): `pinAtTurnEnd` returns
   `{ok:false, line}`, `hop-feed` puts it in `pending` and returns
   `{kind:"failed"}`, and the App's `wake` fires — so the model reads
   `[move failed: <reason>]`. `main.ts`'s `pinNamespace` passes the REASON only
   (no brackets): `hopWakeLine` wraps it, which avoids `[move failed: [move
   failed: …]]` (found by the test).
6. **`PermissionResponse.auto` is set for a `session_hop` answer only**, not for
   every auto-approved tool: three pre-existing tests (`foreign-turns`,
   `auto-accept-feed`, `autoaccept-wake`) compare an auto-approved answer whole,
   and widening every tool's shape was not the plan's intent (OD4 is about moves).
7. **`docs/feat/session-hop.md` D9 got two dated amendments** (the paragraph and
   the failure-mode row) as the plan asked.

### Tests (red-first, per slice)

See the per-slice DONE/PARTIAL report in the review note below. Every failure-mode
row named in Tests has a test; the mutations named in the plan were run and
**reverted** (results pasted in the Review section's mutation log).

### Gate

`bunx tsc --noEmit` clean · `bun run lint` clean (0 errors, 0 warnings — the §6
baseline) · `bun test` full suite: results in Review. No schema changed, so
`packages/protocol/schema/protocol.json` needed no regeneration (no
`@tentacle/protocol` file is touched: `hopAuto`/`auto` are process-internal and
`move_session`'s schema is not in the protocol).

### Unverified

- **The live OpenShift re-test** (the plan's final gate): needs the owner's
  cluster. Everything it asks for is covered by a fake-host test (namespace
  default + trace, `kubernetes:<ns>/<pod>/<c>`, one live line, one summary,
  auto-accept ON ⇒ no prompt and stays ON, the model continues by itself), but
  none of it has run against a real API server.
- **A real pod's cwd in the wake line**: `HopTargetView.cwd` is the daemon's own
  report and is exercised only through the fake; whether a pod reports `/` or its
  real working dir is the daemon's behaviour, unchanged by this task.

## Review

### Mutation log (each run, then reverted — the tests are green again)

| Target (plan's Tests section) | Mutation applied | Result |
|---|---|---|
| `kubeNamespace` (slice 1) | dropped the `TENTACLE_POD_NAMESPACE` step | the `env` row resolved to the context's ns ⇒ FAIL |
| attach host `where` | `deps.host(workload.engine)` (no `where`) | both "dials the namespace it was TOLD" rows ⇒ FAIL |
| k8s 404 wording | restored `errorText(…)` (the engine's `--namespace` advice) | "says the hop's own fix" ⇒ FAIL (`--namespace` present) |
| hop live line, throttle | emit every call / no leading edge | 4 of 7 `hop-live-line` rows ⇒ FAIL |
| hop live line, latch | drop `closed` in `set` | "finish() latches" ⇒ FAIL |
| `statusLineFor` | ignored `liveLine` (the old `logTerm: tty:false`) | the engine `liveLine` row AND the hop's zero-notice row ⇒ FAIL |
| hop target `liveLine` | `logTerm: {tty:false}` instead | "an injecting attach: zero notices" ⇒ FAIL |
| `autoApproves` | `return true` unconditionally | `turn-feed`'s `hopAuto` row ⇒ FAIL |
| `hopAutoAcceptable` | `return true` always | the workload→local row ⇒ FAIL |
| `hopAuto` on the request | passed no origin (`hop-feed`) | `hop-feed-turn`'s OD4 row ⇒ FAIL |
| `hopWakeStep` | wake on `idle` | `hop-wake.test`'s idle row, the TUI's OD5 notice row AND the TUI's OD6 idl-typed row ⇒ FAIL (3 layers) |
| wake chain cap | dropped the `chain >= MAX` test | "the chain cap" ⇒ FAIL |
| proposal origin | dropped `hopOriginRef.current = "proposal"` in App's port | "OD6: after a PROPOSED move the session continues" ⇒ FAIL |
| pin failure line | returned `{kind:"none"}` on a failed pin | "a pin that FAILS … TELLS the model" ⇒ FAIL |
| `hopWakeLine` sanitizing | (asserted directly, not mutated) | bidi/control bytes and newlines are stripped |
| pin BEFORE the ask | (asserted by order: `pinNamespace` called once, before `asked[0]`) | the request and the approved spec both carry `ns-A` |

---

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

8. **`move_session` is DISABLED by default** (owner 2026-11-15 00:30; reverses session-hop Q6 "default on"): the tool is not offered to the model unless the config enables it — `sessionHop.tool: true` (keep the existing key, flip the default; document it in the config reference and `tentacle config list`). `/move` typed by the user is unaffected. Tests: default config → tool absent from the model's tool list; `sessionHop.tool: true` → present.
*— claude-opus-5-5 (orchestrator), 2026-11-15*
