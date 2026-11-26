# fix/mobile-version-mismatch-diagnosis — A phone on an older protocol must read "Update the app", not "Stopped"

> **Status:** execution (done — awaiting Review)
> **Branch:** `fix/mobile-version-mismatch-diagnosis`
> **Type:** fix · **Size:** S · **Blast:** contained · **Suited:** DeepSeek executes; standard in-context Review (pure/leaf mobile modules, no §7 invariant, no protocol/persistence change)
> **Changelog:** `changelog.d/mobile-version-mismatch-diagnosis.fixed.md`

## Context

*— Claude Sonnet 4.5, 2026-11-26*

The phone app dials a `serve` successfully, the Noise handshake succeeds, and then
`initialize` is refused with `VersionMismatch` — the app and the daemon speak
different `PROTOCOL_VERSION`s. The Computers screen shows the wrong thing: on the
owner's device (app protocol 25, build `1863f163`, `serve` protocol 27) the
project read «Stopped · run `tentacle serve` in …», i.e. the app told the person
to start a `serve` that was running and answering.

Why, in code:

- The two "update …" verdicts exist, but the app decides them only from the
  **`E2E_CHANNEL_VERSION`** skew carried by a failed Noise handshake
  (`apps/mobile/src/link-diagnosis.ts:94-99`): `state = remote > E2E_CHANNEL_VERSION
  ? "update-app" : "update-computer"`, from `ChannelError.remoteE2eVersion`
  (`packages/client/src/link-machine.ts:38-43`).
- A `VersionMismatch` happens **later and elsewhere**: `client.initialize()`
  (`apps/mobile/src/connection.ts:442`) rejects with an `RpcError` whose code is
  `DomainErrorCode.VersionMismatch` (`packages/protocol/src/jsonrpc.ts:32`) —
  thrown by the daemon at `packages/daemon/src/connection.ts:858-873`. That call
  is *outside* the two places that feed the diagnoser (`connection.ts:349` for a
  failed open, `connection.ts:377` for a failed handshake); the `catch` at
  `connection.ts:461-465` drains, closes and rethrows without telling the
  diagnoser anything. So `diagnoserFor(id).current()` stays `"ok"`.
- The probe carries the rejection verbatim: `probeComputer` keeps the error
  object (`apps/mobile/src/computer-rows.ts:137-148`) and `App.tsx:885-889`
  builds the observation with `diagnosis: "ok"`, `absent: false`.
- With the diagnosis empty, `failedState`
  (`apps/mobile/src/project-rows.ts:174-180`) has one fallback left:
  `return observation.absent || siblingAnswered ? "stopped" : "unreachable";`
  (`project-rows.ts:179`). Hence «Stopped · run `tentacle serve` in <cwd>»
  (`project-rows.ts:190-192`) when a *sibling* project of the same computer
  answered, or «Not reachable» otherwise. Both are false: the computer answered.

How the owner saw `stopped` rather than `unreachable`: two projects of one Mac,
two `serve` processes. The one that had been restarted on the newer build refuses
`initialize`; the sibling still on the older build answers, so `answered > 0` for
the group (`project-rows.ts:248-251`) and the failing row lands on the `stopped`
arm at `project-rows.ts:179`.

Urgency: `main` is at `PROTOCOL_VERSION = 28`
(`packages/protocol/src/version.ts:76`), so **every installed phone** on an older
build now hits exactly this path against a current `serve`, and is told to start a
daemon that is running.

A second, smaller false claim rides the same error: `describeError`'s
`RpcError` branch (`apps/mobile/src/session-list.ts:385-398`) returns the daemon's
own text with `retry: true` for *any* other code — so the tap path offers "Retry"
for a version skew no retry can fix.

The decision this serves: map the `initialize` `VersionMismatch` to
`update-app` / `update-computer` from the two protocol numbers, show both, and
never fall through to `stopped`/`unreachable`.

**Repro:** run from the repo root (`.tentacle/tmp/<slug>/` is gitignored, so the
script is pasted here; the executor re-runs it on current `main` first —
`docs/EXECUTOR-BRIEF.md`).

