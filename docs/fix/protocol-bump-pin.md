# fix/protocol-bump-pin — a protocol bump edits the pin too; no hand-written versions in tests

Type: fix · Size: S · Blast: cross-module (merge tooling + tests) · Suited: Opus plan → DeepSeek exec → Opus review

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-23*

Found 23/11 04:15 merging `feat/agent-workflows`, the first `PROTOCOL_VERSION` bump since `docs/feat/protocol-version-at-merge.md` (24 → 25): (1) `bun run protocol:bump` (`scripts/protocol-bump.ts`) wrote `packages/protocol/src/version.ts` but NOT the single pin `expect(PROTOCOL_VERSION).toBe(N)` in `packages/protocol/test/version.test.ts:30`, although its design says «a bump is 2 hunks — version.ts and version.test.ts — produced by the same command» (`docs/feat/protocol-version-at-merge.md:~187`); (2) 7 test files had hand-written `protocolVersion: 24` / `.toBe(24)` (`packages/client/test/pairing.test.ts`, `packages/daemon/test/{relay-link,relay-link-push,device-accept,project-pairing,ws-device-route}.test.ts`, `packages/cli/test/serve-devices.test.ts`) — green on every branch, red only after the merge. Both were hand-fixed in the merge (`4ceba7b3`, now `PROTOCOL_VERSION`). Owner 23/11 ~13:25: run it.

