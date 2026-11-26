# AGENTS-core (digest)

This is a digest; AGENTS.md is the source of truth and wins on any conflict. Read this first; open a full AGENTS.md section only when its pointer condition applies.

**Lean docs (owner 26/11, token efficiency).** A task doc keeps Context + Implementation + the LATEST Review round in the main body. Older review rounds and long execution narratives go under a final `## Appendix — history`, so readers can stop before it.

## §0 Hard stop rules (anti-loop)
- Two-strike: two attempts of the same approach category (static reading, same experiment) that don't advance understanding => stop that category; switch (static <-> empirical) or ask. Never a third.
- Repetition detector: re-deriving, re-reading the same region, re-arguing an answered question = loop. Break with the single cheapest deciding experiment, or ask one specific question.
- Blocked (access, ambiguity, repeated failure): stop, report in 2-3 sentences (tried / known / decision needed), wait.
- Ambiguous user constraint: ask one short question at once.

## §1 Bugs: reproduce before diagnosing
- First deliverable is evidence (smallest repro of the observable: frames, output, state dump), not a hypothesis.
- Characterize first: trigger (exact action), magnitude (constant => layout bug; state-tied => state bug), collateral (what else changes).
- Read code only after a repro exists, with the question it raised.
- TUI bugs: copy the `ink-testing-library` + SGR mouse pattern in `packages/tui/test/app.test.tsx`; capture and diff frames, never reason over Ink source.

## §2 Hypothesis discipline
- One hypothesis at a time, falsifiable by a cheap test; if you can't name the test it is a story.
- Code reading generates hypotheses; execution proves them. Prove the exact property that kills the bug, not a correlate.
- Before each significant step: "I know X; hypothesis Y; next cheapest test Z." Blank/vague => fix that first.

## §3 Reading discipline
- Never open a file "to get the picture": name the question first. Likely answer in a file already read => re-read it with the new question. `rg`/`grep` for "where is X" before reading files.

