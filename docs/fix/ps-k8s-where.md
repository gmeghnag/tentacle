# fix/ps-k8s-where — short k8s WHERE in `ps`, short "not reachable" note

> **Status:** review
> **Branch:** `fix/ps-k8s-where`
> **Type:** fix · **Size:** S · **Blast:** contained · **Suited:** a weaker model may execute; standard in-context Review

## Context

*— claude-sonnet-5-5, 2026-11-04*

Owner, live 2026-11-04, two display problems in `tentacle ps`:

1. **WHERE of a kubernetes row is ~80 chars on OpenShift.** `whereOf`
   (`packages/cli/src/kept.ts`) is `<context>/<namespace>`, and `oc login`
   contexts are `<ns>/<dashed-server>:<port>/<user>`, e.g.
   `default/api-sharedocp419-sbr-shift-gsslab-brq2-redhat-com:6443/kube:admin/default`.
2. **The "not reachable" note is long and on stdout**:
   `podman local: not reachable (skipped) — Docker engine socket not found at /var/folders/…/podman-machine-default-api.sock (the kept workload's engine) — is Docker Desktop running / \`podman machine start\`?`

Owner-approved decision (display only — the index, `attach`, `rm` semantics unchanged):

- k8s WHERE = `<cluster>/<namespace>`, `<cluster>` resolved at `ps` time from the
  laptop kubeconfig (same loader as the k8s engine, no kubectl):
  1. the context's cluster server host is `api.<name>.<domain>` → `<name>`;
  2. else the kubeconfig cluster NAME (EKS ARN `arn:aws:eks:…:cluster/<name>` → `<name>`);
  3. else (context gone, unreadable kubeconfig, `server` override entry) → today's
     value truncated to 30 display chars with `…`.
- the note goes to STDERR (dim only when stderr is a TTY), short, engine-specific:
  podman → `… — no podman socket · run podman machine start`;
  docker → `… — no docker socket · is Docker Desktop running?`;
  any other cause keeps a short first-line cause.

**Repro (before):** `whereOf({engine:"kubernetes", context:"openshift-dns/api-sharedocp419-sbr-shift-gsslab-brq2-redhat-com:6443/kube:admin", namespace:"default"})`
returned the full ~80-char string; `psCommand` wrote the note via `deps.write`
(stdout) with the verbatim `dialError` text. Pinned red by the tests below.

## Implementation

*— claude-sonnet-5-5, 2026-11-04*

### Load-bearing assumption

`whereOf` is the ONE producer of the k8s WHERE text for `ps` rows, the note, and
`rm`/`attach` labels, and all of it is display (never fed back to the index or an
engine). Verified: callers are `kept.ts` `renderTable`, `ambiguousMessage`,
`removeConfirmation`, `relayRemoveConfirmation`, `removedLine`, `placeText`;
`kept-cmd.ts` `psCommand` (note) and `rmOne` (label); `main.ts` (`attach`
ambiguity, `elsewhereMessage` places). Matching/dialling use the entry's
`context`/`server`/`namespace` fields directly (`hostOptionsFor`), not `whereOf`.
`renderVerbose` does not call it (it prints the full `context …, namespace …`) —
unchanged on purpose.

### Preconditions

- `Kubeconfig` / `parseKubeconfig` / `defaultKubeconfigPath` live in
  `packages/k8s/src/{kubeconfig,kube-auth}.ts`; `currentKubeContext` already reads
  the file with the same path rule and swallows failures (the pattern reused).
- The docker engine's missing-socket text is the single string in
  `packages/docker/src/byte-duplex.ts:64` (`dialError`, ENOENT) — it starts with
  `Docker engine socket not found at`. Other commands (`run`, `rm`'s
  `cannot reach …`) print `dialError` verbatim and are NOT changed; only the `ps`
  note rewrites it.
- `psCommand` already received `deps.writeErr` (used by `-q` for problems);
  `main.ts` wires it to stderr.
- `bunfig` test preload points `KUBECONFIG` at a nonexistent path, so tests using
  the default loader fall to rule 3 (no real infra).

### Design

- `packages/k8s/src/kube-auth.ts`: `readKubeconfig(path?)` → `Kubeconfig | undefined`
  (never throws). Same default path as `loadKubeClientOptions`.
