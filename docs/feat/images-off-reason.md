# feat/images-off-reason — say WHY images are off, not "the daemon is old"

> **Status:** done
> **Branch:** `feat/images-off-reason`
> **Type:** fix · **Size:** S · **Blast:** contained · **Suited:** DeepSeek (executor) + standard in-context review
> **Changelog:** `changelog.d/images-off-reason.fixed.md` (user-visible wording)

## Context

*— deepseek-v4, 2026-11-13*

Live report (owner, 2026-11-13): in a plain `tentacle` session on a local
OpenAI-compatible model with `model.images` unset, pasting an image path says

```
images are off: this daemon does not take images (its model has no vision, or it predates images — update it)
```

That one sentence merges **two unrelated causes** and always advises an update —
even when the daemon is the *same build* the client just handshook with and the
only fact is `model.images` being unset (`packages/config/src/key-docs.ts:294`
"Unset: the provider default (anthropic true, an OpenAI-compatible endpoint
false)"). The user is told to update software that is already current, and is
never told the one key that would fix it.

The client *does* know which cause applies:

- the daemon advertises `agentCapabilities.images` only when its model takes
  images (`packages/daemon/src/connection.ts:518-536`, fed by
  `daemonImagePolicy`/`imageLimits`), so **absent capability from a daemon of
  our own protocol = its model's config is off**;
- a daemon too old for images either cannot get past `initialize`
  (`connection.ts:496-499`, protocol equality) or answers `MethodNotFound` to
  `attachment/put` (`packages/client/src/remote-client.ts:1625-1627`), which is
  the only genuine "update the daemon" case.

**Repro** (`.tentacle/tmp/images-off-reason/repro.ts`, run 2026-11-13 from
`.tentacle/tmp/images-off-reason/`; a fake daemon answering `initialize` exactly
like the local worker does — same protocol, capabilities without `images`):

```ts
import { PermissionBroker } from "@tentacle/core";
import { RemoteClient } from "@tentacle/client";
import { Method, PROTOCOL_VERSION } from "@tentacle/protocol";
import { createChannelPair, RpcPeer } from "@tentacle/transport";
import { routeDecision } from "../../../packages/tui/src/attach-draft.ts";

const [a, b] = createChannelPair();
new RpcPeer(b, {
  onRequest: async (method) => {
    if (method === Method.Initialize) {
      return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { tools: true, permissions: true } };
    }
    return {};
  },
});
const client = new RemoteClient(a, new PermissionBroker());
const init = await client.initialize();
console.log("handshake: protocol", init.protocolVersion, "| caps", JSON.stringify(init.agentCapabilities));
const mode = client.imageInput();
console.log("imageInput:", JSON.stringify(mode));
if (mode.kind === "off") {
  const routed = routeDecision({ chips: [], upload: null }, { kind: "attachments", images: [], refusals: [] }, mode);
  console.log("notice shown:", routed.notices[0]);
}
client.close();
```

Observed (before):

```
handshake: protocol 24 | caps {"tools":true,"permissions":true}
imageInput: {"kind":"off","reason":"this daemon does not take images (its model has no vision, or it predates images — update it)"}
notice shown: _images are off: this daemon does not take images (its model has no vision, or it predates images — update it)_
```

The handshake says protocol **24** — the daemon is current. The advice is wrong.

Decision this task serves: an off image must tell the user the *actual* cause in
one line — (a) the model's config has images off: name the model and the key,
with the command that sets it; (b) the daemon really predates images: say
update the daemon. No merged sentence, no wrong advice.

## Implementation

*— deepseek-v4, 2026-11-13*

### Load-bearing assumption

**A daemon whose handshake succeeded cannot be one that predates images.** The
client sends its own `PROTOCOL_VERSION` and the daemon refuses any other with
`VersionMismatch` (`packages/daemon/src/connection.ts:496-513`); images entered
the protocol at 23 (`packages/protocol/src/version.ts:23-26`) and the constant
is 24 today (`:32`). So an absent `agentCapabilities.images` *after* a
successful handshake is a statement about the daemon's **model config**, not
about its build — which is exactly what the current sentence gets wrong (the
repro above: protocol 24, and it still says "update it").

