# eval/reaper-gc-flaky-test — pin "a connection forgets a closed session" deterministically, not through the GC

> **Status:** DEFERRED, low priority (owner, 2026-10-20) — a test-only defect: the production code is correct (see Context). Revisit at the end of the protocol v2 migration; then promote to `docs/fix/reaper-gc-flaky-test.md` and open the branch. The Implementation below is a ready draft, not yet approved.
> **Branch:** none until promoted (then `fix/reaper-gc-flaky-test`)
> **Type:** eval → fix · **Size:** S · **Blast:** contained (a read-only getter on `Connection` + one test; no protocol, persistence or IO change) · **Suited:** any model executes; standard in-context Review

## Context

*— claude-opus-5-5, 2026-10-20*

`daemon/test/session-reaper.test.ts` "a connection forgets a session another
client closed (no stale reference kept)" fails intermittently, **only in the
full suite**. It is a test defect, not a tentacle defect: the production code
drops the reference; the test asserts that JavaScriptCore's GC has *collected*
the object within 5 `Bun.gc(true)` rounds, which a conservative GC does not
guarantee.

Why the test exists (`docs/feat/session-ttl-limits.md:997-1004`, review
finding 2): it pins `Connection.dropStale()` in `Connection.open`
(`connection.ts`), which forgets a session closed by another client. When the
per-connection cap existed, a stale entry had a visible effect (it held a cap
slot); since the limits became daemon-wide, a stale entry is only a retained
reference — no observable behaviour changes — so the test reached for a
`WeakRef` + `Bun.gc(true)`.

**Evidence (2026-10-20, bun 1.4.3, `main` @ `52ca635` and
`feat/permission-events`; scripts in `.tentacle/tmp/gc-flake/`, gitignored):**

1. *Where it fails.* Full suite: 1/8 runs on `main`, 3/8 on the branch.
   `bun test packages/daemon`: 0/20. The file alone: 0/20. The test alone: 0/40.
2. *Not a leak.* A diagnostic copy of the file, run at the test's real
   position in the suite order (93rd of 112, via the junit reporter's order;
   `bun test` honours CLI order), 12 full runs:
   ```
   run 1..7, 9..12: OK collected after 1 rounds
   run 8:           MISS after 5 rounds
                      then: collected after 10 more rounds
   ```
   Nothing changed between round 5 and round 15 except more GCs and ticks.
3. *Who retained it.* A heap snapshot (`Bun.generateHeapSnapshot()`) taken at
   the MISS: the closed session (identified by the test's `WeakRef` edge) is
   held by **4 direct `<root>` edges and nothing else** — a BFS from the root
   that forbids those edges does not reach it; the one closure capturing it is
   itself unreachable. Root-only retention with no intermediate object is the
   signature of a conservative stack/register root: a stale pointer in a live
   native frame, which differs with the process's history (hence "full suite
   only"). *Unverified:* which frames hold it (plausibly JIT-tiered code after
   92 files).
4. *Hypothesis ruled out:* `WeakRef` KeepDuringJob. `deref() → Bun.gc(true)
   → deref()` in one job collects (20/20); `Bun.gc(true)` does collect after a
   `deref`. (Also: `heapStats().objectTypeCounts` does not count class
   instances by name — 0 while alive — so it cannot be the assertion either.)

**Constraint:** the test must keep its mutation non-vacuity — removing
`dropStale()` from `Connection.open`, or making its body a no-op, must turn it
red (`session-ttl-limits.md:1215-1216`).

**Repro (the diagnostic copy's change to the test, rest of the file verbatim):**

```ts
let rounds = 0;
for (; rounds < 5 && ref.deref() !== undefined; rounds++) { Bun.gc(true); await tick(5); }
if (ref.deref() === undefined) log(`OK collected after ${rounds} rounds`);
else {
  log("MISS after 5 rounds"); writeFileSync(`snap-${Date.now()}.json`, JSON.stringify(Bun.generateHeapSnapshot()));
  let more = 0;
  for (; more < 200 && ref.deref() !== undefined; more++) { Bun.gc(true); await tick(more < 20 ? 5 : 50); }
  log(`  then: ${ref.deref() === undefined ? `collected after ${more} more rounds` : "STILL ALIVE"}`);
}
```

Seen alongside (not this task): a different intermittent timeout,
`agent/test/session-store.test.ts` "JsonSessionStore durability > drain()
resolves only after in-flight and queued writes settle" (1/12 full runs), not
investigated; and a `HostedSession` from `cli/test/pod-runtime.test.ts` still
reachable from a root closure through its `SpyFakeCluster` fake — a test-scoped
residue. Both recorded in `TODO.md`.

## Implementation

*— claude-opus-5-5, 2026-10-20 (draft, not yet approved; deferred)*

### Load-bearing assumption

**A stale entry in `Connection.attached` has no observable behaviour today**,
so a deterministic test needs a read-only view of the connection's open
sessions. Verified: every read of `attached` (`connection.ts:105,234,253,270,296`)
either identity-checks against `host.get(id)` (`lookup`, the cancel handler) or
is the prune itself; `close()` detaching a closed session is a no-op
(`HostedSession.removeAttachment` finds nothing after `close` cleared the set).

### Design

- `Connection` gains `get openSessionIds(): readonly string[]` — the ids this
  connection has open (keys of `attached`), a copy. Read-only, no behaviour.
  Precedent: `HostedSession.attachedCount`, `SessionHost.size`.
- The test asserts, after B closes X and A opens Y: `a.connection.openSessionIds`
  equals `["Y"]`. No GC, no timing.
- Rejected: reading the private map through a cast (asserts a private detail,
  AGENTS §9); a longer GC loop (still probabilistic — the stale root lives in
  frames the test does not control); eager pruning on `session_closed` (a
  production change that would still need the same view to be tested).

### Files

`packages/daemon/src/connection.ts` (getter); `packages/daemon/test/session-reaper.test.ts`
(the test); `TODO.md` (entry → this doc; the two side findings).

### Failure modes

None at runtime (a getter). Test: the mutation must stay red.

### Tests

The rewritten test, red before the getter exists (compile/undefined), then
mutations: drop `dropStale()` from `open` → red; no-op `dropStale` body → red.
Stability: the test alone 40×, the full suite 8× → 0 failures of it.

## Execution

## Review

*— claude-opus-5-5, 2026-10-20*

**Verdict: defer (low priority).** Production is not affected: at the failure
the closed session is unreachable in the object graph (`dropStale()` did its
job); only the test's demand that a conservative GC collect it within 5 rounds
is wrong. Cost of waiting: an occasional red full-suite run, recognisable by
this test's name. Revisit after the protocol v2 children (8b).