- `packages/cli/src/kept.ts` (pure): `clusterName(kube, context)` (rules 1–2; a
  host must start `api.<letter…>.`, so an IP never matches), `truncate`
  (code-point count, 30 incl. `…`; applied to the whole `<context>/<namespace>`
  string, as the owner worded it), `whereOf(entry, kube?)`, and
  `unreachableNote(engine, where, reason)`. `kube?` is threaded through
  `renderTable`, `ambiguousMessage`, `removeConfirmation`,
  `relayRemoveConfirmation`, `removedLine`, `placeText`. Callers keep
  `untrustedText`.
- `packages/cli/src/kept-cmd.ts`: `KeptDeps` gains optional `dimErr` and
  `kubeconfig` (seams). `psCommand` reads the kubeconfig ONCE, only when a k8s
  row is shown; `rmOne` once, after the name resolves. A throwing loader →
  `undefined`. The note is `deps.writeErr(dimErr(note))`, one line per distinct note.
- `packages/cli/src/main.ts`: `dimErr` = dim iff `process.stderr.isTTY` and no
  `NO_COLOR`; `attach`'s ambiguity/elsewhere texts pass `readKubeconfig()`.

### Files

`packages/k8s/src/kube-auth.ts`, `packages/cli/src/kept.ts`,
`packages/cli/src/kept-cmd.ts`, `packages/cli/src/main.ts`; tests
`packages/cli/test/kept-where.test.ts` (new), `kept-cmd.test.ts`, `main.test.ts`.

### Failure modes

- Kubeconfig missing/unparseable/loader throws → `undefined` → rule 3; `ps` exits 0.
- Context deleted from the kubeconfig → rule 3 (truncated old value).
- Context found but cluster has no `server` → rule 2 (cluster name); cluster entry
  missing entirely → the context's `cluster` ref string (rule 2).
- Two clusters collapsing to the same short name → two rows with the same WHERE;
  accepted (display only; `rm`/`attach` resolve by name + engine, not WHERE).
- Hostile kubeconfig text → still passes through `untrustedText` at every print.
- A missing socket on an engine other than docker/podman (n/a) / any other error →
  first line, ≤120 chars with `…`.
- `ps -q` and a piped `ps` stdout carry no note (stderr).

### Tests

- `kept-where.test.ts` (pure): rule 1 (OpenShift + `upishared`), IP not matched,
  rule 2 (kind, EKS ARN, no-server cluster), rule 3 (no kubeconfig, context gone,
  `server` override, truncation to 30), helpers share the cluster,
  `unreachableNote` podman/docker/other/long/multi-line.
- `kept-cmd.test.ts`: notes on stderr (stdout has no `not reachable`), podman
  socket text + `-q` clean, ps resolves `prod/n` and reads the kubeconfig once, a
  throwing loader does not break `ps`, `rm` label uses the cluster.
- `main.test.ts`: real `main` `ps` writes the short docker note to `writeErr`.
- Mutations (one per rule/item), each reverted (shasum identical).

## Execution

*— claude-sonnet-5-5, 2026-11-04*

1. Added signatures only (behaviour unchanged) in `kept.ts`/`kept-cmd.ts`, wrote
   `kept-where.test.ts`: **8 of 9 red on the assertions** (the `server`-override
   case already held). Then implemented `clusterName`/`truncate`/`unreachableNote`.
   One test (`api.10.0.0.1`) stayed red → the regex now requires a letter after
   `api.`. Green.
2. `kept-cmd.test.ts`/`main.test.ts`: the two existing assertions that read the note
   from stdout became stderr assertions (they were red on the stderr change);
   `main.test.ts`' `run` helper now captures `writeErr`.
3. Mutations (tests: `kept-where` + `kept-cmd`), each reverted:
   - rule 1 disabled → 4 red; rule 2 (ARN branch) → 1 red; rule 3 (no truncation)
     → 1 red; podman text branch → 2 red; note to stdout (item a) → 3 red.
   - `shasum` of `kept.ts` (`2a6d6a8d…`) and `kept-cmd.ts` (`4f66577f…`) identical
     before and after.
4. Gate: see Review.

