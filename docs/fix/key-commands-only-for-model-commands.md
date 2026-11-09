# fix/key-commands-only-for-model-commands — a key command runs only where a model is used

> **Status:** done — Review PASS with nits (Sonnet); LOW-1 and nit-2 applied by the orchestrator; merged 2026-11-09
> **Branch:** `fix/key-commands-only-for-model-commands`
> **Type: fix · Size: S · Blast: cross-module · Suited: deepseek-v4.1-flash (tentacle) executes; standard in-context Review (no §7 invariant touched — see Design)**

## Context

*— deepseek-v4.1-flash (tentacle), 2026-11-09*

`tentacle ps` / `rm` (and the other commands that never call a model) fail when
ONE `models.<n>.apiKeyCommand` in the user's config fails. The command is run
while the config is loaded (`loadConfig`), and `main` loads the config for
EVERY subcommand that gets that far — long before it dispatches to the command
that does not need a key. Found by the models-map-pod live check (O2).

The failure is not cosmetic: `ps` and `rm` are the commands a user reaches for
when a workload or a run is in a bad state, and a key command that needs a
terminal (`exit 7`, a pinentry read) fails exactly in the non-interactive /
broken situation where the user needs `ps`/`rm` most.

**Repro** (`.tentacle/tmp/key-commands-only/cfg/config.jsonc`, fake values only;
`TENTACLE_CONFIG_DIR` + `TENTACLE_HOME` pointed under the scratch dir):

```jsonc
{
  "model": { "provider": "openai", "baseURL": "http://127.0.0.1:1",
             "model": "fake-model", "apiKey": "sk-fake-main" },
  "models": { "bad": { "model": "x", "apiKeyCommand": "exit 7" } }
}
```

```
$ TENTACLE_CONFIG_DIR=$PWD/.tentacle/tmp/key-commands-only/cfg \
  TENTACLE_HOME=$PWD/.tentacle/tmp/key-commands-only/home \
  bun packages/cli/src/main.ts ps
[config error] models.bad.apiKeyCommand exited with code 7: (no stderr)     (exit 1)

$ … run the same for each command, same output, all exit 1:
=== tentacle ps ===                    exit=1
=== tentacle rm nosuch ===             exit=1
=== tentacle rm --force nosuch ===     exit=1
=== tentacle hooks trust --list ===    exit=1
=== tentacle package list ===          exit=1
```

(Pre-fix output, recorded 2026-11-09 on this branch, before any edit.)

The main model's `apiKeyCommand` fails the same way; the task fixes both, since
neither is used by these commands.

## Implementation

*— deepseek-v4.1-flash (tentacle), 2026-11-09*

### Load-bearing assumption

`loadConfig` runs the key commands unconditionally on the laptop, and `main`
loads the config before the dispatch of every subcommand below `serve`:

- `packages/cli/src/main.ts:736` — `config = await loadConfig({…})` runs for
  everything that reaches it; the dispatch follows (`:750` `package`, `:761`
  `hooks`, `:776` `ps`/`rm`, `:849` `serve`, `:1089` `run`, `:1419` `attach`,
  `:1794` `plain`, `:1806` `tui`, and the one-shot prompt at `:1899`).
- `packages/config/src/load.ts:800` — the main `apiKeyCommand` runs unless
  `options.podDaemon === true`; `packages/config/src/load.ts:815-818` —
  `resolveModelKeys(…, options.podDaemon === true ? undefined : runCommand, …)`,
  and with `run === undefined` `resolveModelKeys` runs nothing
  (`packages/config/src/load.ts:635` `if (run !== undefined)`), leaving every
  entry keyless (`:693-706`).

So the existing `podDaemon` skip is exactly the seam: it makes the load run NO
key command at all, and the commands that need no key do not read one.

### Preconditions (verified)

- `packages/config/src/load.ts:120` — `podDaemon?: boolean` already means "run no
  key command"; `:551`/`:557` reuse it to skip `agentTaskDescriptionFile` too.
- `packages/cli/src/main.ts:738` — its only caller today: `serve` + a pod-mode
  flag (`isPodDaemonLoad`, `packages/cli/src/flags.ts:418`).
- `ps`/`rm` read only `config.configDir` (`packages/cli/src/main.ts:789`
  `keptDir(config.configDir)`); `package` reads `configDir` +
  `packagesEnabled` (`:750-758`); `hooks` reads `configDir` (`:761-771`). None
  reads a key, a model or `agentTaskDescription`.