```ts
// .tentacle/tmp/mobile-version-mismatch-diagnosis/repro.ts
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { DomainErrorCode, RpcError } from "@tentacle/transport";
import { projectSections } from "../../../apps/mobile/src/project-rows.ts";

const APP_PROTOCOL = PROTOCOL_VERSION - 3; // the phone's build, three protocols behind the serve

/** Exactly what the daemon sends (packages/daemon/src/connection.ts:858-873). */
const mismatch = new RpcError(
  DomainErrorCode.VersionMismatch,
  "the app is older than this daemon — update the app",
  {
    client: { protocol: APP_PROTOCOL, tentacle: "0.5.0" },
    daemon: { protocol: PROTOCOL_VERSION, tentacle: "0.5.1" },
    update: "client",
  },
);

const record = (id: string, cwd: string) => ({
  id,
  name: "MacBook",
  computerId: "mac-1",
  project: { label: cwd.split("/").pop() ?? cwd, cwd },
});

// App.tsx:885-889 builds these: probe = what `probeComputer` saw, diagnosis =
// the link diagnoser's `current()` (fed only by dial / handshake failures).
const failed = {
  probe: { ok: false as const, error: mismatch },
  diagnosis: "ok" as const,
  absent: false,
};
const answered = { probe: { ok: true as const, entries: [] }, diagnosis: "ok" as const, absent: false };

// (a) the owner's screenshot: another project of the SAME computer answered.
const pair = [record("a", "/Users/me/tentacle"), record("b", "/Users/me/notes")];
const a = projectSections(pair, [answered, failed]);
// (b) one project only.
const b = projectSections([record("a", "/Users/me/tentacle")], [failed]);

for (const [label, sections] of [
  ["two projects, one answered", a],
  ["one project", b],
] as const) {
  console.log(`\n== ${label} (app protocol ${APP_PROTOCOL}, serve ${PROTOCOL_VERSION}) ==`);
  for (const section of sections) {
    for (const row of section.rows) {
      console.log(
        `  ${row.label}: "${row.word}${row.detail === "" ? "" : ` · ${row.detail}`}"  [state=${row.state}]`,
      );
    }
  }
}
```

Output on `main` (`2e38d06d`, 2026-11-26) — the bug:

```
== two projects, one answered (app protocol 25, serve 28) ==
  tentacle: "New · no sessions yet"  [state=new]
  notes: "Stopped · run `tentacle serve` in /Users/me/notes"  [state=stopped]

== one project (app protocol 25, serve 28) ==
  tentacle: "Not reachable"  [state=unreachable]
```

Expected after the fix: `update-app` → `"Update the app · it runs a newer tentacle
than this app (app protocol 25, serve 28)"`, in both cases, and the section
reading «Needs attention» rather than «Offline».

## Implementation

*— Claude Sonnet 4.5, 2026-11-26*

**APPROVED** (owner delegated the decisions below; §8 plan verified against the
source, every claim cited).

### Load-bearing assumption

**The rejection the phone gets from `client.initialize()` is the daemon's
`RpcError` for `VersionMismatch`, carrying `VersionMismatchData` unchanged, and it
reaches the observation as `probe.error` — so direction and both numbers can be
derived from the error object alone, with no new state and no plumbing.**

Proven end to end:

1. The daemon throws `new RpcError(DomainErrorCode.VersionMismatch, message, data)`
   with `data` **always** (`packages/daemon/src/connection.ts:858-873`), shaped by
   `VersionMismatchDataSchema` = `{client:{protocol,tentacle?}, daemon:{protocol,
   tentacle?}, update:"client"|"daemon"}` (`packages/protocol/src/session.ts:366-378`).
2. The wire error is rebuilt client-side as `new RpcError(e.code ?? …, e.message
   ?? "error", e.data)` — `data` preserved (`packages/transport/src/peer.ts:445`;
   `RpcError.data` at `packages/transport/src/errors.ts:14-25`).
3. `RemoteClient.initialize()` → `handshake` maps it through
   `explainVersionMismatch(error, kind) ?? error`
   (`packages/client/src/remote-client.ts:1178-1179, 3457`), which returns **the
   same error object** when `data` is present
   (`packages/client/src/version-mismatch.ts:31-34`).