Drift: `ps -v` is untouched (it never used `whereOf`). `placeText`/`attach` texts
also take the kubeconfig (owner: same WHERE wherever shown). Truncation applies
to the whole `<context>/<ns>` (literal reading of the owner's rule 3), so a very
long unresolved context can hide its namespace.

## Review

*— claude-sonnet-5-5, 2026-11-04*

Gate and in-context review recorded at the end of the task run (see the final
report). Not a fresh-context review: blast is `contained`, size S, so standard
in-context Review applies (AGENTS §10). Unverified: the colour decision for
stderr on a real TTY (`dimErr`) — run `tentacle ps` in a terminal with an
unreachable engine.

## Review

*— claude-opus-5-5, 2026-11-04* (fresh context; executor was claude-sonnet-5-5, a different model)

**Verdict: REQUEST-CHANGES** — one MEDIUM (finding 1). Everything else holds; the rest are LOW.

### Findings

1. **MEDIUM — the stderr colour ignores the injected `writeErr`, so the gate fails in a terminal.**
   `packages/cli/src/main.ts:574` `dimErr` looks at the real `process.stderr.isTTY`
   even when `io.writeErr` is injected. Stdout's colour (`main.ts:372`) does not do
   this: it checks `!io.write`. `packages/cli/test/main.test.ts:1782` checks
   `ps.err` with an exact `toBe`. When `bun test` runs in an interactive terminal
   (stderr is a TTY, `NO_COLOR` not set), the note gets wrapped in `\x1b[2m…` and the
   test fails. Evidence: I set `process.stderr.isTTY = true` at the start of that
   test and got `0 pass, 1 fail` (Expected −1 / Received +1). It is green only
   because CI/agents pipe stderr. Fix: `dimErr` dims only when `!io.writeErr &&
   process.stderr.isTTY === true && !NO_COLOR` (the same shape as `colour`). A test
   could pin it with `isTTY` forced on.
2. LOW — `truncate` (`kept.ts` rule 3) counts code points, not display width. Wide
   (CJK/emoji) contexts take up to 60 columns. Also, `untrustedText` runs *after*
   the cut, so escaped control characters can make the cell longer than 30.
3. LOW — the results of rules 1 and 2 are never capped. A long kubeconfig cluster
   name with no `api.` host or ARN (e.g. a long `oc login` cluster name whose
   server is an IP) is printed in full.
4. LOW — `rmOne` (`kept-cmd.ts:350`) reads the kubeconfig for any resolved
   name, docker/podman too. It is harmless (the failure is swallowed, display
   only), but it does not match `ps`'s "only when a k8s row" rule.

### Premise table

| Premise | Result |
|---|---|
| `byte-duplex.ts:64` ENOENT text starts `Docker engine socket not found at` | TRUE |
| `readKubeconfig` is exported from `@tentacle/k8s` (`index.ts:14` re-exports `kube-auth.ts`) | TRUE |
| `ps -q` returns before any probe/note (`kept-cmd.ts` `options.quiet` branch) | TRUE: `-q` stdout is names only, no note |
| `renderVerbose` does not use `whereOf` | TRUE (not changed) |
| Matching/dialling use the entry fields, not `whereOf` (index/attach/rm semantics unchanged) | TRUE: the diff only adds a `kube?` display parameter |

### Attacks tried

- Rule 1 on an IP (`api.10.0.0.1`) and a host without `api.`: no match → rule 2. **Holds** (`[a-z]` first, a `.` required after it).
- Rule order: an EKS server (`*.eks.amazonaws.com`) never starts with `api.` → the ARN branch gives `prod-eu`. **Holds.**
- No kubeconfig / a loader that throws / context gone / `server` override entry: `ps` exits 0, WHERE truncated to 30 with `…`, and the override is never looked up. **Holds** (`kubeOf` try/catch; tests).
- Kubeconfig read once per `ps`, only when a k8s row is shown: **holds** (`reads === 1`).
- `untrustedText` still wraps every print of `whereOf`: **holds**.
- The note: stderr only, one line per distinct note, the podman/docker wording exactly as the owner specified, any other cause is its first line ≤120 chars: **holds**. The colour on stderr: **finding 1**.

### Mutation (mine)

Rule-1 regex `[a-z][a-z0-9-]*` → `[a-z0-9-]+` (an IP would match): `kept-where.test.ts` **1 fail** ("rule 1 does not match an IP"). Reverted. `shasum packages/cli/src/kept.ts` is `a46b96de…` before and after. The TTY probe in `main.test.ts` was also reverted: `1d4a5ef0…` before and after.

### Gate

Run once, in the foreground. `bun run check` stops at the typecheck because `tsc -p apps/mobile` fails in this worktree (`expo/tsconfig.base` not found: mobile is not installed here). That step also **emitted 6 stray `.js` files** into `apps/mobile` (they made lint fail and added 1 test fail); I deleted them. Parts run on their own after that: `tsc --noEmit` clean · `biome check .` clean (620 files) · `bun test` **4333 pass · 3 skip (opt-in) · 1 fail + 1 error**. The fail and the error are both `apps/mobile/test/rn-websocket.test.ts` ("Cannot find module '@tentacle/client'"): the same missing-install environment issue, not from this diff. All cli/k8s tests pass.

### How the executor behaved

The work is in scope, and red came before green as recorded. The executor wrote the mutations up honestly and named the unverified part (the TTY colour) in their own Review. That unverified part is exactly where the defect is: the colour on a TTY was never exercised.

### Execution — round 2

*— claude-sonnet-5-5, 2026-11-04*

Review findings addressed (no commit):

1. **MEDIUM (stderr colour):** `main.ts` `dimErr` now dims only when `!io.writeErr &&
   process.stderr.isTTY === true && !NO_COLOR` (same shape as `colour`). Pinned by a
   new `main.test.ts` test that FORCES `process.stderr.isTTY = true` (and clears
   `NO_COLOR`) with an injected `writeErr` and asserts the note has no `\x1b` — so
   it holds whether or not the real stderr is a terminal.
2. **Owner's answer (rule 3):** only the context part is cut (30 chars incl. `…`);
   `/<namespace>` stays whole: `openshift-dns/api-sharedocp41…/default`.
3. **LOW fixed (one-liners):** finding 3 — rules 1–2 results are capped at 30 too;
   finding 4 — `rmOne` reads the kubeconfig only when the resolved name(s) include
   a kubernetes entry (test: docker `rm` → 0 reads).
4. **LOW left:** finding 2 (code points vs display width / `untrustedText` after the
   cut) — a width-aware cut needs a width table; display-only, no functional harm.

Mutations (each = the old code put back; reverted, `shasum` identical:
`kept.ts` `1bcc1296…`, `kept-cmd.ts` `cef59654…`, `main.ts` `f166044e…`):
`dimErr` without `!io.writeErr` → `main.test.ts` 1 red (the new TTY test);
whole-string truncation → `kept-where` rule-3 test red; uncapped rules 1–2 → same
test red; `rm` always reads → `rm reads the kubeconfig only for a kubernetes name` red.

Gate (non-TTY): `bunx tsc --noEmit` clean · `bunx biome check .` clean ·
`bun test packages` 4296 pass · 3 skip (opt-in) · 0 fail.
**Not run:** `script -q /dev/null bun test packages/cli/test/main.test.ts` — the
harness refused to run `script` without approval. The property it would show is
covered in-test by the forced `isTTY = true`; run it by hand to confirm.

## Review — round 2

*— claude-opus-5-5, 2026-11-04* (fresh context; executor was claude-sonnet-5-5)

**Verdict: PASS (APPROVE-WITH-NITS)** — the MEDIUM is fixed. Only one LOW is left.

- **Finding 1 (MEDIUM) — fixed.** `main.ts` `dimErr` now dims only when
  `!io.writeErr && process.stderr.isTTY === true && !NO_COLOR`.
  - The new test forces `isTTY = true`, clears `NO_COLOR`, and restores both in a
    `finally`.
  - Probe: I put my round-1 probe back (`isTTY = true` at the start of the old
    test, the one with the exact `toBe`). Round 1: **1 fail**. Now: the whole
    `main.test.ts` gives **92 pass · 0 fail**. Reverted, shasum `87313603…` identical.
  - Not run: `script -q /dev/null …`. The harness refuses `script` ("can't be
    checked before it runs"), for the executor and for me. The forced `isTTY`
    covers the same property in-process. To confirm on a real pty, run it by hand.
- **Rule 3 — `/<namespace>` stays whole.** Only the cluster/context part is cut
  (`truncate(cluster, 30)` + `/${namespace}`).
  - Mutation (mine): back to the old cut of the whole string →
    `kept-where.test.ts` **1 fail** (rule 3). Reverted, `kept.ts` shasum
    `1bcc1296…` identical.
- **LOW 3 and 4 — fixed.** Rules 1–2 are capped at 30. `rmOne` reads the kubeconfig
  only for a kubernetes name (`kept-cmd.ts:351-353`).
- **LOW 2 — left on purpose** (code points vs display width). Accepted:
  display only.
- **No regression.**
  - The note is still stderr-only, and `-q` is still clean.
  - `untrustedText` is still around every print.
  - The index/attach/rm semantics are unchanged.
- **Gate** (foreground, run once):
  - `bunx tsc --noEmit` clean
  - `bunx biome check .` clean (620 files)
  - `bun test packages`: **4296 pass · 3 skip (opt-in) · 0 fail** (4299 tests, 292 files)
  - The tree has only the task's files.