Consequence for the discriminator: the honest facts the client holds are the
daemon's reported `protocolVersion` (`InitializeResultSchema`, keeps its value
on every handshake) and the error shape of a failed `attachment/put`. An absent
capability from a daemon at or past `IMAGES_PROTOCOL_VERSION` → cause (a); a
daemon reporting an *older* protocol, or `MethodNotFound` from
`attachment/put` → cause (b). Unknown protocol (no handshake yet) is treated as
**not old**: claiming "update the daemon" without evidence is the very bug.

### Preconditions

- `initialize` advertises `images` only when the daemon's model takes images —
  `connection.ts:518-536` spreads it from `this.host.images`, which is
  `daemonImagePolicy(config)` (`packages/cli/src/image-policy.ts:33-46`, absent
  when `imageLimits().vision` is false).
- `imageInput()` is called after a successful handshake on every runtime that
  reaches a TUI (`local-runtime.ts:858` `await client.initialize()`; `connect.ts:198`).
- The daemon reports its own model name for display only: `agentInfo.model`
  (`packages/protocol/src/session.ts:251-274`), set by `serve`
  (`packages/cli/src/serve.ts:305`) and absent from a worker/pod daemon (whose
  model is the laptop's, over the tunnel).
- The off `reason` is rendered by the TUI as `_images are off: <reason>_`
  (`packages/tui/src/attach-draft.ts:97`), so the reason must NOT repeat the
  verdict — and `attachImage` throws it as an error whose message the TUI shows
  verbatim (`attach-draft.ts:376-379`), so it must also read as a full sentence.
- AGENTS §7: the decision is pure — `packages/client/src/image-input.ts` already
  is the one pure table this feature turns on; no component gains logic.

### Design

Keep the decision where it is (`image-input.ts`, pure) and give it the two facts
it was missing. Signature grows additively:

```ts
export interface DaemonImageFacts {
  /** `initialize.protocolVersion` of the daemon we talk to; absent = unknown. */
  readonly protocol?: number;
  /** The model that runs the turns: `agentInfo.model`, else the laptop's own. */
  readonly model?: string;
}
export function imageInput(capability, local, daemon: DaemonImageFacts = {}): ImageInput
```

- `IMAGES_PROTOCOL_VERSION = 23` (the version that introduced the capability).
- `capability === undefined` and `daemon.protocol` unknown or `>= 23` → **cause
  (a)**, `imagesOffReason(...)`: `<model> is configured without images — set
  model.images true in your config if this model takes images (tentacle config set
  model.images true)`, the model named from `daemon.model` (or "this model"
  when nothing reports a name).
- `capability === undefined` and `daemon.protocol < 23` → **cause (b)**,
  `OLD_DAEMON_IMAGES`: `this daemon predates images — update it`.
- The `client`-mode branch where the LAPTOP's vision is off becomes the same
  cause (a), naming the laptop's model.
- `ATTACHMENTS_OLD_DAEMON` (the `attachment/put` `MethodNotFound` case) becomes
  `OLD_DAEMON_IMAGES` — one constant, one truth for "update the daemon".
- `RemoteClient` keeps the last handshake's `protocolVersion` and
  `agentInfo.model` beside `capabilities` (re-read on every reconnect, like
  `capabilities`), and passes `{ protocol, model }`; the model falls back to a
  new display-only option `modelName` (the laptop's `config.model`, passed by
  `createLocalRuntime`), because a worker/pod daemon reports no model — the
  owner's own case. A model name is display text: clamped and control-character
  free before it can reach a terminal.

Note the wording does not repeat the verdict: the TUI already prefixes
`images are off: `, and the thrown `ImagesUnavailableError` message reads as a
complete sentence on its own.

### Files

1. `packages/client/src/image-input.ts` — `IMAGES_PROTOCOL_VERSION`,
   `OLD_DAEMON_IMAGES`, `imagesOffReason`, `DaemonImageFacts`, the new table.
2. `packages/client/src/remote-client.ts` — keep `protocol`/`model` from the
   handshake, the `modelName` option, pass the facts; `ATTACHMENTS_OLD_DAEMON`
   re-exported from the pure module.
3. `packages/cli/src/local-runtime.ts` — pass `modelName: deps.model`.
4. `packages/client/test/image-input.test.ts` — both causes, plus the wording.
5. `changelog.d/images-off-reason.fixed.md`.

No daemon, protocol, or on-disk change; no `PROTOCOL_VERSION` bump (the
capability field already exists and only its *interpretation* by the client
changes).

### Failure modes

- **Daemon reports an older protocol** (today impossible past `initialize`, a
  durable branch): cause (b), update advice — the honest answer.
- **No handshake yet** (`capabilities` undefined): cause (a) is claimed only
  when a protocol is unknown → treated as current. Never "update the daemon"
  without evidence (the reported bug).
- **Model name absent** (`worker`/pod daemon, `connect` to a daemon reporting
  nothing): the message still names `model.images` and the command, and says
  "this daemon's model" instead of inventing a name.
- **Model name hostile** (a pod-supplied `agentInfo.model`): stripped of control
  characters and clamped before it enters a rendered line (AGENTS §7, a pod is
  not trusted).
- **Client mode with the laptop's vision off**: same cause (a), name = the
  laptop's model; unchanged verdict, no wrong "update" advice.
- **`attachment/put` `MethodNotFound`** (a same-protocol daemon without the
  method — a replaced binary): cause (b) via the shared constant.
- Compaction/upload paths untouched: only the *off* reasons change.

### Tests

- `packages/client/test/image-input.test.ts`
  - T1 (a): no capability, protocol 24 (= current) → off, reason names the model
    *and* `model.images` and the `config set` command; must NOT contain
    "predates"/"update".
  - T2 (b): no capability, protocol 22 (before images) → off, reason says
    predates/update; must NOT advise setting `model.images`.
  - T3 unknown protocol, no capability → cause (a), never the update advice.
  - T4 no model name → still names `model.images`, no invented name.
  - T5 a hostile/long model name → sanitized, no control characters, bounded.
  - T6 `OLD_DAEMON_IMAGES` is the single constant both surfaces use (the
    `attachment/put` path keeps its instance/behaviour).
- **Red before green** (§9): all of T1–T5 fail on the current code. **Mutation**
  (§9): flip the discriminator (`protocol < IMAGES_PROTOCOL_VERSION` → `true`)
  and confirm T1 goes red.

## Execution

*— DeepSeek-V4-Pro (deepseek-v4-pro), 2026-11-13*

**As built, in order.**

1. Repro first (AGENTS §1): `.tentacle/tmp/images-off-reason/repro.ts` showed
   `protocol 24` (a CURRENT daemon) plus the merged sentence — the evidence the
   Context section quotes.
2. Tests first (red): `packages/client/test/image-input.test.ts` gained the
   `no capability: WHY` block (T1–T6). First red run: `SyntaxError: Export named
   'ATTACHMENTS_OLD_DAEMON' not found in module image-input.ts` — the symbols did
   not exist yet.
3. `packages/client/src/image-input.ts` (pure): added `IMAGES_PROTOCOL_VERSION`
   (23), `OLD_DAEMON_IMAGES`, `imagesOffReason(model)`,
   `MAX_REASON_MODEL_CHARS`/`MAX_REASON_CHARS`, `DaemonImageFacts`, and the third
   (optional) parameter of `imageInput`. The absent-capability branch decides:
   protocol unknown or `>= 23` → cause (a) naming the model; protocol `< 23` →
   cause (b). The `client`-mode laptop-vision-off branch moved to the same
   cause-(a) wording (same cause, the laptop's side).
4. `packages/client/src/remote-client.ts`: `handshake` also keeps the last
   `protocolVersion` and `agentInfo.model` (re-read every reconnect, like
   `capabilities`) in `daemonImages`; `imageInput()` passes `{protocol, model}`
   with the model falling back to the new display-only option `modelName`;
   `ATTACHMENTS_OLD_DAEMON = OLD_DAEMON_IMAGES` so "update the daemon" has one
   source; a local `nameOfModel` guard keeps a non-string off the reason.
5. `packages/cli/src/local-runtime.ts`: passes `modelName: deps.model`.
6. `changelog.d/images-off-reason.fixed.md`.

**Drift from Implementation.** Two, both recorded rather than hidden:

- **Final wording** is `<model> is configured without images — set model.images
  true in your config if this model takes images (tentacle config set model.images
  true)`. The Implementation draft said `<model> takes no images per its config:`;
  that repeated the verdict the caller already prints (`_images are off: …`,
  `attach-draft.ts:97`) and read awkwardly with a model name in front. The final
  shape is the one the owner asked for.
- **Cause (b) is unreachable over today's wire.** Protocol equality at
  `initialize` (`connection.ts:496-499`) refuses a daemon older than images before
  `imageInput()` can run, so the `< 23` branch is defensive only; the real
  user-facing "update the daemon" surface is `attachment/put` → `MethodNotFound`,
  which now shares the constant (T6). Kept because it is the honest answer if a
  future client ever tolerates an older protocol, and it is what T2 pins.

**Not touched:** `packages/tui/src/App.tsx` — the notice is built in the pure
`attach-draft.ts` from the client's reason, and that module needed no change at
all; only the client's `reason` string changed. No daemon/protocol/on-disk change,
no `PROTOCOL_VERSION` bump (the capability already exists; only the client's
interpretation of its absence changed).

**Mutation (§9).** Flipped the discriminator to `if (true)` in `image-input.ts`
(every absent capability taken as an old daemon): T1, T3, T4, T5 went **red**
(11 pass / 4 fail) — the tests prove the branch, not a correlate. Reverted: 15
pass / 0 fail, and `git status` showed no stray backup file.

**End-to-end re-run of the repro** after the change (worktree sources):

```
imageInput: {"kind":"off","reason":"qwen3-27b is configured without images — set model.images true in your config if this model takes images (tentacle config set model.images true)"}
notice shown: _images are off: qwen3-27b is configured without images — set model.images true in your config if this model takes images (tentacle config set model.images true)_
```

**Gate.**

| Check | Result |
| --- | --- |
| `bunx tsc --noEmit` | clean (exit 0) |
| `bun run lint` | clean: `Checked 1064 files … No fixes applied`, 0 errors / 0 warnings (= baseline) |
| `bun test` | **8282 pass, 3 skip, 0 fail** (595 files, 382 s) — the 3 skips are the documented opt-in ones (live k8s, live docker, real-socket keepalive) |
| `packages/client` alone | 646 pass / 0 fail |
| `packages/tui` alone | 1792 pass / 0 fail |

## Review

*— DeepSeek-V4-Pro (deepseek-v4-pro), 2026-11-13 — adversarial pass*

**Gate re-run after the review edits** (the review found two real defects and
changed code, so the gate was re-run, not carried over):

| Check | Result |
| --- | --- |
| `bunx tsc --noEmit` | clean (exit 0) |
| `bun run lint` | clean: `Checked 1064 files … No fixes applied`, 0 errors / 0 warnings (= baseline) |
| `bun test` | **8283 pass, 3 skip, 0 fail** (595 files, 359 s) — 3 documented opt-in skips |

**What holds.**

- *The property the task needed, exactly.* T1 pins the reported case: absent
  capability + a current protocol ⇒ a reason naming the model, `model.images`
  and the command, and **no** "predates"/"update". T2 pins the opposite cause.
  Non-vacuity by mutation: `if (true)` (treat every absent capability as old)
  turned T1/T3/T4/T5 **red** (11 pass / 4 fail), reverted to 16/0.
- *No component gained logic.* `App.tsx` untouched; `attach-draft.ts` untouched
  (it already renders `_images are off: <reason>_` and needed nothing).
- *A pod's name is not trusted.* `agentInfo.model` is stripped of control
  characters, trimmed and bounded in the pure module, and T5 proves it with an
  escape/`BEL`/newline name; `protocolVersion` is type-checked before being kept,
  so a hostile daemon cannot make the "old protocol" branch fire with a string.
- *One source for the update advice.* `ATTACHMENTS_OLD_DAEMON === OLD_DAEMON_IMAGES`
  (T6), so the `attachment/put` refusal and the capability reason cannot drift.

**Two defects the review found and fixed (both would have shipped).**

1. **`MAX_REASON_CHARS` was asserted but not enforced.** The first cut bounded
   the *model name* (80 chars) and claimed the sentence was bounded, so a
   60-char name could push the reason past 220 — T5 passed only by accident of
   the fixture. Fixed: `imagesOffReason` computes the room the sentence leaves
   and shortens the name to fit; T5 and a new T5b assert the sentence bound with
   a 400-char plain name. Mutation: `room = 1000` → T5 **and** T5b red.
2. **`result.protocolVersion` was trusted as a number.** The wire schema says
   `int`, but this module explicitly does not trust a daemon (AGENTS §7) and a
   string protocol would have compared as `"22" < 23` → false, silently taking
   the *config* branch. Now kept only when it is a number.

**What does not hold (stated, not hidden).**

- **Cause (b) is unreachable today.** Protocol equality at `initialize` refuses
  an older daemon, so the `< 23` branch is defensive; its user-facing reality is
  the `attachment/put` `MethodNotFound` refusal, which shares the constant. T2
  pins the branch as a unit, not as a live path — a reader should not mistake it
  for one.
- **A worker/pod daemon reports no model**, so the reason names the laptop's
  `config.model` (`modelName`), which for a `--model-proxy` pod is *the* model in
  play — correct — but for a pod whose daemon runs its own model it could name
  the wrong one. That is the pre-existing `agentInfo` gap (a pod daemon passes no
  `modelInfo`), not this change; the message still names the right KEY, so the
  advice remains actionable.
- **`connect` does not pass `modelName`**, so a `serve` daemon that reports no
  model gets "this model" instead of a name. Acceptable (that daemon does report
  one, `serve.ts:305`), and no branch was added for it.
- **The daemon's own `AttachmentRefused` text still merges the causes**
  (`hosted-session.ts:1942`). Deliberately left: that refusal is only reached by
  a client that ignored the advertised capability, and no TUI shows its message
  — `attach-draft.ts:366-368` renders a fixed line for `data.reason ===
  "images_off"`, matching on the structured reason, never the text. Changing it
  would widen the blast radius past `contained` for text nothing displays.

**How the implementing model behaved.** It reproduced before reading code
(repro pasted in Context, protocol 24 = current, the wrong advice), wrote the
tests red first, and kept the change inside the existing pure module. It
self-corrected twice mid-task: the first notice draft repeated the verdict the
caller already prints, and the first bound claim was not enforced — both caught
and fixed here rather than reported as done. Drift is logged, the unreachable
branch is labelled as such, and nothing was silently dropped.

**Verdict:** holds. Contained blast, S size, standard in-context review per
AGENTS §10 — a fresh-context pass is not required for `contained`/`S`.

## Review

*— claude-opus-5-5, 2026-11-14 — fresh-context adversarial pass (different model family from the executor)*

**Verdict: REQUEST-CHANGES.**

**Gate (re-run here).** `bun test packages/client/test/image-input.test.ts`
16 pass / 0 fail; `bun test packages/client packages/cli/test/local-runtime.test.ts
packages/tui` 2518 pass / 0 fail; `bun run lint` clean (1064 files, = baseline);
`bun run typecheck` clean. Full suite not re-run (Execution reports 8283/3 skip/0).

**Findings.**

1. **MEDIUM — the fix recreates the bug class for a pod without `--model-proxy`.**
   `packages/cli/src/local-runtime.ts:853` passes `modelName: deps.model` (the
   LAPTOP's model) unconditionally, and `remote-client.ts:1678` falls back to it
   whenever the daemon reports no `agentInfo.model`. A pod daemon never reports
   one (`serve.ts:669` sets `identity` but no `modelInfo`), and without
   `--model-proxy` it runs its OWN model and decides `images` from its OWN config
   (`serve.ts:656-663`, `daemonImagePolicy` → `store`/absent). Scenario: laptop
   `model: claude-…`, pod config a text-only local model → the notice reads
   `claude-… is configured without images — … (tentacle config set model.images
   true)`: wrong model name, and the command, run on the laptop, changes nothing.
   That is again confident, wrong, actionable advice — the defect this task exists
   to remove. Executor's Review noted the wrong name and waved it off; the wrong
   *place* of the fix is the real harm. Fix: pass `modelName` only when the daemon
   runs the laptop's model (worker / `--model-proxy`), else say "the pod's model …
   in the pod's config". Same shape, milder, for `connect` (the command runs on the
   laptop, the key lives on the `serve` host) — at least say "the daemon's config".
2. **MEDIUM — the `RemoteClient`/`local-runtime` wiring is untested (§9 vacuity).**
   Mutations, each run against client + cli `local-runtime` + tui suites:
   (a) `remote-client.ts:1678` `model = undefined` and (b) `:1689` protocol forced
   to `1` (every daemon "predates images" — the inverse bug) → **2518 pass / 0
   fail** both. Only the pure table is pinned; the handshake capture
   (`remote-client.ts:2321-2328`), the `modelName` fallback and its
   `createLocalRuntime` plumbing could regress silently. Needs a `RemoteClient`
   test over `createChannelPair` (the Context repro is exactly that test).

**Mutation (pure module).** Discriminator `protocol !== undefined &&` →
`=== undefined ||` → T3 red (15/1); reverted, 16/0, `git status` clean.

**Premises.** `connection.ts:499` equality check TRUE; `connection.ts:528-536`
capability absent iff `host.images` unset TRUE; `serve.ts:305` `modelInfo` TRUE;
"worker/pod daemon reports no model … whose model is the laptop's" — **FALSE for a
non-proxy pod** (finding 1). `tentacle config set model.images true` parses
(`config-args.ts:165-188`) TRUE.

**Attacks tried.** (1) Non-proxy pod path → finding 1. (2) Wiring mutation →
finding 2. (3) Hostile name: C0/C1 stripped, bounded ≤ 220 — holds (bidi/zero-width
chars pass through; nit, not blocking). (4) String `protocolVersion` → guarded by
`typeof`, holds. (5) Unknown protocol before handshake → never "update", holds (T3).

**Nits (not blocking).** `MAX_REASON_MODEL_CHARS` is exported but unused by
`imagesOffReason` (room is ~90); the comment promises an ellipsis that is never
added; `.slice` can split a surrogate pair.

**Executor behaviour.** Clean repro-first, red-first, logic kept in the pure
module; drift honestly logged. But its self-review was same-context and missed
that its own "pod reports no model ⇒ laptop's model" premise is false without
`--model-proxy`, and tested only the pure layer.

### Fix round 1

*— claude-sonnet-4-5 (Claude Sonnet 4.5), 2026-11-14 — executor, fix round 1*

Round-1 review (claude-opus-5-5) raised two MEDIUMs and three nits; all are
addressed. Nothing from the earlier rounds was reverted.

**Finding 1 (MEDIUM) — the advice pointed at the wrong machine. FIXED.**

Root cause: the *scope* of the advice was never modelled. `imageInput` took one
`model` fact, and `createLocalRuntime` fed it `modelName: deps.model`
unconditionally, with `remote-client.ts` falling back to it whenever the daemon
reported none. That premise — "a daemon reporting no model runs the laptop's" —
holds for the in-process worker and a `--model-proxy` pod, and is false for a
`serve` host's neighbour case and for a pod daemon started without
`--model-proxy`, which runs its OWN model from its OWN config
(`serve.ts:656-663`, `daemonImagePolicy` → `store`/absent). The user was then
told a model name that was not the one in play and a command that, run on the
laptop, changes nothing — the same defect class this task exists to remove.

The fix makes the fact explicit rather than inferred:

- `ImageModelScope = "laptop" | "daemon"` in `image-input.ts`.
  `imagesOffReason(model, scope)` has two tails: `… in your config …` (laptop)
  and `… in the daemon's config … (…, on the daemon's host)` (daemon). Default
  `daemon` — never name a machine the evidence does not point at.
- `DaemonImageFacts` now carries `daemonModel` (from `agentInfo.model`) and
  `laptopModel` (this laptop's `config.model`) SEPARATELY, instead of one
  merged `model`. Each side is named from its own fact, so a laptop name can no
  longer stand in for a daemon's.
- `RemoteClientOptions.modelScope`. `RemoteClient.imageInput` treats the scope
  as `laptop` only when the caller claimed it AND the daemon reported no model
  of its own — a daemon that reports a model is one that runs it (`serve` is the
  only host that passes `modelInfo`), so that fact outranks the claim.
- Call sites, each stating its scope: `startWorkerRuntime` → `laptop`;
  `startEngineRuntime`'s run and `attachEngineRuntime` → `laptop` (both exec
  `podDaemonCommand`, i.e. `serve --bridge --model-proxy`, so the pod runs this
  laptop's model); `connect` passes nothing (a `serve` host runs its own).

**Finding 2 (MEDIUM) — the wiring was unpinned. FIXED.**

The reviewer's mutations (drop the `protocolVersion` capture; force it to `1`;
drop `modelName`) left 2518 tests green: only the pure table was tested. Four
new test files/sites now pin the layer between the wire and the table, each
with its own named mutation:

- `packages/client/test/images-off-wiring.test.ts` (new, 7 tests) — real
  `RemoteClient` over `createChannelPair`, exactly the Context repro's link.
  W1 the daemon's own model is named and the key is the daemon's; W2 an old
  protocol yields `OLD_DAEMON_IMAGES` exactly; W3 the boundary (`protocol ===
  IMAGES_PROTOCOL_VERSION` is current, not old); W4 a daemon on its own model
  never names the laptop's; W4b a reported model outranks a caller's `laptop`
  claim; W5 a laptop-scoped daemon names our model and our config; W6 `client`
  mode with the laptop's vision off names our model.
- `packages/cli/test/images-off-runtime.test.ts` (new, 3 tests) — the
  `createLocalRuntime` plumbing: laptop scope, the default scope, and a
  daemon-reported name arriving through the runtime.
- `packages/cli/test/worker.test.ts` — one test over the REAL worker spawn:
  the reason says `your config`, not `the daemon's config`, and names
  `config.model`.
- `packages/cli/test/engine-runtime.test.ts` — the reviewer's exact scenario: a
  `--model-proxy` pod's reason is about THIS laptop's config.
- `packages/cli/test/connect.test.ts` — a `serve` host (which reports its own
  model, `serve.ts:305`) gets "serve-model … the daemon's config".

**Nits — FIXED.** `MAX_REASON_MODEL_CHARS` is now actually enforced (it caps
`imagesOffReason`'s room and is `safeModel`'s default); the promised ellipsis is
now added; and the cut walks code points, so an astral character is whole or
absent instead of a split surrogate (new T5c proves it through a UTF-8 round
trip).

**Drift from the Implementation/earlier Execution.** The wording changed for the
daemon side — the earlier single tail baked in "your config", which was the
finding-1 defect stated as text. `createLocalRuntime`'s `modelName` is still
`deps.model` (it is only ever this laptop's id) and the *scope* travels beside
it rather than the name being dropped. The `laptopModels` helper was briefly
given a `modelScope` field and that was reverted: it is about providers, and
`...rest` is spread straight into a `RemoteClient` in `models-pod.test.ts`, so a
scope there would have been an implicit claim. Both engine sites state it
explicitly instead.

**Mutations (all reverted; §9 non-vacuity).** Each ran against the named tests:

| Mutation | Result |
| --- | --- |
| `remote-client.ts` `onLaptop = daemonModel === undefined` (every daemon laptop-scoped) | W4 + default-scope runtime test **red**, 8 pass |
| `handshake` no longer keeps `protocolVersion` | W2 **red**, 6 pass |
| `{ protocol: 1 }` forced (every daemon "old") | W1/W3/W4/W4b/W5 **red**, 2 pass |
| `handshake` no longer keeps `agentInfo.model` | W1/W3/W4b + the runtime's daemon-model test **red**, 6 pass |
| worker's `modelScope: "laptop"` dropped | worker test **red** (`your config` missing) |
| both engine `modelScope: "laptop"` dropped | engine test **red** (`qwen3` missing) |
| `image-input.ts` `onLaptop = true` (the pre-round-1 wording, always "your config") | connect + W1/W3/W4/W4b + T1/T4/T5/T5c/T7 **red** (9 tests) |

**Raw evidence** (`.tentacle/tmp/images-off-reason/fix1.ts`, worktree sources,
the four cases end to end):

```
serve (own model):
   serve-model is configured without images — set model.images true in the daemon's config if that model takes images (tentacle config set model.images true, on the daemon's host)

pod without --model-proxy (no model reported):
   the daemon's model is configured without images — set model.images true in the daemon's config if that model takes images (tentacle config set model.images true, on the daemon's host)

worker / --model-proxy (scope laptop):
   qwen3-27b is configured without images — set model.images true in your config if this model takes images (tentacle config set model.images true)

old daemon (protocol 22):
   this daemon predates images — update it
```

The rendered TUI row (`routeDecision`, `fix2.ts`) stays one bounded line:
`_images are off: …_`, 201 / 194 / 162 chars for the three causes — under
`MAX_REASON_CHARS` (220) including the notice's own prefix.

**Still not proven.** The `serve` and non-proxy-pod cases are pinned at the
`RemoteClient`/`connect` boundary, not by a live daemon on another host (that
needs a second machine). `connect` does not load a config at all, so its
`modelName` is absent by construction rather than by a test of its absence.

**Gate.**

| Check | Result |
| --- | --- |
| `bunx tsc --noEmit` | clean (exit 0) |
| `bun run lint` | clean: `Checked 1066 files … No fixes applied`, 0 errors / 0 warnings (= baseline) |
| `bun test` | **8299 pass, 3 skip, 0 fail** (8302 tests, 597 files, 357 s) — the 3 documented opt-in skips |
| `packages/client` + `packages/cli` + `packages/tui` | 4550 pass / 0 fail |

One earlier full run of the same tree reported **1 fail** —
`daemon/test/serve-log-store.test.ts` "S11 — a real SIGKILL at random points"
(`expect(loads).toBeGreaterThan(ITERATIONS / 2)` saw `0`). It is a load-timing
flake, not this change: `packages/daemon` is untouched by the diff, the file
passes alone (22/0 in 14.7 s), and the re-run above is clean. Reported rather
than hidden; the repo already tracks this class (TODO.md "Timing flake, not
investigated").

### Round 2

*— claude-opus-5-5, 2026-11-14 — fresh-context re-review of `git diff HEAD~1` (896c7d5)*

**Verdict: PASS** (APPROVE-WITH-NITS).

**Finding 1 (wrong machine named) — resolved.** `modelScope` defaults to
`daemon` (`remote-client.ts` constructor); only the worker (`local-runtime.ts`
`startWorkerRuntime`) and `run`/`attach` (`engine-runtime.ts` — premise verified:
`podDaemonCommand` is `serve --bridge --model-proxy`, `engine-runtime.ts:95`, and
the resident inherits the flag, `pod-resident.ts:105`) claim `laptop`. A daemon
that reports its own model wins over a `laptop` claim. The `daemon`-scope wording
now says "the daemon's config … on the daemon's host", which also fixes `connect`.
My round-1 scenario (a pod without `--model-proxy`) is not reachable through
`run`/`attach`; the default now covers a hand-started one anyway.

**Finding 2 (wiring untested) — resolved.** Mutations, each red then reverted:
- worker `modelScope: "laptop"` → `"daemon"`: worker test red;
- `run`'s `modelScope` dropped: `startPodRuntime` images-off test red;
- handshake protocol forced to `1`: W1, W3, W4, W4b, W5 + connect test red (6);
- `daemonModel = undefined`: W1, W3, W4b, connect, runtime test red (5).

**Gate.** Touched files (`image-input`, `images-off-wiring`, `images-off-runtime`,
`engine-runtime`, `worker`, `connect`): 175 pass / 0 fail. `bun run lint` clean
(1066 files); `bun run typecheck` clean. After all mutations `git status` was
clean. Full suite not re-run by me.

**Nits (not blocking).** (1) `attach`'s `modelScope: "laptop"` survives its
mutation: no attach test covers it. It is nearly equivalent in practice, because
a `--model-proxy` pod advertises `client`, so the absent-capability branch needs
an old or hostile daemon. (2) A hostile proxy pod can report an `agentInfo.model`
and flip the advice to "the daemon's host". That needs a misbehaving pod, the
text is sanitized and display-only, so it is acceptable under §7.
(3) Bidi/zero-width characters still pass `safeModel`.