- `connect` (`:579`), `update` (`:625`), `explain` (`:647`), `config` (`:672`)
  already return BEFORE `loadConfig` — they never had the bug and are left
  alone.
- `config get/list` mask secrets from the FILE (`packages/cli/src/config-run.ts:804`,
  `:815` `maskStored`) and never read a resolved key, so skipping the key
  commands cannot unmask anything.
- No AGENTS §7 invariant is touched: the skip is a value in the config the
  laptop builds for itself, not a wire/persistence/trust decision. A pod daemon
  already relies on it; this only widens WHO may ask for it.

### The classification (every CLI subcommand)

`CliMode` (`packages/cli/src/flags.ts:634`) has 15 members; `SUBCOMMANDS`
(`:524`) adds the `install` alias (→ `package install`). Evidence is the code
each mode reaches after `main`'s dispatch.

**Calls a model / may call a model — keep the strict load (runs every key command):**

| mode | evidence |
| --- | --- |
| `serve` | hosts the daemon and calls the model for its sessions (`main.ts:849`, `main.ts:888` `startDaemon(config, …)` with the resolved provider/key); `--stdio`, `--bridge`, `--resident` run the agent in a pod. |
| `run` | creates the workload and drives a session (`main.ts:1089`); calls the model from the pod through the laptop's proxy (`ProxyModelProvider`, AGENTS §7 "model stays on the laptop"). |
| `attach` | attaches to a session (`main.ts:1419`) and may also re-load a profile (`:1482`, `:1512`) whose keys the session's model needs. |
| `tui` | the interactive app (`main.ts:1806`): the model is its whole point. |
| `empty` + a terminal | the same TUI (`main.ts:1806` `mode === "empty" && terminal.stdin`). |
| `plain` | the REPL, a built agent (`main.ts:1794`, `:1797` `buildAgent(config, …)`). |
| `prompt` | a one-shot turn (`main.ts:1899`, `:1926` `agent.run(…)`). |
| `empty` + no terminal | `prompt.length === 0` → usage error (`main.ts:1900`); it cannot need a key, but it also does nothing, so it keeps the strict path (least surprising: "no model command" is not something anyone types). |

**May call a model — keep the strict load:**

| mode | evidence |
| --- | --- |
| `attach` (also above) | `moveTo()` / `useRunModel()` re-`loadConfig` for a profile or folder (`main.ts:1482`, `:1512`) — a strict first load catches a broken key command before the TUI mounts, which is the current, tested behaviour (`packages/cli/test/main.test.ts:216-241`). |

**Never calls a model — load WITHOUT running any key command:**

