# fix/pod-tls-env-scrub — extend the shared env denylist with this repo's pod-TLS vars

> **Status:** done — committed to `main` (874acaf) · status synced by audit 2026-10-19; Review: APPROVE (fresh-context reviewer, same model as executor — see honesty note in Review)
> **Branch:** none — committed directly to `main` as 874acaf (the branch was never kept)
> **Size:** S · **Blast:** contained (one regex fragment in `core/src/env.ts` + test cases in `core/test/env.test.ts`; the helper is a leaf, its callers already pinned by tests) · **Suited:** a weaker model may execute, standard Review.
>
> Promoted from `docs/eval/pod-tls-env-scrub.md` on the owner's direction (2026-10-17) — option (a), the eval's recommendation.

## Context

*— qwen3.8-27b-ud, 2026-10-17*

**The question being decided.** After the `shell-env-scrub` fix landed, its fresh-context
review filed a finding (nit) that the shared env denylist (`packages/core/src/env.ts`)
misses this repo's own pod-TLS vars, and a follow-up TODO was opened (Block 1). This eval
decides whether that gap warrants a fix now, and if so with what policy — or whether it is
acceptable residual.

**Why the prior framing overstates severity (corrected here).** The finding said the vars
"still reach the shell child *and* the MCP child." Verified against the source, that is only
true in a narrow case, because the TLS material is **not normally in the main process's
ambient `process.env` at all**:

- The kubeconfig path (the common carrier of cluster client key material) keeps TLS
  **in-memory**, never in env: `loadKubeClientOptions` reads `ca`/`cert`/`key` from the
  kubeconfig (`packages/k8s/src/kube-auth.ts:116-141`) and hands them to `fetch`/`WebSocket`
  via a closure `tls`; `KubeClient` holds them in a private field
  (`packages/k8s/src/client.ts:87`). No `process.env.TENTACLE_POD_TLS_*` assignment exists in
  the main process (verified: `grep "process.env.TENTACLE_POD_TLS"` outside `pod-cleanup.ts`
  and tests → none).
- The **only** writer of these env vars is the pod-delete child's freshly-built env in
  `spawnPodDelete` (`packages/k8s/src/pod-cleanup.ts:165-183`): it copies the parent
  `process.env`, then explicitly sets `TENTACLE_POD_TLS_{CA,CERT,KEY}` from the in-memory
  `options.tls`. It does **not** call `scrubSensitiveEnv` (0 matches in the file).
- But that child is **trusted first-party** and spawns nothing model-driven: it is `detached`
  with `stdio: ["ignore","ignore","ignore"]` and is a `fetch`-and-exit script
  (`buildPodDeleteScript`) or the compiled binary's `__delete-pod` subcommand
  (`deletePodFromEnv`) — no shell, no MCP server, no model reader in that tree.

**So the realistic exposure is one narrow case:** a human who *ambiently exports* the
cluster's TLS client key/cert (e.g. sources a cluster env) would then have
`TENTACLE_POD_TLS_KEY`/`_CERT` inherit into the shell child (`host-execution.ts`) and the
MCP child (`mcp/transport.ts`) **unscrubbed**, because `SENSITIVE_KEY`
(`packages/core/src/env.ts:11-12`) does not match them (verified: all three `TENTACLE_POD_TLS_*`
names return `false` from the regex, while `TENTACLE_POD_DELETE_TOKEN` / `TENTACLE_REMOTE_TOKEN`
already match via `TOKEN`). The normal `tentacle pod run` flow does not hit this.

**Tracked as** `TODO.md` Block 1, the "Shared env denylist misses this repo's own pod-TLS
vars" item (the follow-up to `fix/shell-env-scrub`).

## Implementation

*— qwen3.8-27b-ud, 2026-10-17*

### Load-bearing assumption

**The model-driven children's envs are exactly the two `scrubSensitiveEnv` sites.** `exec/src/host-execution.ts:156` (shell/spawn children) and `mcp/src/transport.ts:31` (MCP server subprocess) are the only callers (verified: `grep -rn scrubSensitiveEnv packages/` → no other call sites), so extending `SENSITIVE_KEY` closes the ambient-export vector end-to-end; there is no third child to wire.

### Preconditions

- `TENTACLE_POD_TLS_{CA,CERT,KEY,INSECURE}` do not currently match `SENSITIVE_KEY` (`core/src/env.ts:11-12`; verified by execution — all four return `false`, while `TENTACLE_POD_DELETE_TOKEN` / `TENTACLE_REMOTE_TOKEN` match via `TOKEN`).
- The main process never writes `TENTACLE_POD_TLS_*` into `process.env`: the kubeconfig path keeps TLS in-memory (`k8s/src/kube-auth.ts:116-141` → private field `k8s/src/client.ts:87`). The only writer is the detached delete child's own freshly-built env (`k8s/src/pod-cleanup.ts:173-186`), which never calls `scrubSensitiveEnv` — so this change cannot break the delete net.
- The helper's docstring already states the denylist is open-ended by construction (`core/src/env.ts:1-8`).