4. `probeComputer` returns `{ok: false, error}` with that object, not a copy
   (`apps/mobile/src/computer-rows.ts:137-148`), through `LINKS.get`
   (`apps/mobile/App.tsx:836-838`) into `App.tsx:885-889`.
5. Grep confirmation: the `VersionMismatch` from `initialize` has exactly ONE
   consumer in the app today, and it is the *pairing* path
   (`apps/mobile/src/pairing-flow.ts:222` → the generic "version" sentence, which
   names no side); the **link/probe** path consumes it nowhere — which is
   precisely the bug.

If step 3's `?? error` ever disappears, the whole design fails; the tests below
build the RpcError directly, and the executor MUST also assert the identity
(`explainVersionMismatch(...)` path) with one test in
`apps/mobile/test/link-diagnosis.test.ts` so drift is caught here, not on a phone.

### Preconditions

- `DomainErrorCode` is exported from `@tentacle/protocol`
  (`packages/protocol/src/index.ts:14` re-exports `version.ts`; precedent for the
  import pair: `apps/mobile/src/session-list.ts:16-17` imports `DomainErrorCode`
  from `@tentacle/protocol` and `RpcError` from `@tentacle/transport`).
- `apps/mobile` depends on `@tentacle/protocol` and `@tentacle/transport`
  (`apps/mobile/package.json:10-13`) — no dependency change.
- `PROTOCOL_VERSION` is the app's own number, compiled in
  (`packages/protocol/src/version.ts:76`), and `RemoteClient` sends exactly it
  (`packages/client/src/remote-client.ts:3420-3422`).
- `VersionMismatchDataSchema` is a **strip** schema (unknown fields dropped, §7
  forward-compat), so a newer daemon's report still parses.
- A daemon that sends **no** `data` predates the report and therefore predates any
  client that has this code — stated at
  `packages/client/src/version-mismatch.ts:1-10` and relied on at line 31-37. That
  is the licence for "no data ⇒ the serve is older ⇒ `update-computer`".
- `project-rows.ts` is pure, React-free and owns every row decision (§7), and it
  already sees the probe error through `ProjectObservation.probe`
  (`apps/mobile/src/project-rows.ts:63-68`, consumed at `:270`).
- The e2e-skew verdicts (`update-app`/`update-computer` from
  `E2E_CHANNEL_VERSION`) stay exactly as they are — this fix is additive to the
  same two states, adding no union member (so no ripple into `computer-rows.ts`,
  `drawer-list.ts` or any exhaustive `switch`).
- `project-rows.test.ts` already has the fixtures this needs (`answered()`,
  `failed()`, `rec(...)` — `apps/mobile/test/project-rows.test.ts:40-50,119-127`).

### Design

One derivation, three call sites, **no new state**:

1. **`link-diagnosis.ts` (the pure module that exists to turn an error OBJECT into
   a verdict, never text — file header lines 1-18):**

   ```ts
   /** The protocol numbers of a `VersionMismatch`: ours, and the serve's when it said. */
   export interface ProtocolSkew {
     /** This app's `PROTOCOL_VERSION` — never the daemon's echo of it. */
     readonly app: number;
     /** The serve's protocol; absent when it is old enough to predate the report. */
     readonly serve?: number;
   }

   /** The skew named by an `initialize` rejection, or `undefined` if it is not one. */
   export function protocolSkewOf(error: unknown): ProtocolSkew | undefined;
   /** Which side must update (a `serve` that is absent predates the report ⇒ older). */
   export function skewState(skew: ProtocolSkew): "update-app" | "update-computer";
   /** The two numbers, for a sentence: `app protocol 25, serve 28`. */
   export function protocolSkewNote(skew: ProtocolSkew): string;
   ```

   `protocolSkewOf` rules, in order:
   - not `RpcError` or code ≠ `DomainErrorCode.VersionMismatch` → `undefined`
     (unchanged behaviour for every other failure);
   - `error.data === undefined` → `{ app: PROTOCOL_VERSION }` (a serve older than
     the report — the citation is in Preconditions);
   - `error.data` present but `VersionMismatchDataSchema.safeParse` fails →
     `undefined`: a report exists, so this is **not** an old daemon, and guessing a
     direction from a shape we cannot read would be the text-matching mistake this
     module forbids. Falls through to today's behaviour;
   - `data.daemon.protocol > PROTOCOL_VERSION` → `{app, serve: data.daemon.protocol}`
     (⇒ `update-app`); `<` → `update-computer`; `===` → `undefined` (a report
     contradicting itself: no claim). `data.client.protocol` is **ignored** — our
     own number is the one we know; `data.update` is **ignored** too, because it is
     the same comparison done remotely and we need the numbers anyway.

   `skewState`: `skew.serve === undefined || skew.serve < skew.app` →
   `"update-computer"`, else `"update-app"`.

   `protocolSkewNote`: `` `app protocol ${app}, serve ${serve}` `` when `serve` is
   known, else `` `app protocol ${app}, its serve predates the version report` ``.

   `diagnosisMessage(diagnosis, computerName, skew?)` gains one optional argument
   and appends ` (${protocolSkewNote(skew)})` for the two update states — the ONE
   place the note is worded, shared by the banner and (below) the row.

