# fix/run-rm-flag — `run --rm` replaces `run --keep`; `-d` for `--detach`

> **Status:** execution done on main 171e06b (plan approved by the owner 2026-11-06), awaiting fresh-context Review
> **Branch:** `fix/run-rm-flag`
> **Type:** fix · **Size:** L · **Blast:** load-bearing · **Suited:** a STRONG model executes (or split, see Files); Review MANDATORY in a fresh context, red-teaming the §7 pod-lifecycle invariant and the on-disk-record rule (AGENTS §10: load-bearing, any size). Raised from S–M / cross-module by owner answer 2: the internal `keep` field becomes `rm` in persisted records, the relay spec and the delete decision (`attach-plan`, `relay-state`, `attach-run`), with a `RUN_STATE_VERSION` bump.
>
> *— claude-sonnet-5-5, 2026-11-05*
> *— claude-sonnet-5-5, 2026-11-06* (refresh)
> *— claude-opus-5-5, 2026-11-06* (execution; Implementation corrected for drift, see "Drift at execution")

## Context

*— claude-sonnet-5-5, 2026-11-05*

Owner decisions (TODO.md:442, 2026-11-04) — FINAL, not reopened here:

- `run --keep[=true|false]` is replaced by `--rm`, as in docker/podman/kubectl:
  the default KEEPS the workload; `--rm` removes it when the run ends.
  `--detach --rm` = removed when the run ends.
- Config `keep: false` → `rm: true`; `--rm=false` only overrides the config.
- No `--remove` alias, no `--keep` compat (pre-public; CHANGELOG line).
- Update help, README, the `still running · removed when the run ends` line,
  `docs/attach-detach-behaviour.md`.
- `-d` becomes the short flag of `--detach`.
- Runs after `fix/cli-output-streams` (done, bd2e5a3) and on top of
  `feat/tui-target-badge` and `fix/stale-pod-binary`.
- **Owner answer 2 (2026-11-05) overrides the first plan:** the internal `keep`
  field is renamed to `rm` everywhere (polarity `rm = !keep`), with a
  `RUN_STATE_VERSION` bump. Answers 1 and 3 stand. Round 2: **B confirmed**;
  **N1: `keepHint` → `resumeHint`** (decided, see Design 7).
- **Line numbers:** every cite in Implementation was re-verified on `main`
  8bcca6a (2026-11-06; see "Refresh drift" below). If another branch lands first,
  re-find by text, never by number.

**Evidence (main):** `parseArgs(ARGS.run)` accepts `keep` as an optional-value
flag (`flags.ts:55`, `:126`) and `detach` with no short (`flags.ts:125`). The
config key is `keep` (`config/src/schema.ts:295`). `docs/attach-detach-behaviour.md:40`
already lists "`--rm` instead of `--keep`, `-d` for `--detach`: today `unknown option`".

**Repro (the feature is missing)** — to be pasted with output by the executor, on
current `main`, from `.tentacle/tmp/run-rm-flag/`:

```sh
bun packages/cli/src/index.ts run --image x --rm        # expect today: unknown option --rm
bun packages/cli/src/index.ts run -d "hi" --image x     # expect today: unknown option -d
```
(Executor: confirm the entry point name with `rg -n "main\(" packages/cli/src/index.ts`
and paste the real output + date; both are one-line `parseArgs` results and can be
captured through `parseArgs(["--rm"], ARGS.run)` if the CLI needs a cluster.)

## Implementation

*— claude-sonnet-5-5, 2026-11-05*
*— claude-sonnet-5-5, 2026-11-06* (refresh)

### Drift at execution (2026-11-06, main 171e06b) — *claude-opus-5-5*

The code contradicts the refreshed plan in one place, so the plan is fixed here
(§8), not the code:

- **The relay wake cap is gone** (`fix/autowake-unbounded`, merged e0a5798):
  `RELAY_WAKE_LIMIT`, `relayWakeCapped`, `sayCapped` and the `R-W10*` tests no
  longer exist. Every cap item below (the "Wake cap" failure mode, the
  `R-W10b` `rm:false` twin, the "move the `rm` row above the cap row" mutation,
  `netSaved` "vs the cap") is **void** and was not implemented. Its successor in
  `exitPlan` is the **wake-pending `hold` row** (`relay-state.ts:308-311`), which
  sits BEFORE the `rm` row (`:312`) exactly as the cap row did; the mutation
  "move the `rm` row above the wake-pending row" replaces the cap mutation
  (a kept run with a pending wake must `hold`, `relay-state.test.ts` "a pending
  wake holds, rm or not").
- Line numbers moved again (`relay.ts` `:233,335,447,555,557,596`;
  `relay-state.ts` `needsUse` `:285`, `exitPlan` `:299`); re-found by text.
- `fix/tool-output-location` and `fix/parallel-agents-followups` touch none of
  the sites.
- **Load-bearing assumption re-verified first** (before any edit): the full hit
  list `rg -n "\bkeep\b|keepHint|ownerKeeps|resolveKeep|\bKEEP\b|keep=(true|false)|--keep|keep:|\.keep\b" packages/cli/src packages/config/src`
  showed exactly the Design-7 consumers (minus the cap), no other reader of the
  boolean; after the rename the same `rg` shows only unrelated English
  ("keep the resolved path", `keep-id`, …) — see Execution.

### Refresh drift (2026-11-06, main 8bcca6a)

Design: **no change forced by the code.** What moved or changed meaning:

- **Line numbers** moved by +8…+27 in `relay.ts`, `attach-run.ts`, `kept.ts`,
  `kept-cmd.ts`, `schema/resolve/load/defaults.ts`, `flags.ts` (−4), `engine-runtime.ts`
  (+3) — all re-cited below.
- **`relay-state.ts` was rewritten** by `fix/detached-autowake`: `needsUse`/`exitPlan`
  moved from `:239-262` to `:306-335` and `exitPlan` gained a wake-cap row
  (`:329-334`, `RELAY_WAKE_LIMIT`) BEFORE the `keep` row (`:335`). Meaning for this
  change: unchanged polarity test, but a new place where `keep=false` must keep the
  workload (see Failure modes → "Wake cap"). Nothing new reads `keep` besides the
  sites listed; `runFinished` (`run-state.ts:488`), `kept.ts:323` (`finished`),
  `kept-cmd.ts:225,397` read only owner `state`/liveness, never `keep`.
- **`relay.ts`**: the exit-net arming now has a save gate, `netSaved` (`:295`, set
  `:380`), at BOTH arming sites, which are `!spec.keep` tests (`:336`, `:463`); the
  "not saved" note for `keep=true` is `:616`. All become `spec.rm` / `!spec.rm`.
- **`keepHint` rename is now decided (N1 = `resumeHint`)**, so Design 7 no longer
  says "stays": ≈56 lines in `main.ts`, `engine-runtime.ts` and 3 test files.
- **Counts** re-measured (Design 7 / Files); the hit lists of comments were
  re-located.
- `docs/attach-detach-behaviour.md` gained the autowake row `:118` and line refs
  `:175-187` that are already stale versus `main` (not this task's to fix, except
  where this change moves them).

### Load-bearing assumption

**`rm` becomes the only name of the concept below the CLI, and no layer inverts
it.** After the rename `rm === true` means "the workload is removed when the run
ends" in the config, the flag, the owner record, the relay spec, `exitPlan`,
`quitPlan` and `ps`. There is no flip at all (the first plan had one), but every
*consumer* of the boolean must change its test (`!spec.keep` → `spec.rm`,
`plan.keep` → `!plan.rm`, …); a missed or doubly-inverted site silently turns
"keep my workload" into "delete it" (or the reverse). That is what the change
stands or falls on, and why the blast is load-bearing: the sites are the delete
decision of a detached run and of a TUI's quit (AGENTS §7 "Pod/container
lifecycle"). Pinned by tests with BOTH values at every site and by mutations.

Where the field lives *(re-cited on 8bcca6a)*:

- owner record: `run-state.ts:81` (type), `:208` (read), `:406-408` (`ownerKeeps`);
  relay spec: `run-state.ts:112` (type), `:354` (strict parse), `:366`;
- relay: `relay.ts:234` (record write), `:336` (arm the net at start,
  `!spec.keep`), `:463` (re-arm after a hand-over leaves, `!spec.keep`), `:571`
  (`needsUse(model, spec.keep)`), `:573` (`exitPlan(model, spec.keep, use)`), `:616`
  (`spec.keep &&` the keep=true `not saved` note); `relay-state.ts:306-307`
  (`needsUse`, `!keep &&`), `:320` (`exitPlan` param), `:335`
  (`if (keep || model.linkStopped)`), comment `:210`;
- plan/quit: `attach-plan.ts:43,75,80,109`; `attach-run.ts:440` (owner write
  `keep: plan.keep`), `:465` (`plan.keep ? …` disarm), `:473` (`!plan.keep`), `:541`
  (`plan.keep &&`), `:580` (`!plan.keep`), `:662` (`quitPlan` input);
- `ps`/`rm` view: `kept.ts:322` (`KeptRelay.keep`), `:451`; `kept-cmd.ts:224`;
- launch: `main.ts:1010` (`listed = kept.keep || detach`), `:1071`
  (`removedAtEnd`), `:1095` (spec `keep: kept.keep`).

**Sites the merged branches made relevant (no extra code beyond the rename, but
tests must cover them):**

- *(VOID at execution: the cap was removed, see "Drift at execution".)* the relay wake cap (`relay-state.ts` `RELAY_WAKE_LIMIT`, `relayWakeCapped`,
  `exitPlan` row `:329-334`) sits BEFORE the `keep` row: at the cap the plan is
  `hold`/`leave` for both polarities, so it needs no code change, but `keep=false`
  is exactly where a missed inversion would delete a workload whose agent was cut
  off mid-work. Pinned by `relay.test.ts` `R-W10b` (`:2537`, "the cap with
  keep=false: … the workload stays"), `R-W10` (`:2512`), `R-W10c` (`:2558`),
  `R-W5` (`:2362`), `R-W6` (`:2394`) — all rename to `rm`;
- `netSaved` (`relay.ts:295`) gates the net armed under `!spec.keep` (`:336`,
  `:463`): the net must be armed only for `rm: true`.

**Not the field — stays:** the label `tentacle.kept` (`kept.ts:19`; value
`"true"`, `kept.ts:80`) and the "kept index" (`keptDir`, `KeptEntry`,
`KEPT_SCHEMA_VERSION`, `kept.ts:31`) mean "listed workload". They are set for
every listed run INCLUDING a detached `--rm` one (`main.ts:1007-1010`), and
`rm <name>` verifies `labels?.[KEPT_LABEL] === "true"` (`kept.ts:98`). `KeptEntry`
has no `keep` field (the `keep` hits in `kept.ts` are only `:113`, `:322`,
`:451`). So: **no label rename, no `KEPT_SCHEMA_VERSION` bump, and `tentacle rm
<name>` on workloads created by the previous build keeps working.**

### Preconditions

- `parseArgs` optional-value flags: the next word is the value only if `accepts`
  says so; `--k=v` always explicit; a bare flag lands in `bools` (`flags.ts`
  option loop ≈ `:255-290`; re-find `accepts`). So a renamed `KEEP` spec behaves
  identically. `--rm name` keeps `name` positional (it is the prompt slot, `run`
  `positional: {min:0,max:1}`, `flags.ts:128`), exactly as `--keep name` does today.
- Short flags: `FlagDef.short` (`flags.ts:20`) is resolved by `longOf`
  (`flags.ts:239`) over `values` and `bools`; `detach` is a bool (`flags.ts:125`),
  so `{ short: "d" }` works with no parser change. Existing shorts: `n`, `c`, `i`,
  `q`, `v`, `a`, `f` (`flags.ts:116,133-134,145,160,166`); no other `run` flag uses
  `d`; no `-d` exists elsewhere in `packages/cli/src`. `-d=…` on a bool is
  rejected by the existing "takes no value" rule (`flags.ts:269`).
- Config schema is `.strict()` (`schema.ts:4`, strict objects at `:241,:265,:279`;
  `keep` lives in the shared `settingsShape`, `schema.ts:180`/`:295`, used by both
  the file and `ProfileSchema`, `:369`). So after the rename an old `keep:` line
  fails config validation LOUDLY (unrecognized key) instead of being silently
  ignored — important, because silently ignoring `keep: false` would flip a user's
  "delete on exit" into "keep forever". No compat code is added (owner), the
  strictness already gives the right outcome; a test pins it.
- Config plumbing of the key: `resolve.ts:118-119,513`, `load.ts:113-114,640`,
  `defaults.ts:159-160` (template comment). `profile.ts`: no `keep` mention (verified).
- Pre-public: no `PROTOCOL_VERSION` bump (no wire change: no `keep` in
  `packages/protocol`, nor in `control-socket.ts`). `RUN_STATE_VERSION` 1 → 2
  (`run-state.ts:38`) because owner record and relay spec change shape (§7 "On-disk
  records are versioned separately from the wire"). ONE constant versions both:
  owner record (`run-state.ts:62,183,198,360`; written at `relay.ts:227`,
  `attach-run.ts:429`) and relay spec (`run-state.ts:104,342`; written at
  `main.ts:1089`). `KEPT_SCHEMA_VERSION` and `CONTROL_SCHEMA_VERSION` are
  untouched. Old version → the EXISTING refusal paths (`run-state.ts:183-193`
  → `{kind:"unknown"}`; `:342-346` throws); no reader accepts v1 (owner: no
  compat; no "read once").

### Design

1. **Flag.** `flags.ts`: replace the `KEEP` const (`:55`) with `RM = { rm: { accepts: word
   === "true" || word === "false" } }` (same optional-value shape: `--rm`,
   `--rm=false`, `--rm false`). `ARGS.run.optional` (`:126`) spreads `RM` instead of
   `KEEP`; `ARGS.run.bools.detach` (`:125`) becomes `{ short: "d" }`. `--keep` is no
   longer in the spec → the existing `unknown option --keep` error (no hint text:
   owner said no compat; owner answer 1).
2. **Resolution.** `engine-select.ts:131-146`: `resolveKeep` → `resolveRm`
   returning `{ ok:true, rm:boolean }`: `--rm=<v>` → v; bare `--rm` → true;
   else `configured ?? false`. Bad value error: `--rm takes true or false, got "x"`.
   `main.ts:898-906`: pass `bare: runBools.has("rm")`,
   `value: runFlags.get("rm")`, `configured: config.rm`; the result is used as is,
   no inversion: `listed = !rm.rm || detach` (`:1010`), `...(rm.rm ? { removedAtEnd:
   true } : {})` (`:1071`), spec `rm: rm.rm` (`:1095`). Import `resolveKeep` at
   `main.ts:55` → `resolveRm`.
3. **Config.** `schema.ts:293-295`: `keep` → `rm: z.boolean().optional()` with doc
   "whether `run` removes its pod/container when the run ends; `--rm[=true|false]`
   wins. Unset: false (kept)". `resolve.ts:118-119,513`, `load.ts:113-114,640`: rename
   field `keep` → `rm` (type and spread). `defaults.ts:157-160` template becomes
   `// "rm": false,` with text "Default false: the workload is kept and the re-attach
   command printed; true removes it when the run ends. --rm[=false] and a profile win
   as before (flag > profile > config)". `profile.ts` needs no change (generic merge;
   verified: no `keep` mention).
4. **Message.** `engine-runtime.ts:469` text `removed when the run ends` stays
   verbatim (owner: keep the line; it now matches the flag's wording). Only the
   comments naming the flag change.
5. **Help/usage text** (all user-visible strings):
   - `main.ts:143` usage: `[--keep[=true|false]]` → `[--rm[=true|false]]`; add
     `[-d|--detach]`-style mention at `:150` (`tentacle run --detach …` → `-d|--detach`).
   - `main.ts:149` "kept on exit by default (--keep=false deletes)" → "(--rm
     removes it when the run ends)".
   - `main.ts:159` "--keep=false removes the workload when the run goes idle" →
     "--rm removes the workload …".
   - `main.ts:173` attach: "with --keep=false it removes…" → "on a run made with --rm it removes…".
   - `main.ts:269-272` the option block: `--rm[=true|false] (run only)`: "DEFAULT
     false: the pod/container is NOT deleted on exit or Ctrl+C; tentacle prints the
     'tentacle attach …' to resume. --rm (or --rm=true) deletes it when the run ends;
     --rm=false overrides config `rm: true`. Config: "rm:" (user config or profile);
     flag > profile > user config > false". Add `-d` next to `--detach` wherever the
     options block lists it.
   - `flags.ts:666` the `run` usage string (`USAGE.run`): `--keep[=true|false]` →
     `--rm[=true|false]`, `--detach` → `-d|--detach`.
6. **Docs.**
   - `README.md:98` (`--keep=false (or keep: false …) deletes it on exit`) → `--rm
     (or rm: true in the config or a profile) removes it when the run ends`; keep
     "flag > profile > user config > default (kept)".
   - `README.md:103` example `[--keep=false]` → `[--rm]`; add `-d` in `:115`
     (`tentacle run -d|--detach …`; `:116` mentions `--detach` too).
   - `README.md:129`, `:137` ("With `--keep=false` (or `keep: false`)") → `--rm` /
     `rm: true`. (`:145` `detach.keepAwake` and `:183` English "keeps" stay.)
   - `docs/attach-detach-behaviour.md`: `:15` (add: internal state names
     `keep=true/false` mean "without / with `--rm`"; the record field is now
     `rm`, with the polarity reversed), `:26-27`, `:33` (flag names), `:40` row → ✅
     with the commit; keep the `keep=…` state labels elsewhere (`:69-121`, incl. the
     autowake row `:118` "con keep=false rimosso solo a fine turno … oltre il limite
     … resta") as they describe run state, not the flag. The line refs in
     `:175-187` are already stale vs `main`; refresh only the ones this change
     moves. The ES/IT text is edited in place, no restructure.
   - Task docs under `docs/feat|fix|eval/` that mention `--keep` are history, left
     as is (re-run `rg -l -e "--keep" docs` for the list; it now also includes
     detached-autowake). `TODO.md:442` entry: mark done with the commit.
7. **Internal rename `keep` → `rm` (owner answer 2).** Hit list from
   `rg -n "\bkeep\b|keepHint|ownerKeeps|resolveKeep|\bKEEP\b|keep=(true|false)|--keep|keep:|\.keep\b" packages/cli/src packages/config/src`
   (re-run before starting; at 8bcca6a the real hits, excluding `keep-awake`/
   `keepAwake`/`keepalive`, are ≈ 125 lines in 20 src files; **unrelated English
   "keep"**: `config/skills.ts:161`, `config/schema.ts:95`, `defaults.ts:199`,
   `engine-k8s.ts:48`, `workspace-mount.ts:802`, `local-runtime.ts:296,609`,
   `status-line.ts:154`, `hooks-trust.ts:246`, `run-state.ts:375`,
   `engine-host.ts:102`). Tests: ≈ 290 matching lines in 15 files rename:
   `relay.test.ts` (40), `main.test.ts` (63 + 12), `attach-run.test.ts` (32),
   `engine-keep.test.ts` (32), `engine-runtime.test.ts` (26), `run-state.test.ts`
   (21), `config/test/keep.test.ts` (15), `engine-docker.test.ts` (12),
   `attach-plan.test.ts` (11), `kept-cmd.test.ts` (8), `relay-state.test.ts` (7),
   `kept.test.ts` (3), `engine-select.test.ts` (1). **Unrelated** (leave):
   `packages-cmd.test.ts` (dir named `keep`, 4), `render.test.ts` (1),
   `local-runtime.test.ts` (1), `serve-resident.test.ts` (1), `keep-awake.test.ts`
   (1), `carried-settings.test.ts:615`, `serve-persistence.test.ts:443-444`.
   Per kind:
   - **Fields/types:** `OwnerRecord.keep?` → `rm?` (`run-state.ts:81`; absent =
     not removed, as today); `RelaySpec.keep` → `rm` (`:112`); `KeptRelay.keep` →
     `rm` (`kept.ts:322`); the attach plan (`attach-plan.ts:43,80`); the `quitPlan`
     input (`attach-plan.ts:102-109`); `attach-run.ts:440,662`.
   - **Helper:** `ownerKeeps(owner)` (`run-state.ts:407`, `owner.keep !== false`)
     → `ownerRemoves(owner)` = `owner.rm === true`. Users: `attach-plan.ts:12,75`,
     `kept-cmd.ts:41,224`, `run-state.ts:465,534`. Absent-field meaning is
     preserved (not removed).
   - **Params:** `needsUse(model, keep)` / `exitPlan(model, keep, use)` → `rm`
     (`relay-state.ts:306,320`); bodies `!keep && …` → `rm && …` (`:307`), `if (keep ||
     …)` → `if (!rm || …)` (`:335`). The wake-cap row (`:329-334`) is untouched.
   - **Consumers (invert the TEST, not the data):** `relay.ts:336,463`
     `!spec.keep` → `spec.rm`; `:571,573` pass `spec.rm`; `:616` `spec.keep &&` →
     `!spec.rm &&`; `attach-run.ts:465` `plan.keep ? …` → `!plan.rm ? …`; `:473`
     `!plan.keep` → `plan.rm`; `:541` `plan.keep &&` → `!plan.rm &&`; `:580`
     `!plan.keep` → `plan.rm`; `attach-plan.ts:109` `if (input.keep)` → `if
     (!input.rm)`; `kept.ts:451` `!relay.keep` → `relay.rm`; `kept-cmd.ts:224`
     `known ? ownerKeeps(known) : true` → `known ? ownerRemoves(known) : false`;
     `run-state.ts:465` (`!ownerKeeps(owner) && … lost` → `ownerRemoves(owner) && …`)
     and `:534` (`!ownerKeeps(owner.owner)` → `ownerRemoves(owner.owner)`);
     `main.ts:1010` and `:1071` (Design 2).
   - **`keepHint` → `resumeHint` (N1, owner-decided):** `engine-runtime.ts:199`
     (type), `:196` and `:215` (comments), `:450` (`const { keepHint } = deps`),
     `:455`, `:467`, `:468`, `:586`; `main.ts:328` (comment), `:1042`, `:1103`
     (`workloadDeps.keepHint?.`). Tests: `main.test.ts` (the `--keep wiring`
     block `:498-570`, helper `keepHintFor` → `resumeHintFor`, `seen?.keepHint`),
     `engine-runtime.test.ts`, `engine-docker.test.ts` (≈56 lines in all). It is NOT
     the polarity (present for every listed run, also a detached `--rm` one,
     `main.ts:1010`) and `removedAtEnd` (`engine-runtime.ts:204`) stays.
   - **Comments/docs naming `keep=false`/`--keep`** → `rm`/`--rm`:
     `engine-runtime.ts:13,194,201,328,449,520,574,586`, `engine-host.ts:103`,
     `engine-docker.ts:245`, `engine-select.ts:131-132,148,238`, `kept.ts:113`,
     `kept-cmd.ts:274,296,420,462`, `relay.ts:17,612`, `relay-state.ts:210`,
     `run-state.ts:65,80,406,429,448,506`, `attach-run.ts:7,533,535,649,676`,
     `main.ts:888,1007-1008,1351,1452`, `flags.ts:52-53`.
   - **Stays:** `tentacle.kept`/`KEPT_LABEL`, the kept index and its types and
     commands, `keep-awake.ts`/`keepAwake`, `keepalive`, English "keeps", and the
     historic task docs (answer 3).
8. **Persisted format.** `RUN_STATE_VERSION = 2` (`run-state.ts:38`). The
   doc comment at `run-state.ts:13` already states the §7 rule. No migration and
   no v1 reader: a v1 file takes the existing `unknown` path, code unchanged.
   Effects are listed under Failure modes → "Previous build's records".

### Files

In dependency order (config → cli). Size L: if split, slice 1 = config + flag +
`resolveRm` + help/docs (surface, mergeable alone while the internals still say
`keep` = `!rm`); slice 2 = the rename + version bump (load-bearing, fresh-context
review). The plan below is the end state either way.

| File | Change | Shared with |
|---|---|---|
| `packages/config/src/schema.ts` | `keep` → `rm` (`:293-295`) | none |
| `packages/config/src/resolve.ts` | field + spread (`:118-119`, `:513`) | none |
| `packages/config/src/load.ts` | field + spread (`:113-114`, `:640`) | none |
| `packages/config/src/defaults.ts` | template comment (`:157-160`) | none |
| `packages/cli/src/flags.ts` | `RM` spec, `detach` short, `USAGE.run`, comments (`:52-56,125-126,666`) | none |
| `packages/cli/src/engine-select.ts` | `resolveKeep` → `resolveRm` (`:131-146`); comments `:148,238` | none |
| `packages/cli/src/run-state.ts` | `RUN_STATE_VERSION` 2 (`:38`); `rm` in `OwnerRecord`/`RelaySpec`/parsers (`:81,112,208,354,366`); `ownerRemoves` (`:407`); users `:465,534`; comments | none |
| `packages/cli/src/relay-state.ts` | `needsUse`/`exitPlan` param (`:306-307,320,335`); wake-cap row `:329-334` unchanged | none |
| `packages/cli/src/relay.ts` | `spec.rm` consumers (`:234,336,463,571,573,616`); `netSaved` gate (`:295,380`) unchanged but covered by tests; comments | none |
| `packages/cli/src/attach-plan.ts`, `attach-run.ts` | `rm` field + inverted tests (`attach-plan.ts:43,75,80,109`; `attach-run.ts:440,465,473,541,580,662`) | none |
| `packages/cli/src/kept.ts`, `kept-cmd.ts` | `KeptRelay.rm` (`kept.ts:322,451`), `kept-cmd.ts:41,224`; comments | none |
| `packages/cli/src/main.ts` | `:55` import; `:898-906` call site; `:1010,1071,1095`; `resumeHint` `:1042,1103`; help `:143-173,269-272`; comments | **both**: stale-pod-binary edits `main.ts` import and the `--version` branch; target-badge adds one line near the `run` prelude. Hunks do not touch my lines; re-locate by text. |
| `packages/cli/src/engine-runtime.ts`, `engine-host.ts`, `engine-docker.ts` | `keepHint` → `resumeHint` (`engine-runtime.ts:199` etc.), comments | **both** (badge: `engine-runtime.ts`, `engine-host.ts`; stale: `engine-host.ts`, `engine-runtime.ts` +73 lines): re-locate by text. |
| `README.md`, `docs/attach-detach-behaviour.md`, `TODO.md`, `CHANGELOG.md` | text | **both** touch `CHANGELOG.md` `[Unreleased]` (badge `### Added`; stale `### Fixed`; main has `### Changed`). Add mine under `### Changed`. |
| Tests (below): `relay.test.ts` (40), `main.test.ts` (75), `attach-run.test.ts` (32), `engine-keep.test.ts` (32), `engine-runtime.test.ts` (26), `run-state.test.ts` (21), `config/test/keep.test.ts` (15), `engine-docker.test.ts` (12), `attach-plan.test.ts` (11), `kept-cmd.test.ts` (8), `relay-state.test.ts` (7), `kept.test.ts` (3), `engine-select.test.ts` (1) | rename + new tests | badge touches `main.test.ts`, stale `engine-runtime.test.ts`: disjoint hunks. |

Not touched: `PROTOCOL_VERSION`, `protocol`, `daemon`, `tui`, `control-socket.ts`,
`KEPT_SCHEMA_VERSION`, the label `tentacle.kept`, `apps/mobile` (no `keep` hit).

**CHANGELOG `[Unreleased]` → `### Changed`:**

- `tentacle run --keep[=true|false]` is replaced by `--rm`, as in docker and
  kubectl. A run still keeps its pod or container by default; `--rm` removes it
  when the run ends (`--detach --rm`: when the run goes idle or is stopped), and
  `--rm=false` overrides the config. In the config (and profiles) `keep: false`
  becomes `rm: true`; `keep` is no longer accepted and is reported as an unknown
  key. There is no `--keep` alias.
- `-d` is now the short form of `run --detach`.
- Detached-run state files (`owner.json`, `spec.json`) change format (version 2).
  Runs started by a previous build keep running and keep their workload, but this
  build lists them as `unknown owner`, cannot attach to them, and leaves their
  `owner.json` for you to delete; `tentacle rm <name>` still removes them.

### Failure modes

- **Old muscle memory `run --keep` / `--keep=false`** → `unknown option --keep`,
  exit 1, nothing created (parse happens before any provisioning: the error path at
  `main.ts` for `parseArgs` failures, same as every unknown flag). Converges: nothing
  to clean.
- **Old config `keep: …` (file or profile)** → strict-schema error naming the key,
  at config load, before any run. Never silently ignored (Preconditions). Converges:
  user edits the file. (The same load error already shows for any typo.)
- **`--rm=maybe`** → `[<noun>] --rm takes true or false, got "maybe"`, exit 1,
  nothing created (call site `main.ts:898-906`).
- **`--rm false`** (space) → value `false` (accepts), consistent with the old
  `--keep false`; **`--rm name`** → `name` stays positional (prompt slot). **`--rm
  true`/`--rm false` as an actual one-word prompt** is the pre-existing ambiguity of
  the old `--keep true`; unchanged.
- **`--rm` twice / `--rm --rm=false`** → existing "given more than once" error
  (`flags.ts:266`).
- **`-d` with a value (`-d=1`)** → "takes no value"; `-d` repeated with `--detach`
  → "--detach given more than once" (the check is on the long name,
  `flags.ts:265-267`).
- **`--detach --rm` with config `rm: false`/`true`** → flag > profile > config, same
  precedence as `keep` had; the relay spec gets `rm: true` (`main.ts:1095`).
- **`attach --rm`** → unknown option (attach never had `--keep`; the existing
  `attach has no --keep` test is renamed). Attach to a run made with `--rm`
  inherits the record's `rm: true` (`attach-plan.ts:75`, now `ownerRemoves`).
- *(VOID at execution: no cap any more; the wake-pending `hold` row took its place, see "Drift at execution".)* **Wake cap (relay autowake) with `rm: true`** (`relay-state.ts:329-334`, `relay.ts`
  `sayCapped`): past `RELAY_WAKE_LIMIT` with a wake pending, `exitPlan` returns
  `leave` BEFORE the `rm` row, so the workload stays (the agent was cut off
  mid-work) and the record says the cap. Only the `rm` row (`:335`) is renamed, in
  place; a mis-edit that moved the `rm` test above the cap row, or inverted it,
  would delete a cut-off run's workload. Pinned by `R-W10b` (`rm: true`) AND a
  `rm: false` twin asserting the same `leave` (keep-side: also never removed).
  Converges: `rm <name>` removes it later.
- **Exit net under `rm` (`netSaved`, `relay.ts:336,463`; TUI `attach-run.ts:473`):**
  armed only for `rm: true`; its fire is gated by the save gate
  (`netSaved()` / the TUI's `saveConfirmed`), else `not saved — workload kept: tentacle
  rm <name>` (`relay.ts:296-299`). A missed inversion arms the net for default
  (kept) runs — `rm`-less runs would be deleted at SIGKILL-adjacent exits — or
  disarms it for `--rm` runs (workload leaks). Tests assert the arm count for BOTH
  values (existing `armNet` spy in `relay.test.ts`; `armExitNet` spy in
  `attach-run.test.ts`).
- **`ps` for finished runs (`runFinished`, `kept-cmd.ts:225,397`):** reads only
  owner `state` + liveness, not `keep`; `removal   when the run ends`
  (`kept.ts:451`) is the only `ps` line that reads the field. No change besides
  the rename; the v1-owner fallback is "not removed" (`kept-cmd.ts:224`).
- **Missed or doubled inversion at a consumer** (the load-bearing risk): a
  `--rm` run's workload would be kept forever, or a default run's workload
  deleted. Not recoverable silently — designed out by Tests 6 (both values at each
  consumer) and the mutations.
- **Previous build's records (version-skew; RUN_STATE_VERSION 2 vs 1).** Records
  live in `<configDir>/kept/runs/<stem>/` (`run-state.ts` `runDirIn`); the user
  sees NOTHING at upgrade, only when a command reads them:
  - `tentacle ps`: a live old detached run shows `detached · unknown owner`
    (`run-state.ts:475`); the removal line (`kept.ts:451`) is absent for it,
    since `kept-cmd.ts:224` falls back to "not removed" — an old `--keep=false` run
    LOOKS kept in `ps` (display only; its old relay still deletes at the end,
    see below).
  - `tentacle attach <name>` on a live old relay: refused with the relay reason
    (`attach-plan.ts:51-53`, `{kind:"refuse", why:"relay"}`): the TUI cannot
    take it over. With its relay dead: a `plain` attach (`attach-plan.ts:51-53`):
    a new session in the workload, the old session is not resumed and the old
    run's save/delete bookkeeping does not apply.
  - **The old relay itself is unaffected**: it is the previous binary, already
    running with its in-memory v1 spec; it keeps writing v1 `owner.json` and, on
    an old `--keep=false` run, removes the workload when it finishes. So live
    detached runs from the old build are **not lost, but unmanageable by this
    build except `rm`**: finish on their own, or `tentacle rm <name>` — it
    verifies the managed + `tentacle.kept` labels (`kept.ts:98`, unchanged label),
    stops the relay with SIGTERM via the lock holder (`kept-cmd.ts:410-420`;
    `control-socket.ts` is not versioned by this change) and the old relay
    removes its workload as before.
  - A dead old run (relay gone, `owner.json` v1): the workload stays (nothing
    in this build deletes it without `rm`); `ps` cannot say "not saved"
    (it needs the record); recovery = `tentacle rm <name>`.
  - After `rm` (or the workload's disappearance) the run dir is kept:
    `Left <…/owner.json>: it is not readable by this version, delete it yourself.`
    (`kept-cmd.ts:319`; §7 "refused, left untouched"). Delete that file by hand.
  - `tentacle run --detach --name X` while X has an old `owner.json`: refused —
    `not started: <path> is not readable by this version: left untouched, delete
    that file to run under this name` (`relay.ts:181`; launcher: `, or delete
    <path> to run under this name`, `relay.ts:764-768`). Recovery: delete the
    file named.
  - A relay started by THIS build reads only its own spec, written by the same
    binary just before (`main.ts:1089`, `readSpec` `run-state.ts:342`). A v1
    `spec.json` can only arise from a binary swapped between launch and spawn
    (`self-update` window): the relay exits `schemaVersion 1 is not 2`
    (`run-state.ts:343-345`), the launcher says `stays up … tentacle rm <name>`
    (`relay.ts:768`); converges with `rm`.
  - Kept-index entries (`kept/<id>.json`) and workload labels are not touched, so
    `ps` lists every old workload and `rm`/`attach` (non-detached) work as before.
  - The reverse (new records read by an OLD build after a downgrade) is the same
    §7 rule, `unknown`; the TUI-handover comment at `run-state.ts:65-67` already
    documents it.
  - Not provided, by decision: migration or read-once of v1 (owner answer 2 chose
    the bump; pre-public, §7).
- **Merge-order**: if the executor finds line numbers shifted by the two earlier
  branches, re-find by text; if the `resolveKeep` call site in `main.ts` no longer
  matches, STOP and fix this plan (§8).

### Tests

Red first (§9): write each test below, run on unchanged main, and paste the failing
output in Execution; then implement. Keep the existing repo style (no `!`).

1. `packages/cli/test/engine-keep.test.ts` (rename the describes; keep the file
   name or `git mv` to `engine-rm.test.ts`, executor's choice):
   - `resolveRm`: bare `--rm` → rm true; `--rm=true` true; `--rm=false` false
     even when `configured: true`; unset → config; nothing → `false`; `value: "yes"`
     → error `--rm takes true or false, got "yes"`.
   - `parseArgs(ARGS.run)`: `--rm`, `--rm=false`, `--rm false` (value, not name),
     `--rm name` (name stays positional), `name --rm`; `--rm=true`; `--keep` and
     `--keep=false` are `{ok:false, error:"unknown option --keep"}`;
     `-d` ≡ `--detach` (`bools.has("detach")`); `-d` + `--detach` → "given more than
     once"; `-d=1` → takes no value; `attach` rejects `--rm` and `-d`.
2. `packages/config/test/keep.test.ts` (→ `rm.test.ts`): `rm` boolean in file and in
   a profile, anything else is an error; resolved `rm` absent when unset; a profile's
   `rm` beats the file's; **`keep: true` / profile `keep: false` are REJECTED** (the
   strict-schema guard: this is the test that proves no silent flip); template
   contains `// "rm": false,`. Leave the `detach.keepAwake` block untouched.
3. `packages/cli/test/main.test.ts` (the `detached` rig, `:644` ff., writes
   `{keep: over.keep}` into the config → writes `rm`): the L12 test becomes "`--rm`,
   or `rm: true` in the config: the spec says `rm:true`, `removedAtEnd` is true";
   the default (no flag) and `--rm=false` over `rm: true` give `spec.rm === false`
   and `removedAtEnd === undefined`. Add `run -d "hi" --image …` ≡ `--detach`.
   Add a help test: `--help` output contains `--rm` and `-d`, and does not contain
   `--keep` (pins the help text so it cannot drift back; check how other help tests
   in the file capture `out`). The `--keep wiring` block (`:498-570`) is renamed
   `--rm wiring`, with `resumeHint` (N1).
4. `engine-runtime.test.ts` (`removed when the run ends` line, find by text):
   unchanged behaviour; only the test names that say `--keep` are renamed ("kept: …").
   `engine-docker.test.ts`, `engine-runtime.test.ts` (`keepHint` titles/deps):
   `keepHint` → `resumeHint` (N1).
5. `flags`/usage: a test that `USAGE.run` (or the `usage: tentacle run` line printed
   by the error path, `main.test.ts` already asserts `usage: tentacle run`)
   contains `[--rm[=true|false]]` and `-d|--detach`.

6. **Polarity at every consumer (rename tests, both values).** Rename the
   existing `keep` cases and make sure each site has a `rm:true` AND a `rm:false`
   (or absent) case asserting the opposite outcomes: `run-state.test.ts` (`rm`
   round trip through `writeOwner`/`readOwner`, absent → `ownerRemoves` false,
   `rm:false` → false, `rm:true` → true; `readSpec` requires boolean `rm`);
   `relay-state.test.ts` (`needsUse`/`exitPlan` with `rm` true/false, **including
   the wake-cap row: capped + `rm:true` → `leave`, never `remove`**);
   `relay.test.ts` (`spec.rm:true` removes the workload at the end, `false` never,
   `:616` the `not saved` line only for `!rm`; **`R-W10`/`R-W10b`/`R-W10c`,
   `R-W5`, `R-W6` renamed, with a `rm:false` twin of `R-W10b`; the net is armed
   (`:336`, `:463`) only for `rm:true`, via the `armNet` spy**);
   `attach-plan.test.ts` + `attach-run.test.ts` (`planAttach` carries `rm` from the
   record; `quitPlan` deletes only for `rm:true`; arm/disarm of the exit net);
   `kept-cmd.test.ts` (`ps` shows `removal   when the run ends` only for
   `rm:true`; unknown/untied owner → not removed); `kept.test.ts`.
7. **Version skew (red first; mandatory).** In `run-state.test.ts` and
   `kept-cmd.test.ts`/`attach-plan.test.ts`:
   - a hand-written v1 `owner.json` (`schemaVersion: 1`, `keep:false`, otherwise
     valid) → `readOwner` is `{kind:"unknown"}` and the file is byte-identical
     after the read (RED on main: it parses as an owner);
   - a v1 `spec.json` → `readSpec` throws `schemaVersion 1 is not 2`;
   - `planAttach` with `{kind:"unknown"}`: `relayAlive` → `refuse relay`, dead →
     `plain` (pins the "unmanageable but not deleted" claim);
   - `statusOf` of a live relay with an unknown owner = `detached · unknown
     owner`; `ps` row has no `removal` line;
   - `rm` of a workload whose run dir holds a v1 `owner.json`: the workload is
     removed, the run dir stays, stderr has `Left …owner.json: it is not readable
     by this version, delete it yourself.` (`kept-cmd.ts:319`);
   - `launchRelay` with a v1 `owner.json` in the run dir: refuses with the
     `not started:` / `delete that file` wording and does not touch the file
     (`relay.ts:181`);
   - a v2 record with `rm:true` round-trips; `RUN_STATE_VERSION === 2` is NOT
     asserted as a literal (use the exported constant, plus the literal `1` for
     the old-file fixtures).
   - label stays: a test (exists: `kept.test.ts`) that `rm <name>` accepts a
     workload with `tentacle.kept=true` — run once unchanged to show it still passes.
8. Test fixtures that write `schemaVersion: 1` for owner records/specs
   (`rg -n "schemaVersion: 1" packages/cli/test`: ≈ 17 hits in 11 files at
   8bcca6a: `relay.test.ts` 4, `run-state.test.ts` 3, `attach-run.test.ts` 2,
   `serve-persistence.test.ts` 2, and 1 each in `control-socket`, `kept-where`,
   `kept`, `attach-plain-resume`, `attach-plan`, `output-streams`, `kept-index`)
   must use `RUN_STATE_VERSION` (or `2`) where they are owner records/specs, else
   they turn into skew tests by accident; classify each hit (kept-index /
   daemon-record ones are other formats and stay).

**Mutations (non-vacuity, §9; each run once then reverted):**
- in each consumer listed in Design 7 (`relay.ts:336,463,571,573,616`,
  `relay-state.ts:307,335`, `attach-plan.ts:109`, `attach-run.ts:465,473,541,580`,
  `kept.ts:451`, `main.ts:1010,1071`) invert the test → at least one named test
  from Tests 6 or 3 fails per site (one mutation per site; list the failing test
  in Execution).
- *(Replaced at execution by: move the `rm` row above the wake-pending row → "a pending wake holds, rm or not" fails.)* `relay-state.ts`: move the `rm` row above the wake-cap row → `R-W10b` (or its
  `rm:false` twin / the relay-state cap test) fails.
- `RUN_STATE_VERSION` left at 1 → the v1-fixture tests (7) fail.
- `ownerRemoves` back to `!== false` → the absent-field test fails.
- `RM` spec `accepts` always false → the `--rm false` test fails.
- in `resolveRm`, drop the `value` branch precedence (let config win) → the
  `--rm=false` over `rm: true` test fails.
- invert `rm.rm` at `main.ts:1071`/`:1095` → the `main.test.ts` L12 test fails
  (`spec.rm`), and so does the default-keeps test.
- remove `short: "d"` → `-d` test fails.
- make the config schema accept `keep` again (re-add the key) → the strict-rejection
  test fails.

**Gate:** `bun test packages/cli/test/engine-keep.test.ts packages/config/test packages/cli/test/main.test.ts`
per slice (plus `relay.test.ts relay-state.test.ts attach-run.test.ts` for slice 2);
before done `bun run check`, compared with the clean lint baseline (§6).
Also `rg -n -e "--keep|keep:|keepHint|ownerKeeps|resolveKeep|\.keep\b" -g '!docs/**' -g '!CHANGELOG.md' packages` must show only the unrelated hits
(`keepHint` is renamed, N1), and `rg -n "keep" README.md` only non-flag
prose. Manual smoke (fresh context, Review): a `run --detach --rm` and a
`run --detach` against a fake engine, `ps`, `attach`, `rm` on both, with the
previous build's `owner.json` planted.

## Execution

*— claude-opus-5-5, 2026-11-06*

On `fix/run-rm-flag` off main 171e06b, one branch (not split). Not committed (the
orchestrator commits).

**Repro (before).** Running a script needs approval in this session, so the repro
is the red tests themselves, on the unchanged `flags.ts`/`engine-select.ts`:
`engine-keep.test.ts` failed to load (`SyntaxError: Export named 'resolveRm' not
found in module …/engine-select.ts`), `config/test/keep.test.ts` 5 fail / 3 pass
(`rm` rejected by the strict schema, `keep` accepted, template says `"keep": true`).
`parseArgs(["--rm"], ARGS.run)` was `unknown option --rm` and `-d` `unknown option -d`
on main (the `--keep`-is-unknown and `-d` tests now pin the reverse).

**As built, in plan order:**

1. Config: `schema.ts` `keep` → `rm` (doc: unset = false, kept); `resolve.ts`,
   `load.ts` field + spread; `defaults.ts` template `// "rm": false,`.
2. Flag: `flags.ts` `KEEP` → `RM` (same optional-value `accepts`), `detach: {
   short: "d" }`, `USAGE.run` `[--rm[=true|false]]` / `[-d|--detach]`.
   `engine-select.ts` `resolveKeep` → `resolveRm` (`configured ?? false`, error
   `--rm takes true or false, got "x"`).
3. `main.ts`: `resolveRm` call (`runBools.has("rm")`, `runFlags.get("rm")`,
   `config.rm`); `listed = !rm.rm || detach`; `...(rm.rm ? { removedAtEnd: true } :
   {})`; spec `rm: rm.rm`; `resumeHint`; help text (usage line, the two
   `--keep=false` lines, attach's line, the options block `--rm[=true|false]` +
   a `-d, --detach` line); comments.
4. Internal rename (Design 7): `run-state.ts` `RUN_STATE_VERSION = 2`,
   `OwnerRecord.rm?`, `RelaySpec.rm`, both parsers, `ownerRemoves` (`rm === true`),
   `statusOf` / `relayBlockingMessage` users; `relay-state.ts` `needsUse(model, rm)`
   (`rm && …`), `exitPlan(model, rm, use)` (`if (!rm || model.linkStopped)`);
   `relay.ts` record `rm: spec.rm`, both net armings `if (spec.rm)`, `needsUse` /
   `exitPlan` get `spec.rm`, the kept-run `not saved` note `!spec.rm &&`;
   `attach-plan.ts` plan/quit `rm`, `if (!input.rm) stay`; `attach-run.ts` record
   `rm: plan.rm`, `disarm = !plan.rm ? noop : armNet`, notice `if (plan.rm)`,
   `lastOut` `!plan.rm &&`, `deleting = plan.rm && …`, `quitPlan({ rm })`;
   `kept.ts` `KeptRelay.rm`, removal line `relay.rm`; `kept-cmd.ts` `rm: known ?
   ownerRemoves(known) : false`; `engine-runtime.ts` `keepHint` → `resumeHint`;
   comments in `engine-host.ts`, `engine-docker.ts` and the files above.
5. Tests: renames + both polarities at each consumer; new tests listed below.
6. Docs: README (`--rm`, `rm: true`, `[--rm]`, `-d|--detach`),
   `docs/attach-detach-behaviour.md` (rule 4 explains `keep=true/false` = without /
   with `--rm` and the `rm` record field; rows `:26,:27,:31,:33`; row `:40` → ✅;
   table pipes escaped), `docs/feat/detached-runs.md` (a dated rename note at DR-5
   and on the owner.json field list; the rest kept as history), CHANGELOG
   `[Unreleased] ### Changed` (3 entries, as planned).
   **AGENTS.md §7 (pod/container lifecycle): only the flag/field names changed**
   (`--keep`/`keep:`/`--keep=false` → `--rm[=false]`/`rm:`/`--rm`; `keep=true` →
   "without `--rm`", `keep=false` → "`--rm`" / "record `rm: true`"); 8 lines, the
   invariant text and rules are unchanged word for word otherwise.

**New tests** (beyond renames): `engine-keep.test.ts` — `resolveRm` (3), `--rm`
parse incl. `--rm` twice, `--keep`/`--keep=false` = `unknown option --keep`,
`attach` rejects `--rm`/`-d`, `-d` ≡ `--detach`, `-d --detach` twice, `-d=1`,
`USAGE.run`; `config/test/keep.test.ts` — old `keep` key REJECTED (file and
profile), template has `// "rm": false,` and no `keep`; `main.test.ts` — `--rm` /
`--rm=true` / `--rm box` / config `rm` / profile `rm` / `--rm=maybe` / `--keep=false`
unknown / old `keep:` config refused; L12: `--rm`, `-d … --rm`, `rm: true` config →
`spec.rm` true + `removedAtEnd`; default, `-d "hi"`, `--rm=false` over `rm: true`
→ `spec.rm` false; help contains `--rm[=true|false]`, `-d|--detach`, no `--keep`;
`run-state.test.ts` — `rm` round trip (absent/false/true), v1 owner.json →
`unknown` byte-identical, spec with `keep` instead of `rm` refused, v1 spec →
`schemaVersion 1 is not 2`; `kept-cmd.test.ts` — live v1 relay → `detached ·
unknown owner`, no removal/session line; `rm` with a v1 owner.json → removed, file
left byte-identical, `Left …owner.json: it is not readable by this version, delete
it yourself.`; `relay.test.ts` — a v1 record added to "an unknown owner.json is
refused" (`not started` wording, untouched), the launch test asserts `spec.rm`;
`attach-run.test.ts` — only an `rm` run gets the `Quitting removes the container`
notice (added because that site's mutation survived the renamed suite).

Fixtures: owner/spec `schemaVersion: 1` → `RUN_STATE_VERSION` in `run-state`,
`relay` (3), `attach-run`, `attach-plan`, `kept-cmd` (owner only), `main` (5),
`output-streams`; the stale "unknown schema" spec test used `2` → now `99`.
KeptEntry (`kept`, `kept-where`, `kept-index`, `attach-plain-resume`, entry
fixtures), daemon records (`serve-persistence`) and `control-socket` stay `1`
(other formats). File names `engine-keep.test.ts` / `config/test/keep.test.ts`
kept (the plan allowed it; `git mv` needed an approval this session did not have).

**Mutations (each applied from a `cp` backup, restored, shasum identical):**

| Site | Failing test(s) |
|---|---|
| schema accepts `keep` again | config "the old `keep` key is REJECTED" |
| `RM.accepts` always false | "--rm true / --rm false (space form) is the value" |
| no `short: "d"` | the two `-d` tests |
| `resolveRm`: config wins over `value` | "bare --rm, --rm=true and --rm=false …" |
| `RUN_STATE_VERSION` left at 1 | v1 owner/spec (run-state, 2), v1 `ps`/`rm` (kept-cmd, 2), relay "unknown owner.json is refused" |
| `ownerRemoves` → `rm !== false` | "`rm` round trip; absent …", statusOf ×2, relayBlockingMessage |
| `statusOf` `!ownerRemoves` | 3 statusOf tests incl. "R6 `rm: true` … not saved" |
| `relayBlockingMessage` inverted | 2 relayBlockingMessage tests |
| `needsUse` `!rm` | "needsUse: the read happens only where …" |
| `exitPlan` `if (rm …)` | 7 exitPlan tests |
| `rm` row moved above the wake-pending row | "a pending wake holds, rm or not" |
| `attach-plan` `if (input.rm) stay` | 3 quitPlan tests |
| `planAttach` `rm: !ownerRemoves` | "a live relay: the hand-over; …" |
| `kept.ts` removal line `!relay.rm` | 5 (kept ×2, kept-cmd ×3) |
| `kept-cmd` `!ownerRemoves` / fallback `true` | "-v: pid, session, log, removal" / v1 `ps` + R4 |
| `relay.ts` net arm at start inverted | 15 (L21 ×3, H26/H27/H38, R-W5/W5b/W6, …) |
| `relay.ts` re-arm after hand-over inverted | H27 |
| `relay.ts` `needsUse(!spec.rm)` | 18 |
| `relay.ts` `exitPlan(!spec.rm)` | 23 (incl. "rm=false: no read, no delete", "rm=false: a stop removes nothing") |
| `relay.ts` `not saved` note `spec.rm &&` | 3 (Q3, F6/Q13, the link stopped) |
| `relay.ts` record `rm: !spec.rm` | 5 (H39, D13 ×3, D14) |
| `attach-run` `disarm` inverted | 18 |
| `attach-run` notice inverted | the new notice test (survived before it existed) |
| `attach-run` `lastOut` inverted | 4 |
| `attach-run` `deleting` inverted | 19 |
| `attach-run` `quitPlan({ rm: !plan.rm })` | 14 |
| `attach-run` record `rm: !plan.rm` | 3 (relay H39, D13 ×2) |
| `main.ts` `listed = rm.rm \|\| detach` | 11 |
| `main.ts` `removedAtEnd` inverted | L12 ×2 |
| `main.ts` spec `rm: !rm.rm` | L12 ×2 |

**Gate (once, at the end, foreground):** `bun run typecheck`: the root `tsc
--noEmit` is clean; the second half, `tsc -p apps/mobile --noEmit`, fails in this
worktree only because `apps/mobile/node_modules` is not installed (`Cannot find
module 'react-native'`, lib.dom/`@types/ws` clashes) — no file under `apps/mobile`
is touched; verify on a checkout with mobile deps. `bunx biome check .`: clean
(677 files, after `--write` on import order/format of 4 files). `bun test packages`:
**4992 pass, 3 skip (the opt-in live-k8s / live-docker / slow), 0 fail**, 335 files
(the reaper flake did not occur). `rg -n -e "--keep|keep:|keepHint|ownerKeeps|resolveKeep|\.keep\b" packages`:
only the deliberate v1 fixtures / negative tests and `agent` `keep: CarriedSkill[]`
(unrelated). `git status`: no stray files.

**Drift from Implementation:** the wake-cap items are void (cap removed upstream,
see "Drift at execution"); the cap mutation became "the `rm` row above the
wake-pending row". The `R-W10b` `rm:false` twin is not written (no cap). TODO.md
left to the orchestrator (the index is committed on `main`). The help gained a
`-d, --detach (run only)` line in the options block (the plan said "add `-d` next
to `--detach` wherever the options block lists it"; it listed none).

**Unverified:** the real CLI end to end (no script runs here) and the mobile half
of the typecheck. **Owner live checklist:**

- [ ] `tentacle run --engine docker --image … --rm`: quitting deletes the container (also on Ctrl+C).
- [ ] plain `tentacle run …`: the container stays, `still running · tentacle attach <name>` printed.
- [ ] `tentacle run -d "hi" --image … --rm`: `still running · removed when the run ends · …`; the container is deleted once the turn ended and its save is on the laptop (`ps` until then: `detached · …`).
- [ ] `tentacle run --keep …` → `unknown option --keep`; a config with `"keep": false` → a config error naming `keep`.
- [ ] `tentacle ps -v` on a `-d --rm` run shows `removal   when the run ends`, not on a plain `-d` run; `tentacle rm <name>` works on both; `tentacle --help` shows `--rm` and `-d`.
- [ ] a detached run started by the previous build: `ps` says `detached · unknown owner`; `attach <name>` is refused while its relay lives; `tentacle rm <name>` removes it and says `Left …/owner.json: … delete it yourself.`

## Review

**Verdict: PASS (APPROVE-WITH-NITS)** — one LOW finding, no code change required.

**Gate** (worktree, HEAD 104c797): `bunx tsc --noEmit` clean · `bunx biome check .`
677 files, no fixes · `bun test packages/cli packages/config packages/docker
packages/k8s` → **2396 pass, 2 skip (opt-in), 0 fail**, 2398 tests / 140 files.

**Attacks tried (the DELETE decision):**
1. *Every `keep`→`rm` flip, once.* Read each site in `git diff main...HEAD`:
   `resolveRm` default `configured ?? false` (`engine-select.ts:145`, `run` keeps
   by default) · `listed = !rm.rm || detach` (`main.ts:1009`) → `resumeHint`
   only when listed → launcher exit net armed only when `!keptLine`
   (`engine-runtime.ts:330`): plain `run --rm` = unconditional net, `run -d --rm`
   = no launcher net · `removedAtEnd` only on `rm.rm` · relay net arming both
   sites `if (spec.rm)` (`relay.ts:777,786`) · `needsUse`/`exitPlan` `rm &&` /
   `!rm ||` (`relay-state.ts:726,746`) · relay "not saved" note `!spec.rm`
   (`relay.ts:812`) · `quitPlan` `!input.rm` → stay (`attach-plan.ts:119`) ·
   `joinRun` disarm/notice/lastOut/deleting (`attach-run.ts:150,159,178,187`) ·
   `ownerRemoves = rm === true` (absent ⇒ keep) · `statusOf` lost · `relayBlockingMessage`
   · `kept-cmd` relayRow `rm: known ? … : false` · `renderVerbose` removal line.
   **No double or missed inversion found.**
2. *v1 records.* `readOwner` refuses `schemaVersion !== 2` → `unknown`
   (`run-state.ts:183`); `readSpec` throws (`:342`). `planAttach` on `unknown`:
   live relay → refuse, dead → `plain` (user-owned, no net, no delete);
   `relayRow` → `rm:false`. Nothing deletes on an unreadable record; tests at
   `run-state.test.ts:131,358,366` pin the exact v1 shape `keep:false`. Holds.
3. *Flags/config.* `--keep` → `unknown option --keep` (`main.test.ts:585`);
   `keep:` refused at top level and in profiles (`keep.test.ts:20-22`, and
   `main.test.ts:591` nothing started); `--rm name` leaves `name` positional;
   `-d` is the only `short: "d"` in `flags.ts`; help/usage pinned without
   `--keep` (`main.test.ts:2687`). No env var involved. Holds.
4. *AGENTS.md §7 edit*: names only (`--keep`→`--rm[=false]`, `keep=false`→`--rm`);
   the invariant (default keeps, net rules, `saveConfirmed`, `quitPlan`) unchanged.
   `tentacle.kept` label and `KEPT_SCHEMA_VERSION` untouched (no grep hit).

**Mutation (§9):** `resolveRm` default `?? false` → `?? true` (the run-keeps-by-default
flip, the most load-bearing). `main` + `engine-select` + `engine-keep` tests:
**9 fail / 136 pass**. Restored from backup; `shasum -c` OK (byte-identical).

**Findings:**
1. **LOW** — `CHANGELOG.md` (and this doc's CHANGELOG text, l.352) says a
   previous-build run "cannot attach": true only while its relay lives; with the
   relay gone `planAttach` gives `plain` (`attach-plan.ts:51-53`), i.e. a
   user-owned attach without its session/`--rm` ownership. Safe direction
   (keeps), but the sentence overstates. Recommend: "cannot take it over while
   its relay runs; afterwards `attach` is a plain one (no delete)". The manual
   check l.704 already says it correctly.

**Owner question:** none blocking. Optional: fix finding 1's wording before merge
(recommended, docs-only on this branch).

**Executor behaviour:** claude-sonnet-5-5; diff is a disciplined mechanical rename
with comments rewritten to the new sense rather than search-replaced, v1 refusal
pinned with the real old shape. Reviewer is claude-opus-5-5 — same Claude family,
different model, fresh context: shared blind spots possible.

*— claude-opus-5-5, 2026-11-06*

## Owner questions

N1. ~~Name of `keepHint`~~ — **decided (round 2): rename to `resumeHint`.** See
Design 7.

### Owner answers (2026-11-05)

1. `--keep`: plain `unknown option --keep`, no "(replaced by --rm)" hint.
2. **Rename the internal `keep` field to `rm` everywhere** (run records, relay spec, `attach-plan`, …) with a `RUN_STATE_VERSION` bump — owner chose this over the recommendation. The plan must be updated: files, persisted-format failure modes (records written by the previous version: refused loudly per §7, or read once?), Size/Blast.
3. Old task docs keep their `--keep` mentions; update only README, help, config template, `docs/attach-detach-behaviour.md`.

*Plan updated for answer 2 — claude-sonnet-5-5, 2026-11-05.* Decided in the
update (no question needed): the records are refused, not read once (§7, the
existing `unknown` paths; Failure modes); label `tentacle.kept` and
`KEPT_SCHEMA_VERSION` stay (they mean "listed", not the flag).

### Owner answers (2026-11-05, round 2)

- Re-asked with the new cost (L, load-bearing, ~375 lines, old detached runs → `unknown owner`, only `rm`): **B confirmed** — rename everywhere.
- N1: **rename `keepHint` → `resumeHint`** (recommendation accepted).

Refreshed on main 8bcca6a, awaiting owner re-approval. *— claude-sonnet-5-5, 2026-11-06*