## §4 Verification
- Iterating: only the relevant file (`bun test packages/tui/test/app.test.tsx`).
- Before done: full `bun run test` + `bun run typecheck` + `bun run lint` (or `bun run check` = typecheck, lint, test in order), vs the lint baseline (clean: 0 errors, 0 warnings; any new one is yours).
- Every fix ships a regression test shown RED on the buggy code (on the property's assertion, not an import error) before green.

## §5 Output
- Report: what changed (file:line), why (root cause, one sentence), evidence (output, before/after). No journey narrative, no failed-attempt history unless asked. State the unverified part in one line + how to verify.

## §6 Repo facts agents trip on
- Bun >= 1.4.3 monorepo, TS strict, Biome. TUI stays on React 18 / Ink 5.0.1.
- `bun run test` is parallel (~1 min); baseline = all pass except 3 opt-in skips (live-k8s, live-docker, slow keepalive) which are not failures; a new fail or other skip is yours. A worker crash counts as a fail. Bare `bun test` = serial ~10 min, only for bisecting isolation.
- `bun run lint` = `biome check .`; fix with `biome check --write <file>`; hand-fix `noDelete` (computed `delete obj[key]`) and `noAssignInExpressions` (block-body arrow).
- Ink gotcha: an empty `<Text>` is 0x0 and collapses blank rows; render blank rows as `" "`.
- Repros live in `<repo root>/.tentacle/tmp/<slug>/` (never /tmp); gitignored so paste script + output into the task doc's Repro. TUI repro: import React/Ink by relative path from `packages/tui/node_modules/...` and use `createElement` (no JSX); full import lines in AGENTS.md §6.
- Git: commit only on the user's explicit OK; if on `main`, branch first (docs/index carve-out in §10). Repo style: double quotes, trailing commas, no `!` non-null assertions.

## §7 Architecture invariants (breaking one is a bug; open §7 for the full text when the trigger applies)
- TUI always over RPC, one session path (`RemoteClient` <-> `Connection`, `createLocalRuntime`): new execution target = only a transport + lifecycle, never a second agent loop/send path. Open when adding a runtime/transport or copying send/stream logic.
- Logic in pure modules, components only render. Open when adding logic near a `.tsx`.
- Single broker: ONE `PermissionBroker` shared by `RemoteClient` and `startTui`; two silently auto-approve. Open if you touch PermissionBroker / `runEngineTui` wiring.
- Persistence (session `<uid>.jsonl` lock/rewrite/aside rules, daemon sidecar `<uid>.state.json`, archive, `/clear` fork, suspended turns): open if you touch session saving/loading, `SessionPersister`, `session/log`, or any on-disk session format.
- Model stays on the laptop (`ProxyModelProvider`): never put provider creds in a pod/image. Open if touching model/provider plumbing in pods.
- Pod is not trusted: every pod-requested laptop effect is gated on the laptop (allowlist + broker prompt); never let a pod-originated prompt make a lasting approval. Open if adding any pod->laptop capability.
- Protocol: schemas in `@tentacle/protocol` are the truth; wire BOTH ends (new `session/update` variant => union member + `client/mapping.ts` reverse). Pre-public: breaking changes allowed, no compat shims. A breaking change needs a `protocol.d/<slug>.md` note; NEVER edit `PROTOCOL_VERSION` on a branch (orchestrator runs `bun run protocol:bump` at merge; `protocol.json` is generated, never hand-merged). Payloads are strip schemas (never `.strict()`); each update kind has one class in `UPDATE_CLASS` (display free / mandatory needs bump or fallback / blocking must be declared + fallback). Open the full bullet for any protocol, update-kind or on-disk format change.
- Don't serialize the RPC peer: no await/lock serializing `Connection` handlers (`transport/peer.ts`).
- Never write raw to the terminal while Ink owns it (no stray `process.stdout.write`; startup via `StatusLine`, daemon stderr buffered, MCP stderr piped). Open if emitting output during a TUI session.
- Pod/container lifecycle (`run`/`attach`/`--rm`/detach, delete-on-exit net, `rm`, secrets via env never argv): open if touching `EngineHost`, run/attach/rm, or detached runs.
- Bun TLS + k8s (per-call `tls`, `v4.channel.k8s.io`, stdin EOF byte count): open if touching k8s exec/auth.

## §8 Planning a change
- Verify every assumption against source with `file:line`; name the one load-bearing assumption and prove it first. Prefer reuse-existing-seams; list exact files in dependency order (protocol -> daemon -> client -> cli -> tui); enumerate failure modes (error, disconnect, race, empty, version skew) with how state converges; no silent drops. If a step contradicts the code: STOP and fix the plan. Open §8 when writing a plan.

## §9 Writing tests
- Red before green (mandatory); prove the exact property; confirm non-vacuity by mutation (break the code, test must fail, revert).
- Test failure modes (error, reject, race, ordering, empty, boundary), not only happy path.
- Use existing seams/fakes (injected fetch, `FakeWS`, fake spawner, `SpyBroker`, mock API server), assert the behavioural contract at the boundary.
- Never use a fixed sleep as a sync point: poll the condition with a throwing timeout (`until`/`untilAsync` in `packages/client/test/support/fakes.ts`).
- Never probe-then-reuse a loopback port: a must-stay-closed port is `127.0.0.1:1`; a port to rebind is picked outside the ephemeral range (macOS 49152-65535, Linux 32768-60999), bound for real, retry on `EADDRINUSE`.

## §10 Task workflow
- One task = one living doc `docs/<type>/<slug>.md` (copy `docs/TASK-TEMPLATE.md`); `feat`/`fix` get branch `<type>/<slug>` off `main`; `eval` has no code, commits directly to `main`. One code task at a time.
- Metadata line at the top: `Type · Size (S/M/L, no XL: split) · Blast (contained/cross-module/load-bearing) · Suited`. Load-bearing or L => stronger model executes and Review is mandatory fresh-context.
- Sections: Context, Implementation (plan, approved first; assumption · preconditions · design · files · failure modes · tests), Execution (as-built + drift), Review (adversarial, never a rubber stamp). Each signed `*— <model-id>, <date>*`.
- User-visible change => `changelog.d/<slug>.<category>.md` (one bullet; categories added|changed|deprecated|removed|fixed|security); never edit `CHANGELOG.md`.
- Merge is the orchestrator's: `git merge`, then `bun run protocol:bump` and full `bun run check`.
- Docs/index-only edits (TODO.md, eval docs, typos) are committed directly to `main` (still only on OK); a task's own doc rides its branch; substantive changes to AGENTS.md rules are a `feat`. Open §10 for carve-out or routing details.