2. **`project-rows.ts` — the row (the bug):**
   - `failedState` (`:174-180`): after the authenticated-diagnosis arm, before the
     `stopped`/`unreachable` fallback,
     `const skew = observation.probe.ok ? undefined : protocolSkewOf(observation.probe.error);
      if (skew !== undefined) return skewState(skew);`
     The `absent || siblingAnswered` fallback is then unreachable for a version
     skew — **never `Stopped`**, which is the whole point.
   - `detailOf` (`:182-204`): merge the two update arms into one that appends the
     note: `it runs a newer tentacle than this app (app protocol 25, serve 28)` /
     `tentacle on it is older than this app (…)`, note only when `protocolSkewOf`
     finds one (an e2e skew has no numbers — unchanged text).
   - The section band (`:297`, `NEEDS_PAIRING` at `:156`): a section whose rows are
     all `update-*` must read «Needs attention», not «Offline» — the computer
     answered. Add
     `const NEEDS_ACTION = new Set([...NEEDS_PAIRING, "update-app", "update-computer"])`
     and use it **only** at `:297`. The row's tone and its menu actions stay keyed
     on `NEEDS_PAIRING` — the row tone at `:283-286`, and the sheet the screen
     derives from `row.state` (`apps/mobile/src/screens/ComputersScreen.tsx:296`)
     — because "pair again / remove" is wrong for an update.

3. **`session-list.ts` — the tap path's banner:** in `describeError`'s `RpcError`
   branch (`:385-398`), before the generic `retry: true` return:
   `const skew = protocolSkewOf(error); if (skew !== undefined) return { message:
   computerName !== undefined ? diagnosisMessage(skewState(skew), computerName, skew)
   : <the daemon's own message>, retry: false };`
   `retry: false` is the field's own contract ("False for a condition a retry
   cannot fix", `:363-364`).

Why here and not in `connection.ts`: feeding the diagnoser would mean a new state
whose only consumer is a projection that already holds the error object; it would
also tempt the reset-streak machinery (`link-diagnosis.ts:113`) with an
opened-but-refused handshake, which must never feed the `maybe-reset` hint. The
error object is the seam (§7 "reuse existing seams"), so `connection.ts`, `App.tsx`
and `computer-rows.ts` are untouched.

#### Orchestrator decisions

The owner delegated the open questions; each is settled here with a one-line reason.

1. **Derive from the probe error, not from a new diagnoser state.** → The error
   object is already on the observation (`project-rows.ts:63-68`), so the diff is
   three pure call sites with no plumbing through `App.tsx`/`connection.ts`, and no
   risk of the skew feeding the reset streak.
2. **Show protocol numbers, not the tentacle app versions.** → They are the facts
   being compared, cannot be stale, and survive a daemon that reports no
   `clientInfo`; `data.*.tentacle` stays unused (debt noted in Review).
