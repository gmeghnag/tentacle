# eval/pod-tls-env-scrub — does the pod-TLS env gap warrant extending the shared denylist?

> **Status:** eval (Context + Review; direct-to-`main`, no branch; Implementation empty until promoted)
> **Prospective work (if promoted):** Type: `fix` · Size: S · Blast: contained (one regex fragment in `core/src/env.ts` + one test case in `core/test/env.test.ts`; the helper is a leaf, its callers already pinned by tests) · Suited: a weaker model may execute, standard Review.

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

*(empty — an eval is not built until promoted to a `fix`.)*

## Execution

*(empty.)*

## Review

*— qwen3.8-27b-ud, 2026-10-17 (recommendation; owner decides)*

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
- **(c) Leave it, document the caveat.** Accept the narrow residual; the helper's docstring
  already states the denylist is open-ended by construction.

**Decision asked of the owner:** take (a) now as a tiny `fix` (I lean yes — it's cheap,
closes a genuine ambient-exfil vector, and is the natural completion of the
`shell-env-scrub` hardening), or batch it into a future denylist review, or accept as
documented residual (c).

**Promotion trigger (if (a)):** on the owner's OK, `git mv` this doc to
`docs/fix/pod-tls-env-scrub.md` and open branch `fix/pod-tls-env-scrub`; the fix is one
regex fragment + one test, with a red-first test in `core/test/env.test.ts` asserting
`isSensitiveEnvKey("TENTACLE_POD_TLS_KEY")` is `true` (and `CA`/`CERT`).

**What would change the recommendation:** any evidence the main process is *meant* to
ambiently carry cluster TLS in env (none known — the design deliberately keeps it
in-memory), or a requirement that a model-driven child legitimately needs
`TENTACLE_POD_TLS_*` (none known).