| mode | evidence of "no model" |
| --- | --- |
| `ps` | `main.ts:800` → `psCommand(...)` (`packages/cli/src/kept-cmd.ts:144`): the laptop's kept index, verified against the engine. No agent, no provider. |
| `rm` | `main.ts:809` → `rmCommand(...)` (`packages/cli/src/kept-cmd.ts:335`): deletes a kept workload by name. No agent, no provider. |
| `hooks` | `main.ts:761` → `hooksTrustCommand(fileTrustStore(config.configDir), …)` (`packages/cli/src/hooks-trust.ts`): a trust store edit. |
| `package` | `main.ts:750` → `packagesCommand(...)` (`packages/cli/src/packages-cmd.ts`): git install/remove/list of package dirs. `install` aliases into it (`flags.ts:554`). |
| `update` | `main.ts:625` — returns before `loadConfig` already; listed for completeness. |
| `explain` | `main.ts:647` — idem. |
| `config` | `main.ts:672` — idem (`config-run.ts` reads/edits the file, masks secrets itself). |
| `connect` | `main.ts:579` — idem (the remote daemon's model). |

### Design

One pure decision beside the dispatch, in `packages/cli/src/flags.ts` (where
`isPodDaemonLoad` already lives, and where `CliMode` is defined):

```ts
/** The modes that never call a model: their config load runs no `apiKeyCommand`. */
export function modeUsesModel(mode: CliMode): boolean
```

`main` then asks it once, at the single `loadConfig` call site, and reuses the
`podDaemon` seam:

```ts
const usesModel = modeUsesModel(mode);
config = await loadConfig({
  cwd, scaffold: !isStdioDaemon,
  ...(mode === "serve" && isPodDaemonLoad(parsed.bools) ? { podDaemon: true } : {}),
  // A command that never calls a model must not run the user's key commands
  // (they may need a terminal and fail: `ps`/`rm` then die instead of listing).
  ...(usesModel ? {} : { podDaemon: true }),
  ...
});
```

`podDaemon: true` also skips `agentTaskDescriptionFile` (`load.ts:557`). That is
correct rather than incidental: the value is composed into a system prompt, and
these commands build no prompt — and a required-but-unreadable file must not
break `ps` either. It is stated here so the widening is a decision, not a
surprise.

Why not a new option (e.g. `runKeyCommands`)? The seam's meaning is already
exactly "this load needs no key": a pod daemon asks because the model is
proxied over the wire, `ps` asks because there is no model at all. A second
flag would duplicate the `podDaemon !== true` checks in `load.ts:800`/`:815` and
rot apart. Reuse, per the task.

The mode list is a total `Readonly<Record<CliMode, boolean>>`: a new member of
the `CliMode` union does not compile until it is classified, so a new subcommand
cannot silently inherit "never calls a model" — see "Failure modes". (Planned as
a `Set`; the `Record` is what actually forces the classification. Execution
records this.)

### Files

1. `packages/cli/src/flags.ts` — add `modeUsesModel` (pure, next to
   `isPodDaemonLoad`).
2. `packages/cli/src/main.ts` — compute it once before `loadConfig` (`:736`) and
   pass `podDaemon: true` for a model-free mode; a comment names the why.
3. `packages/cli/test/model-free-commands.test.ts` (new) — the red-first
   regression tests (below).
4. `CHANGELOG.md` — one `Fixed` line under `[Unreleased]`.
5. `docs/fix/key-commands-only-for-model-commands.md` — this doc.

### Failure modes

- **A command that later needs a key.** There is no lazy key resolution: the key
  is resolved inside `loadConfig` and nowhere else. So each listed mode must be
  *provably* key-free — the table above is that proof, per mode, by the code it
  reaches. `attach` is the one mode where a later *re*-load happens
  (`main.ts:1482`/`:1512`), and it keeps the strict path, so a broken key
  command is still caught with the same `[config error] …` as today. The
  key-free modes call `loadConfig` only once.
- **A new subcommand.** The table is a total `Record<CliMode, boolean>`: a new
  mode does not compile until it is classified, and it cannot be left off a
  `Set` by accident. The strict answer (`true`) is the safe default the comments
  point at: a broken key is reported, never silently keyless. A test pins every
  current mode's answer so a CHANGE is a visible decision too (`cliMode`'s own
  `SUBCOMMANDS`/`CliMode` remain the source of truth for what exists).
- **`run`/`attach`/`connect`/`serve` must keep today's strict behaviour.**
  Pinned by the existing tests (`packages/cli/test/main.test.ts:216-241`: a plain
  `serve --stdio` with `apiKeyCommand: "exit 7"` still exits 1 with the config
  error) plus a new test asserting the model modes still fail.
- **`config get`/`list` masking.** Untouched: they return before `loadConfig`
  and mask from the stored file (`config-run.ts:804`/`:815`). No key command
  runs for them before or after, so nothing about masking changes.
- **`explain`.** Untouched (`main.ts:647`, before the load; it prints the key
  registry, not effective values — that is `config show`'s job, per the comment
  there).- **A silent drop.** The skip is silent by design (it changes what the load
  RUNS, not what it reports). The values it removes are ones these commands
  never read, so there is no state to converge: `ps`/`rm`'s only config input
  is the config DIR, which the skip does not touch (`load.ts` resolves it
  before any of the skipped steps).
- **Empirical check.** The repro is re-run after the fix: `ps`/`rm`/`hooks`/
  `package` succeed, the model commands still fail, and a mutation (delete the
  `modeUsesModel` guard) makes the new tests red.

### Tests

`packages/cli/test/model-free-commands.test.ts` (new): it drives `main`
end-to-end with a scratch `TENTACLE_CONFIG_DIR` (the pattern `main.test.ts`
uses); the models-map key-command behaviour at the `loadConfig` level is pinned
separately in `packages/config/test/models-load.test.ts`, which this task does
not change.

1. **RED before GREEN — `ps`/`rm`/`hooks`/`package` with a failing entry command
   still work.** Config: a literal main `apiKey`, plus
   `models: { bad: { model: "x", apiKeyCommand: "exit 7" } }`. Hooks/package/ps
   must exit 0 with no `[config error]`. On current code all four exit 1 with
   `models.bad.apiKeyCommand exited with code 7` → red on the property (§9).