3. **Take the direction from the numbers, not `data.update`.** → We must display
   both numbers anyway; one derivation beats two that can disagree.
4. **Fix the tap banner in the same task.** → The same error makes `describeError`
   offer "Retry" for something no retry can fix (`session-list.ts:396-397`); leaving
   it would ship a row that says "Update the app" beside a button that says Retry.
5. **No new `ProjectState` / `LinkDiagnosis` member.** → The two states already
   exist for the e2e skew; reusing them keeps `computer-rows.ts`, `drawer-list.ts`
   and every exhaustive switch untouched (blast: contained).
6. **The section band joins them.** → A lone `update-app` row reads «Offline»
   today, which is as false as «Stopped»; one set addition fixes it.

### Files

In dependency order (pure module first, its consumers after):

1. `apps/mobile/src/link-diagnosis.ts` — `ProtocolSkew`, `protocolSkewOf`,
   `skewState`, `protocolSkewNote`; `diagnosisMessage`'s optional `skew`.
2. `apps/mobile/src/project-rows.ts` — `failedState`, `detailOf`, `NEEDS_ACTION`
   band.
3. `apps/mobile/src/session-list.ts` — `describeError`'s skew branch.
4. `apps/mobile/test/link-diagnosis.test.ts`, `apps/mobile/test/project-rows.test.ts`,
   `apps/mobile/test/session-list.test.ts` — the tests below (each slice's tests land
   with that slice).
5. `changelog.d/mobile-version-mismatch-diagnosis.fixed.md` — one bullet, e.g.
   `- **Phone says which side to update when it is older than its \`serve\`.** …`.
