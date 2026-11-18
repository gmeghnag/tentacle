# feat/mobile-e2e-gate — a deterministic, AI-free mobile e2e gate

> **Status:** execution
> **Branch:** `feat/mobile-e2e-gate`
> **Type:** feat · **Size:** M · **Blast:** contained (tests/tooling) · **Suited:** Opus
> **Changelog:** none (dev-only tooling)

## Context

*— claude-opus-5-5, 2026-11-18*

Owner 18/11: *"avere i test automatici, senza AI, in place è sempre stato il nostro
forte: facciamolo anche su mobile"*. The mobile pure modules are in `bun test`, but the
Maestro suite (`apps/mobile/e2e/flows`, driven by `bun run e2e:mobile`) only ran when an
AI agent drove it by hand: it needed a hand-picked simulator, it stopped at the first
build, it printed one `✓/✗` line per flow and the exit code was Maestro's worst one, with
no notion of a flow that is known-broken. So UI wiring regressions reached the phone — the
reported one: "New session" from the hub no longer opens a session; and flow `33-hub` is
red because of the flow itself.

The decision this serves: the iOS build that publishes `tentacle.so/i/<token>/`
(`.tentacle/tmp/orchestration/run-build-ios-now.sh`) can call ONE command and refuse to
publish on red, and a nightly run can do the same unattended.

**Repro (the capability is missing), 2026-11-18, on `main` @ 753d7fa2:**
`bun run e2e:mobile --udid EF264127-…` with only iOS 26 installed → preflight exit 2
(*iOS 18 runtime missing*): a UDID did not imply its major. With `--ios 26 --udid …` the
run works, but its end is `FAIL — logs in <dir>` with Maestro's exit code, no table, no
per-flow time, no timeout (a hung XCTest driver stalls the run forever), no retry policy
and no way to mark a flow known-broken.

## Implementation

*— claude-opus-5-5, 2026-11-18*

### Load-bearing assumption

Each flow is already state-isolated, so running them one after another unattended is
deterministic: every flow pairs first through `_pair.yaml` with `launchApp: clearState:
true` + `clearKeychain` (`apps/mobile/e2e/flows/_pair.yaml:21-23`), the harness closes any
pairing window between flows (`run.ts` `pairing.stop()` in the flow loop), and every flow
that leaves daemon-side state gets a session of its own created just before it runs
(`COMPOSE_SESSION_VARS` + `spawnFlow`). The gate adds a `simctl terminate` before each
attempt; it does not invent a new isolation scheme.

### Preconditions

- The harness already owns the world: mock model in-process (`mock-model.ts`), a real
  `serve` from source on `freePort()` (ephemeral, `127.0.0.1`, private config dir), local
  relay + fake APNs, hooks server (`run.ts` `main`). Never port 4000 (now also guarded).
- Maestro reads a flow's header config (before `---`), where `tags:` is native; a single
  `maestro test <file>` ignores tags, so gate tags cannot change how Maestro runs a flow.
- `apps/mobile/test/e2e-flows.test.ts` pins flow hygiene (every flow pairs, names
  `${output.computerId}`, asserts more than its container); new flows must satisfy it.

### Design

- **`apps/mobile/e2e/gate.ts`** (pure, React-free, unit-tested): the gate's decisions.
  - Tags live in the flow's own header: `tags: [flaky | known-bug | quarantine]`, each
    with a `# <tag>: <reason>` line. A tag without a reason (or a reason without a tag,
    or `quarantine` plus another tag) is refused before anything runs (exit 2).
  - `flaky` → ONE retry (`shouldRetry`), listed in the summary; nothing else retries.
  - `known-bug` → runs, not counted; listed; if it passes the summary says *drop the tag*.
  - `quarantine` → not run; listed with its reason; must have a `TODO.md` line (test).
  - `verdictOf` → exit 0 iff no counted flow is red (fail or timeout).
  - `summaryText` → the one table (flow · result · seconds · tries) + counts + the lists.
  - `majorOfDevice` → a UDID names its iOS major (from `simctl list -j devices`).
- **`run.ts`**: `--udid` (or `E2E_SIM_UDID`) without `--ios` runs that simulator only,
  never falling back to another device; it boots it (`simctl boot` + `bootstatus -b`),
  uninstalls the app then builds+installs once per run (or installs `--app <path.app>`),
  runs each flow with a per-attempt timeout (`--flow-timeout` / `E2E_FLOW_TIMEOUT_S`,
  default 600 s, SIGKILL + `timeout.txt`), writes `summary.txt` + `summary.json` in the
  run dir and returns the verdict's exit code. Each attempt keeps its own output dir
  (`ios<major>/<flow>[.retry]/`: Maestro's failure screenshots, `maestro.log`, JUnit).
- **Hub coverage** — `34-hub-<item>.yaml`, one per fan item and More item, each on a
  fresh session (`HUBITEM_ID`), each asserting the surface the item names: Attach → the
  chooser; Activity (two background children running) → `activity-sheet` with the child;
  Artifacts (laptop turn `present`s one) → `artifact-gallery` with it; Tools →
  `tools-sheet` listing MCP `demo`; Commands → `commands-sheet`; More → Sessions →
  `drawer` with this session current; More → Session info → `session-info-sheet`; More →
  Scheduled (laptop turn `schedule_create`, approved) → Session info with the wake; More →
  Dictate (Settings → Beta → Dictation on) → the voice card; More → New session → an EMPTY
  transcript. World changes that need a JSON tool call go through the `laptop-prompt`
  hook (`34-hub-laptop.js`): iOS smart punctuation curls quotes typed into the composer.
  Shared sub-flows `_hub-fan.yaml` / `_hub-more.yaml`.
- **`scripts/e2e-gate.sh <udid> [flags]`**: `exec bun apps/mobile/e2e/run.ts --udid …`;
  exit code passes through.

### Files

`apps/mobile/e2e/gate.ts` (new) · `apps/mobile/e2e/run.ts` · `apps/mobile/e2e/flows/34-hub-*.yaml`,
`_hub-fan.yaml`, `_hub-more.yaml`, `34-hub-laptop.js` (new) · flow fixes/tags (Execution) ·
`apps/mobile/test/e2e-gate.test.ts` (new) · `scripts/e2e-gate.sh` (new) ·
`apps/mobile/e2e/README.md` · `TODO.md`.

### Failure modes

- Hung Maestro/XCTest driver → the attempt is killed at the timeout, counted `TIMEOUT`.
- A red flow leaves the app mid-screen or a pairing window open → next attempt
  terminates the app, closes the window, relaunches with `clearState`.
- Simulator shut down → booted; wrong/unknown UDID → exit 2, never another device.
- Build/install fails → its exit code, no flows run (nothing is reported green).
- An untagged flaky flow → counted red (no silent retry); tagging needs a reason.
- A `known-bug` that got fixed → reported as *now passes*, so the tag does not rot.
- Selected nothing (`--only` empty) → every flow (the gate); unknown name → error.

### Tests

`apps/mobile/test/e2e-gate.test.ts`: tag parsing (block/inline, header only), the reason
rule, one-retry-flaky-only, last attempt decides, verdict (known-bug/quarantine not
counted, timeout counted, fixed known-bug surfaced, empty run), the summary table rows and
lists, `majorOfDevice` (unknown/unavailable → undefined), the new CLI flags, and over the
REAL flows: every tag has its reason and every known-bug/quarantine has a `TODO.md` line.
The e2e evidence is the full run in Execution (the known-bug `34-hub-*` red on `main`).

## Execution

*— claude-opus-5-5, 2026-11-18*

(pending the first full run)

## Review

*(fresh-context reviewer)*