2. **The model commands still refuse it.** A one-shot prompt / `--plain`-style
   load path stays strict: the same config makes `main(["bun","cli","--plain"])`
   (or the `serve --stdio` case already at `main.test.ts:216-241`) exit 1 with the
   config error. Pins "we only widened the model-free modes".
3. **The pure predicate.** `modeUsesModel` classifies EVERY `CliMode` member
   (the `Record` is total by type; the test pins the answers and drives the
   predicate from `cliMode`'s own output, so a mode in neither list fails it).
   Cheap, no I/O.
4. **A failing MAIN `apiKeyCommand` also stops failing `ps`** (the same seam,
   `load.ts:800`) — the main key is what most users have.

Mutation (§9 non-vacuity): delete the `usesModel ? … : { podDaemon: true }`
spread from `main.ts`, confirm tests 1 and 4 go red, restore, `shasum` before/after.

## Execution

*— deepseek-v4.1-flash (tentacle), 2026-11-09*

**Reproduced first** (before any edit), scratch config under
`.tentacle/tmp/key-commands-only/`, fake values only:

```
$ cat cfg/config.jsonc
{ "model": { "provider": "openai", "baseURL": "http://127.0.0.1:1",
             "model": "fake-model", "apiKey": "sk-fake-main" },
  "models": { "bad": { "model": "x", "apiKeyCommand": "exit 7" } } }

$ TENTACLE_CONFIG_DIR=…/cfg TENTACLE_HOME=…/home bun packages/cli/src/main.ts ps
[config error] models.bad.apiKeyCommand exited with code 7: (no stderr)     exit=1
=== tentacle ps ===                    exit=1
=== tentacle rm nosuch ===             exit=1
=== tentacle rm --force nosuch ===     exit=1
=== tentacle hooks trust --list ===    exit=1
=== tentacle package list ===          exit=1
```

**Done, in order**

1. `packages/cli/test/model-free-commands.test.ts` (new) — 9 tests, written
   first. RED on the pre-fix code, failing on the property (not on an
   import/compile error):
   - `ps lists` — `[config error] models.bad.apiKeyCommand exited with code 7`
   - `rm reaches its own logic` — same error instead of the "no kept … named"
     message
   - `hooks trust --list and package list work too` — same error
   - `the MAIN apiKeyCommand does not stop ps either` — same seam, main key
   - the other 5 pass on both (the strict paths, and the pure predicate's table)
2. `packages/cli/src/flags.ts:651-688` — `USES_MODEL`, a
   `Readonly<Record<CliMode, boolean>>`, plus `modeUsesModel(mode)`. Model-free:
   `ps`, `rm`, `hooks`, `package`, and the four modes that already return before
   `loadConfig` (`connect`, `update`, `explain`, `config`). Strict: `serve`,
   `run`, `attach`, `plain`, `tui`, `prompt`, `empty`.
3. `packages/cli/src/main.ts:733-741` — `const usesModel = modeUsesModel(mode)`
   and `...(usesModel ? {} : { podDaemon: true })` in the single `loadConfig`
   call; `modeUsesModel` imported at `:82`.
4. `CHANGELOG.md` `[Unreleased]` → `### Fixed`, one line.
5. This doc.

**Drift from Implementation** (and why)

- *Design said a `Set`; shipped a `Readonly<Record<CliMode, boolean>>`.* The
  doc's own "a new subcommand" failure mode wanted the compiler to force a
  classification; a `Record` over `CliMode` does that (a new member of the
  union stops compiling), a `Set` cannot. Every mode is still pinned by a test.
- *Design's test 2 used `serve --stdio`; shipped `--plain` + `-i`.*
  `serve --stdio` at `packages/cli/test/main.test.ts:216-241` already pins the
  strict behaviour, so the new file pins the two paths it can drive cheaply: a
  one-shot prompt, `--plain`, and the TUI's own load. No coverage lost.
- *`attach` re-loads (`main.ts:1482`, `:1512`) are not a separate test.* They
  are strict because `attach` is classified strict; driving those paths needs a
  kept workload + engine fake, which `kept.test.ts`/`attach-*` own. What the
  change must not break — the FIRST load — is pinned. A regression would need
  `attach`'s classification flipped, which the table test catches.

**Mutation (§9 non-vacuity)**

- Remove the `...(usesModel ? {} : { podDaemon: true })` spread from `main.ts`:
  4 of the 9 tests go red (the 4 model-free ones), 5 pass.
  `shasum packages/cli/src/main.ts` before `834b531e…` = after restore
  `834b531e…`.
- Flip `ps: false` → `ps: true` in `flags.ts`: 4 red (`ps lists`, the MAIN-key
  test, and both `modeUsesModel` tests). Restored; `flags.ts` treated the same
  way (backup + restore).

**Repro after the fix** (same scratch config, same commands):

```
=== tentacle ps ===                  NAME   ENGINE   WHERE   MOUNT   MODEL   AGE   STATUS     exit=0
=== tentacle rm nosuch ===           [error] no kept container or pod named "nosuch" — see `tentacle ps`   exit=1
=== tentacle hooks trust --list ===  no stored project hooks decisions                      exit=0
=== tentacle package list ===        no packages installed                                 exit=0
=== tentacle hello (prompt) ===      [config error] models.bad.apiKeyCommand exited with code 7: (no stderr)  exit=1
=== tentacle --plain ===             [config error] models.bad.apiKeyCommand exited with code 7: (no stderr)  exit=1
```

`rm`'s exit 1 is its own "no such workload" answer, not a config error.

**Gate**

- `bunx tsc --noEmit` → exit 0, no output.
- `bunx biome check .` → `Checked 768 files`, no errors, no warnings.
- `bun test packages` → **5894 pass, 3 skip, 0 fail** (5897 tests, 398 files);
  the 3 skips are the opt-in trio (live k8s, live docker, slow keepalive), not
  failures.

Nothing is unverified. One thing deliberately left: `podDaemon: true` also skips
`subagents.agentTaskDescriptionFile` (`packages/config/src/load.ts:557`) for
these four commands — stated in Design, and harmless (it composes a system
prompt none of them builds).

## Review

*— deepseek-v4.1-flash (tentacle), 2026-11-09*

In-context review (Blast cross-module, no §7 invariant touched → standard
review, not fresh-context).

- **Exhaustiveness holds.** `USES_MODEL` is a total `Record<CliMode, boolean>`;
  `CliMode` has 15 members, the record 15 keys — a new mode cannot default
  silently, and the table test pins each answer. It is not exported, so a later
  mode change is a compile error in `flags.ts`, not a silent default.
- **"Never calls a model" is proven per mode, not assumed**: `ps`/`rm` →
  `kept-cmd.ts:144`/`:335` (kept index + an engine); `hooks` → a trust store;
  `package` → package dirs + git; the other four never reach `loadConfig`.
- **The strict paths are unchanged**: `serve`/`run`/`attach`/`plain`/`tui`/
  `prompt`/`empty` keep `podDaemon` unset → `load.ts:800`/`:815` run the key
  commands as before; pinned by `--plain`, `-i`, a prompt, and the existing
  `serve --stdio` test (`main.test.ts:216-241`).
- **Masking is untouched**: `config get`/`list` return before `loadConfig` and
  mask from the stored file (`config-run.ts:804`, `:815`). Checked, not assumed:
  with the repro config (the one whose entry command fails), `config get
  model.apiKey` → `***`, `config get models.bad.apiKeyCommand` → `***`,
  `config list` → `model.apiKey = ***` / `models.bad.apiKeyCommand = ***` /
  `models.bad.model = "x"`. Same before and after the change (those modes were
  already pre-`loadConfig`, and still are).
- **What does not hold / debt**: the reuse of `podDaemon` widens the meaning of
  that flag slightly ("this load runs no key command" rather than "a pod
  daemon"): the option's doc comment (`load.ts:113-120`) still speaks of a pod
  daemon. A follow-up could reword it; the task told me to reuse the seam, not
  rename it, and its behaviour is exactly what is needed.
- The implementing model followed the brief: reproduced before editing, wrote
  the test red first, and recorded two drifts (the `Record` and the test paths)
  rather than silently reshaping the plan.

### Owner questions

None left open — the two decisions taken without asking, and why:

1. **Should `hooks` and `package` be model-free too, or only `ps`/`rm`?**
   Shipped: all four. They reach no provider either, so leaving them strict
   would keep the same bug for two more commands. *If you want only `ps`/`rm`*:
   move `hooks`/`package` to `true` in `USES_MODEL` — one line each, the table
   test then pins it.
2. **`empty` with no terminal (`tentacle` on a pipe) — strict or not?** Shipped:
   strict (it is a usage error, and a strict load is the least surprising: no
   one gets a behaviour change from a command that prints help). *If you prefer
   it lenient*: flip `empty` — but that also makes the TUI-when-a-terminal
   case lenient, since both are `mode === "empty"`, so it would need a
   `terminal.stdin` argument in `modeUsesModel`. Not recommended.


### Fresh-context review

**Verdict: PASS with nits.**

Gate (re-run): `bunx tsc --noEmit` exit 0; `bun run lint` 768 files, clean; `bun test packages` 5894 pass / 3 skip / 0 fail (5897 tests, 398 files).

**Findings**

- LOW-1 `packages/config/src/load.ts:113-120` — the doc comment of `podDaemon` still says "A pod daemon's load (`serve --model-proxy`, …)". The meaning is now wider (`main.ts:740` passes it for ps/rm/hooks/package). Exact fix, comment only (no rename, no behaviour change): replace the first sentence with "A load that needs no key: a pod daemon's (`serve --model-proxy`, `--resident-status`, `--resident-stop`) and a command that never calls a model (`ps`, `rm`, `hooks`, `package`: `modeUsesModel`, docs/fix/key-commands-only-for-model-commands.md)." Keep the rest. A rename (`skipKeys`) is NOT worth it: 6 call sites + tests for no behaviour gain.
- nit-2 Implementation says `CliMode` has 15 members; it has 15 (the executor's Review has it right). Doc only.
- nit-3 `main.ts:733-738` comment names "(`ps`, `rm`, `hooks`, `package`)" only; `connect/update/explain/config` return earlier (OK, stated in flags.ts).

No HIGH/MEDIUM.

**(1) Classification — attacked per mode.** `false` modes: `ps`/`rm` use `config.configDir` only (`main.ts:789`); `hostFor` builds from the kept entry (`engine-select.ts:290`), `residentStop`/relay probing dial by run dir, not by config; the relay holds its own model key (it is launched with its own `loadConfig`, not this one). `hooks` → trust store at `configDir`; `package` → `configDir` + `packagesEnabled` (`podDaemon` does not change `packagesEnabled`). None reaches a provider. `connect/update/explain/config` return before `loadConfig`, so the flag is moot. `true` modes: `serve/run/attach/plain/tui/prompt/empty` all build or proxy a model; `empty` is strict (see 4). No `true` mode is wrongly strict.

**(2) `podDaemon` side effects** — grepped every use (`load.ts:534/551/557/754/800/818`): it only (a) skips the main `apiKeyCommand`, (b) skips `resolveModelKeys`' commands, (c) skips `agentTaskDescription`/`File` (and swallows an invalid inline one). `scaffold`, defaults, warnings, masking, `packagesEnabled`, skills/hooks diagnostics are NOT touched. For ps/rm/hooks/package (c) is irrelevant: none builds a system prompt (diagnostics at `main.ts:~820` are after their `return`). Side effect to know, not a bug: with `podDaemon` the resolved `config.apiKey` stays the unresolved/undefined one — nothing reads it on these paths.

**(3) Non-vacuity — re-run.** (a) deleted the `usesModel ? {} : {podDaemon:true}` spread: 4 fail / 5 pass (ps, rm, hooks+package, MAIN-key). (b) my own: `hooks: false → true` in `USES_MODEL`: 2 fail (the hooks/package test and the table test), 7 pass. (The executor's `ps` flip was not re-run; (b) covers the same property for `hooks`.) Restored both; `git status` clean afterwards.

**(4) Decisions.** hooks/package included: sound — same bug, same proof, one line each to undo. `empty` strict: sound; `empty`+terminal is the TUI so it cannot be lenient, and no-terminal `empty` is a usage error nobody scripts. Attacks that found nothing: `rm` deleting a workload (no key needed — engine from the index); `ps` probing a relay (dials socket by run dir); `--profile`/`--model` with these commands (still validated by the load, key-independent).

**Executor honesty.** The Execution matches what I re-ran: counts, the red/green split and the mutation outcomes are true; the two drifts (`Record` instead of `Set`, test paths) are recorded, not hidden, and the doc's own "debt" bullet anticipates LOW-1. The only slip is the 13-vs-15 count in the plan. Reviewed by the same family as no one in the Anthropic sense, but a different model than the executor (DeepSeek); a fresh context.

### Owner questions

None blocking. Optional: apply LOW-1 now (comment only) or leave it as debt.

*— claude-sonnet-5-5, 2026-11-09*