6. `TODO.md` — tick the item with the merge commit at merge time (orchestrator's
   step, not the executor's).

No daemon, protocol, client-package, CLI or TUI file changes: nothing rides the
wire, no `PROTOCOL_VERSION` note needed, no `protocol.d/` note.

Deliberately **not** changed: `apps/mobile/src/pairing-flow.ts:222` keeps its
generic "version" failure (it names no side). It is a different moment — a pairing
refusal, not a paired computer that stopped answering — and widening it would drag
the pairing reducer (and its `PairingFailure` union) into a one-row bug fix. The
row the owner saw is the one this task fixes; the pairing sentence is noted as
debt for a later pass.

### Failure modes

| Case | Behaviour after the fix |
| --- | --- |
| `serve` newer than the app (today's urgent case, `main` at 28) | `update-app`, both numbers. Never `stopped`. |
| `serve` **older** than the app (the app updated first, or an old `serve` left running) | `update-computer` — never "update the app", which would be the wrong side. |
| Daemon with no `data` (older than the report) | `update-computer`, note «its serve predates the version report»; the sentence already loses nothing, since `packages/client` rewrote the daemon's message for that case (`version-mismatch.ts:34-37`). |
| `data` present but unparseable (future shape, an edited frame) | No claim: falls through to today's `stopped`/`unreachable`. Deliberate — a direction guessed from an unreadable report is exactly the text-matching bug this module exists to avoid. |
| Report contradicting itself (`daemon.protocol === app`) | No claim (falls through). A mismatch of equal numbers is impossible from a real daemon; claiming a side would be a guess. |
| The same error seen again on every re-probe / Reconnect | Same derivation from the same object ⇒ stable row, no flapping. The diagnoser is never called, so the reset streak is untouched and a protocol skew can never surface as `maybe-reset` (pairing again would fail again — a destructive false claim). |
| An authenticated diagnosis is already present (`revoked`, `maybe-reset`, e2e skew) | It wins: `failedState` returns it first (`project-rows.ts:175-178`). |
| A dropped socket / unauthorized / `MethodNotFound` / any other error | Unchanged paths, byte for byte. |
| `broken` Keychain record | Never probed (`App.tsx:831-832`), unchanged. |
| A server that lies about its protocol | Display only: the sentence picks which side to update; no permission, key or persistence decision rides on it (AGENTS §7 "a pod is not trusted" is untouched — the phone only talks to `serve`). |
| Concurrency | None introduced: no new shared state, no new async, pure functions of one argument. |

### Tests

Red before green (§9): A and C must fail on `main` before the change; B's first two
must fail too (they are the reported bug). Iterate with
`bun test apps/mobile/test/link-diagnosis.test.ts` etc.; full `bun run check`
before done.

**A. `apps/mobile/test/link-diagnosis.test.ts` — the pure derivation**

1. Serve newer: `new RpcError(DomainErrorCode.VersionMismatch, "x", {client:{protocol:25},
   daemon:{protocol:PROTOCOL_VERSION + 1}, update:"client"})` →
   `protocolSkewOf` gives `{app: PROTOCOL_VERSION, serve: PROTOCOL_VERSION + 1}` and
   `skewState` → `"update-app"`. *(Mutation: flip the comparison → red.)*
2. Serve older → `"update-computer"`. *(Mutation: always `update-app` → red.)*
3. No `data` → `{app: PROTOCOL_VERSION}`, `skewState` → `"update-computer"`,
   `protocolSkewNote` names the absent report.
4. `data` present but unparseable (`{client: {}, daemon: 7}`) → `undefined`.
   *(Mutation: treat unparseable as absent → red — that mutation is the difference
   between "no claim" and calling a future daemon old.)*
5. `daemon.protocol === PROTOCOL_VERSION` → `undefined`.
6. Not a skew: `Unauthorized` RpcError, `new ChannelError("unreachable", "x")`,
   `new Error("x")`, `undefined` → `undefined` for all.
7. Our number wins over the echoed one: `data.client.protocol = 1`,
   `data.daemon.protocol = PROTOCOL_VERSION + 2` → `app === PROTOCOL_VERSION`.
   *(Mutation: use `data.client.protocol` → red.)*
8. `diagnosisMessage("update-app", "Mac", skew)` contains both numbers;
   without a `skew` argument it is byte-identical to today (regression).
9. Identity through the client: `explainVersionMismatch(mismatch)` (the
   `packages/client` hop the phone really takes) returns the object whose
   `protocolSkewOf` is not `undefined` — pins the load-bearing assumption of §3.

**B. `apps/mobile/test/project-rows.test.ts` — the row (the reported bug)**

10. Two projects of one computer, the sibling answered
    (`answered()`), the other's probe error is the serve-newer `VersionMismatch` →
    `state === "update-app"`, `word === "Update the app"`, `detail` contains
    `"app protocol 25"` and `"serve 28"`. **On `main` this is `"stopped"`** — the
    screenshot, reproduced.
11. One project, same error → `update-app` (today `"unreachable"`),
    `detail` carries both numbers.
12. Serve older, one project → `update-computer`.
13. `absent: true` (relay 4404) plus a skew error → `update-app`, never `stopped`
    *(Mutation: move the skew branch after the `absent || siblingAnswered` line →
    red.)*
14. Precedence: `diagnosis: "revoked"` + skew error → `"revoked"`.
15. An e2e skew stays as it is: a `ChannelError` with `remoteE2eVersion` →
    `update-app`/`update-computer` and a detail with **no** numbers (non-vacuity:
    proves the note comes from the protocol report, not from the state).
16. Section band: a single-project computer whose only row is `update-app` reads
    `"attention"` / «Needs attention», not `"offline"` *(red on `main`)*.

**C. `apps/mobile/test/session-list.test.ts` — the banner**

17. `describeError(mismatch, {computerName: "Mac"})` → message carries both numbers,
    `retry === false`. **On `main`: the daemon's text with `retry: true`.**
18. Same error with **no** `computerName` → the daemon's own message, `retry === false`.
19. `MethodNotFound` / `Unauthorized` / a generic `RpcError` → unchanged.

Every test uses the existing fixtures and constructs the error inline (no I/O, no
fake socket): the module contract is "an error object in, a verdict out" (§7), and
building the `RpcError` by hand is what makes the red step cheap. Repo style applies:
double quotes, trailing commas, no `!` assertions.

## Execution

*— Claude (Anthropic), 2026-11-26. Model snapshot string is not surfaced to the agent; the doc header expected DeepSeek to execute this one.*

**Load-bearing check (re-run first, as the brief demands).** The Context repro, run
unchanged on this branch's base (`a257d85d`, `main`), reproduced the bug byte for
byte — same two lines as recorded in Context:

```
== two projects, one answered (app protocol 25, serve 28) ==
  tentacle: "New · no sessions yet"  [state=new]
  notes: "Stopped · run `tentacle serve` in /Users/me/notes"  [state=stopped]

== one project (app protocol 25, serve 28) ==
  tentacle: "Not reachable"  [state=unreachable]
```

Two claims of the §3 chain were also checked against the source before editing:
`explainVersionMismatch` returns **the same object** when `data` is present
(`packages/client/src/version-mismatch.ts:31-34`), and `RemoteClient.handshake`
throws `explainVersionMismatch(error, this.daemonKind) ?? error`
(`packages/client/src/remote-client.ts:3457-3460`). A9 pins that hop.

**Drift from the Implementation (2 items, both fixture/mechanics — no design change):**

1. **The Context repro's numbers could not exercise the fix.** It simulated an
   older phone by hard-coding `APP_PROTOCOL = PROTOCOL_VERSION - 3` while leaving
   `daemon.protocol = PROTOCOL_VERSION`, i.e. it asked the derivation to read the
   *app's* number from `data.client.protocol` — the very thing decision 7 and rule
   7 of `protocolSkewOf` forbid (our own compiled-in number wins). With the design
   implemented, that fixture correctly lands on the "report contradicts itself"
   rule (equal numbers ⇒ no claim) and still prints «Stopped». Repro corrected to
   express the owner's 25-vs-28 shape in this tree's numbers —
   `APP_PROTOCOL = PROTOCOL_VERSION`, `SERVE_PROTOCOL = PROTOCOL_VERSION + 3` — and
   it then shows the fix end to end. The design was not changed. The repro's only
   change (script at `.tentacle/tmp/mobile-version-mismatch-diagnosis/repro.ts`,
   gitignored, so kept here):

   ```ts
   const APP_PROTOCOL = PROTOCOL_VERSION;
   const SERVE_PROTOCOL = PROTOCOL_VERSION + 3; // the newer side
   // …
   daemon: { protocol: SERVE_PROTOCOL, tentacle: "0.5.1" },
   ```
2. **`protocolSkewOf` reports the pair; `skewState` alone decides the side.** The
   Design's rule list put the `>` / `<` comparison inside `protocolSkewOf`; since
   `skewState` is defined by that same comparison, having both would be two
   derivations that can disagree (the exact thing Orchestrator decision 3 rules
   out). Behaviour is identical; `protocolSkewOf` keeps `serve` as sent and still
   returns `undefined` for an equal pair. A1/A2/M1/M2 pin it.

**As built, in the Implementation's order:**

1. `apps/mobile/src/link-diagnosis.ts:87-138` — `ProtocolSkew`, `protocolSkewOf`
   (`:100`)
   (code first, then report presence, then `VersionMismatchDataSchema.safeParse`,
   then the equal-protocol "no claim"; `data.client.protocol` and `data.update`
   ignored), `skewState`, `protocolSkewNote`, a private `skewNote`;
   `diagnosisMessage` gained the optional `skew` and appends the note only to
   `update-app` / `update-computer` (`:207-210`).
2. `apps/mobile/src/project-rows.ts` — `NEEDS_ACTION` (`:171-176`, used ONLY at the
   band, `:334`); `failedState`'s skew branch before the `stopped`/`unreachable`
   fallback (`:193-211`, helper `skewOfProbe` at `:209`); `detailOf`'s two update
   arms append `skewNoteOf(probe)` (`:236-238`, helper at `:214`).
3. `apps/mobile/src/session-list.ts:402-412` — `describeError`'s skew branch after
   `Unauthorized`, before the generic `retry: true`: the diagnosis sentence with a
   `computerName`, else the daemon's own message (and the module's existing
   fallback text when that message is empty), always `retry: false`.
4. Tests: `apps/mobile/test/link-diagnosis.test.ts` (9 new, A1-A9),
   `apps/mobile/test/project-rows.test.ts` (6 new, B10-B16),
   `apps/mobile/test/session-list.test.ts` (3 new, C17-C19).
5. `changelog.d/mobile-version-mismatch-diagnosis.fixed.md` — one bullet.

No change to `connection.ts`, `App.tsx`, `computer-rows.ts`, `drawer-list.ts`,
`pairing-flow.ts`, the protocol, the daemon, or `PROTOCOL_VERSION` — nothing rides
the wire, so no `protocol.d/` note and no `protocol.json` regeneration. `TODO.md`
untouched (the orchestrator's).

**Red before green, per slice (narrow files, §4):**

- **A** — red as an absent export (`SyntaxError: Export named 'protocolSkewNote'
  not found`, 1 error): unavoidable for a brand-new API, so A's non-vacuity rests
  on the mutations M1/M3/M4 below, which are red **on the assertions**.
- **B** — red on the reported bug itself, four failures on unmodified code:
  `Expected: "update-app" / Received: "stopped"` (twice, incl. the sibling-answered
  screenshot case), `Expected: "update-computer" / Received: "unreachable"`,
  `Expected: "attention" / Received: "offline"`.
- **C** — red on the exact property: `Expected to contain: "update the app" /
  Received: "protocol version mismatch"` and `Expected: false / Received: true`
  (the Retry offer for a skew no retry can fix).

**Mutation checks (§9 non-vacuity), each applied to the finished code, run, and
reverted from a scratch backup — every one red on the target assertion:**

| # | Mutation | Result |
| --- | --- | --- |
| M1 | `skewState` comparison flipped | 3 fail — incl. «serve newer → update-app» |
| M2 | `skewState` never returns `update-computer` | 1 fail — B12 «serve older → update-computer» |
| M3 | an unreadable report treated as an absent one | 1 fail — A4 |
| M4 | `app` taken from `data.client.protocol` | 2 fail — A1, A7 |
| M5 | skew branch moved after the `stopped`/`unreachable` fallback | 2 fail — B10 (sibling answered → stopped), B13 (4404 → stopped) |
| M6 | the row's detail drops the protocol numbers | 2 fail — B10, B12 |
| M7 | `describeError`'s skew branch removed | 2 fail — C17, C18 |

Restored and green afterwards (21 pass). Script and outputs:
`.tentacle/tmp/mobile-version-mismatch-diagnosis/mutations.sh` (gitignored).

**End-to-end evidence after the fix** (same repro, corrected fixture):

```
== two projects, one answered (app protocol 28, serve 31) ==
  tentacle: "New · no sessions yet"  [state=new]
  notes: "Update the app · it runs a newer tentacle than this app (app protocol 28, serve 31)"  [state=update-app]

== one project (app protocol 28, serve 31) ==
  tentacle: "Update the app · it runs a newer tentacle than this app (app protocol 28, serve 31)"  [state=update-app]
```

**Failure-mode table, as built:** serve newer → `update-app` (B10, B11, C17);
serve older → `update-computer` (A2, B12, C17); no `data` → `update-computer` with
the «predates the version report» note (A3, A9); unparseable `data` → no claim,
today's fallback (A4); equal protocols → no claim (A5); an authenticated diagnosis
wins (B14); an e2e skew keeps its numberless detail (B15, proving the note comes
from the report, not the state); `Unauthorized` / `MethodNotFound` / any other
error unchanged (A6, C19). Re-probe stability needs no code: the derivation is a
pure function of the same object, and the diagnoser is never called.

**Narrow verification run here** (the full gate is the orchestrator's script):
`bun test` on the three touched files → **77 pass, 0 fail**;
`bunx biome check` on the six changed files → clean;
`bunx tsc -p apps/mobile --noEmit` → clean. Changelog fragment written; `TODO.md`
and `CHANGELOG.md` untouched.

**Not verified here:** the iOS/Android surface (no simulator) — the change is pure
view-model, so the screens render the new `word`/`detail` with no code change; and
nothing was run against a real `serve` on a different `PROTOCOL_VERSION` (the
report path is pinned by A9's object identity plus the daemon-side schema).

## Review

*— (pending — adversarial pass in a fresh context after Execution)*