Goal: (a) `protocol:bump` also rewrites the pin line (and its test proves it, red first); (b) a guard test that FAILS on any hand-written protocol version literal in tests outside `version.test.ts` (e.g. `protocolVersion: <digits>`, `toBe(<digits>)` next to `protocolVersion`, `PROTOCOL_VERSION`-equal literals) — cheap, deterministic, no false positives on unrelated numbers (prove it on today's tree: zero hits; mutation: add `protocolVersion: 25` to a test → red). Keep `toBeGreaterThanOrEqual(n)` floors (they are by design).

## Implementation

*— claude-opus-5-5 (planner), 2026-11-23*

> Brief note: the planner prompt also asked about permission-ask detail / broker /
> TUI permission view / iPhone `PermissionSheet` / Mac+iPhone parity. Those come
> from another task's template and do not apply here: this fix touches merge
> tooling and tests only. No wire, UI or persisted change, so there is nothing to
> keep in parity between Mac and iPhone. No `changelog.d/` fragment (internal).

### Load-bearing assumption

**A hand-written version literal is harmful only when it EQUALS the current
`PROTOCOL_VERSION`.** If it equals the number, it is green on every branch and red
right after the next bump (the 23/11 case). Every other literal is a deliberate fake
that never moves. For example, `protocolVersion: 1` in `packages/transport/test/peer.test.ts:7,9`,
`packages/protocol/test/session.test.ts:22,30,35,41`, `methods.test.ts:39-169` and
`json-schema.test.ts:63-70` is a schema-shape input or a fake peer. `protocolVersion: 22`
in `packages/cli/test/connect.test.ts:842` is a fake older daemon. `protocolVersion: -1`
in `worker-version-marker.test.ts:63` is a deliberately invalid input. A literal that
differs from the number and is compared with a real peer is already red today, so the
gate catches it without help.
So the guard flags a literal **only in a version context and only when it equals
the live `PROTOCOL_VERSION`** (imported, never written). That gives no false positives
on the fakes above, and it catches exactly the class that broke.

Proven on the tree (rg, the same two patterns as below, N=25): today's tree has 1 hit,
`packages/protocol/test/version.test.ts` (the allowlisted pin) → **0 hits once the
pin is allowlisted**. The pre-fix merge parent (`git show 4ceba7b3^2:<file>`) has
2 hits in `packages/cli/test/serve-devices.test.ts` and 8 in
`packages/daemon/test/relay-link.test.ts` (N=24) → the historic case is caught. The
merge diff also shows a **multi-line** form:
`.result.protocolVersion).toBe(\n        24,\n      )` (serve-devices). Because of it,
the match runs over the whole file text with `\s*` allowing newlines, not line by line.

The second assumption (part a): the pin is exactly one line matching
`^\s*expect\(PROTOCOL_VERSION\)\.toBe\((\d+)\);$`. Verified at
`packages/protocol/test/version.test.ts:30` (`expect(PROTOCOL_VERSION).toBe(25);`).
`version.ts:40` is `25` today.

### Preconditions (verified)

- `scripts/protocol-bump.ts:228-259` `applyBump` is pure and returns `versionText`
  byte-identical when nothing is pending (`:250-252`).
- `runProtocolBump` (`:283-326`) computes everything before its first write
  (`:286-291`). It writes only `version.ts`, through `deps.writeVersion ?? writeFileSync`
  (`:293`), and deletes the notes after that write (`:307-309`). **It never touches
  the pin.** That is bug (1).
- Write-order test: `scripts/test/protocol-bump.test.ts:278-302` (M7). Its
  `fixture()` (`:194-200`) writes only `version.ts`.
- All tests live under `<pkg>/test/` (`git ls-files '*.test.ts*' | grep -v /test/` is
  empty). Non-TS files under test dirs (`transport/test/vectors`, fixtures) have no
  `protocolVersion` keys except MCP date strings, which the patterns do not match.

### Design

**(a) The bump writes the pin. A pin that cannot be written makes the bump refuse.**

- `scripts/protocol-bump.ts`: add `export const PIN_PATH =
  "packages/protocol/test/version.test.ts"` and
  `const PIN_LINE = /^(\s*)expect\(PROTOCOL_VERSION\)\.toBe\((\d+)\);$/m`.
- Pure `export function applyPin(pinText: string, from: number, to: number): string`:
  - The pin must match `PIN_LINE` **exactly once** (count it with a `gm` copy, like
    `readVersion` `:141-150`). Otherwise throw `ReleaseError`
    `"${PIN_PATH}: expected exactly one \"expect(PROTOCOL_VERSION).toBe(<n>);\" line (found k)"`.
    A pin that is missing or duplicated therefore stops the bump. It never skips the
    pin silently. This is the guard that "a cut list must be impossible" asks for:
    the bump either writes both places or writes nothing.
  - If pin == `to` → return the text unchanged (idempotent re-run).
  - If pin == `from` → replace the number with `to` and keep the indentation.
  - Otherwise throw `ReleaseError` `"${PIN_PATH}: pins ${pin} but version.ts was ${from} — the pin was hand-edited; fix it to ${from} and re-run"`.
    A stale or foreign pin is never silently overwritten, so the pin's own job
    (catching a hand-bump of `version.ts`) survives.
- `runProtocolBump`: read `PIN_PATH` next to `version.ts`. Compute
  `pinAfter = applyPin(pinBefore, readVersion(before), readVersion(after))` **before
  any write**. A missing or malformed pin then leaves the tree untouched, the same
  contract as a malformed note (`:280-281`).
- **Write order: pin → `version.ts` → delete notes.** With this order every crash
  point converges on a re-run:
  - Crash after the pin, before `version.ts`: the re-run sees from=24, to=26 and
    pin=26. The pin equals `to`, so it stays unchanged, and then `version.ts` is written.
  - Crash after both writes, before the deletes: from=to=26 and pin=26. Nothing is
    written; the notes are deleted.
  - The reverse order would not converge. After a crash between `version.ts` and the
    pin, the re-run sees from=to=26 and pin=24, and `applyPin` refuses forever.
- Generalise the injectable write: rename `writeVersion?: (path, text)`
  (`:272`) to `writeFile?: (path, text)`. It is called for every disk write, so a
  test can record the path order. Write each file only if it changed.
- Output: the final "Stage …" message (`:316-320`) also names `PIN_PATH`.
  The fold line (`:297-299`) appends `; ${PIN_PATH} pinned to ${version}`.
- With **no notes**, from == to. The pin is checked: if pin == to it is a no-op.
  Otherwise the bump refuses before the schema export, which is honest:
  `version.test.ts` would be red anyway.
- `packages/protocol/test/version.test.ts:28-29`: change the comment to "`bun run
  protocol:bump` rewrites this line (scripts/protocol-bump.ts `applyPin`)". Also fix
  the stale `version.ts:32` → `version.ts:40`, or better, say "the number line" with
  no line number.

**(b) Guard: a hand-written literal equal to the live version is red.**

- New `scripts/test/protocol-version-literals.test.ts`, next to `changelog-guard.test.ts`,
  using the same ROOT idiom `join(import.meta.dir, "..", "..")`. It contains:
  - The pure function `findVersionLiterals(text: string, version: number): { line: number; match: string }[]`.
    It lives in the test file itself, or in `scripts/protocol-bump.ts` if the executor
    prefers it to be reusable. It is the union of two patterns, built with
    `new RegExp(…, "g")` and with `version` interpolated:
    1. key form: `"?\b(protocolVersion|protocol|PROTOCOL_VERSION|x-protocol-version)"?\s*:\s*${version}\b`
    2. assert form: `\b(protocolVersion|PROTOCOL_VERSION)\s*\)\s*\.to(Be|Equal|StrictEqual)\(\s*${version}\b`
       (`\s*` spans newlines, which covers Biome's wrapped `.toBe(\n 24,\n)`).
    `toBeGreaterThanOrEqual(n)` floors are not matched (`toBe` must be followed by `(`).
    `line` is the 1-based line of the match start, for the failure message.
  - The scan: `new Bun.Glob("{packages,apps}/*/test/**/*.{ts,tsx}")` and
    `"scripts/test/**/*.ts"`, with `cwd: ROOT`. Skip any path containing `node_modules/`.
    Two files are ALLOWLISTED, by exact repo-relative path, each with a one-line reason:
    `packages/protocol/test/version.test.ts` (THE pin) and
    `scripts/test/protocol-bump.test.ts` (fixtures of a fake `version.ts` and a fake pin,
    never compared with the real number). The guard file itself is **not**
    allowlisted. Its own fixtures are built from `${PROTOCOL_VERSION}` templates, so its
    source holds no literal.
  - Tests:
    1. "no test hand-writes the current protocol version": scan, then
       `expect(hits).toEqual([])`. Hits are formatted `path:line  match`, so the failure
       names the line to change to `PROTOCOL_VERSION`.
    2. Non-vacuity of the scan: `expect(files.length).toBeGreaterThan(100)`, and the
       file list contains `packages/daemon/test/relay-link.test.ts`. This proves the
       glob is not silently empty.
    3. Mutation (pure): fixture texts built from `PROTOCOL_VERSION`. Each is red:
       `protocolVersion: ${V},`, `expect(init.protocolVersion).toBe(${V});`, the
       wrapped `.result.protocolVersion).toBe(\n        ${V},\n      )`,
       `{ protocol: ${V}, tentacle: "x" }`, `"protocolVersion": ${V}`.
    4. No false positive (pure): each finds nothing:
       `protocolVersion: 1`, `protocolVersion: ${V + 1}`, `protocolVersion: ${V}0`
       (word boundary), `expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(${V})`,
       `expect(count).toBe(${V})` (no version context), `protocolVersion: PROTOCOL_VERSION`,
       and MCP strings `protocolVersion: "2025-06-18"`.
    5. End-to-end mutation (documented in Execution, not committed): add
       `protocolVersion: 25,` to a real test such as `packages/transport/test/peer.test.ts`.
       Test 1 goes red and names that line. Revert.

### Files (dependency order)

1. `scripts/protocol-bump.ts` — `PIN_PATH`, `PIN_LINE`, `applyPin`. `runProtocolBump`
   reads and checks the pin before writing, then writes pin → version.ts → deletes,
   using `writeFile` (renamed from `writeVersion`). Update the messages and the header
   doc comment (`:14-18`): "the shell does the disk (version.ts AND the pin)".
2. `scripts/test/protocol-bump.test.ts` — the `PIN` fixture constant
   (`expect(PROTOCOL_VERSION).toBe(24);` inside a minimal test body). `fixture()` also
   writes `PIN_PATH` (with `mkdirSync` of `packages/protocol/test`). Add the new tests
   below and adapt M7 to `writeFile`.
3. `packages/protocol/test/version.test.ts` — comment only (`:28-29`).
4. `scripts/test/protocol-version-literals.test.ts` — new.
5. `docs/feat/protocol-version-at-merge.md:186-188` — no edit needed, because the claim
   becomes true. Optionally add a one-line "(fixed by fix/protocol-bump-pin)" pointer.

### Failure modes → how state converges

- Pin missing, moved or duplicated: `applyPin` throws before any write. Exit 1;
  nothing is written or deleted and there is no export.
- Pin hand-edited (≠ from, ≠ to): refused, with a message giving the value to fix it to.
  It is never overwritten.
- Crash between the writes: converges thanks to pin-first order (see Design).
  Crash after both writes: the existing idempotence (`pendingNotes` `:206-216`)
  together with pin==to.
- No notes, pin in sync: byte-identical and a no-op. The schema refresh still runs
  (the existing contract at `:233-251`).
- Guard false positive on a legitimate fake: only possible if a fake deliberately
  uses the CURRENT number. That is exactly the case that breaks at the next bump, so
  the right fix is `PROTOCOL_VERSION`, not an allowlist entry.
- Guard false negative (residual, accepted): the version inside a string
  (`"client 25 …"`), a computed value (`24 + 1`) or a key outside the list. Those are
  out of the cheap-deterministic scope; `connect.test.ts:719` already derives its
  message from `PROTOCOL_VERSION`. Record this in Review if a reviewer finds a live case.
- After a bump, a literal equal to the OLD number is not flagged by the guard (it
  compares to the new one). The test that holds it is red by itself, so the gate catches it.

### Tests (red first, in `scripts/test/protocol-bump.test.ts` unless noted)

Write each test and show it red on the current `protocol-bump.ts` **before** the change:
- R1 `runProtocolBump` with one note: the pin goes from `toBe(24)` to `toBe(25)` and keeps
  its indentation. **Red today**: the pin stays at 24 — the exact 23/11 bug.
- R2 `applyPin` unit cases: from→to rewrites; pin==to is unchanged (byte-identical);
  pin ≠ from,to throws `ReleaseError`; zero or two pin lines throw. Red today, because
  the export does not exist (an import error counts as red; show it).
- R3 malformed or missing pin + a valid note: exit 1, `version.ts` byte-identical,
  the note still on disk, `exports === 0`. Red today: exit 0 and version.ts is folded.
- R4 order: a `writeFile` spy records `[PIN_PATH, VERSION_PATH]` in that order, and the
  note is still present at both writes (it extends M7). Mutation: swap the writes →
  red.
- R5 crash re-run: pin already at 26, version.ts at 24, notes present → exit 0,
  both at 26, notes gone. Also the reverse-order state (version 26, pin 24, notes
  present) → exit 1 with the hand-edit message. That documents why the order matters.
- Guard tests 1–4 (`protocol-version-literals.test.ts`). Show them red by mutation:
  test 3 against a stub `findVersionLiterals` that returns `[]`, then step 5 against the
  real tree.
- Gate: `bun test scripts/test/protocol-bump.test.ts
  scripts/test/protocol-version-literals.test.ts packages/protocol/test/version.test.ts`
  while iterating, then the full `bun run check` (lint baseline 0/0).

Implementation APPROVED (orchestrator, owner delegated: S fix)

## Execution

*— claude-code_2-1-325_agent (Claude Code executor; the model id itself is not
exposed to this harness), 2026-11-23*

### Load-bearing check (re-run first, as instructed)

Verified on the branch head before any edit, `PROTOCOL_VERSION` = 25
(`packages/protocol/src/version.ts:40`):

```
$ rg -n '"?\b(protocolVersion|protocol|PROTOCOL_VERSION|x-protocol-version)"?\s*:\s*25\b' packages apps scripts
(no hits)
$ rg -n -U '\b(protocolVersion|PROTOCOL_VERSION)\s*\)\s*\.to(Be|Equal|StrictEqual)\(\s*25\b' …
packages/protocol/test/version.test.ts:30:    expect(PROTOCOL_VERSION).toBe(25);
```

Exactly one hit, the allowlisted pin ⇒ **0 hits once allowlisted**. The plan's
assumption holds; proceeded.

### As built, in order

1. **`scripts/protocol-bump.ts`** — `PIN_PATH`, `PIN_LINE`, `applyPin` added;
   `applyPin` is called in `runProtocolBump` **before the first write**, with
   `readVersion(before)`/`readVersion(after)` as its from/to. Write order is
   **pin → `version.ts` → delete notes**; `writeVersion` renamed to `writeFile`
   (called for every write, so a spy records the order). Messages now name
   `PIN_PATH` (fold line and the final "Stage …" line); header doc comment
   updated. `PIN_LINE` is matched with a `gm` copy to count hits, exactly like
   `readVersion`.
2. **`scripts/test/protocol-bump.test.ts`** — `PIN` fixture, `fixture()` writes
   `PIN_PATH` (mkdir of `packages/protocol/test`), `pinOf` reader; R1, R2 (four
   cases), R3 (missing/moved/duplicated pin table + a hand-edited pin), R4 (path
   order `[PIN_PATH, VERSION_PATH]`, adapted from M7), R5 (both crash states), the
   missing-pin-**file** case, and a no-notes "nothing is rewritten" case.
3. **`packages/protocol/test/version.test.ts`** — comment only: says the bump
   rewrites the line (`applyPin`), names the guard test, and drops the stale
   `version.ts:32` line number.
4. **`scripts/test/protocol-version-literals.test.ts`** (new) — `findVersionLiterals`,
   `testFiles`, `scanVersionLiterals` (module-local: Biome's `noExportsInTest`);
   tests 1–4 as planned, allowlist by exact path with reasons.

### Red before green

- Import error first: `SyntaxError: Export named 'PIN_PATH' not found` — the
  R1/R2 tests were red for the missing capability, then green after the change.
- **Mutation 1** (drop the pin write, i.e. the 23/11 bug): `2 fail` — R1 (*one
  note: the pin line moves with version.ts*) and R4 (path order).
- **Mutation 2** (swap the order to `version.ts` → pin): `1 fail` — R4's order
  assertion. `applyPin`'s "pin == to ⇒ unchanged" case is what makes the correct
  order converge; the reverse order is covered by R5's refused state.
- **Mutation 3** (stub `findVersionLiterals` to return `[]`): `1 fail` — the
  non-vacuity test (*the historic literals are caught*), i.e. the guard is not
  passing because the matcher matches nothing.
- **Mutation 4** (end-to-end, not committed): added
  `const MUTANT = { protocolVersion: 25, … }` to
  `packages/transport/test/peer.test.ts:7` → the repo guard went red naming
  `packages/transport/test/peer.test.ts:7  protocolVersion: 25`; reverted.

### Drift from the Implementation (and why)

- **`applyPin` does no pin write in the no-notes branch.** The plan said the pin
  is "checked" there; it is, but a write is impossible: `after === before` means
  from == to, so `applyPin` returns the text unchanged or refuses. Implemented as
  a comment at that site instead of a dead `put`, with a test proving the no-notes
  run issues **zero** writes.
- **One extra test** (missing pin *file*, ENOENT): the plan listed "missing or
  malformed" as text-level cases; a deleted file is the shell's own refusal and
  deserves its own red-capable case.
- **`applyPin`'s comment was kept inside the test file, not moved to
  `protocol-bump.ts`**, and the helpers are unexported (Biome forbids exports in
  test files) — the plan allowed either location.
- **No `changelog.d/` fragment**: confirmed internal by
  `docs/feat/changelog-fragments.md:223` ("Internal/dev/test-only work adds no
  fragment") — the change touches merge tooling and tests only, with no user-visible
  behaviour. Flagged for the orchestrator: this is the one plan-stated decision
  that the spawn prompt asked for unconditionally.
- **No `protocol.d/` note**: the wire version is not changed (no schema edit, so
  `protocol.json` is untouched).

### Narrow verification

```
$ bun test scripts/test/protocol-bump.test.ts ./scripts/test/protocol-version-literals.test.ts packages/protocol/test/version.test.ts
 39 pass, 0 fail
$ bun test packages/protocol/test/{version,json-schema}.test.ts packages/daemon/test/version-mismatch.test.ts scripts/test/changelog-guard.test.ts
 51 pass, 0 fail
$ bunx biome check <the 4 changed files>
Checked 4 files in 9ms. No fixes applied.
```

Full `bun run check` is the orchestrator's (per the spawn brief); nothing was
run at repo scope. Nothing unverified except that gate itself.

## Review
