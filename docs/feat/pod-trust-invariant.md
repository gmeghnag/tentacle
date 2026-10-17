# feat/pod-trust-invariant — AGENTS §7: compute next to the code, identity with the user; a pod is not trusted

> **Status:** done — merged 2026-10-18
> **Branch:** `feat/pod-trust-invariant`
> **Size:** S · **Blast:** contained (one AGENTS.md bullet, no code; it is a rule change, so a `feat`, AGENTS §10) · **Suited:** any model executes; standard Review

## Context

*— claude-opus-5-5, 2026-10-18*

The owner approved the invariant proposed in
`docs/eval/remote-execution-model.md` on 2026-10-18 (recorded there under "Owner
decisions"). It must be in §7 **before** `mcp-client-tools` (piece 3), because
that eval's laptop-side gate follows from it.

**Repro (why the rule is needed):**
- In pod mode today, the decision to prompt is made **daemon-side**. The
  daemon sends `session/request_permission` only when it decides to
  (`daemon/src/hosted-session.ts:41-50`).
- The laptop only displays what it receives
  (`client/src/remote-client.ts:176`, `onPermission`).
- That is safe while every tool runs in the pod. It stops being safe the
  moment the pod can trigger effects on the laptop, which piece 3 introduces.

## Implementation

*— claude-opus-5-5, 2026-10-18*

- **Design:** one new bullet in AGENTS §7, placed right after "Model stays on
  the laptop", since both existing laptop-side bullets are special cases of it.
  It states:
  - the split between workspace and identity;
  - the trust boundary (the daemon runs in the pod);
  - the rule: gate on the laptop, with an allowlist and the single broker;
  - the corollary: no lasting approval for pod-supplied input;
  - a pointer to the rationale.
- **Files:** `AGENTS.md`.
- **Failure mode:** bloat in a file every agent reads. It is kept to one bullet
  that points to the eval for the detail.

## Execution

*— claude-opus-5-5, 2026-10-18*

Added the bullet to AGENTS.md §7 (11 lines). No drift. Markdown only, so there
is no gate to run (§6).

## Review

*— claude-opus-5-5, 2026-10-18 (in-context, same model — allowed for `contained` S)*

**Verdict: APPROVE.**
- **Consistent with the existing invariants.** "Model stays on the laptop" and
  "Persistence lives on the laptop" are named as special cases. The
  single-broker invariant is reused, not duplicated.
- **The wording matches the approved text** in
  `docs/eval/remote-execution-model.md`, including the post-Fable correction
  (no lasting approval for pod-supplied input).
- **Self-review caveat:** the author reviewed its own text. The substance was
  already reviewed by a different model (Fable, Review #2 in the umbrella).
