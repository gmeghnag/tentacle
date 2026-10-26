# fix/agent-defs-warn — warn (not silently drop) invalid `model`/`contextWindow` in a sub-agent definition

> **Status:** done
> **Branch:** `fix/agent-defs-warn`
> **Type:** fix · **Size:** S · **Blast:** contained · **Suited:** weaker model + standard in-context Review

## Context

*— qwen3.8-27b (tentacle), 2026-10-26*

`parseAgentDefinition` (packages/agent/src/agent-defs.ts) parses a user's
sub-agent definition (`<configDir>/agents/*.md` plus each package `agents/` dir).
Two frontmatter fields are validated and, on failure, **silently ignored**:

- `model` — kept only when a non-empty string (agent-defs.ts:72); a non-string
  (e.g. the frontmatter list `[oops]`) or an empty string is dropped with no signal.
- `contextWindow` — kept only when a positive whole number of tokens
  (agent-defs.ts:73-78); anything else (`"abc"`, `0`, `1.5`, …) is dropped with
  no signal.

A user who typos `contextWindow: abc` (or writes `model: [foo]`) gets an agent
that quietly loads with the *parent's* window / default model — the exact "silent
drop is a bug" case AGENTS.md names. There is no warning anywhere in the load
path: `loadUserAgentTypes` (packages/cli/src/wiring.ts) only reports name
clashes, built-in shadowing, and *parse* errors — never a dropped field.

**Repro** (ran on `main` `c00f5c2`, 2026-10-26). Script lives at
`/Users/gmeghnag/tentacle/.tentacle/tmp/agent-defs-warn/repro.ts` (gitignored
per AGENTS §6), so pasted in full here:

```ts
// Repro for fix/agent-defs-warn: an invalid `model` / `contextWindow` in a
// sub-agent definition's frontmatter is dropped SILENTLY — the user gets no
// warning, on the load path or anywhere else.
//
// Run:  bun /Users/gmeghnag/tentacle/.tentacle/tmp/agent-defs-warn/repro.ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserAgentTypes } from "../../worktrees/agent-defs-warn/packages/cli/src/wiring.ts";

const root = await mkdtemp(join(tmpdir(), "agent-defs-warn-"));
const cfg = join(root, "cfg");
const agents = join(cfg, "agents");
await mkdir(agents, { recursive: true });
await writeFile(
  join(agents, "reviewer.md"),
  "---\nname: reviewer\ndescription: Review a diff.\nmodel: [oops]\ncontextWindow: abc\n---\nYou review code.",
);

try {
  const { types, diagnostics } = loadUserAgentTypes(cfg);
  const t = types[0];
  const droppedModel = !("model" in (t ?? {}));
  const droppedWindow = !("contextWindow" in (t ?? {}));
  console.log("types[0]     =", JSON.stringify(t));
  console.log("diagnostics  =", JSON.stringify(diagnostics));
  console.log(
    `SILENT DROP: model dropped=${droppedModel}, contextWindow dropped=${droppedWindow}, ` +
      `diagnostics.length=${diagnostics.length}` +
      (diagnostics.length === 0 && droppedModel && droppedWindow
        ? "  <- BUG: fields ignored with NO warning to the user"
        : "  (a warning IS surfaced)"),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
```

Observed output (buggy code):

```
types[0]     = {"name":"reviewer","description":"Review a diff.","prompt":"You review code.","tools":"all"}
diagnostics  = []
SILENT DROP: model dropped=true, contextWindow dropped=true, diagnostics.length=0  <- BUG: fields ignored with NO warning to the user
```