### Design

Add a `TLS[_-]?(KEY|CERT|CA)` alternative to `SENSITIVE_KEY`. It matches this repo's own `TENTACLE_POD_TLS_KEY` / `_CERT` / `_CA` (case-insensitive, optional `_`/`-` separator, so future `TLS_KEY`-family names — including user-supplied `options.env` overlays — are covered too). `TENTACLE_POD_TLS_INSECURE` intentionally stays unscrubbed: it is a boolean flag, not a secret. The delete child is untouched (it never scrubs, and its TLS env is required by design — `k8s/src/pod-cleanup.ts:81-84` and `:110-119` read those exact vars).

### Files

1. `packages/core/src/env.ts` — one regex fragment.
2. `packages/core/test/env.test.ts` — red-first test cases.

### Failure modes

- **False positive (scrubs a var a child legitimately needs):** only keys containing `tls_key` / `tls_cert` / `tls_ca` (any case) are affected. No model-driven child consumes cluster TLS (the material stays in-memory daemon-side; §7 "model stays on the laptop"), so nothing legitimate is lost; the helper's policy is best-effort by documented design.
- **Delete child breaks:** cannot — it never calls the helper and builds its TLS env explicitly (verified above); its tests (`k8s/test/pod-cleanup.test.ts:96-99`) pin that env and stay green.
- **Gap persists elsewhere:** the ambient-export vector is closed for exactly the two scrub sites. A *future* child that copies `process.env` unscrubbed is out of scope — that is the helper's documented contract, not this change's.

### Tests

Red-first in `core/test/env.test.ts`: `isSensitiveEnvKey("TENTACLE_POD_TLS_KEY")` (plus `_CERT`, `_CA`) is `true` — currently `false`, so red on the unpatched regex. The `scrubSensitiveEnv` "drops secret keys" case gains `TENTACLE_POD_TLS_CA`, proving the scrub path (not just the predicate) drops it. `TENTACLE_POD_TLS_INSECURE` is added to the "leaves ordinary vars alone" case to pin the deliberate non-match.

## Decision (from the eval)

*— qwen3.8-27b-ud, 2026-10-17 (recommendation; owner decided option (a), 2026-10-17)*

**Recommendation: low-priority hardening, not a live defect in the normal flow.** The
provider-key exfiltration the original defect named is already fixed. This residual is a
defense-in-depth gap reachable only via an ambient export of cluster TLS material — real but
narrow, and the common kubeconfig path is already env-safe. Two options, in order of
preference:

- **(a) Extend the denylist** — add a `TLS[_-]?(KEY|CERT|CA)` fragment to `SENSITIVE_KEY`
  (`core/src/env.ts:11-12`) and one test case in `core/test/env.test.ts`. This is the same
  one-line-class change as the merged shell fix (S, contained). It closes the
  ambient-export vector for the shell + MCP children. It does **not** change the delete
  child (that path never scrubs), but that child is trusted and model-free, so nothing is
  lost. Cost: `tls.ca` (a CA bundle, lower sensitivity than the key) is also dropped from
  those children — harmless, since no model-driven child consumes cluster TLS.
- **(b) Leave it, document the caveat.** Accept the narrow residual; the helper's docstring
  already states the denylist is open-ended by construction.

**Decision asked of the owner:** take (a) now as a tiny `fix` (I lean yes — it's cheap,
closes a genuine ambient-exfil vector, and is the natural completion of the
`shell-env-scrub` hardening), or batch it into a future denylist review, or accept as
documented residual (b).

**Promotion trigger (if (a)):** on the owner's OK, `git mv` this doc to
`docs/fix/pod-tls-env-scrub.md` and open branch `fix/pod-tls-env-scrub`; the fix is one
regex fragment + one test, with a red-first test in `core/test/env.test.ts` asserting
`isSensitiveEnvKey("TENTACLE_POD_TLS_KEY")` is `true` (and `CA`/`CERT`).

**What would change the recommendation:** any evidence the main process is *meant* to
ambiently carry cluster TLS in env (none known — the design deliberately keeps it
in-memory), or a requirement that a model-driven child legitimately needs
`TENTACLE_POD_TLS_*` (none known).

## Execution

*— qwen3.8-27b-ud, 2026-10-17*

Done exactly as Implementation specified; **no drift**.

