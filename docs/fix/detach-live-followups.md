# fix/detach-live-followups — the follow-ups of fix/detach-live, plus `--model`

> **Status:** execution round 3 done 2026-11-03 (owner decisions A/B/C of 2026-11-03 applied) — awaiting a re-Review
> **Branch:** `fix/detach-live-followups`
> **Type:** fix · **Size:** M (≈13 source files in 5 packages, each change S; no new seam) · **Blast:** load-bearing (config precedence, the relay's model and record, the laptop session store) · **Suited:** Opus executes, mandatory fresh-context Review

Size note: if the owner takes Q12 (a cross-process lock) into this branch, it becomes L. Then Q12 must be split into its own task (OQ10). Two phases, one gate each, on this one branch:
- **Phase A** (user-visible, ships first): F2–F5 (F1 dropped, OQ6).
- **Phase B** (persistence/lifecycle): F6–F9.

## Context

*— claude-opus-5-5, 2026-11-02*

`fix/detach-live` was merged at `0edf0be`. Its owner closed the scope with a list of follow-ups (`TODO.md:1116`). The sources are in `docs/fix/detach-live.md`: Q8/Q11/Q12/Q13 (`:1447`, `:1526-1528`, `:1568`), the R9 note (`:1596`, `:1641`) and Q-A1 (`:1789`). The owner added a note on 2026-11-02:
- `--model <id>` must work on EVERY command that starts or joins a session (`run`, `attach`, `connect`, the plain TUI).
- It is a CLI equivalent of `TENTACLE_MODEL`: a model id on the active profile's endpoint, with no config change.

The goal is to ship before the next release, so the user-visible items come first. There is no protocol change unless one is unavoidable. Exactly one item would need one (F5 on `connect`); it is flagged there and in OQ1.

| # | Item | Source | Seen by the user |
|---|---|---|---|
| F1 | ~~The TUI error line shows `⚠ RpcError: connection closed`~~ — DROPPED: the owner keeps the class name (OQ6) | live KO 5, `detach-live.md:75` | yes |
| F2 | `↑0 ↓0` and `ctx 0%` in the status bar after a failed turn | `TODO.md:1116` | yes |
| F3 | `tentacle rm` takes only one name | `TODO.md:1116` | yes |
| F4 | `ps` lists `gone` rows forever | `TODO.md:1116` | yes |
| F5 | `--model <id>` on every session command | Q-A1 + owner note | yes |
| F6 | Q13: a FAILED keep=true run whose laptop copy lags does not say `not saved` | `detach-live.md:1440,1528` | `ps` |
| F7 | Q11: the Q6 `.aside` files are never removed | `detach-live.md:1484,1526` | disk |
| F8 | R9: the synchronous `onIdle` flush is load-bearing but has no comment | `detach-live.md:1596,1641` | no |
| F9 | Q8: the marker for a turn cut mid-stream by a lone `/quit` | `detach-live.md:1447,1568` | resumed history |
| F10 | Q12: the cross-process window of the Q6 guard | `detach-live.md:1482,1527` | no |

### Owner decisions (2026-11-02), binding

OQ1 = a: `connect --model` is refused loudly. `connect` uses the model that `tentacle serve` serves. · ~~OQ2 = rec: `--model` is a leading global, like `--profile`.~~ **SUPERSEDED 2026-11-03 by decision A below.** · OQ3 = yes: `tentacle serve --model <id>` sets the model its `connect` clients use (wording per decision A). · OQ4 = rec: X is for this TUI only; the kept entry and `ps` keep Y. · OQ5 = partial: tokens read `↑– ↓–` and ctx reads `ctx –` until this TUI measures a turn. There is **no** `~NN%` from history. · **OQ6 = KEEP the class-name prefix, so F1 is DROPPED.** · OQ7 = rec: `rm` continues past a failure, exits 1 if any failed, and asks y/N per name as today; `-f` asks nothing. · OQ8: plain `ps` hides `gone` rows with **no footer line**. `ps -a` shows every row. `rm` removes them for good. · OQ9 = rec. · OQ10 = rec: Q12 is deferred. · OQ11 = rec: Q8 is closed with R-F9 as evidence. · OQ12 = rec. · OQ13: already confirmed.

### Owner decisions (2026-11-03, after the fresh Review), binding

- **A — `--model` and `--profile` are NO LONGER leading global options (supersedes OQ2 and Q-R3).** They are flags of the SESSION commands, written AFTER the command: `tentacle run [...] --model X --profile Y`, `tentacle attach <name> --model X`, `tentacle serve --model X`; the bare local session has no command word, so they go right after `tentacle` (`tentacle --model X`, `-i --profile Y`, `--resume --model X`, `--plain ...`, a one-shot `tentacle --model X "prompt"`).
  - Before a subcommand (`tentacle --model X run`) → an error naming the right form (`--model goes after the command: tentacle run --model X`).
  - On `ps`, `rm`, `update`, `hooks`, `package`, `install` → the normal unknown-option error (each kept entry carries its engine and location; a profile must not filter `ps`: "ps deve mostrare tutti i containers").
  - `connect` keeps refusing both; the hint is `tentacle serve --model <id>`.
  - Semantics unchanged: `--model` beats `TENTACLE_MODEL`, `--profile` beats `TENTACLE_PROFILE`; `attach` uses the run's model unless one of them is given (round 10 owner A); the relay serves `entry.model`; env vars stay.
  - The global-option path is removed; parsing decisions stay in the pure flags module, tested there.
- **B (Q-R4 = add the test).** A test that FAILS if the F8 listeners move to `queueMicrotask`; the F8 comment cites it truthfully.
- **C.** The F6 "save landed" test is renamed: it pins today's behaviour pending Q-N1, which is deferred to `feat/resume-after-model-loss`.

### Evidence, per item (from the source; each one is to be re-run as a red test, see Tests)

- **F1.** `App.tsx:1152` builds the line with `failTurn(…, String(error), …)`. `RpcError` sets `this.name = "RpcError"` (`transport/src/errors.ts:19`), so `Error.prototype.toString` gives `RpcError: <message>`. `failTurn` prefixes `⚠ ` (`tui/src/state.ts:186`). The live output is `⏺ ⚠ RpcError: connection closed` (`detach-live.md:75`). `turn-feed.ts:114` uses `String(error)` the same way.
- **F2.**
  - The agent yields `usage` only on the stream's `done` (`agent/src/agent.ts:757-760`, `:934-935`). A stream that fails yields none.
  - The TUI's totals start at `{0,0}` / `null` (`tui/src/state.ts:110-111`), and only a `usage` event moves them (`:324-336`). `resetHistory` keeps them (`:443-446`).
  - The bar prints `↑{prompt} ↓{completion}` and `ctx` = `lastTurnTokens?.prompt ?? 0` (`App.tsx:2589-2590`, `StatusBar.tsx:93-95`).
  - So any TUI that has measured no usage itself shows `↑0 ↓0 · ctx ░░░░░░░░░░ 0%`. That covers a first turn that failed, an attach after the lid-close failure, and a `--resume` before the first answer.
- **F3.** `ARGS.rm.positional` is `{min:1,max:1}` (`cli/src/flags.ts:141`). A second name is refused with `unexpected argument "b"` (`flags.ts:251-255`). `main.ts:541` passes only `positional[0]`.
- **F4.**
  - `verify` maps a 404 to `{kind:"gone"}` (`kept-cmd.ts:97-99`), and `statusText` prints `gone` (`kept.ts:283-284`).
  - `psCommand` renders every indexed entry (`kept-cmd.ts:148-168`). Only `rm` drops one (`kept-cmd.ts:266-267`, `:404-417`).
- **F5.**
  - Only `--profile` is a global option (`flags.ts:474-528`). No command spec has `model` (`flags.ts:68-143`). So `--model` is an unknown flag everywhere.
  - The model id comes from `pick(env.TENTACLE_MODEL, model.model, DEFAULT_MODEL)` (`config/src/resolve.ts:284`).
  - `connect` needs no laptop config at all: it dispatches before `loadConfig` (`main.ts:405-445`). Its model is the `serve` daemon's own, and `session/open` carries no model (`protocol/src/session.ts:427-442`).
- **F6.** `relay.ts:529-536` writes the Q3 note only when `finalView(model).state !== "failed"`. A failed run keeps just its reason in `detail` (`relay-state.ts:102-112`, `run-state.ts:426-427`).
- **F7.**
  - `writeAtomic` writes a stale copy to `<uid>.stale-<ms>-<8hex>.aside` (`agent/src/session-store.ts:499-513`).
  - `removeFile` removes only `<uid>.json` (`:563-570`).
  - `rm` deletes the workload and the run dir, never laptop sessions (`kept-cmd.ts:291-302`).
- **F8.** Only the setter's own synchronous call makes `flush()` (which sets `confirmed = false`) run before any reader of `saveConfirmed`:
  - `RemoteSession`'s `streaming` setter calls the idle listeners synchronously (`client/src/remote-session.ts:175-181`);
  - the `onIdle` subscription calls `flush()` (`cli/src/local-runtime.ts:344-352`).

  Neither place says so.
- **F9.** **Already done by round 8 for the case the TODO names.**
  - `attach-run.ts:616` passes `ending: runQuit.othersOnSession() === 0`.
  - `quit` calls `cutTurn()` on `closeForAll || ending` (`local-runtime.ts:698-704`).
  - `cutHistory` closes a prompt-only or tool-result tail with `ENDED_TURN_NOTE` (`local-runtime.ts:238-248`).
  - Pinned by `local-runtime.test` "live item 6" ×2 and `attach-run` Q2 (`detach-live.md:1549`, `:1630`).
  - What is NOT covered: (i) the plain `dispose` path (`local-runtime.ts:645-651`: non-detached `run`, the plain TUI, a non-detached `attach`); (ii) a user cancel (Esc), for which the daemon writes no note (no cancel constant in `daemon/src/persisted-session.ts:361-417`). Whether either really leaves a bare-prompt tail on the laptop is **unverified** (repro R-F9).
- **F10.** The guard's `load` (`session-store.ts:499`) and its `rename` (`:505`) are not atomic across processes. The owner accepted this window on 2026-11-02 (`detach-live.md:45`).

**Repro.** I did not run these (shell runs were refused in this planning session). The executor runs them on current `main` before any edit, with `TENTACLE_CONFIG_DIR=<repo>/.tentacle/tmp/detach-live-followups/cfg`, and pastes the output here. The expected output is taken from the code cited above:

```
$ tentacle rm alpha beta          → [error] unexpected argument "beta"  + usage   (F3)
$ tentacle --model foo ps          → [error] unknown option --model …              (F5)
$ tentacle attach box --model foo  → [error] unknown option --model …              (F5)
```

F1, F2, F6 and F7 are reproduced by their red tests (Tests). F9 is reproduced by R-F9.

## Implementation

*— claude-opus-5-5, 2026-11-02*

### Load-bearing assumption

**`--model` can be a pure laptop-config override.** Every session path that talks to a LAPTOP model takes it from one of two places:
- the single `config` that `main` loads (`main.ts:476-481`) and passes down: the TUI, the in-process worker, `run`/`attach` through `ProxyModelProvider`, `serve`'s `startDaemon(config…)` (`main.ts:617`), and the kept entry's `model: config.model` (`main.ts:897`);
- the kept entry: the relay (`relay.ts:595-606` reads the entry) and `attach`'s `useRunModel` (`main.ts:1107-1136`).

No other `loadConfig` caller exists (`rg 'loadConfig\('`: `main.ts:477`, `:1123`, `relay.ts:595`). So an override applied in `loadConfig`, plus the relay taking `entry.model`, reaches every laptop-model path.

The exception is proven too: `connect` loads no laptop config (`main.ts:405-445`). Its model lives in the `serve` daemon, and the wire has no field for it (`session.ts:427-442`). **`connect --model` is the only item that would need a protocol change** (OQ1).

### Preconditions (verified)

- **Precedence is "env > profile > file > defaults"** (`main.ts:220`, `resolve.ts:284`). A CLI flag beats its env twin: `--profile` beats `TENTACLE_PROFILE` (`load.ts:57`).
- ~~**`--profile` is a leading-only global.**~~ **SUPERSEDED (decision A, 2026-11-03):** `--profile` and `--model` are flags of the session commands, after the command; `connect` refuses both.
- **The relay inherits `process.env`** (`relay.ts:629`), so `TENTACLE_MODEL` reaches it today. A flag does not, so the relay must take the model from the kept entry. The relay already reads that entry (`relay.ts:600-605`).
- **Round 10 owner A:** `attach <name>` uses the run's model unless the command names one (`run-model.ts:15-31`). `explicit.model` today is only `TENTACLE_MODEL` (`main.ts:1114`).
- **`ps -q` verifies nothing** (`kept-cmd.ts:136-141`), so it cannot know `gone`.
- **`rm` never touches laptop sessions** (`kept-cmd.ts:291-302`): laptop history is kept by design (AGENTS §7 Persistence).
- **The Q6 aside name never collides with another id's files** if it is matched strictly. `SAFE_ID` allows `.` (`session-store.ts:153`), so the match must be exact: `^<id>\.stale-\d+-[0-9a-f]{8}\.aside$`, never a prefix.
- **`/sessions` delete reaches `JsonSessionStore.remove`** through `saver.remove` (`local-runtime.ts:546`, `session-saver.ts:104`).
- AGENTS §7 "Pod/container lifecycle": an unreachable engine never prunes an entry. A 404 is "reachable, absent", but its meaning depends on dialling the right place, which a renamed kube context breaks (TODO 4e(2)). This is why F4 hides rows and does not prune them.

### Design

**F1 — DROPPED (OQ6: the class-name prefix stays).** Nothing is built.

**F2 — say "unknown", never a fake 0 (OQ5).**
- A pure `statusTokens(state)` in a new `tui/src/status-view.ts` returns `{ totals: TokenTotals | null, context: number | null }`.
- Both are `null` until this TUI has applied a `usage`; `lastTurnTokens === null` is exactly that fact (`state.ts:111`, `:324-336`), so `DisplayState` needs no new field.
- `StatusBar` renders `↑– ↓–` and `ctx –` for `null`, and only renders.
- The first measured turn gives the real numbers. There is nothing from history (no `~NN%`).

**F3 — `rm <name>...`.**
- `ARGS.rm.positional` becomes `{min:1,max:Number.MAX_SAFE_INTEGER}`.
- `rmCommand` keeps its one-name body, renamed `rmOne`. A new `rmCommand(names, …)` dedups the names in order and runs `rmOne` sequentially: one engine dial, one y/N and one stop per name, as today.
- It continues past a failure and returns 1 if any name failed (OQ7).
- `USAGE.rm` becomes `… <name>...`.

**F4 — hide `gone` (OQ8: no footer line).**
- Plain `psCommand` drops rows with `status.kind === "gone"` that have no live relay pid and no attached TUI. A live process stays visible: never hide what still acts.
- If nothing is left, it prints the empty line.
- A new `-a/--all` bool shows them. `-q` is unchanged (no verify). `rm` drops the entry for good.
- The filter is a pure predicate in `kept.ts` (`shownInPs(row, all)`); `kept-cmd.ts` only applies it.

**F5 — `--model <id>`.**
- ~~`extractGlobalOptions` accepts `--model` as a leading global with `--profile`'s rules.~~ **SUPERSEDED by decision A (2026-11-03), as built:**
  - `ARGS.run`, `ARGS.attach`, `ARGS.serve`, `ARGS.tui` and `ARGS.plain` take `model` and `profile` values (`parseArgs` gives the missing-value / repeat errors); `ps`, `rm`, `update`, `hooks`, `package`, `connect` do not (the normal unknown-option error).
  - `extractGlobalOptions` is replaced by the pure `extractSessionFlags`, which only handles what a spec cannot: a one-shot prompt's leading options, the options BEFORE a subcommand (an error naming `tentacle run --model X`; `unknown option` for `ps`/`rm`/…), and `connect`'s refusal (naming `tentacle serve --model <id>`).
  - `cliMode` takes `--plain` anywhere among the leading options, so `--model X --plain` works.
- `LoadConfigOptions.model?` (`config/src/load.ts:47-59`) "beats `TENTACLE_MODEL`". `loadConfig` resolves with `TENTACLE_MODEL` replaced by it, on a COPY of `env` (`process.env` untouched, so no child sees it).
- `main.ts` passes `modelFlag` / `profileFlag` (from `extractSessionFlags` for a prompt, else from the parse) to `loadConfig`, the relay spec and `useRunModel`.
- **Relay:** `relayMain` runs with `config.model = entry.model` (`relay.ts:600-606`). The launcher wrote `entry.model = config.model` (`main.ts:897`), so the relay serves exactly the model the launcher chose, and `ps` shows it. There is no spec field and no on-disk change.
- Help (`main.ts:195-197`), the provider hint (`anthropic-provider.ts:422`: "… or --model / TENTACLE_MODEL"), `README.md` and `docs/feat/config-profiles.md` get one line each.
- `serve` takes it for free: it sets the daemon's model for its `connect` clients (OQ3).

**F6 — Q13.** At `relay.ts:529-536`, a failed run (still with keep=true, no hand-over, and `!settled || unsaved.length > 0`) emits `note` with `detail = "<its failure detail> · not saved — the laptop copy lacks the last turn"`. `ps` then reads `failed: <reason> · not saved — …` (`run-state.ts:426-427`). It is informational, and no delete changes (owner Q3 = a).

**F7 — Q11.**
- `removeFile` (`session-store.ts:563`) also removes the strict-name `.aside` files of that id, best-effort: readdir, then `rm` each match. A failure leaves a file that is never loaded (`:628`). It does not fail the removal, because the session WAS removed.
- `rm` is unchanged (OQ9).
- `serve`'s store has no `onAside`, so it has no asides; the code path is shared and harmless.

**F8 — R9 comment.**
- On the setter (`remote-session.ts:175-181`): "LOAD-BEARING (detach-live R9): listeners run synchronously, inside the setter; making this async lets `saveConfirmed` read `true` before the post-turn save starts."
- On the subscription (`local-runtime.ts:344-352`): the mirror sentence.
- There is no code change.

**F9 — Q8.** No code by default. The executor runs R-F9 and pastes it:
- a detached run with a lone `/quit` mid-stream must end on `ENDED_TURN_NOTE` (expected: already true);
- a plain-path `/quit` mid-stream, and an Esc mid-stream: record what the laptop record's tail is.

If (ii) ends on a bare prompt, that is the Q-B1 policy the owner already routed to `feat/resume-after-model-loss` (`TODO.md:1116`). Q8 is closed here with that evidence (OQ11).

**F10 — Q12.** Not built by default (OQ10).

### Files (dependency order)

| Phase | File | Item |
|---|---|---|
| A | `packages/config/src/load.ts` | F5 `model` option |
| B | `packages/agent/src/session-store.ts` | F7 |
| B | `packages/client/src/remote-session.ts` | F8 (comment) |
| A | `packages/providers/src/anthropic-provider.ts` | F5 hint text |
| A | `packages/cli/src/flags.ts` | F3 positional, F4 `-a`, F5 global |
| A | `packages/cli/src/main.ts` | F3 call, F5 load/`useRunModel`/help |
| A | `packages/cli/src/relay.ts` | F5 `entry.model`; B: F6 |
| A | `packages/cli/src/kept.ts` | F4 `shownInPs` |
| A | `packages/cli/src/kept-cmd.ts` | F3 loop, F4 filter |
| B | `packages/cli/src/local-runtime.ts` | F8 (comment) |
| A | `packages/tui/src/status-view.ts` (new) | F2 |
| A | `packages/tui/src/App.tsx` | F2 props |
| A | `packages/tui/src/components/StatusBar.tsx` | F2 render `–` |
| A | `README.md`, `docs/feat/config-profiles.md` | F3/F4/F5 docs |

No protocol, daemon, on-disk format or `PROTOCOL_VERSION` change, unless the owner picks OQ1 (b). That would be a separate `feat` that bumps protocol 15.

### Failure modes

- **F5**
  - **Unknown model id:** the endpoint refuses it on the first turn, the same as `TENTACLE_MODEL` (no offline check exists). The hint names `--model`.
  - **Window:** the context window stays the profile's (`engine-runtime.ts:75-83`), the same as `TENTACLE_MODEL`. To be said in the help.
  - **`attach <run> --model X` on a run started with Y:** explicit wins for this TUI (Q-A1), and `ps` keeps showing Y ("the model at start", `kept.ts:366`) (OQ4).
  - **Relay:** an entry whose `model` is empty cannot exist (`KEPT_SCHEMA` requires it). If the profile no longer loads, `relayMain` fails as today (`relay.ts:607-609`).
  - **Leaks (AGENTS §7):** a model id is not a secret, and only the laptop config is touched. The pod gets nothing new.
  - **Misplacement or a repeat:** a loud error, never ignored.
- **F3**
  - **Ctrl+C mid-loop:** each name is atomic as today, so the names already done stay done.
  - **Duplicates:** they are deduped, so the second y/N is never asked and no second "no kept … named" error appears.
  - **An ambiguous name:** its error is printed and the loop continues.
  - **Mixed results:** exit 1, and every name has its own line.
- **F4**
  - **A 404 from a wrongly dialled place** (a renamed context): the row is hidden, not pruned. The entry survives, and `-a` shows it.
  - **A `gone` row with a live relay or TUI:** it stays visible.
  - **Hidden, never lost:** the owner chose no footer (OQ8). The entry stays in the index, and `-a` lists it.
- **F2:** a later failed turn keeps the last measured figures; `failTurn` touches no tokens.
- **F6:** a failure detail that is already long is cut by the table column as today; `-v` shows it whole.
- **F7**
  - **A cross-process writer that sets an aside AFTER the remove:** it stays, and is never loaded. The same holds for a save after a remove, which re-creates the file (`session-store.ts:550-555`).
  - **readdir fails:** the session file is still removed.
- **F8/F9:** no runtime change.

### Tests (red first; each red is run on the unchanged code and pasted in Execution)

- **F2**
  - `tui/test/status-view.test.ts`: a fresh state and one after `failTurn` give `{totals: null, context: null}`; after a `usage` the measured values, which a later failed turn keeps.
  - App frame: after a failed first turn the bar shows `↑– ↓–` and `ctx –`, and after a measured turn the numbers. Red: `↑0 ↓0` and `0%`.
- **F3** `cli/test/kept-cmd.test.ts`, with the existing fake hosts:
  - `rm a b` removes both;
  - `rm a missing b` removes a and b, says the missing name's error, and exits 1;
  - `rm a a` on a RUNNING `a` answered `n` asks once (without dedup it asks twice).

  The parser takes `rm a -f b c`. Red: `parseArgs` fails on the second name.
- **F4** `kept-cmd.test`:
  - one `gone` row and one running row → exactly the running row, no footer (`toBe`), and the entry is not pruned;
  - only `gone` rows → the empty line;
  - `-a` → both;
  - a `gone` row whose run dir has a live lock holder, or a live TUI presence → shown.

  Red: the `gone` row is printed.
- **F5**
  - ~~`flags.test`: `--model x` taken as a leading global~~ — superseded by decision A: `session-flags.test.ts` (specs of the session commands, the unknown-option error on `ps`/`rm`/…, `extractSessionFlags`: prompt options, before-a-subcommand errors, `connect` refusal).
  - `config/test/load.test.ts`: `model` beats `TENTACLE_MODEL` and the profile, and `process.env` is unchanged.
  - `main.test.ts`, for the TUI's `config.model` (the existing `startTui` spy) under `--model x`:
    - the plain TUI, a one-shot prompt and `run`;
    - `attach <run> --model x`: x wins over the run's model. Mutation: `useRunModel` without `modelFlag`.
  - `relay.test.ts`: the relay's provider gets `entry.model` when the env has none.
  - Red: the unknown-option error / `laptop-default`.
- **F6** `relay.test.ts`: a sibling of the Q3 test where the turn fails and the save does not land. Red: `detail` lacks `not saved`. Mutation: the old `!== "failed"` guard.
- **F7** `agent/test/session-store.test.ts`:
  - a held file, then a stale save (an aside exists), then `remove` → no `.aside` left;
  - the aside of the id `a.stale-1-deadbeef` survives a `remove("a")`.

  Red: the aside remains.
- **F8:** comment only, so no new test. The existing R9 test (`local-runtime.test`, "R9") already kills the "no idle flush" mutant (`detach-live.md:1629`). The Review re-runs that mutant.
- **F9 (R-F9, a repro, not a test unless the owner asks):** a scratch copy of the `local-runtime.test` "live item 6" rig under `.tentacle/tmp/detach-live-followups/`, with three cases:
  - a lone `quit({ending:true})` mid-stream;
  - `dispose()` mid-stream;
  - a cancel of the own turn mid-stream.

  Print the laptop record's roles and its last content. Paste the output.
- **Gate per phase:** narrow files first, then `bun run check` (lint baseline 0/0, the 3 opt-in skips).

### Owner questions (ANSWERED 2026-11-02 — see "Owner decisions" in Context; kept as asked)

1. **OQ1 — `connect --model`.**
   - **Rec (a):** refuse it loudly, as `--profile` is refused (`flags.ts:521-526`): "the remote daemon uses its own model — start it with `tentacle --model <id> serve`".
   - (b) Make it work. That needs `session/open{model}` plus a per-session model in the daemon, so a **PROTOCOL_VERSION 15 bump** (a silently dropped field on an older daemon is not acceptable). That is its own `feat` after the release.
2. **OQ2 — Where `--model` goes.**
   - **SUPERSEDED 2026-11-03 (decision A):** a flag of the session commands, after the command; not a global. (The original rec was: a leading global, exactly like `--profile`.)
   - Alternative: also accept it as a per-command flag after `run`/`attach`/`-i` (two parse paths).
3. **OQ3 — `--model` with `serve`.** **Rec yes:** it sets the daemon's model for its `connect` clients. It comes for free and is the answer to OQ1 (a).
4. **OQ4 — `attach <run> --model X` on a run started with Y.**
   - **Rec:** X for this TUI only. The kept entry and `ps` keep Y (the model at start).
   - Alternative: rewrite the entry's model.
5. **OQ5 — Tokens and ctx that this TUI has not measured.**
   - **Rec:** `↑– ↓–`. ctx comes from the history's last `contextUsage`, shown `~NN%`, else `ctx –`. The first measured usage replaces them.
   - Alternatives: `–` only, or hide the token field until it is known.
6. **OQ6 — Error text.**
   - **Rec:** drop the class name for EVERY error (`ModelRequestError:` etc. too), message only.
   - Alternative: only `RpcError`.
7. **OQ7 — `rm` with several names.** **Rec:** continue past a failure, exit 1 if any failed, one y/N per name (as today's single prompt).
8. **OQ8 — `gone` rows.**
   - **Rec:** hide them by default, with the footer and `ps -a`.
   - Auto-pruning is NOT recommended: a renamed kube context gives a 404 for a pod that still exists elsewhere, and its entry would be lost.
9. **OQ9 — Q11, aside files.** **Rec:** delete them with the session (`/sessions` delete → `store.remove`). Not with `tentacle rm`, which by design keeps the laptop history they belong to.
10. **OQ10 — Q12, the per-file lock.**
    - **Rec:** defer again (accepted 2026-11-02). Revisit with Q9's revision counter in `permission-reply`'s record bump.
    - If wanted now: an O_EXCL `<uid>.json.lock` with pid + start-time liveness and a bounded wait, injected through `SessionStoreIo`, as its own task (it makes this one L).
11. **OQ11 — Q8.**
    - **Rec:** close it here as done in round 8 (lone and for-all `/quit` are marked), with R-F9's output as evidence.
    - A bare-prompt tail after a cancel or a plain-path quit goes to Q-B1 in `feat/resume-after-model-loss`.
12. **OQ12 — Q13 wording.** **Rec:** `failed: <reason> · not saved — the laptop copy lacks the last turn`.
13. **OQ13 — Round 10's open defaults Q-A2–Q-A4** (`detach-live.md:1790-1792`). **Rec:** confirm them as they are, unchanged by this task:
    - the `ps` id on the run's profile;
    - for old entries, the current config + the `ps` id;
    - this applies to every kept attach.

## Execution

*— claude-opus-5-5, 2026-11-02*

`node_modules` was installed by the orchestrator (`bun install --frozen-lockfile --filter '!@tentacle/mobile'`); my own install was refused. Order: the doc (owner decisions, plan amended), then Phase A (F3, F4, F5, F2), then Phase B (F6, F7, F8, F9). F1 was not built (OQ6). F10 was not built (OQ10).

### Per item

| Item | Change (file) | Red on main's code (the assertion) | Green |
|---|---|---|---|
| **F3** `rm <name>...` | `flags.ts` `ARGS.rm.positional.max = MAX_SAFE_INTEGER`, `USAGE.rm`; `kept-cmd.ts` `rmCommand(names)`: dedup (`Set`), then the old body (`rmOne`) per name, sequentially, `max` of the exit codes; `main.ts` passes `parsed.positional` | `parseArgs(["a","-f","b","c"], ARGS.rm)` → `Received: false`. The three `rmCommand([...])` tests crashed in `untrustedText` (a `TypeError`, not an assertion), so the parser test is the honest red | `kept-cmd.test` F3 ×5 |
| **F4** hide `gone` | `kept.ts` `shownInPs(row, all)` (pure); `kept-cmd.ts` filters after `sortKept`, prints the empty line when nothing is left; `flags.ts` `ps -a/--all`; `main.ts` passes `all` | plain `ps`: `+ b … gone` printed; only-gone: the table instead of `No kept containers or pods.` | F4 ×3, incl. a live relay lock or TUI presence keeping the row |
| **F5** `--model <id>` | `flags.ts` `extractGlobalOptions`: `GLOBAL_FLAGS` (`--profile`, `--model`), same rules, any order; after a command → `--model must come before the command`; with `connect` → the OQ1 error naming `tentacle --model <id> serve`. `config/load.ts` `LoadConfigOptions.model` → `TENTACLE_MODEL` on a COPY of env. `main.ts`: passed to `loadConfig`; `useRunModel`'s `explicit.model` includes it (OQ4); help text. `relay.ts` `runRelay`: `config.model = entry.model`. `anthropic-provider.ts` hint names `--model` | `global-options.test`: `rest` kept `--model m1` (×4 tests); `load.test`: `Received: "env-model"`; `main.test` attach: `model: "deep-chat"`, detached run entry `model: "deep-chat"`; `relay.test`: `["laptop-x"]` | all green |
| **F2** unknown tokens | `tui/src/status-view.ts` (new, pure) `statusTokens`: `null`s while `lastTurnTokens === null`; `StatusBar.tsx` renders `↑– ↓–` / `ctx –`; `App.tsx` passes the view | App frame: `/tmp/work · ↑0 ↓0 · ctx ░░░░░░░░░░ 0% (0/128k)` after `⚠ Error: model connection lost mid-stream (ECONNRESET)`, the live symptom | App F2 (failed → `↑– ↓–`, `ctx –`; then measured → `↑64k ↓2`, `50%`), `status-view.test` ×2, `ContextMeter` `ctx –` |
| **F6** Q13 | `relay.ts`: the keep=true note also for a failed run, `"<reason> · not saved — the laptop copy lacks the last turn"` | `Received: "internal error"` (the mutation below re-runs main's guard against the final test) | `relay.test` F6 ×2 |
| **F7** Q11 | `session-store.ts` `removeFile` → `removeAsides(id)`: `readdir`, then `rm` of `<id>.stale-` + `ASIDE_TAIL` (`^\d+-[0-9a-f]{8}\.aside$`), best-effort | `s.stale-1793658444282-26573132.aside` left after `remove("s")` | Q11 test; the twin id `s.stale-1-deadbeef` keeps its file and aside |
| **F8** R9 comment | `remote-session.ts` setter, `local-runtime.ts` `onIdle`: LOAD-BEARING comments | — (comment) | mutation below |
| **F9** Q8 | no code | R-F9 below | — |

### Drift from the Implementation

- **F2:** no `measured` field. `lastTurnTokens === null` is already exactly "nothing measured" (set only by `usage`, kept by `failTurn`/`resetHistory`).
- **F3:** `rmCommand` takes `string | readonly string[]`, so the 40 existing one-name call sites in the tests are unchanged.
- **F4:** the empty line also covers "only gone rows". There was no `docs/feat/engine-ps-rm.md` edit; `README.md` covers `-a` and several names.
- **F5:** the relay change is in `runRelay`, not `relayMain`, so it is testable through the rig's `attach` seam. `main.test` covers `attach` and `run --detach`; the plain TUI and one-shot prompt paths take the same `loadConfig` call (`main.ts:477`), pinned by `load.test`, but have no `main.test` case of their own.
- **F6 changed one existing expectation:** "the link stopped: `failed`…" (`relay.test.ts:412`) now reads `the container is gone · not saved — …`. The turn was in flight when the link stopped, so the laptop copy lacks it; that is exactly Q13.
- **F6 test:** the model streams one event before failing. A turn that fails before its first event triggers no save (`persistingController` `saved`, "changed nothing"), so nothing is unsaved. See Notes.

### R-F9 (Q8 evidence; a temporary test in `local-runtime.test.ts` with the "live item 6" rig, `cp` backup, removed, `shasum` `77164f4c…` identical)

```
R-F9 (i) lone /quit mid-stream: [["user","first turn"],["assistant","Failed: connection closed. The turn stopped here; the reply above, if "]]
R-F9 (ii) dispose mid-stream: []
R-F9 (ii) cancel+dispose mid-stream: [["user","first turn"]]
```

- (i) A lone `/quit` is marked, as round 8 says (in this rig by the daemon's failed note, since the relay left first; `ENDED_TURN_NOTE` otherwise, pinned by "live item 6" ×2). Q8 is closed (OQ11).
- (ii) The plain path (the App cancels a running turn, then `dispose`) leaves a bare prompt, which is Q-B1 → `feat/resume-after-model-loss`. A `dispose` with no cancel saves nothing at all. That is not an App path (it cancels first), so it is unverified in a real TUI.

### Mutations (`cp` to `.tentacle/tmp/detach-live-followups/bak/`, narrow test, `cp` back; every `shasum` identical after restore)

| Item | Mutant | Killed by | `shasum` restored |
|---|---|---|---|
| F3 | no dedup | `rm a a`: `asked` length 2 | `kept-cmd.ts` `dee463d4…` |
| F4 | `shownInPs` always true | F4 ×2 (`b … gone` printed) | `kept.ts` `ef021d7b…` |
| F5 | `useRunModel` without `globals.model` | `main` owner A: `model: "deep-chat"` | `main.ts` `29e5940d…` |
| F2 | unmeasured → `sessionTokens` / `0` | App F2 (`↑0 ↓0`), `status-view` | `status-view.ts` `0c226e30…` |
| F6 | main's `state !== "failed"` guard back | F6 (`internal error`), link-stopped | `relay.ts` `85d04a03…` |
| F7 | no `removeAsides` | Q11 (aside left) | `session-store.ts` `fb8a0825…` |
| F8 | no idle flush (`turns === -1`) | the existing R9 test (record lacks `tool`) | `local-runtime.ts` `9a5b787a…` |

### Gate

- `bunx tsc --noEmit`: clean.
- `bunx biome check .`: 599 files, 0 errors / 0 warnings. Two formatter findings, in `App.tsx` (import order) and `session-store.test.ts`, were fixed by hand; no `--write`.
- `bun test packages`: **4105 pass, 3 skip, 0 fail** (4108 tests, 278 files). The baseline is 4082 / 3 / 0, so +23.

### Repro

The Context's CLI repro block was not run through the binary. Its exact errors are the parser reds above: `rm a b`, and `--model` left in `rest`, hence the unknown option.

### Notes (not done, no new owner decision taken)

- **A pre-existing gap seen while writing F6:** a turn that fails before its FIRST event writes nothing to the laptop (`local-runtime.ts` `saved`: "changed nothing"). Since round 10 the daemon's history does change on such a failure (`closeFailedTurn` adds the failed note), so the laptop copy can lack the prompt and the note while the relay counts it as `settled`.
- **Unverified live:** `ps` / `rm` / `--model` against a real engine and model.

### New owner question (behaviour kept as today)

- **Q-N1.** Should a turn that fails before its first event still be read back and saved? Today: no. Rec: yes (read back on every turn end, since round 10 a failed turn always changes the daemon's history). It belongs with `feat/resume-after-model-loss`, which reworks that path.

### Execution — round 3

*— claude-sonnet-5-5, 2026-11-03*

Scope: the owner's decisions A, B, C of 2026-11-03 (Context, "Owner decisions (2026-11-03)"), after the fresh Review's FIX. Same worktree, uncommitted. Order: B, C, then A (the biggest), then the docs, then the gate. Round 1–2 code is untouched except where A and B say.

| Item | What changed | Red (the assertion) | Green |
|---|---|---|---|
| **A** `--model`/`--profile` after the command | `flags.ts`: `SESSION_MODEL` (`model`, `profile` values) in `ARGS.run/attach/serve/tui/plain`; `extractGlobalOptions` + `GlobalOptions` + `GLOBAL_FLAGS` removed; new pure `extractSessionFlags` (one-shot prompt options, options before a subcommand, `connect` refusal, `install` alias); `cliMode` takes `--plain` anywhere among the leading options; `USAGE` lines. `main.ts`: `extractSessionFlags` instead of `extractGlobalOptions`, `profileFlag`/`modelFlag` (from the prompt form, else from the parse) feed `loadConfig`, the relay spec and `useRunModel`; help text. | `session-flags.test.ts` on a stub that returned `args` unchanged and on the old specs: `unknown option --model` for `run`/`attach`/`serve`/`tui`/`plain`; `model` left in `rest` for a prompt; no error before `run`/`ps`/…; no `connect` refusal (11 failures, 4 pins already green: `ps`/`rm`/… must NOT take them) | `session-flags.test.ts` (15 tests incl. `cliMode`), `packages-cmd.test.ts` migrated, `profile-flag.test.ts` e2e (prompt, `--profile p --model=x`, `--profile p serve` refused, `ps --profile p` unknown, `--model x run`, `connect … --model`), `main.test.ts` migrated to the new forms (`run … --profile`, `attach box --model`, detached `run … --profile deep --model cli-x`) |
| **B** F8 synchrony | new `client/test/idle-sync.test.ts` (real daemon + `RemoteClient`; reads the listeners' count in the same tick `turn_end` is applied) and `local-runtime.test.ts` "R9 synchrony" (fake inner; `saveConfirmed()` is `false` right after the idle notification, `true` only after the save). Both comments (`remote-session.ts`, `local-runtime.ts`) now cite them, and say the R9 mid-turn test alone does not catch a deferred call. | the two mutants below, `Received: 0` and `Received: true` | both green on the real code |
| **C** F6 test | renamed "F6 / Q-N1 (OPEN, deferred to feat/resume-after-model-loss): a run that fails before its first event keeps only its reason — no save ran, so no `not saved` (pins TODAY's behaviour)", with a comment saying it is expected to change then | — (rename) | green |
| docs | help (`main.ts`), provider hint (`anthropic-provider.ts`), `README.md` (a paragraph under Configuration), `docs/feat/config-profiles.md` (an AMENDED note + the superseded bullets/table row), `defaults.ts` comment, this doc's plan text (OQ2, Q-R3, Preconditions, Design F5, Tests marked SUPERSEDED) | — | — |

### Mutations (one per item; `cp` to `.tentacle/tmp/detach-live-followups/bak/`, narrow tests, `cp` back; `shasum` identical after every restore)

| Item | Mutant | Killed by | `shasum` restored |
|---|---|---|---|
| A (1) | the before-a-subcommand check never fires | `session-flags` ×2 (`model` kept, no error) and the e2e `--model x run` | `flags.ts` `e6adc414…` |
| A (2) | `ARGS.ps` takes `SESSION_MODEL` (a profile could filter `ps`) | `session-flags` "commands that take no model" and e2e `ps --profile p` (exit 0) | `flags.ts` `e6adc414…` |
| B (1), the Review's mutant | `remote-session.ts` setter: `listener()` → `queueMicrotask(listener)` | `idle-sync`: `Expected: 1, Received: 0` | `remote-session.ts` `184ec953…` (before the comment edit) |
| B (2) | `local-runtime.ts` idle subscription: `flush()` → `queueMicrotask(flush)` | "R9 synchrony": `Expected: false, Received: true`; the old R9 mid-turn test stays green under it, which is the Review's finding | `local-runtime.ts` `9a5b787a…` (before the comment edit) |
| C | none: a rename pins nothing new | — | — |

### Gate

- `bunx tsc --noEmit`: clean.
- `bunx biome check .`: 600 files, 0 errors / 0 warnings. Three findings were fixed by hand (no `--write`): a `delete` on `process.env`, and two formatter layouts.
- `bun test packages`: **4114 pass, 3 skip, 0 fail** (4117 tests, 279 files). Round 2 was 4105 / 3 / 0.

### Drift from the decisions / the plan

- **`--plain` anywhere.** `cliMode` now returns `plain` when `--plain` is among the leading options, not only first, so `tentacle --model X --plain` works (it did before, with the old leading `--profile`). The plain spec still refuses the TUI-only flags (`-i`, `--resume`).
- **Breaking, on purpose.** `tentacle --profile P serve|run|attach …` (before the command) used to work and is now an error naming the right form; `tentacle serve --profile P` used to be refused and now works. Pre-public, so no shim (AGENTS §7).
- **Before a command that takes no model** (`tentacle --model X ps`), the error is `unknown option --model` from `extractSessionFlags`, printed without the usage line the parse errors carry.
- **`serve --model` has no behavioural test through `main`**: there is no seam to observe `startDaemon`'s config. It is covered by `ARGS.serve` (the flag parses) plus the one shared `loadConfig` call that `run`/`attach`/the TUI tests pin. Unverified live.
- **`connect --profile`** keeps its round-1 text; only the `--model` hint changed to `tentacle serve --model <id>` (decision A).
- `global-options.test.ts` was deleted (every case moved to `session-flags.test.ts`); `docs/feat/engine-ps-rm.md` was not touched.
- The old e2e test `serve --profile p` is gone: under the new rule it would start a real daemon.

### Owner questions (every one open now; my recommendation first)

1. **Q-R2 (all-gone `ps`).** *ANSWERED 2026-11-04: the message is removed; an empty plain `ps` prints only the header row (see "Execution — round 4").* Round 3 text: plain `ps` with only `gone` rows prints "No kept containers or pods." while entries exist and `ps -a` lists them. **Rec:** keep it (OQ8 said no footer); say it once in the help for `ps -a` (done). The alternative reopens OQ8.
2. **Q-R5 (reviewer family).** This is a load-bearing task whose planner, executor and reviewers have all been Anthropic models. **Rec:** one more pass on a different model before the merge.
3. **CHANGELOG.** A `--profile` placement change is user-visible (`CHANGELOG.md:125` mentions `--profile <name>`). **Rec:** a line in the release notes at release time, not in this branch.
4. **Q-N1 bookkeeping.** C defers Q-N1 to `feat/resume-after-model-loss`. **Rec:** add one line to that item in `TODO.md` (a docs-only direct-to-`main` edit, with your OK) so it is not lost; the F6 test's name and comment already point to it.

Q-R1 is answered by C (Q-N1 deferred); Q-R3 and OQ2 by A; Q-R4 by B.

Unverified: `run`/`attach`/`serve` with the new flags against a real engine and model; the live CLI trace the Review could not run.

## Review

*— claude-opus-5-5, 2026-11-03* (round 3; fresh context. I also reviewed rounds 1 and 2, so I am not fresh to the task. The executor this round was claude-sonnet-5-5: the same model family, a different model. Shared blind spots across the family remain possible, see Q-R5.)

This replaces the round-2 Review. Its findings 1 (F8 synchrony) and 2 (the F6 name) were the scope of this round, together with owner decision A.

**Verdict: PASS.** Decisions A, B and C are implemented as stated. Every new test kills its mutant, including two independent mutants of mine. The gate is green. No finding is above LOW.

**Gate (re-run by me)**
- `bunx tsc --noEmit`: clean.
- `bunx biome check .`: 600 files, 0 errors / 0 warnings.
- `bun test packages`: **4114 pass, 3 skip (the opt-in ones), 0 fail**, 4117 tests in 279 files. This matches Execution.

**Placement (decision A): each case vs the code and the test that pins it**

| Case | Behaviour | Pinned by |
|---|---|---|
| `run … --model X --profile Y`, `attach box --model X`, `serve --model X --profile Y` | parsed by the command's spec (`SESSION_MODEL`, `flags.ts:71`) | `session-flags` "run, attach, serve" |
| `serve --stdio --model-proxy --model X` | `--model-proxy` is a different flag (`flagOf` requires an exact match or `--model=`) | `session-flags` |
| bare `tentacle --model X`, `-i --profile Y`, `--resume --model X`, `--model X --plain` | `extractSessionFlags` returns argv as is (`:580-581`) → `cliMode` tui/plain → `parseArgs` | `session-flags` (incl. the `--plain`-anywhere mutant) |
| one-shot `tentacle --model X fix it` | the leading pair comes off; the prompt keeps an inner `--model` | `session-flags` + `profile-flag` e2e (the id beats the file's and `TENTACLE_MODEL`) |
| `tentacle --model X run|attach|serve` | `--model goes after the command: tentacle run --model X` | `session-flags` + `profile-flag` e2e |
| `tentacle --model X ps|rm|update|hooks|package|install` | `unknown option --model` | `session-flags` |
| `ps|rm|update|hooks|package … --model/--profile` | the normal parse error, `unknown option --…` (with the usage line) | `session-flags` + e2e `ps --profile p` exit 1 |
| `connect` with either flag, before or after | the refusal; the model hint is `tentacle serve --model <id>` | `session-flags` + e2e |
| precedence (`--model` > `TENTACLE_MODEL`, `--profile` > `TENTACLE_PROFILE`) | `load.ts` is unchanged since round 2 (`git diff --stat` +7/−1); `main.ts:417-418` feeds `loadConfig` | `load.test`, e2e "beats TENTACLE_MODEL" |
| attach's run-model rule | `run-model.ts` untouched; `main.ts:1133-1136` uses `profileFlag`/`modelFlag` in place of the old globals | `main.test` attach (the entry stays `deep-chat`) |
| relay serves `entry.model` | `relay.ts` unchanged since round 2 | relay F5 |

Hidden children (relay, pod/container delete) are spawned without `--model`/`--profile` (a grep of `packages/*/src` for `"--profile"`/`"--model"` finds no argv builder). No `packages/protocol` change.

**Live CLI trace: not run.** I wrote a driver of the real `main()` with its own `HOME`/`TENTACLE_CONFIG_DIR` under `.tentacle/tmp/detach-live-followups/review/` (`placement.ts`: 24 error-path argv plus 7 parse-only accepted forms). Running it needed a shell approval that was not given. I did not route around that. The executor's `profile-flag.test.ts` drives the same `main()` end to end (under the test env guard) for the prompt, `--profile p serve`, `ps --profile p`, `--model x run`, `connect … --model` and the env precedence. The pure cases are in `session-flags.test.ts`.

**Mutations (`cp` to `.tentacle/tmp/detach-live-followups/review/bak/`, narrow tests, `cp` back)**

After the restores, `shasum` is identical: `flags.ts e6adc414…`, `remote-session.ts d4ada665…`, `local-runtime.ts 111e402c…`.

| Item | Mutant | Result |
|---|---|---|
| A1 | the before-a-subcommand check never fires | KILLED: `session-flags` ×2 and the e2e `--model x run` (it went on to dial the cluster) |
| A2 | `ARGS.ps` takes `SESSION_MODEL` | KILLED: `session-flags` "commands that take no model" and e2e `ps --profile p` (exit 0) |
| A3 (mine) | `connect` refusal only for LEADING flags (`key = firstLead`) | KILLED: `session-flags` connect and e2e (`unknown option --model` instead of the hint) |
| B1 (the round-2 mutant) | `remote-session.ts` `listener()` → `queueMicrotask(listener)` | KILLED: `idle-sync` `Expected 1, Received 0` (it SURVIVED in round 2) |
| B2 | `local-runtime.ts` `flush()` → `queueMicrotask(flush)` | KILLED: "R9 synchrony" `Expected false, Received true` |
| C | rename only | n/a. The name and comment now say it pins TODAY's behaviour, pending Q-N1 (`relay.test.ts:859-864`) |

**Findings (all LOW / nits)**
1. **LOW: the A1-regression test would start a real daemon.** Under the A1 mutant, e2e "`--profile p serve` … refused" timed out at 5 s: `main()` went on to start `serve`. It still fails red, so it is non-vacuous. But a regression there binds a port inside the test run instead of failing fast. A stub for the serve start, or a short `--port 0`, would make the red cheap.
2. **Nit: `tentacle --model X --help` / `--version`** reach the tui spec instead of help/version, because `extractSessionFlags` leaves argv whole and `main.ts:390-400` checks only `args[0]`. Whether that is an error or a silent start depends on the tui spec. Unverified; a one-line test decides it.
3. **Nit: a one-shot prompt whose first word is a subcommand** (`tentacle --model X run the tests`) gets the "goes after the command" error. This is consistent with `tentacle run the tests` being the `run` command, and `--` disambiguates.
4. **Nit: the error for a flag before a no-model command** (`tentacle --model X ps`) has no usage line, unlike the parse errors (Execution, drift). It is clear enough.
5. **Carried, owner-level:** Q-R2 (an all-gone `ps` says "No kept containers or pods.") is still open.

**What holds.** Decision A: one parse path (the specs) plus one pure pre-pass, the global-option path removed, all placements as stated, and connect refusing both, wherever they appear. Decision B: the synchrony is now pinned on both sides (setter and subscription), and both comments cite the tests truthfully. Decision C: done. Rounds 1–2 behaviour is intact (the relay, load and run-model diffs are unchanged; the full suite is green). §7 holds: the model id stays a laptop-config override on an env copy, and the pod gets nothing new.

**Owner-level questions (every one open now)**
- **Q-R2:** should an all-gone plain `ps` keep "No kept containers or pods." (OQ8 literal)? Rec: keep it, and `ps -a` in the help (done).
- **Q-R5:** a different model family for one more pass before the merge (load-bearing; planner, executors and reviewers all Anthropic)?
- **Q-R6 (new, LOW):** make the A1-regression e2e fail fast (stub the serve start) in this branch, or later?
- **Q-R7 (new, nit):** should `--help`/`--version` work after `--model X` / `--profile Y`? Rec: yes, a two-line check in `extractSessionFlags`; a test decides today's behaviour first.
- **Executor's Q3 (CHANGELOG):** note the `--profile` placement break at release. Rec: yes, at release time.
- **Executor's Q4 (Q-N1 bookkeeping):** a `TODO.md` line under `feat/resume-after-model-loss`. Rec: yes (docs-only, direct to `main`, with your OK).

### How the executing model behaved

**Grade: A−** (claude-sonnet-5-5, round 3).
- **Strong.**
  - Decision A was built the clean way: removed, not shimmed; the parsing is pure; the e2e goes through the real `main()`.
  - It added tests for both sides of the synchrony, and showed that the round-2 R9 test alone misses a deferred call. That is the exact property, not a correlate.
  - Every claimed mutation reproduces; the gate numbers match.
  - Drift and breaking changes are written down honestly (the `--plain`-anywhere change, `serve --profile` now accepted, no `serve` behaviour test).
- **Weak.**
  - One e2e red path starts a real daemon (finding 1).
  - `--help`/`--version` after a session flag were not considered.
  - The live CLI repro is again not run (said so).

### Review — round 4 (superseded: round 4 had not run)

*— claude-sonnet-5-5, 2026-11-04* — this note was written when the executor's account had expired and no round-4 work existed in the tree. Round 4 was then executed (below); it still needs its own review.

**Verdict: FIX (nothing to review).** The worktree holds no round-4 work, so no item could be checked.
- There is no "### Execution — round 4" in this doc. The headings stop at "Execution — round 3" and the Review.
- (1) An empty plain `ps` still prints the message: `kept-cmd.ts:148` and `:162` write `EMPTY_LINE`, and `kept-cmd.test.ts:159,189` and `main.test.ts:1340` still expect it.
- (2) `flags.ts` has no `--help`/`--version` handling after `--model`/`--profile`.
- (3) `profile-flag.test.ts` is unchanged from round 3, so the serve A1 e2e still starts a daemon when it fails.

Mutations: none run, because there is no new code or test. Gate: not claimed for round 4. The tree is the round-3 state I passed, so round 3's gate stands. A full `bun test packages` was started and not waited for.

**Question:** was round 4 run in another worktree, or did the executor stop before writing it?

### Execution — round 4

*— claude-sonnet-5-5, 2026-11-04*

Owner answers of 2026-11-04: Q-R2 (remove the empty-`ps` message), Q-R7 (`--help`/`--version` after the session flags), Q-R6 (the serve e2e fails fast). Q-R5 = no extra review; CHANGELOG at release; the Q-N1 TODO line is the orchestrator's. The executor's account had expired, so I did this round myself in the same worktree (uncommitted). Each item was red first.

| Item | Change | Red (assertion) | Green |
|---|---|---|---|
| **1 Q-R2** | `kept-cmd.ts`: both "empty" early returns removed, so `renderTable([])` prints only the header row; `-v` with no rows prints nothing; `-q` unchanged; `-a` unchanged; no footer, no hint. `EMPTY_LINE` deleted from `kept.ts` (no other user). Tests: `kept-cmd.test` (empty index, only-gone, `-a` still lists the gone row), `main.test` `ps` e2e, `kept.test` (EMPTY_LINE assertion and import removed) | `Received: "No kept containers or pods.\n"` where the header was expected (2 tests) | `kept-cmd.test` + `kept.test` 68 pass |
| **2 Q-R7** | `flags.ts` pure `infoRequest(error)`; `main.ts` on a failed `parseArgs`: the exact errors `unknown option --help|-h|--version` print HELP / `tentacle <version>` and exit 0. Nothing that parsed before changes meaning (it only recovers an error), and a one-shot prompt keeps its own `--help` text | `[ "--model foo --version", 1 ]` (expected 0) | `profile-flag.test` "--help and --version still work after --model / --profile": `--model foo --version`, `--profile p --version`, `--profile p --model=foo -h`, `run --profile p --help`, `attach box --model foo --help`, `serve --model foo --help` (none starts a daemon), plus: a prompt `say --help` is still sent; `run --bogus --help` still reports `--bogus` |
| **3 Q-R6** | `main.ts` `CliIO.startDaemon` seam (`(io.startDaemon ?? startDaemon)`); the A1 e2e uses a stub that throws and asserts it was never called. A new test, `serve --model x --profile p`, asserts the stub receives `config.model === "x"` (this also covers OQ3, which round 3 listed as untested through `main`) | see the mutation | green |

Docs: `docs/feat/engine-ps-rm.md` (two lines quoting the old message); README and the help never quoted it. Plan text: Q-R2 above marked ANSWERED; the round-3 text kept.

### Mutations (one per item; `cp` to `.tentacle/tmp/detach-live-followups/review/bak/`, narrow tests, `cp` back; `shasum` identical after each restore)

| Item | Mutant | Killed by | `shasum` restored |
|---|---|---|---|
| 1 | `rows.length === 0` prints "No kept containers or pods." | the two `kept-cmd.test` cases (`Received: "No kept containers or pods.\n"`) | `kept-cmd.ts` `b4cf8177…` |
| 2 | `infoRequest` returns `undefined` for `--version` | the Q-R7 e2e (`[ "--model foo --version", 1 ]`) | `flags.ts` `d3ffb71e…` |
| 3 | the before-a-subcommand check never fires | the A1 e2e: `started` is `["profile-model"]` after about 1 ms (round 3: a 5 s timeout with a real daemon), and the `--model x run` e2e | `flags.ts` `d3ffb71e…` |

### Gate

- `bunx tsc --noEmit`: clean.
- `bunx biome check .`: 600 files, 0 errors / 0 warnings (one formatter layout fixed by hand, no `--write`).
- `bun test packages`: **4116 pass, 3 skip, 0 fail** (4119 tests, 279 files). Round 3 was 4114 / 3 / 0.

### Notes

- The `-v` empty case prints nothing instead of a blank line: not stated by the owner, chosen so `ps -v` has no stray output. Say if you want the header there too.
- `--help` for a subcommand (`run --help`) prints the global help, not a per-command page; no per-command help exists today.
- Not run live: the CLI through the binary (the orchestrator verifies, per the brief).
