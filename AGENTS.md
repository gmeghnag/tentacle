# AGENTS.md

Operating rules for AI agents working in this repository.
Goal: correct results at minimum token cost, with explicit stop rules so work
never degrades into repetitive reasoning loops. These rules are mandatory, not
style suggestions.

## 0. Hard stop rules (anti-loop)

- **Two-strike rule**: if two attempts with the *same approach category*
  (static code reading, the same kind of experiment) fail to advance
  understanding, stop that category. Switch category (static → empirical, or
  vice versa) or ask the user. Never a third iteration of the same approach.
- **Repetition detector**: if you catch yourself re-deriving the same
  calculation, re-reading the same file region, or re-arguing a question you
  already answered — that is a loop. Break it with the single cheapest
  experiment that decides the question, or by asking the user one specific
  question.
- **Escalate, don't spin**: when blocked (missing access, ambiguous
  requirement, repeated failures), stop and report in 2–3 sentences: what was
  tried, what is known, the specific decision needed. Then wait.
- **Clarify constraints early**: if a user constraint is ambiguous ("don't
  write code" — does a throwaway repro in `/tmp` count?), ask one short
  question immediately. Do not burn reasoning budget navigating constraints.

## 1. Bugs: reproduce before diagnosing

- The first deliverable for a bug is **evidence, not a hypothesis**: the
  smallest possible reproduction that captures the actual observable
  (rendered frames, command output, state dump). A 20-line before/after diff
  usually contains the answer; 200 lines of code reading may not.
- **Characterize the symptom before reading code** — from the report, or with
  one question to the user:
  1. *Trigger*: which exact action/event causes it (press vs drag vs release;
     first render vs resize; …).
  2. *Magnitude*: how much does it deviate — fixed number, proportional,
     random? A constant tied to content structure ⇒ layout bug. A value tied
     to state (scroll offset, counters) ⇒ state bug.
  3. *Collateral*: what else changes at the same moment (spacing, colors,
     missing/extra lines, messages)?
- Only after a reproduction exists, read code — with the specific question the
  reproduction raised.
- **TUI bugs specifically**: this repo already has `ink-testing-library` and
  SGR mouse helpers in `packages/tui/test/app.test.tsx`. Copy that pattern.
  Do not derive rendering behavior by armchair reasoning over Ink source;
  capture frames and diff them.

## 2. Hypothesis discipline

- One hypothesis at a time. Each must be **falsifiable by a cheap test**
  (a command, a diff, a 10-line script). If you cannot name the cheap test,
  you have a story, not a hypothesis.
- Read code to *generate* hypotheses, not to *prove* them. Proof comes from
  execution.
- **Prove the exact property that kills the bug**, not a weaker correlated
  one. Classic trap: proving "frame height is constant" when the bug needs
  "content position is stable" — it feels like proof, it isn't.
- **One-sentence check** before each significant step on a multi-step task:
  "I know X for sure; my current hypothesis is Y; my next cheapest test is Z."
  If any of X/Y/Z is blank or vague, stop and fix that first.

## 3. Reading discipline

- Never open a file "to get the picture". Open it to answer one named
  question; name the question first.
- If the answer is likely in a file you already read, **re-read it with the
  new question** instead of opening a new file. (Documented failure mode:
  reading the one file that contains the answer and not registering it,
  because the question was aimed at the wrong layer.)
- Use `rg`/`grep` for "where is X" before reading whole files.

## 4. Verification

- During iteration: run only the relevant test file
  (`bun test packages/tui/test/app.test.tsx`), not the full suite.
- Before reporting done: full `bun test` + `bun run typecheck` + `bun run
  lint`, compared against the pre-existing lint baseline in §6 so the claim
  "no new issues" is true.
- Every fix ships with a regression test that was **shown failing on the
  buggy code** (red) before the fix (green). A test that passes on both
  proves nothing. See §9 for how to write one that actually holds.

## 5. Output discipline

- Report: what changed (file:line), why (root cause in one sentence),
  evidence (command output, before/after). No narrative of the journey.
- Do not include failed-attempt history unless asked. State the unverified
  part in one line: what it is and how to verify it.

## 6. Repo facts (verified)

- Bun workspaces monorepo, **14 packages** (`agent`, `cli`, `client`, `config`,
  `core`, `daemon`, `exec`, `k8s`, `mcp`, `protocol`, `providers`, `tools`,
  `transport`, `tui`), TypeScript strict, Biome. **Bun ≥ 1.4.3 required**
  (`engines.bun`; the compiled-binary worker path needs it — see the TODO entry).
  - `bun test` — full suite. **Baseline: all pass except the single opt-in
    live-k8s skip** (that skip is NOT a failure). The total grows with every
    task, so no exact count is pinned here — it only goes stale; run it, and any
    *new* fail (or a non-opt-in skip) is yours.
  - `bun run typecheck` — `tsc --noEmit`.
  - `bun run lint` — `biome check .` (checks TS/JS/JSON; not Markdown).
  - `bun run check` — typecheck **then** lint **then** test, in order (a
    typecheck failure short-circuits before tests run). Green before "done".
- **Lint baseline: clean (0 errors, 0 warnings).** `bun run lint` passes, so
  `bun run check` is green for lint; any new error/warning is yours. Common
  auto-fixable trips: `biome check --write <file>` for formatting; hand-fix
  `noDelete` (use a computed `delete obj[key]`) and `noAssignInExpressions`
  (make the arrow a block body).
- TUI stack: Ink 5.0.1, React 18.3.1, ink-testing-library 4.0.0.
- **Ink gotcha (already bit us once)**: an empty `<Text>` measures as `0×0`,
  so a per-row `<Text>` list collapses blank rows and shifts content up.
  Render blank rows as `" "` (the output grid `trimEnd()`s it back to `""`).
- **TUI repro from `/tmp`** (when the repo must stay untouched): bun cannot
  resolve bare/directory imports from `/tmp`, so import via absolute paths
  into the `.bun` store, and use `createElement` instead of JSX (avoids
  `react/jsx-runtime` resolution). The `+<hash>` store suffixes below drift on
  any dependency change — glob `node_modules/.bun` for the current directory
  rather than copying these verbatim:
  ```ts
  import { createElement as h } from "<repo>/node_modules/.bun/react@18.3.1/node_modules/react/index.js";
  import { Box, Text } from "<repo>/node_modules/.bun/ink@5.0.1+d2b1a511eef311f2/node_modules/ink/build/index.js";
  import { render } from "<repo>/node_modules/.bun/ink-testing-library@4.0.0+2b82e8ab9dffa8af/node_modules/ink-testing-library/build/index.js";
  import { App } from "<repo>/packages/tui/src/App.tsx"; // TS/TSX source: absolute paths work
  ```
- Git: commit **only on the user's explicit OK**; if on `main`, branch first
  (except the docs/index carve-out in §10).
- Docs: `README.md`, `ARCHITECTURE.md`, per-feature design docs under `docs/`.

## 7. Architecture invariants (mandatory — breaking one is a bug)

These are load-bearing. Verify you are not violating one *before* writing code;
each has bitten us. Cited symbols are the source of truth — read them, don't
assume.

- **TUI always over RPC — one session path.** Every runtime (in-process worker,
  pod `run`, pod `exec`, remote `connect`) drives the TUI through the SAME
  `RemoteClient` ↔ `Connection` stack (`createLocalRuntime`). The agent loop +
  tool execution run daemon-side, off the render thread. A new execution target
  adds **only a transport** (a `DuplexChannel`) + lifecycle — never a parallel
  agent loop or a second session code path. If you're copying the send/stream
  logic, stop: you're meant to reuse it.
- **Logic lives in pure modules; components only render.** Any decision with
  branching or computation — editing, history, selection, view projection, key
  routing — goes in a pure, React-free, unit-tested module (`editor.ts`,
  `history.ts`, `input-view.ts` are the pattern), so a behaviour is understood
  and tested in one place, not chased across components. A `.tsx` component is a
  dumb renderer: it maps a precomputed view-model to elements and owns only
  presentation (colours, glyphs, spacing). The split line: *computation/branching
  you'd want to test → pure module; "what it looks like" → component.* Don't push
  presentation into the view-model (that's just ceremony), and don't bury logic in
  a component "because it's small" — the TUI harness strips SGR, so render-time
  logic left in a component is often untestable, which is reason enough to extract
  it. (New code follows this; the `App.tsx` key handler is known debt to extract.)
- **Single-broker invariant.** Exactly ONE `PermissionBroker` instance is shared
  between the runtime (`RemoteClient`) and `startTui`. Two instances **silently**
  decouple: the daemon-side default `allowAll` auto-approves everything and the
  interactive prompt is never reached. See the invariant comment on `runPodTui`
  (`cli/main.ts`) and its regression test (a *separate* daemon-side broker spy).
- **Persistence lives on the laptop/main thread.** The daemon owns the live
  conversation; the main thread owns the on-disk JSON store. Read history back
  via `snapshot` after each turn/compaction and persist there; the main owns the
  session uid (passed into `session/new`) so `--resume` keeps the file. Persist
  only `ChatMessage`s — never rendering-only events (e.g. `steer`).
- **Model stays on the laptop (pod reverse-tunnel).** A pod reaches the model
  THROUGH us (`model/stream` over RPC, `ProxyModelProvider`): the daemon is given
  the LOCAL provider so the endpoint + API key never leave the laptop. Never put
  provider creds in a pod/image.
- **Protocol changes are additive; version stays 1.** Schemas in
  `@tentacle/protocol` are the shared truth. A new method → an old peer
  returns `MethodNotFound` (clean, catchable — handle it). A new `session/update`
  variant → a union member + its reverse mapping in `client/mapping.ts`. Wire
  BOTH ends (request and, if it streams back, the update). Don't bump the version
  for additive work. (Caveat: an unknown update *discriminant* is NOT silently
  ignored by an old client — only relevant for mixed-version `connect`.)
- **Don't serialize the RPC peer.** `transport/peer.ts` dispatches inbound
  requests concurrently (`void handleRequest`, no per-connection mutex) on
  purpose: a long-running `session/prompt` must not block a short
  `session/enqueue` / `session/request_permission`. Never add an await/lock that
  serializes `Connection` handlers.
- **Never write raw to the terminal while Ink owns it.** During a TUI session the
  alt-screen is Ink's. Startup diagnostics go through the single `StatusLine`,
  cleared with `finish()` *before* Ink mounts; daemon stderr is buffered
  (`createStderrSink`) and flushed only after unmount or on the pre-mount failure
  path; MCP server stderr is piped+routed, never `inherit`. A stray
  `process.stdout.write` mid-session corrupts the render.
- **Pod lifecycle.** `run` creates AND deletes its pod; the delete-on-exit net
  (`deletePodBestEffort`) survives `process.exit`/Ctrl+C via a detached child
  (`exit` handlers still fire; SIGINT routes through it). `exec` is user-owned:
  never create or delete, no exit net. Pass secrets to the child via **env, never
  argv** (argv is visible in `ps`).
- **Bun TLS + k8s specifics.** Bun honours per-call `tls:{ca,cert,key}` on
  `fetch` AND `WebSocket` (and `NODE_EXTRA_CA_CERTS`) — that's how cluster auth
  works with no `kubectl`. Use the `v4.channel.k8s.io` exec subprotocol; stdin
  EOF is a known byte count + command exit (`head -c N`), because v4 can't
  half-close stdin (v5 needs k8s ≥1.29 — don't adopt it as a drop-in).

## 8. Planning a change (write the plan, then follow it)

A feature/fix plan (a doc under `docs/`) must be *verified against the code*, not
narrated from memory. A plan that mis-states the code produces wrong work.

Writing it:
- **Verify every assumption against the source first**, citing `file:line`. Name
  the ONE assumption the change stands or falls on (e.g. "requests are dispatched
  concurrently") and prove it before anything else. If you can't cite it, you
  don't know it.
- Prefer the **additive, reuse-existing-seams** shape (§7). List the exact files
  with the smallest diff, in dependency order (protocol → daemon → client → cli →
  tui). Identify the shared source of truth and wire both ends.
- **Enumerate the failure modes**, not just the happy path: error, disconnect,
  race, empty input, version skew. For each, say how state converges. A silent
  drop is a bug — design it out or surface it.
- Sections: *Problem* (with evidence) · *Preconditions* (verified invariants it
  relies on) · *Design* · *Files to change* (exact) · *Tests* · *Validation* ·
  *Notes/debt* (what you deliberately left, and why).

Following it:
- Implement in the plan's order; run the **narrow** test file per slice (§4).
- If a step contradicts the code, **STOP and fix the plan**, don't force the code
  to match a wrong plan. Update the doc so it stays the source of truth.
- `bun run check` green before declaring done (§4), compared to the lint baseline
  (§6). Report honestly against §5.

## 9. Writing tests (don't fool yourself)

Tests complement §4; these are about *quality*, because a passing test can prove
nothing.

- **Red before green** (mandatory here): show the test failing on the buggy /
  unimplemented code first. A test green on both old and new code tests nothing.
- **Prove the exact property** that the change hinges on (§2), not a weaker
  correlate. When in doubt, confirm **non-vacuity by mutation**: temporarily break
  the code (or wire the wrong dependency) and confirm the test fails, then revert.
  The single-broker test was validated exactly this way.
- **Test the failure modes, not just the happy path** — error, reject, race,
  ordering, empty, boundary. A happy-path-only suite is the classic weak suite;
  the bug lives in the cases you skipped.
- **Use injectable seams and fakes**, not real I/O: injected `fetch`, fake
  `WebSocket` (`FakeWS`), fake spawner, `SpyBroker`/`SpyFakeCluster`, the mock API
  server. Match the existing fakes rather than inventing new ones. Drive async
  deterministically (`open()`/`receive()`/`tick()`); use small timeouts for
  timeout paths.
- Assert the **behavioral contract at the boundary**, not private implementation
  details (those churn).
- Repo style: double quotes, trailing commas, **no `!` non-null assertions**
  (assert conditionally, like the existing tests). Iterate on the single relevant
  file; full suite only before done.

## 10. Task workflow (one task, one living doc)

Every change — feature, fix, or evaluation — is a single task with a single
living doc. A **`feat`/`fix` changes code and gets a branch**; an **`eval` is a
decision record with no code and is committed directly to `main`** (no branch).
This formalises §8 (the plan) and §4/§5/§9 (verify/report/test) into one
lifecycle. It is mandatory.

- **One code task at a time.** Finish the current `feat`/`fix` (through Review)
  and merge it before starting the next; exactly ONE code-task branch off `main`
  at a time. (This is the rule that prevents the parallel-edit / merge-conflict
  mess.) `eval`s do **not** count — they carry no code, commit directly to
  `main`, and any number may be open at once.
- **Folders** under `docs/`, by type:
  - `docs/feat/` — a new capability or improvement, including an **approved**
    refactor or perf change.
  - `docs/fix/` — a defect in existing behaviour.
  - `docs/eval/` — under evaluation: a question being decided (a migration, a
    refactor/perf idea not yet approved). May never be built. An `eval` carries
    **no code** and is committed **directly to `main`** (no branch); any number
    may be open at once.
  A refactor/perf task goes in `feat/` if already approved, `eval/` if still
  being decided. An `eval` that gets approved is **promoted**: `git mv` its doc
  into `feat/` (or `fix/`) **and open the code branch then** — the move is the
  decision.
- **Branch ↔ doc (`feat`/`fix` only), 1:1.** A `feat`/`fix` has branch
  `<type>/<slug>` and doc `docs/<type>/<slug>.md`, same slug, branched off
  `main`. An `eval` has only its doc (`docs/eval/<slug>.md`), committed to `main`
  with no branch. Either way, commit only on explicit OK (§6).
- **The doc has four sections** (copy `docs/TASK-TEMPLATE.md`), each **signed by
  the model that wrote it** — `*— <model-id>, <date>*` — so we can see which
  model did what on a task and how it behaved, and spot drift:
  1. **Context** — why the task exists: problem + evidence, constraints, the
     decision it serves. For an `eval`, the exact question being decided.
  2. **Implementation** — the plan per §8, source-verified (`file:line`),
     structured as §8 sub-sections: **load-bearing assumption · preconditions ·
     design · files · failure modes · tests**. Approved before Execution starts.
     (The §8 seven-part plan lives *here*; a legacy plan's Problem → Context,
     Validation → Execution/Review, Notes/debt → Review.)
  3. **Execution** — the as-built: what was actually done, in order, and **any
     drift from Implementation** (and why). Honest facts, not a re-narration.
  4. **Review** — an **adversarial** pass, never a rubber stamp: re-run the gate
     (`bun run check`, §4), red-team the Implementation's failure modes, confirm
     test non-vacuity (§9). Ideally in a **fresh context** (a subagent or
     `/code-review`) to avoid self-approval. State what holds, what does not, and
     how the implementing model behaved.
- **Size every task on two independent axes** (they are not the same — a
  one-line change in a load-bearing path is small but dangerous; a pile of
  isolated new code is large but safe):
  - **Size** (effort): `S` (one file/module, known approach, ≲50 lines, own
    tests) · `M` (a few files / one package, some design) · `L` (many files or a
    new subsystem/seam, cross-cutting tests). There is **no `XL`** — an XL task
    must be **split** into S/M/L sub-tasks (it would break "one legible branch").
  - **Blast radius** (reach if it breaks), by what it touches: `contained`
    (pure/leaf code in one module; no change to a public API, protocol schema,
    persisted format, or terminal/IO path; behaviour pinned by its own tests) ·
    `cross-module` (a shared util / several packages / a widely-used component;
    still no wire/persistence/invariant change) · `load-bearing` (touches a §7
    invariant, the agent loop, or a seam many depend on).
  Record both in a one-line metadata block at the top of the doc and in the
  `TODO.md` index: `Type: … · Size: … · Blast: … · Suited: …`.
- **Blast radius gates who executes and how hard Review is** — this repo is
  driven by a MIX of models (a strong one and a local Qwen3 27B), and the
  dangerous combination is *high blast × weak model* (the silent-breakage zone:
  the `fs_edit`-corruption / session-poison class we have hit):
  - `contained`, S–M → a weaker model may execute; standard in-context Review.
  - `load-bearing` (any size) **or** `L` → a stronger model executes (or split
    first), and Review is **mandatory fresh-context** (a sub-agent or
    `/code-review`) that red-teams the §7 invariant the change touches.
- **Lifecycle (`feat`/`fix`):** Context → Implementation (approved) → Execution
  → Review → merge. An **`eval`** is just Context + a Review verdict, committed
  straight to `main` (no branch, no merge); its Implementation/Execution stay
  empty until it is promoted (which opens the code branch).
- **Index & registries:** `TODO.md` is the backlog/index — each item links its
  task doc. `docs/library-bugs.md` is the cross-cutting upstream-bug registry (a
  reference, not a task). Docs under `docs/` predating this standard are legacy;
  new work uses this structure.
- **Docs & index edits are not code tasks (carve-out).** A blast-nil Markdown
  file that carries no code — `TODO.md`, `docs/library-bugs.md`, a folder
  `README`, a standalone decision/notes doc, or **an `eval` doc
  (`docs/eval/<slug>.md`)** — is committed **directly to `main`**, no branch and
  (for loose notes) no four-section doc. This is the exception to §6's "if on
  `main`, branch first": a branch exists to protect *code* from parallel-edit /
  merge conflicts, and prose that touches no code, test, or build path has no
  such blast (Biome does not lint Markdown, §6). **NOT** carved out: (a) a
  **`feat`/`fix` task's own doc** (`docs/feat|fix/<slug>.md`) — it rides that
  code task's branch (an `eval` doc does **not**: it is a direct-to-`main`
  record); (b) a Markdown edit **bundled with a code change** — it rides that
  code's branch; (c) a **substantive change to this file's rules** — those shape
  how everyone works, so they stay a `feat` task with the reasoning trail and
  Review (a typo/link/formatting fix to any doc is fine direct). Unchanged: every
  direct commit still needs the user's explicit OK (§6) — the carve-out removes
  the branch, not the OK. When unsure "does this change code or a rule?", treat
  it as a code task.
- **Agent briefs:** a fresh agent spawned to execute or review a task is given
  `docs/EXECUTOR-BRIEF.md` / `docs/REVIEWER-BRIEF.md` — the spawn-time
  choreography (read AGENTS.md + the task doc, then do / adversarially attack).
  They operationalise this section; they do not restate its rules. A fresh agent
  starts with only its `PROMPT.md`, so the brief is the channel that primes it.