The agent loads with `model` and `contextWindow` absent (→ parent's defaults),
and **zero diagnostics**. After the fix the same run prints two `[agents]`
lines naming the file and each field (see Execution).

## Implementation

*— qwen3.8-27b (tentacle), 2026-10-26*

### Load-bearing assumption

The fix stands or falls on **the load diagnostics already reaching the user on a
pre-Ink, stderr path that this change only feeds into — not on inventing a new
delivery mechanism.** Proven: `loadUserAgentTypes` returns
`{ types, diagnostics }` (wiring.ts:98-137) and `main.ts` prints every
diagnostic to stderr as `[agents] <line>` **before any Ink mount**, inside the
`mode !== "run" && mode !== "attach"` block (main.ts:348-365):

```
const agentTypes = loadUserAgentTypes(config.configDir, config.packageAgentDirs);
for (const line of agentTypes.diagnostics) {
  writeErr(`[agents] ${line}\n`);
}
```

So the entire fix is *producing* the right strings and appending them to
`diagnostics`; the delivery path (stderr, pre-Ink, §7-safe) is reused verbatim,
exactly as skills use `config.skillDiagnostics` → `writeErr("[skills] …")`
(main.ts:349-351). Nothing writes raw to the terminal while Ink owns it.

### Preconditions

- **`parseAgentDefinition` is pure and directory-agnostic** (agent-defs.ts:1-16
  doc; "Pure — directory loading lives in the wiring layer"): it never knows the
  file path. So it can name the *field* and the *value* but **not** the path —
  the path is the wiring layer's to add. This is what forces the
  two-level (pure warnings → caller prefixes path) shape.
- **The field-drop semantics stay identical** (agent-defs.ts:72, 73-78): a bad
  `model` / `contextWindow` is still *ignored* and the agent still loads. The fix
  adds a warning; it does not change what gets kept/dropped. `AgentType`
  (packages/agent/src/subagent.ts:27-41) is unchanged.
- **The `diagnostics: string[]` array is the shared seam** — every other load
  problem (clash, shadowing, parse error) is a plain string in it
  (wiring.ts:117-124, 127-130, 133), so appending field warnings there is
  additive and needs no new return shape.
- **`main.ts` is the only place `loadUserAgentTypes` diagnostics are consumed**
  for user display (main.ts:359-365). `buildAgent` (wiring.ts:293-296) calls it
  too but only reads `.types` and discards diagnostics — that path is unchanged
  and stays warning-free (it runs *inside* a session, where we must not write to
  the terminal).

### Design

Reuse the existing diagnostic seam end-to-end; no new delivery path:

1. **`parseAgentDefinition` returns the warnings** (pure): new return type
   `{ type: AgentType; warnings: string[] }`. For each dropped field it pushes a
   field-scoped, value-carrying message (the file is NOT named here — the
   function is path-free):
   - `model` → ``model "<raw>" ignored — expected a non-empty string``
   - `contextWindow` → ``contextWindow "<raw>" ignored — expected a positive whole number of tokens``
   A valid or absent field pushes nothing (absent stays silent; we only warn on a
   *present-but-invalid* value).
2. **`loadUserAgentTypes` prefixes the path and appends to `diagnostics`:**
   after parsing, `for (const w of r.warnings) diagnostics.push(`agent "${r.type.name}" (${path}): ${w}`)`.
   The agent's *effective* name (`r.type.name`) is used — the frontmatter name if
   given, else the filename — so the warning matches the agent the user sees.
3. **No change to `main.ts`**: it already prints `diagnostics` as `[agents] …`
   to stderr pre-Ink. The final user-visible line becomes, e.g.:
   `[agents] agent "reviewer" (/…/agents/reviewer.md): contextWindow "abc" ignored — expected a positive whole number of tokens`.

Both ends of the shared truth are wired: the parser *names the field*, the
loader *names the file*, and the existing `main.ts` loop *delivers*.

### Files

Smallest diff, dependency order (agent → cli):

- `packages/agent/src/agent-defs.ts` — `parseAgentDefinition` returns
  `{ type, warnings }`; collect the two field warnings. (Pure; no I/O.)
- `packages/cli/src/wiring.ts` — `loadUserAgentTypes` prefixes each returned
  warning with `agent "<name>" (<path>): ` and appends to `diagnostics`.
- Tests: `packages/agent/test/agent-defs.test.ts`, `packages/cli/test/wiring.test.ts`.
- No protocol, no daemon, no client, no tui, no `main.ts` change.

### Failure modes

- **Valid / absent fields** → `warnings` empty; no spurious warning (a user who
  simply omits `model`/`contextWindow` is not nagged). Converges to today's
  silent-omission behaviour.
- **Both fields invalid in one file** → two warnings, one per field, both
  carrying the same path/name. Order: `model` then `contextWindow` (deterministic).
- **Parse *error* (throw) on a package file** → unchanged: the `catch` still
  pushes its own `…skipped (…)` diagnostic and `continue`s, so no field warnings
  are produced for an unparseable file (there is no parsed type to warn on).
- **Name clash / built-in shadowing** → the `continue` paths are untouched; a
  field warning on a *clashing* file is emitted **before** the clash `continue`
  only if we push warnings first. Design decision: emit the field warnings
  immediately after parse (before the clash check), so a clashing file with a bad
  field reports both its field warning and the clash — both are true. (No state
  divergence: both are just strings appended to the same array.)
- **`run`/`attach` (pod)** → `main.ts` skips the whole `diagnostics` block
  (main.ts:348), so the pod session is unaffected — consistent with skills.
- **`buildAgent` (in-session) path** → still discards diagnostics
  (wiring.ts:295); no terminal write mid-session (§7 preserved).

### Tests

Red-before-green (AGENTS §9). Exact property each test pins:

- **agent-defs (pure, property = the warning string + that the field is still
  dropped):** for `model: [oops]` and `contextWindow: abc`, `parseAgentDefinition`
  returns `warnings` naming the field and the raw value, and `type` still lacks
  the field. Also: a *valid* value → `warnings` empty (no false positive).
  Non-vacuity by mutation: if the field were *kept* (wrong) or the warning
  *omitted* (wrong), the assertions on `warnings.length`/`type` fail.
- **wiring (property = the path+name prefix lands in `diagnostics` and is
  delivered):** a `<configDir>/agents/reviewer.md` with both bad fields yields
  `diagnostics` containing the full
  `agent "reviewer" (<path>): …` lines, and `types[0]` still loads. This pins the
  caller's prefixing — the part the pure parser cannot prove.
- **main (property = it reaches stderr, not stdout, pre-Ink):** extend the
  existing skill-diagnostics E2E to assert an `[agents] agent "reviewer" …` line
  appears on `writeErr` for a one-shot mode and never on `write` (stdout). This
  pins the *delivery* seam (the load-bearing assumption) end-to-end.

## Execution

*— qwen3.8-27b (tentacle), 2026-10-26*

As-built (order), with red→green evidence and the gate. Any drift from
Implementation is called out honestly.

1. **Repro on `main` `c00f5c2`** (before any edit): the Context script printed
   `diagnostics = []` with both fields dropped — silent. (Output above.)
2. **Tests first (RED on the property, not on a compile error):**
   - `packages/agent/test/agent-defs.test.ts`: 2 new tests (+ 3 existing
     call sites updated to destructure `{ type }`). On buggy code: the new
     "invalid … yield a warning" test failed with `warnings === undefined`
     (expected the two field strings); "valid/absent → no warnings" failed with
     `undefined` vs `[]`. RED.
   - `packages/cli/test/wiring.test.ts`: new `dropped-field warnings` describe
     (2 tests). RED: `diagnostics` was `[]`, expected the two prefixed lines.
   - `packages/cli/test/main.test.ts`: new E2E test reusing the skill-diagnostics
     pattern (io capture, help path → code 1, then `run` → no diagnostics).
     RED: `err` was `[]`, expected the two `[agents] …` stderr lines.
3. **Fix** (in the Implementation's dependency order):
   - `packages/agent/src/agent-defs.ts` — `parseAgentDefinition` now returns
     `{ type, warnings }`; added `rawValue` helper (agent-defs.ts:71); field
     warnings collected at :95-108 (present-but-invalid → warn, absent → silent).
     The keep/drop semantics (lines :90, :100) are byte-identical to before.
   - `packages/cli/src/wiring.ts` — `loadUserAgentTypes` parses once, takes
     `.type`, and prefixes each warning `agent "<name>" (<path>): ` into
     `diagnostics` (wiring.ts:116-122).
   - **No change to `main.ts`** — its existing `for (line of agentTypes.diagnostics)
     writeErr("[agents] …")` loop (main.ts:363-365) delivers them, pre-Ink, to
     stderr. This is the reused seam the task required.
4. **GREEN:** `bun test packages/agent/test/agent-defs.test.ts
   packages/cli/test/wiring.test.ts packages/cli/test/main.test.ts` → 43 pass,
   0 fail. Repro re-run now prints:
   `diagnostics = ["agent \"reviewer\" (…/reviewer.md): model [oops] ignored —
   expected a non-empty string", "agent \"reviewer\" (…/reviewer.md):
   contextWindow \"abc\" ignored — expected a positive whole number of tokens"]`
   with `model`/`contextWindow` still absent from `types[0]` (behaviour kept).
5. **Non-vacuity by mutation** (one mutation per key test, each restored):
   - *Wiring* — commented out the `diagnostics.push` of field warnings: the
     wiring "warns with the agent name + path" test went RED (diagnostics `[]`),
     restored.
   - *Parser* — omitted the `contextWindow` warning push: the agent-defs "invalid
     model and contextWindow each yield a warning" test went RED (one warning
     instead of two), restored.
6. **Gate:** `bun run check` → **green**: `tsc --noEmit && tsc -p apps/mobile`
   clean; `biome check .` clean (485 files; one formatter nit on a wrapped
   ternary fixed with `bunx biome check --write`); `bun test` →
   **2904 pass / 2 skip / 0 fail** (222 files, ~120 s; the 2 skips are the
   opt-in live-k8s and slow-socket tests, not failures).

**Drift (honest):**
- **Two slips during mutation testing (this was two, not one — under-reported
  here).** Each time I *restored* a mutated file with `git checkout -- <file>`,
  in this worktree it reverted to the committed baseline (which lacked the fix),
  silently discarding the implemented fix in `agent-defs.ts` and `wiring.ts`.
  This happened **twice** before it was noticed; caught on the post-mutation
  `git status` (the two source files showed clean). The fix was re-applied
  verbatim and re-verified (43/43 green, repro shows both warnings). Lesson: in
  a worktree with uncommitted changes, "restore" a mutation with a `cp` backup —
  never `git checkout --`.
- Warning format for an array `model` is `[oops]` (items' quotes were stripped by
  `parseFrontmatter`; re-quoting each item was not worth it) — the tests pin the
  exact string. No other drift; the design's file list and ordering were followed.

### Fix 1 (Review nits)

*— qwen3.8-27b (tentacle), 2026-10-26*

Addressing the Review's nits (2, 3) and the doc-honesty findings (1, 4). No
protocol, daemon or TUI change; `main.ts` untouched again.

1. **Accurate message for a 10-digit `contextWindow`** (Review finding 2,
   `agent-defs.ts:105-107`). `9999999999` is a positive whole number but is
   rejected by the pre-existing 9-digit cap (`/^[0-9]{1,9}$/`), so the old
   "expected a positive whole number of tokens" was misleading. Added a branch:
   when the value is 10+ digits it now reads
   `contextWindow "<raw>" ignored — exceeds the 9-digit cap (max 999999999 tokens)`;
   every other invalid value keeps the original wording. The keep/drop logic is
   untouched (the regex still decides what is kept); only the *warning string*
   gained the case.
   - **RED first:** new `agent-defs` test `the 9-digit cap: …` failed on the
     buggy code — received `…expected a positive whole number of tokens`,
     expected `…exceeds the 9-digit cap (max 999999999 tokens)`.
   - **GREEN:** `9 pass / 0 fail` (agent-defs file). `999999999` (9 digits) is
     still kept with no warning; `9999999999` is still dropped.
2. **Missing tests** (Review finding 3). Both pin already-correct behaviour the
   suite had not exercised — green on first run (no code change needed):
   - `wiring`: `a clashing package file warns its bad field BEFORE the clash
     line` — pins the field-warning-before-clash ordering the Failure modes chose
     (a *package* file that both clashes and has a bad field).
   - `wiring`: `a dropped field in a package dir warns with the package path` —
     pins that a warning carries a **package** dir path, not only
     `<configDir>/agents`.
   - **Non-vacuity (mutation, restored with `cp` + `shasum`):** I hoisted the
     field-warning push to *after* the clash `continue` in `wiring.ts`; the
     ordering test went **RED** (clash line preceded the field warning).
     Restored — `wiring.ts` `shasum` back to `8d5369a9…`.
3. **Doc honesty (findings 1, 4).** Corrected the Execution Drift note from
   "one slip" to **two** `git checkout --` wipes (and to the `cp`-backup
   lesson); corrected "3 new tests (2 new + …)" → 2; added the missing `Type:`
   to the metadata line.

**Gate (re-run):** `bun run check` → **green** (typecheck clean; `biome check .`
485 files, no fixes; `bun test` **2907 pass / 2 skip / 0 fail** — 3 more pass
than the pre-nit gate, the three new tests). Narrow: the 3 touched test files →
**46 pass / 0 fail** (was 43).

## Review

*— claude-opus-5-5, 2026-10-26* (fresh context; a different model family from
the executor, qwen3.8-27b)

**Verdict: APPROVE-WITH-NITS.** The code is complete and correct, and it reuses
the existing diagnostics seam. Every claim in Execution that I re-ran holds. The
nits below are optional and none blocks the merge. **Executor grade: A**
(merge as-is), with one process blemish (finding 1).

**Gate (re-run by me):** `bun run check` → typecheck clean; `biome check .`
485 files, no fixes; `bun test` **2904 pass / 2 skip / 0 fail** (2906 tests, 222
files, 121.8 s). The two skips are the opt-in ones. Narrow run: the 3 touched
test files → 43 pass / 0 fail. Both match Execution exactly.

**Final code is complete (the `git checkout --` incident).** The working tree
has the full fix in both source files: `rawValue` + the two
present-but-invalid checks at `agent-defs.ts:71-108`, and the prefixing loop at
`wiring.ts:116-122`. The tests are green against it.

**Mutations (mine, restored with a `cp` backup, not git):**
1. `agent-defs.ts`: model warning condition → `if (model === undefined)` (warns
   on an absent field) → the agent-defs test "valid or absent fields yield no
   warnings" **FAILS**, along with 2 existing wiring tests. Restored.
2. `main.ts:348`: guard → `if (true)` (diagnostics also printed for `run`/`attach`)
   → the new main E2E test **FAILS** on its `run` leg, and so does the skills
   one. Restored.
After restoring, `shasum` matches the pre-mutation hashes byte for byte:
`agent-defs.ts 7cb1bb9f…`, `main.ts 1dd28199…`, `wiring.ts 8d5369a9…`.
`git status` is unchanged.

**Premise table**

| Premise | Verdict |
|---|---|
| Context symptom: bad `model`/`contextWindow` dropped with 0 diagnostics (main `c00f5c2`) | TRUE: on main, `parseAgentDefinition` returns a bare `AgentType` and has no warning channel. My trace on the fix shows the same file now gives 2 diagnostics. |
| `agent-defs.ts:72` model rule, `:73-78` contextWindow rule (main) | TRUE (`:72`, `:74-78`) |
| `parseAgentDefinition` is pure and path-free (`agent-defs.ts:1-16` doc) | TRUE, and it stays pure: no I/O was added and the path is added by the caller |
| `loadUserAgentTypes` returns `{types, diagnostics}` (wiring.ts:98-137) | TRUE |
| main prints `[agents]` to stderr pre-Ink, only outside `run`/`attach` (main.ts:348-365) | TRUE. Every `startTui(` call (main.ts:509/669/724) comes after it |
| `buildAgent` reads only `.types` (wiring.ts:293-296 main) | TRUE (`:290-296`; now `:301`). Diagnostics are discarded in-session |
| `AgentType` unchanged (subagent.ts:27-41) | TRUE |

**Attacks tried**
1. *Terminal-IO (§7) in each mode.* **TUI / one-shot**: the warning is a
   `diagnostics` string, printed by the existing `writeErr("[agents] …")` loop
   before any Ink mount. **`serve` / `serve --stdio`**: the same block runs
   before the serve branch and writes to stderr, never stdout (stdout is RPC
   there). **Pod `run`/`attach`**: the block is skipped, and mutation 2 proves
   the test pins this. A pod daemon's own `[agents]` lines take the existing
   `createStderrSink` path (pod-runtime.ts:316/468). No new write site.
   **Holds.**
2. *Behaviour otherwise unchanged.* I traced 11 edge inputs through the real
   parser: `model:`, `[]`, `""`, `contextWindow: 0/1.5/-5/1e5/9999999999/""/[1]`
   each warn and are still dropped. `"32000"` (quoted) is still kept with no
   warning. An absent field stays silent. A package file that clashes with the
   user's own still loads the first, and the fields are still dropped.
   **Holds.**
3. *Wording.* A real trace gives
   `[agents] agent "reviewer" (<abs path>): contextWindow "abc" ignored — expected a positive whole number of tokens`.
   It names the agent, file, field, raw value and expected form. **Holds**,
   with nit 2.
4. *Non-vacuity.* Both mutations went red, and the executor's two mutations are
   plausible from the code. **Holds.** Weak spot: the parser-level RED in
   Execution was partly a return-shape failure (`warnings === undefined`), which
   is close to a compile error. The mutations are the real proof, and they hold.
5. *Clash + bad field in a package dir.* The shadowed package file emits its
   field warning AND the clash line, in that order. The design chose this and
   documents it, and both lines are true. **Holds** (nit 3: untested).

**Findings**
1. *(process / doc honesty, low)* Execution says "one slip". The owner reports
   that `git checkout --` wiped the fix **twice** before it was noticed. The
   final state is correct, but the Drift note under-reports. It belongs in the
   scorecard: restoring a mutation with git in a dirty worktree is a real hazard
   for this model.
2. *(nit, low)* `agent-defs.ts:105-107`: `contextWindow: 9999999999` is a
   positive whole number, but it is rejected by the existing 9-digit cap
   (`/^[0-9]{1,9}$/`). The message "expected a positive whole number of tokens"
   is then misleading. Either mention the cap or accept it. The cap itself
   predates this task.
3. *(nit, low)* Test gaps: nothing pins the field-warning-before-clash ordering
   that the Failure modes chose, or a warning from a **package** dir path (only
   `<configDir>/agents` is tested).
4. *(nit, doc)* Execution step 2 says "3 new tests (2 new + …)", but agent-defs
   gained 2. The header says `Status: done` before Review. The metadata line
   lacks `Type:`.

**What holds:** the pure-module split (the parser names the field, the wiring
names the file, main delivers); no protocol, daemon or TUI change; the drop
semantics are byte-equivalent; the repo test style is followed (double quotes,
no `!`, `types[0] ?? {}`).

**How the executor behaved:** strong on plan quality. The premises are cited and
every one I checked is true. It named the load-bearing assumption, reused the
seam instead of inventing a delivery path, and enumerated failure modes
(including pod and in-session). It added an E2E stderr-vs-stdout test copied from
the skills pattern, and its gate report is exact. Weak on execution hygiene: it
twice destroyed its own uncommitted fix with `git checkout --`. It recovered
correctly, but under-reported the incident. A few small inaccuracies in the doc.