1. **Promote (the move is the decision, §10):** on `main`, `git checkout -b fix/pod-tls-env-scrub`;
   `git mv docs/eval/pod-tls-env-scrub.md docs/fix/pod-tls-env-scrub.md`; re-titled the doc,
   set the branch/size/blast header, and wrote the Implementation section (sub-sections above),
   each claim re-verified against the source at the time (not carried on faith from the eval).
2. **Red first (§9):** added the test cases to `packages/core/test/env.test.ts` —
   `TENTACLE_POD_TLS_KEY` / `_CERT` / `_CA` to "flags keys that look like secrets" (expect
   `true`), `TENTACLE_POD_TLS_INSECURE` to "leaves ordinary vars alone" (expect `false`), and
   `TENTACLE_POD_TLS_CA` + `TENTACLE_POD_TLS_INSECURE` to the `scrubSensitiveEnv` case (CA
   dropped, INSECURE kept, `toEqual` updated). Ran the file: **2 fail / 1 pass** — red on the
   unpatched regex, exactly the property the fix hinges on.
3. **Fix:** added `|TLS[_-]?(KEY|CERT|CA)` to `SENSITIVE_KEY` (`packages/core/src/env.ts:12`).
   Ran the file: **3 pass / 0 fail** — green.
4. **Gate:** `bun run check` → typecheck ✓, lint ✓ (clean baseline, 0 new), full suite
   **649 pass / 1 skip / 0 fail** (the skip is the opt-in live-k8s test, not a failure).
   (Note: the 540 figure pinned in AGENTS.md §6 is stale — the suite has grown; the gate is
   green, which is the §4 requirement.)

Files changed: `docs/fix/pod-tls-env-scrub.md` (promoted + Implementation + this Execution),
`packages/core/src/env.ts` (one regex fragment), `packages/core/test/env.test.ts` (the cases).

## Review

*— qwen3.8-27b-ud, 2026-10-17 (fresh context; same model as the executor — see the honesty note)*

**Verdict: APPROVE.**

**Non-vacuity by mutation (§9):** I removed the `|TLS[_-]?(KEY|CERT|CA)` fragment from
`SENSITIVE_KEY` and re-ran `bun test packages/core/test/env.test.ts` → **2 fail / 1 pass**
(the two TLS assertions the fix adds). Restored the fragment → **3 pass / 0 fail**, and the
restored file is byte-identical to the committed version (verified by diff). The test pins the
exact property and is not vacuous.

**Gate re-run:** `bun run check` → typecheck ✓, lint ✓ (0 errors, 0 warnings vs the clean
baseline), full suite **649 pass / 1 skip / 0 fail** (2012 expect() calls, 88 files). Green.

**Attack the plan, not the checklist:**

1. *Is `TLS[_-]?(KEY|CERT|CA)` the right shape, or does it under/over-match?* Over-match is
   bounded: it only matches keys containing `tls_key`/`tls_cert`/`tls_ca` (any case,
   `_`/`-`/none separator). No model-driven child consumes cluster TLS (the material stays
   in-memory daemon-side; §7 "model stays on the laptop"), so the only false positives are
   user-supplied `options.env` overlays that happen to carry a `tls_key`-family name — which is
   exactly the class the denylist is meant to drop. Under-match: `TENTACLE_POD_TLS_INSECURE`
   is deliberately left (a boolean flag, not a secret) and is pinned by the "leaves ordinary
   vars alone" case, so a future edit can't silently start dropping it without a red test.
2. *Does this break the delete child?* No — `spawnPodDelete` (`k8s/src/pod-cleanup.ts:153-190`)
   never calls `scrubSensitiveEnv`; it builds the TLS env explicitly and the child reads it
   back (`:81-84`, `:110-119`). Its tests (`k8s/test/pod-cleanup.test.ts:96-99`) still pass in
   the full gate. The change cannot regress the net.
3. *Is there a third child site the plan missed?* `grep -rn scrubSensitiveEnv packages/` →
   exactly two call sites, both model-driven (`exec/src/host-execution.ts:156`,
   `mcp/src/transport.ts:31`). The load-bearing assumption holds; no unwired third end.
4. *Scope:* the diff is exactly this task — one regex fragment, its tests, and the task doc.
   No unrelated refactor, no deferred-phase leak.

**Honesty note (reviewer routing, §10):** I am the **same model** as the executor, only in a
fresh context. For a `contained`/S task this is the permitted routing (a weaker model +
standard Review), so it is acceptable — but it is **weaker** than a different or stronger
reviewer, and shared blind spots survive both passes. A different model should still re-read
the regex shape if it has any opinion about the denylist's breadth; nothing here is
load-bearing, so the risk of a surviving blind spot is low.
