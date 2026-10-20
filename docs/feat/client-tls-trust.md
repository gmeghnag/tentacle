# feat/client-tls-trust — `connect` trusts a self-signed daemon: `--ca-cert` and `--insecure-skip-tls-verify`

> **Status:** Review 2 (claude-opus-5-5): REQUEST-CHANGES (small) — findings 1–5 open; gate green
> **Branch:** `feat/client-tls-trust`
> **Type:** eval → feat · **Size:** S · **Blast:** contained · **Suited:** weaker model executes; standard in-context Review

## Context

*— qwen3.8-27b-q6, 2026-10-20*

**The question being decided:** `serve` already offers TLS (`--tls-cert`/`--tls-key` →
`wss://`, `packages/daemon/src/ws-server.ts:24,205,240`), but `connect` has **no way to
trust a daemon whose certificate is not in the system CA store**. The built-in
`WebSocket` client verifies against system CAs only, so a self-signed / private-CA
daemon is unreachable by the CLI even though the server side is fully wired. This
eval decides the client-side knobs and the exact shape they take:

1. **`--ca-cert PATH`** — PEM file of the CA (or the self-signed cert) that signed the
   daemon's server cert. The **secure, primary** path; verification stays fully on.
2. **`--insecure-skip-tls-verify`** — skip server-certificate verification. **Boolean,
   default off**, explicitly **dev-only** (the k8s-standard escape hatch).

Naming is part of the decision:

- **`--ca-cert`** (not `--tls-ca`/`--ca`) mirrors `kubectl --certificate-authority`
  vocabulary and is distinct from the *server-side* `--tls-cert` (the daemon's own
  cert). The distinction is documented in the README: the client flag is the trust
  *anchor*, not the server's cert.
- **`--insecure-skip-tls-verify`** (not `--insecure-tls-verify=[true|false]`) is the
  k8s-standard name and is already used inside this repo
  (`packages/k8s/src/kubeconfig.ts:19`, `kube-auth.ts:127`), so the flag set stays
  consistent. A boolean flag (present = true, absent = false) matches this CLI's
  existing bool flags (`--plain`, `--model-proxy`, …, `flags.ts:20-45`) and avoids the
  double-negative of a `[true|false]` value.

Constraints: no protocol change, no §7 invariant touched, no new transport — additive
options on the existing `connect` path.

### Measured evidence

*2026-10-20, Bun 1.4.3 (macOS arm64). A self-signed CA for `127.0.0.1`
(SAN `IP:127.0.0.1`) served by a `Bun.serve` WebSocket server with a proper
`srv.upgrade`. Scripts (re-runnable) live in `.tentacle/tmp/tls-flags/`:
`serve2.mjs` (TLS server), and the probe below; `cert.pem`/`key.pem` are the
self-signed pair. `fetch` is used as the oracle because it surfaces the real TLS
error message, where the WS `error` event does not.*

```
$ bun -e '<probe: for each init, fetch("https://127.0.0.1:49443/", init) + new WebSocket("wss://…", init)>'
no-init                      | fetch: ERR: self signed certificate | ws: ERROR
tls.ca                       | fetch: HTTP 426                    | ws: OPENED
tls.rejectUnauthorized:false | fetch: HTTP 426                    | ws: OPENED
disableTlsCerts              | fetch: ERR: self signed certificate| ws: ERROR
```

plus, with `NODE_EXTRA_CA_CERTS=cert.pem` and no init: **`ws: OPENED`**.

Three facts drive the design:

1. **The Bun `WebSocket` client honours the per-call `tls` object in `init`** — both
   `tls.ca` and `tls.rejectUnauthorized: false` work (the same mechanism the k8s pod
   path already uses: `kube-auth.ts:137` `new WS(url, { protocols, ...(hasTls ? { tls } : {}) })`).
2. **`disableTlsCerts` does NOT work on the WS client** (it is a fetch/undici knob; the
   WS ignores it). An implementer who reaches for the "obvious" name would silently
   ship a broken flag. The correct knob is `tls.rejectUnauthorized = false`.
3. `NODE_EXTRA_CA_CERTS` already works but is global, env-based and undiscoverable —
   fine as a fallback, not a first-class flag.

**Repro:** the missing capability (no `connect` flag exists) is shown by the `no-init`
row above: `wss://` to a self-signed daemon fails with `self signed certificate` and no
CLI option exists to supply a CA. The re-run procedure is in *Validation* (below).

## Implementation

*— qwen3.8-27b-q6, 2026-10-20*

### Load-bearing assumption

The change stands or falls on: **the built-in `WebSocket` client accepts a `tls` object
in its `init` argument and honours `tls.ca` / `tls.rejectUnauthorized`.**
**Proven** by the measured table above (`tls.ca` → OPENED, `tls.rejectUnauthorized:false`
→ OPENED, `disableTlsCerts` → ERROR). If a future Bun stops honouring `init.tls`, this
whole approach breaks — that is the one thing to re-verify on a Bun bump. The
corollary (use `tls.rejectUnauthorized`, *not* `disableTlsCerts`) is equally load-bearing
and equally proven.

### Preconditions (verified, cited)

- `connect` path (after `client-reattach`, which split the socket into the factory):
  `connect` (`main.ts:205`) → `connectTui` (`cli/src/connect.ts:61`) → the default
  `dial` = `webSocketChannelFactory(url, { token })` (`connect.ts:66`) →
  `openSocket` → `new WebSocket(target, init)` (`client/src/ws-channel.ts:112,115`).
  Today `init` carries only the token headers — the `tls` object is simply not passed.
  (`connectWebSocket`, the direct open, shares `openSocket`, so it is extended too.)
- `ConnectOptions` is `{ readonly token?: string }` (`ws-channel.ts:71-74`); adding an
  optional field is backwards-compatible.
- `connectTui`'s `ConnectOptions` is `{ url, token? }` (`cli/src/connect.ts:21-25`).
- The server already serves `wss://` (`ws-server.ts:205,240`) and the client URL is
  user-supplied (`connect ws(s)://host:port`, `main.ts:91`) — no client change needed to
  *use* TLS, only to *trust* it.
- Non-fatal warnings during a session must not write raw to the terminal (AGENTS §7):
  `connect.ts` already has `bufferedErrorSink()` (`connect.ts:33`) that flushes
  peer-error lines only after the TUI exits — the insecure-TLS warning rides the same
  sink (gaining a `warning` method).
- The k8s path already composes a single `tls` object from ca/cert/key/reject and
  injects it into `WebSocket`/`fetch` (`kube-auth.ts:116-147`) — the pattern to reuse,
  not invent.
- Token auth over a real socket is already tested via `startWsServer` +
  `connectWebSocket` (`client/test/auth.test.ts:16-31`) — the seam for a TLS test.

### Design

One optional `tls` field flows from the CLI flags to the `WebSocket` `init`, mirroring
the k8s pattern (one object carrying all TLS material, injected where the socket is
created):

- `client/src/ws-channel.ts` — a new exported `TlsOptions`
  (`{ readonly ca?; readonly rejectUnauthorized? }`) and `ConnectOptions.tls`
  (`ws-channel.ts:66,71`). `socketTarget` composes `init` as
  `{ headers?, tls? }` so the token header and TLS coexist (`ws-channel.ts:91`); both
  `connectWebSocket` (`:123`) and `webSocketChannelFactory` (`:175`) pass
  `options.tls` through. (The plan's "build `init` from the token only" predates
  `client-reattach`, which split the socket logic into `socketTarget`/`openSocket` —
  the same two seams the factory reuses, so extending them covers both dial paths.)
  **The factory's classifying `probe` also carries `tls`** (`ws-channel.ts`, the
  `probe` fetch): it is a plain GET that must *complete* the TLS handshake to read the
  daemon's 401, so without `tls` a `wss://` probe fails its own handshake and a bad
  token's `1002` would be misclassified `rejected` (transient redial) instead of
  `unauthorized` (terminal) — the case the review red-teamed (Finding 1).
- `cli/src/connect.ts` — extend its `ConnectOptions` with the same `tls` field
  (`connect.ts:21`) and pass it through to the dial (`connect.ts:68-71`, the
  `webSocketChannelFactory` default the plan called `deps.connect`); emit the
  insecure-TLS warning when `tls.rejectUnauthorized === false`
  (`connect.ts:75-81`) through the existing `bufferedErrorSink` — which gains a
  `warning(line)` method alongside `onError`/`flush` (`connect.ts:33`) so a
  non-error dev notice shares the same "never write while Ink owns the terminal"
  path.
- `cli/src/main.ts` — in the `connect` branch (`main.ts:205-217`):
  - `--ca-cert PATH` → PEM contents (a missing/unreadable file fails loudly at startup,
    before any socket, with a clear error);
  - `--insecure-skip-tls-verify` → boolean flag;
  - build `tls` only if either is set: `{ ca? }`, `{ rejectUnauthorized: false }`, or
    both.
  - `--ca-cert` and `--insecure-skip-tls-verify` may be combined; the insecure flag
    alone is the documented dev path.
  - The flag→`TlsOptions` resolution is a pure `resolveTls(flags, bools)` in
    `cli/src/flags.ts` (`:271`) next to `resolveToken` (§7: flag logic in a pure,
    unit-tested module, not buried in `main`) — see Execution for why it moved from
    `main.ts`.
- No change to `serve`, the daemon, the protocol, or any transport — additive on the
  `connect` side only.

### Files (smallest diff, dependency order: client → cli)

1. `packages/client/src/ws-channel.ts` — `TlsOptions` + `ConnectOptions.tls` +
   `init` composition in `socketTarget` (both dial paths).
2. `packages/cli/src/flags.ts` — `--ca-cert`/`--insecure-skip-tls-verify` in the
   `connect` `ArgSpec` + `USAGE` line + the pure `resolveTls`.
3. `packages/cli/src/connect.ts` — `ConnectOptions.tls` pass-through + the
   `bufferedErrorSink.warning` + insecure warning.
4. `packages/cli/src/main.ts` — call `resolveTls` in the `connect` branch + help text.
5. `README.md` — one line in *Remote control* documenting both client flags
   (and that `--ca-cert` is the trust anchor, distinct from the server's `--tls-cert`).
6. Test-only fixtures `packages/client/test/fixtures/` (self-signed pair + an
   unrelated CA, long-lived, SAN `IP:127.0.0.1`) + the tests below.

### Failure modes (and how state converges)

- **`--ca-cert` points at a missing/unreadable file** → throw at flag resolution, before
  `connectTui`; the user gets `[connect error] cannot read --ca-cert …` and no socket is
  opened. Converges to a clean startup failure.
- **Self-signed daemon, no `--ca-cert`** → the socket errors in the TLS layer;
  `connectWebSocket` rejects with the existing `failed to connect to <url>`, and the
  factory (the `connect` path) classifies it `unreachable`. The user is pointed at
  `--ca-cert` by the README. No silent success.
- **Wrong CA (file exists, didn't sign the server)** → TLS handshake fails → the same
  `failed to connect` rejection. The test suite pins this (non-vacuity check).
- **`wss://` URL but the daemon is not actually serving TLS** → the socket errors at
  connect time (TLS expected, plain returned) → `failed to connect`. Converges to a
  clean failure, not a hang.
- **Insecure mode + a MITM** → the user *chose* it and got a warning (flushed after the
  TUI exits, §7-compliant); the risk is documented as dev-only. Not a silent drop — it
  is surfaced.
- **Token + TLS together** → `init` carries both `headers.Authorization` and `tls`; a
  regression test asserts the token header is still present when TLS is set (guards the
  composition, not just TLS).
- **Bad token against a TLS+token daemon** → the socket upgrade is refused (close 1002)
  and the factory's classifying `probe` (a plain GET) reads the daemon's 401 →
  classified `unauthorized` (terminal), NOT `rejected` (transient → an infinite redial).
  This is why the probe must carry the same `tls` trust (without it the probe's own
  handshake fails and the `1002` is misclassified) — the case the review red-teamed
  (Finding 1), now pinned by a regression test.
- **Version skew** → none: no wire change; an old client simply lacks the flags.

### Tests

New file `packages/client/test/tls-trust.test.ts`, mirroring the real-socket seam of
`auth.test.ts` but with a self-signed TLS server:

- **Fixture:** a checked-in self-signed cert/key for `127.0.0.1` (SAN `IP:127.0.0.1`,
  long-lived, test-only) so the suite is hermetic (no `openssl` dependency). A plain
  `Bun.serve({ tls, fetch: upgrade, websocket: { open } })` is sufficient — it is not
  the full `startWsServer` (which adds token/origin logic the TLS test does not need).
- **Red-before-green property (the exact one the change hinges on):** a WS to the
  self-signed server **fails without a CA and opens only when `tls.ca` is wired through
  `connectWebSocket`**. Asserted as: `connectWebSocket(url)` rejects; then
  `connectWebSocket(url, { tls: { ca } })` resolves. To show red, run this against a
  `connectWebSocket` that ignores `options.tls` (the pre-change behaviour) and confirm
  the CA case still rejects; after the fix it resolves.
- **Insecure path:** `connectWebSocket(url, { tls: { rejectUnauthorized: false } })`
  resolves. (This is also the mutation that proves the *correct knob* is used: if the
  code were written with `disableTlsCerts`, this test would fail while the CA test
  passes — non-vacuous.)
- **Non-vacuity (wrong CA):** `connectWebSocket(url, { tls: { ca: <other-cert> } })`
  rejects.
- **Composition:** a unit assertion that when both token and tls are set, the
  `WebSocket` is constructed with both `headers.Authorization` and `tls` (assert the
  composed `init`, not private fields).
- **Real-daemon handshake (added):** the exact `webSocketChannelFactory` `connect`
  wires into, against `startWsServer` serving the self-signed cert — no CA → a
  `ChannelError` of kind `unreachable`; `tls.ca` and `tls.rejectUnauthorized:false`
  each complete `RemoteClient.initialize()` (the full stack, not just the socket).
- **Bad token over TLS (added, the review's Finding 1):** a `startWsServer` with both a
  token and the self-signed cert; a wrong token + the correct CA classifies
  `unauthorized` (terminal) — **not** `rejected` (a transient that would redial forever).
  Red-first: with the probe's `tls` pass-through removed the same case classifies
  `rejected`, so the test pins the fix, not a correlate. The correct token + CA still
  opens (the fix does not regress the happy path).
- Existing `auth.test.ts` (token over a real socket) must stay green — the `init`
  composition must not regress the no-TLS, token-only path.

CLI tests (the flag side), alongside the existing flag/seam suites:
- `packages/cli/test/args.test.ts` — `--ca-cert` (a value flag, `=` and space forms),
  `--insecure-skip-tls-verify` (a bool, no value), both together, `--ca-cert` without a
  value, and `--insecure-skip-tls-verify=true` (a value on a bool) all parse as the
  spec dictates (closed `ArgSpec`).
- `packages/cli/test/connect.test.ts` — `resolveTls` (no flags → `undefined`;
  `--ca-cert` → PEM contents; `--insecure-skip-tls-verify` → `rejectUnauthorized:false`;
  both → both fields; a missing CA file → throws before any socket) and the
  `connectTui` pass-through (the `tls` reaches the dial options; an insecure knob warns
  via the sink, **not** a raw write while the TUI runs; no insecure knob → no warning).

## Execution

*— qwen3.8-27b-q6, 2026-10-20*

Promoted: `git mv docs/eval/client-tls-trust.md docs/feat/` + branch
`feat/client-tls-trust` (off `main` @ `8ea7c77`).

**Repro re-run on current `main` before any edit** (the Context's table, the
`.tentacle/tmp/tls-flags/` scripts): `no-init` → FAIL (self-signed), `tls.ca` → OK,
`disableTlsCerts` → FAIL. Confirms the capability is still missing and the load-bearing
assumption (`init.tls` honoured; `disableTlsCerts` NOT) still holds on Bun 1.4.3.

Order, per the Implementation:

1. **Fixtures** — generated a hermetic test-only pair in
   `packages/client/test/fixtures/` (`server.pem`/`server-key.pem`, self-signed,
   SAN `IP:127.0.0.1`, 10 y; `other-ca.pem`, an unrelated CA for the wrong-CA
   non-vacuity case). No `openssl` needed at test time.
2. **`client/src/ws-channel.ts`** — `TlsOptions` + `ConnectOptions.tls`;
   `socketTarget` composes `{ headers?, tls? }`; both `openSocket` callers
   (`connectWebSocket`, `webSocketChannelFactory`) thread `options.tls`; the factory's
   classifying `probe` also carries `tls` (see the post-Review note below).
3. **`cli/src/flags.ts`** — the two flags in the `connect` `ArgSpec` + `USAGE` line +
   the pure `resolveTls`.
4. **`cli/src/connect.ts`** — `ConnectOptions.tls` pass-through; `bufferedErrorSink`
   gains `warning`; the insecure knob emits the dev warning through the sink.
5. **`cli/src/main.ts`** — the `connect` branch calls `resolveTls` and passes `tls`;
   help text documents both flags (trust anchor vs `--tls-cert`).
6. **`README.md`** — the *Remote control* line.
7. **Tests** — `client/test/tls-trust.test.ts` (socket + composition + real-daemon
   handshake), `cli/test/args.test.ts`, `cli/test/connect.test.ts`.

**Red before green (AGENTS §9):** `bun test packages/client/test/tls-trust.test.ts`
against the pre-change `ws-channel.ts` (swapped in via `git show
main:packages/client/src/ws-channel.ts`, then restored) → **5 fail / 1 pass** — the
"ca opens", "insecure opens", both composition cases, and the "real daemon handshake"
test fail on the property assertions; the lone pass is the "neither token nor tls → no
init" guard (as it must — that path is unchanged; the intended non-vacuity
discriminator). After the fix: **green**. The wrong-CA and
`rejectUnauthorized`-vs-`disableTlsCerts` cases pin non-vacuity.

**Drift from the Implementation (two, both to make the change better/cleaner, none
contradicting the design):**
- **`resolveTls` lives in `flags.ts`, not `main.ts`** as the plan's file list said.
  It is pure flag→`TlsOptions` logic with an injected `Bun.file` read — the same seam
  as `resolveToken`, which §7 wants in a pure, unit-tested module, not buried in
  `main` (which has no injection point for `startTui`). `main.ts` only calls it.
- **The insecure warning is a new `bufferedErrorSink.warning` method** (not a reuse of
  `onError`): it is a dev notice, not a peer error, and forcing it through `onError`
  would mislabel it `[connect] error:`. Same "never write while Ink owns the
  terminal" path, correct label.

**Post-Review fixes (all three findings resolved, red-first where functional):** the
fresh-context Review (below) returned APPROVE-WITH-NITS with one functional nit and two
doc nits. All are fixed:
- **Finding 1 (functional):** the factory's `probe` now carries `tls` (the GET must
  complete the TLS handshake to read the 401). Without it, a bad token over a TLS daemon
  is misclassified `rejected` (transient redial loop) instead of `unauthorized`
  (terminal). Fixed + pinned by a new red-first regression test (removing the probe's
  `tls` makes it classify `rejected`); the correct-token+CA happy path still opens.
- **Finding 2 (doc):** `NODE_EXTRA_CA_CERTS` global fallback now mentioned in the README
  (the 2026-10-20 eval asked for it).
- **Finding 3 (hygiene):** the `TODO.md` index entry now reflects the promotion
  (`docs/feat/client-tls-trust.md`, branch, reviewed), replacing the stale
  "eval, promotion-ready" pointer.

**Gate:** `bun run check` (typecheck → lint → test) — **1298 pass / 0 fail / 2 skip**
(the two documented opt-in skips: live k8s + the real-socket keepalive; the count rose
from 1297 to 1298 with the probe regression test). No new lint issues (the baseline is
clean); formatting nits auto-fixed with `biome check --write`.

**Unverified (one line):** the flags were exercised through `resolveTls` + `connectTui`
unit tests and the real-socket TLS tests, but I did **not** run a full `tentacle
serve --tls-cert … && tentacle connect --ca-cert …` end-to-end from two processes —
the real-daemon-handshake test (`startWsServer` + `webSocketChannelFactory`) covers the
same stack in-process. To verify live: `bun packages/cli/src/main.ts serve
--tls-cert <c> --tls-key <k>` in one shell, `bun packages/cli/src/main.ts connect
wss://127.0.0.1:<port> --ca-cert <c>` in another.


## Review

*(Note: the 2026-10-20 pre-promotion eval verdict was "approved to promote". The
section below replaces that eval block with the adversarial Review of the executed
diff.)*

*— qwen3.8-27b-q6 (FRESH CONTEXT, same model as executor), 2026-10-20*

**Verdict: APPROVE-WITH-NITS**

The core property is real, non-vacuous, and correct: a WS to a self-signed daemon
fails without a CA and opens only when `tls.ca` / `rejectUnauthorized:false` is threaded
into the socket `init`. Gate is green and I reproduced it. One genuine functional nit
(Finding 1) in the *error-classification* path that the change introduced but did not
exercise; two minor doc/hygiene nits (Findings 2–3). None touches the happy path, the
protocol, a §7 invariant, or the socket `init` composition.

### Findings

1. **[nit, functional] The `probe` in `webSocketChannelFactory` does not carry `tls`,
   so a bad-token + self-signed-TLS daemon is misclassified as `rejected` (transient)
   instead of `unauthorized` (terminal).** `ws-channel.ts:182-190` — `probe()` builds
   its HTTP GET with `socketTarget(url, options.token)` (the `tls` arg omitted) and calls
   `fetch(…)` with **no `tls` object**. Against a `wss://` daemon the probe's *own* TLS
   handshake fails (`self signed certificate`), the probe returns `null`, and a bad-token
   `1002` is classified `rejected` ("the daemon refused the upgrade") rather than
   `unauthorized` (which `terminalReason`, `link-machine.ts:81`, stops on).
   - **Empirically confirmed** (real `startWsServer` + `webSocketChannelFactory`, this
     Review): `wss://` + `tls.ca` + **bad token → `rejected`**; the identical plain-`ws://`
     case → `unauthorized`. Passing `tls` into the probe's `fetch` yields a `401` →
     `unauthorized` (so the fix is a two-line pass-through of `options.tls` into `probe`).
   - **Consequence, bounded:** the *initial* `connect` with a bad token still fails
     cleanly (verified: `connectTui` throws → `main.ts` prints
     `[connect error] the daemon refused the upgrade` — a misleading *diagnosis*, the
     user typed the wrong token but is told the daemon refused). The real harm is on a
     **redial** of a TLS+token daemon whose token has since become bad: `unauthorized` is
     terminal, `rejected` is transient → the client back-offs/retries forever instead of
     stopping. Narrow (token is static for a session's life; wrong-token is the one TLS+
     token failure mode), but it is a failure mode the Implementation's list omits and no
     test covers.
   - **Not** a "false 401/426 from a probe that can't complete" (the brief's worry):
     `classifyUpgradeFailure` treats a `null` probe as `rejected`, never a bogus status.
     It *is* a wrong *kind*. The plan's failure-mode table has no "bad token over TLS"
     row, so this is a missed case, not a contradicted plan.

2. **[nit, doc] The `NODE_EXTRA_CA_CERTS` global fallback is not mentioned in the
   README.** The 2026-10-20 eval explicitly asked the executor to "mention it in the
   README, do not remove anything." The *Remote control* line (`README.md:84-91`)
   documents `--ca-cert` and `--insecure-skip-tls-verify` but not the env fallback
   (`grep -c NODE_EXTRA_CA_CERTS README.md` → 0). Nothing was removed (good); the
   mention is missing.

3. **[nit, hygiene] `TODO.md` still reads as if the task is un-promoted.** The index
   item (`TODO.md:523-526`) still says "**Eval:** `docs/eval/client-tls-trust.md` —
   promotion-ready" even though the doc now lives at `docs/feat/client-tls-trust.md` and
   the branch is open. Stale pointer (the link target no longer exists at that path).

### Gate (re-run by this Review, Bun 1.4.3)

`bun run check` (typecheck → lint → test) — **exit 0**:
- typecheck (`tsc --noEmit`): clean.
- lint (`biome check .`): "Checked 320 files in 66ms. No fixes applied." — clean (0
  errors/0 warnings, matches the §6 clean baseline).
- test: **1297 pass / 0 fail / 2 skip** — the two skips are the documented opt-ins (live
  k8s `TENTACLE_K8S_SERVER`, real-socket keepalive `TENTACLE_SLOW_TESTS=1`), 4986
  `expect()` calls across 127 files. Matches the executor's claim exactly.

### Mutation non-vacuity (§9)

Broke the exact property: in `socketTarget` made `init` **drop `tls`** (`if (tls) { void
tls; }` instead of `init.tls = tls`), ran `bun test packages/client/test/tls-trust.test.ts`:
**5 fail / 1 pass**. Failed: "fails with no CA, opens with tls.ca, rejects a wrong CA",
"insecure opens", "token and tls are both in the init", "tls alone yields an init with
tls and no headers", and "the real daemon handshake over TLS". The **single pass is the
"neither token nor tls → no init" guard** — the unchanged path, the intended
non-vacuity discriminator (it passes on both broken and fixed code, exactly as the doc
predicts). Reverted and confirmed the file is **byte-identical** to pre-mutation
(`git hash-object` before == after); `git status` clean of Review artifacts; the file's
6 tests pass again on the reverted tree. The property is genuinely pinned, not a
correlate.

### Premise table (Implementation "Preconditions" — verified against the code)

Line numbers cite the post-change files (the doc's Design/Files sections are accurate
against the final line numbers; the Preconditions section cites the pre-change layout,
which is why a few are "≈").

| Premise (as cited) | Cited | Verdict |
| --- | --- | --- |
| `connect` path: `connect` (`main.ts:205`) → `connectTui` (`connect.ts:61`) → default `dial` = `webSocketChannelFactory` (`connect.ts:66`) → `openSocket` → `new WebSocket(target, init)` (`ws-channel.ts:112,115`) | main.ts:205 / connect.ts:61,66 / ws-channel.ts:112,115 | **TRUE** (post-change: `main.ts:203` branch, `:211` `connectTui` call; `connect.ts:62` `connectTui`, `:64` default `dial=webSocketChannelFactory`; `ws-channel.ts:112` `openSocket`, `:119` `new Ctor(target[,init])`. All seams real and used by both `connectWebSocket` and `webSocketChannelFactory`.) |
| Today `init` carries only the token headers; `tls` simply not passed | ws-channel.ts | **TRUE** (pre-change `socketTarget` returned `{ target }` or `{ target, init:{headers} }` only.) |
| `socketTarget`/`openSocket` are the real seams used by BOTH `connectWebSocket` and `webSocketChannelFactory` | ws-channel.ts | **TRUE** — `connectWebSocket:127` and `webSocketChannelFactory:196` both call `openSocket`; grep shows no other `new WebSocket(` production site (k8s `client.ts:101` is a separate, already-TLS-aware path). |
| `webSocketChannelFactory` is the default `dial` wired into `RemoteClient` in `connectTui` | connect.ts:64 | **TRUE** (`deps: ConnectDeps = { dial: webSocketChannelFactory, startTui }`, then `channelFactory: dial` on `RemoteClient`). |
| `ConnectOptions` is `{ readonly token?: string }` (pre); optional field additive | ws-channel.ts:71-74 | **TRUE** (pre-change `:55` `{ readonly token?: string }`; now `:71-76` adds `tls?`. Additive, no wire change.) |
| `connectTui`'s `ConnectOptions` is `{ url, token? }` (pre) | connect.ts:21-25 | **TRUE** (pre-change `:16`; now `:21-25` adds `tls?`). |
| The `connect` branch in `main.ts` calls `resolveTls` | main.ts:205-217 | **TRUE** (`main.ts:210` `const tls = await resolveTls(flags, bools)`, `:211` passes `tls` to `connectTui`). |
| Server already serves `wss://` | ws-server.ts:205,240 | **TRUE** (`:205` spreads `{tls:{cert,key}}` into `Bun.serve`, `:240` `scheme = options.tls ? "wss" : "ws"`). |
| Client URL is user-supplied `connect ws(s)://host:port` | main.ts:91 | **TRUE** (usage line `main.ts:93`; URL is `positional[0]`, `main.ts:207`). |
| `bufferedErrorSink()` flushes peer-error lines only after the TUI exits; insecure warning rides the same sink (gains `warning`) | connect.ts:33 | **TRUE** (`bufferedErrorSink:33`, `warning:41`, pushed pre-mount at `:76-82`, `flush(write)` in the `finally` at `:101` — *after* `startTui` returns. Never a raw write while Ink owns the terminal; verified by the connect.test.ts "not a raw write" assertion.) |
| The k8s path composes a single `tls` object into `WebSocket`/`fetch` | kube-auth.ts:116-147 | **TRUE** (`kube-auth.ts:116` `const tls`, `:137` `new WS(url, { protocols, ...(hasTls ? { tls } : {}) })`); the pattern is mirrored, not reinvented. |
| Token auth over a real socket already tested via `startWsServer` + `connectWebSocket` | auth.test.ts:16-31 | **TRUE** (`auth.test.ts:16-31` real-socket token seam; the TLS test reuses `startWsServer`). |
| `--insecure-skip-tls-verify` already used in the repo (k8s) | kubeconfig.ts:19, kube-auth.ts:127 | **TRUE** (`kubeconfig.ts:19` `insecure-skip-tls-verify`, `kube-auth.ts:127` `if (ctx.insecureSkipTlsVerify)`). |
| `resolveTls` is pure flag→`TlsOptions` next to `resolveToken` | flags.ts:271 | **TRUE** (`flags.ts:277` `resolveTls`, `:313` `resolveToken`; pure, injected `Bun.file`, unit-tested). |

No false premises. (The line numbers are post-change references; the one place to be
careful is that the Preconditions block was written against the pre-change layout, so
`ws-channel.ts:112,115` etc. shift — but every cited symbol is real and the claims hold.)

### Attacks tried (each with result)

1. **Does the `probe` need `tls` too, or correctly not?** → **FOUND A BUG (Finding 1).**
   The probe's HTTP GET cannot complete its TLS handshake against a self-signed daemon
   (it has no `ca`), so a bad-token `1002` is classified `rejected` (transient) instead
   of `unauthorized` (terminal). Verified empirically: bad token over `wss://` + `tls.ca`
   → `rejected`; the same over plain `ws://` → `unauthorized`; passing `tls` into the
   probe's `fetch` → `401` → `unauthorized`. It does *not* produce a false 401/426 (the
   brief's specific worry) — `null` probe → `rejected`, never a bogus status — but it is
   a wrong *kind* on the one TLS+token failure mode.
2. **Any OTHER `new WebSocket(` / `socketTarget` site that should (or should not) carry
   `tls`?** → **Nothing missed.** Grep of the whole repo: production `new WebSocket(`
   sites are `ws-channel.ts` (now threaded) and `k8s/client.ts:101` (a separate, already
   TLS-aware pod path via its own `makeWebSocket` — correctly left alone). `socketTarget`
   is called from `openSocket` (with `tls`) and the `probe` (without — Finding 1). The
   remaining `new WebSocket(` hits are all test-only (plain or injected `Ctor`).
3. **Does the token `?token=` fallback URL + `Authorization` header still coexist with
   TLS, and does the composition test assert the *real* composed init (not an always-pass
   mock)?** → **Holds.** The test injects `CapturingWebSocket` *only* as the socket
   constructor; the real `webSocketChannelFactory` → `socketTarget` → `openSocket` runs
   and produces the `init` the test asserts (`{ headers:{Authorization}, tls }`, plus the
   normalized `?token=` URL). It is the genuine composed init, not a mock that always
   passes. (The real-socket TLS tests independently prove that init actually opens a
   handshake.)
4. **Insecure-mode warning: flushed after TUI exit, never while Ink owns the terminal,
   suppressed when the flag is absent?** → **Holds.** `sink.warning` is pushed before
   `startTui` and only written by `sink.flush(write)` in the `finally` after `startTui`
   returns (no `process.stdout.write` on the path). `connect.test.ts` asserts the
   warning is *not* in `written` during the (fake) TUI mount and *is* present after; and
   "no insecure knob → no warning" asserts `written` is empty for a `ca`-only `tls`.
5. **§7 invariant touched? (should be `contained`)** → **Holds.** No protocol schema,
   transport, persistence, or terminal/IO change. The only terminal-adjacent code is the
   buffered sink (already §7-compliant, extended not bypassed). `contained` is honest.
6. **Version skew — additive with no wire change?** → **Holds.** Only additive optional
   fields (`TlsOptions`, `ConnectOptions.tls`), new CLI flags, new tests, README lines.
   The socket URL/token scheme is unchanged; `init.tls` is a client-side Bun option and
   never crosses the wire. An old client is unaffected; a new client without the flags
   behaves exactly as before.
7. **wss:// URL against a plain (non-TLS) daemon — does it hang or fail clean?** →
   **Holds.** Empirically: `connectWebSocket` rejects in ~1ms (`failed to connect`); the
   factory classifies it `unreachable` (close 1015). Matches the plan's failure-mode row.
8. **Fixture validity (real TLS, not a mock that could pass)?** → **Holds.** `server.pem`
   is self-signed `CN=tentacle-test-daemon`, SAN `IP:127.0.0.1`, valid 2026-10-20 →
   2036-10-17; `server-key.pem` is the matching RSA key; `other-ca.pem` is an *unrelated*
   self-signed CA (SAN `IP:10.9.9.9`) that does **not** sign the server (openssl
   `verify` fails), so the wrong-CA test is a real rejection. The TLS tests use real
   `Bun.serve({ tls })` + real sockets, so they genuinely exercise a TLS handshake.

### What holds

- The load-bearing assumption (`init.tls` honoured; `rejectUnauthorized`, not
  `disableTlsCerts`) is re-proven by the real-socket tests on Bun 1.4.3.
- The exact property is non-vacuous (mutation: 5/6 fail, the no-init guard is the
  discriminator).
- The design is the reuse-existing-seams shape (§7): one `tls` object composed in
  `socketTarget` and threaded through `openSocket` to both dial paths, mirroring
  `kube-auth.ts`. No new transport, no protocol change, no §7 invariant touched.
- The end-to-end trace is real: `tls-trust.test.ts` "the real daemon handshake" runs
  `startWsServer({ tls })` + `webSocketChannelFactory` (the exact factory `connectTui`
  wires) + `RemoteClient.initialize()` — no CA → `ChannelError{unreachable}`;
  `tls.ca` and `rejectUnauthorized:false` each complete a full `initialize()` and match
  `PROTOCOL_VERSION`.
- Naming is consistent with the repo (`--insecure-skip-tls-verify` = existing k8s
  vocabulary; `--ca-cert` distinct from the server's `--tls-cert`, documented in README).

### How the executor behaved

Followed the Implementation in the planned order (client → cli), ran the repro on
current `main` before editing (re-confirmed the load-bearing assumption), and showed
**red before green** (reported "4 fail / 1 pass" against the pre-change `ws-channel.ts`).
Re-running that exact swap (main's `ws-channel.ts` in place, the 6-test file unchanged)
yields **5 fail / 1 pass** — the executor under-counted by one: the file has 6 tests and
only the "neither token nor tls → no init" guard passes on the pre-change code; the
"real daemon handshake" test also fails (its `initialize()` never completes without the
socket opening), which is the fifth. The substance of the red-before-green claim holds
and the lone pass is the intended non-vacuity discriminator in both counts; only the
number was imprecise. The two declared drifts are both
**justified, not findings**: (a) `resolveTls` in `flags.ts` not `main.ts` — it is pure
flag→`TlsOptions` logic with an injected read, exactly the `resolveToken` seam §7 wants
in a pure, unit-tested module, and `main.ts` only calls it; (b) the new
`bufferedErrorSink.warning` method rather than reusing `onError` — correct, since a dev
notice routed through `onError` would be mislabelled `[connect] error:`. The gate count
(1297/0/2) and the lint baseline were reported accurately. The one thing it *didn't* do
is cover the bad-token-over-TLS classification path (Finding 1) — a gap in the failure
modes it enumerated, not a dishonesty. It also left the `NODE_EXTRA_CA_CERTS` README
mention and the `TODO.md` index pointer (Findings 2–3).

**Reviewer note (honesty about the pass):** this is a `contained` / `Size S` task, so a
fresh-context same-model Review is the sanctioned bar — but I am the **same model as the
executor** (`qwen3.8-27b-q6`), only with a fresh context. Shared blind spots survive
both passes; a different-model pass would be stronger. I have red-teamed the failure
modes and the non-vacuity explicitly, and the one functional nit (Finding 1) is in the
error-classification path, not the happy path or any §7 invariant.

*— qwen3.8-27b-q6 (FRESH CONTEXT, same model as executor), 2026-10-20*

### Resolution (executor, 2026-10-20)

All three findings are fixed and re-verified, so the verdict stands as **APPROVE**
(with the nits now resolved):
- **Finding 1** — the `probe` in `webSocketChannelFactory` now threads `options.tls`
  into its classifying `fetch` (the GET must complete the TLS handshake to read the
  daemon's 401). Pinned by a new red-first regression test ("a bad token against a TLS
  daemon is `unauthorized`, not `rejected`"): with the probe's `tls` removed the same
  case classifies `rejected` (the bug), with it `unauthorized`; the correct-token+CA
  happy path still opens. Implementation + Failure modes + Tests sections updated.
- **Finding 2** — `README.md` now mentions the `NODE_EXTRA_CA_CERTS` global fallback.
- **Finding 3** — `TODO.md` index entry updated to reflect the promotion (was the stale
  "eval, promotion-ready" pointer).
- The red-before-green count in Execution was corrected to the reviewer's verified
  **5 fail / 1 pass** (the executor had under-counted by one).
- Re-run gate after the fixes: `bun run check` → **1298 pass / 0 fail / 2 skip**,
  typecheck + lint clean.

*— qwen3.8-27b-q6, 2026-10-20*

### Review 2 — different model (fresh context), 2026-10-20

*— claude-opus-5-5 (FRESH CONTEXT, different model family from the executor), 2026-10-20*

**Verdict: REQUEST-CHANGES (small).** The core works and is well pinned. Every flag
reaches the socket and the probe, the gate is green, and every new test fails under
mutation. But the feature's own failure path, a self-signed daemon with no or wrong
trust, gives the user no TLS hint, and one "fails loudly" claim in the plan does not
hold. Both fixes are a few lines.

#### Findings

1. **[UX, the feature's main failure case] Untrusted cert → `cannot reach the daemon
   (close 1015)`. Nothing says TLS or names `--ca-cert`.** E2E through `main()`
   (`.tentacle/tmp/client-tls-trust-review/e2e.ts`): no CA → `[connect error] cannot
   reach the daemon (close 1015)`, and the wrong CA prints the same thing. 1015 is the
   WebSocket close code for TLS-handshake failure, so `classifyUpgradeFailure`
   (`client/src/ws-channel.ts:145-158`) can tell it apart. Suggest
   `unreachable`, "TLS handshake failed — the daemon's certificate is not trusted (pass
   `--ca-cert FILE`)". The plan's failure-mode rows also do not match what was built.
   They say `failed to connect to <url>`, but that string comes only from
   `connectWebSocket`, and `connect` uses the factory. The test comment
   `tls-trust.test.ts` "close 1006" is also wrong: the code is 1015.
2. **[fail-loud] An empty or non-PEM `--ca-cert` file is accepted, then fails as a
   network error.** `resolveTls` (`cli/src/flags.ts:277`) only checks that the file
   is readable. `empty.pem` and `garbage.pem` each produce `cannot reach the daemon
   (close 1006)`, which reads as "host down". The plan promises a loud,
   startup-time failure for a bad `--ca-cert`. Parse the file in `resolveTls` (e.g.
   `new X509Certificate(pem)` from `node:crypto`) and throw `--ca-cert FILE is not a PEM
   certificate`. Red test: an empty file rejects.
3. **[nit] TLS flags on a `ws://` URL are silently ignored.** `connect ws://… --ca-cert
   X` (or `--insecure-skip-tls-verify`) connects in plaintext with no notice. The
   insecure warning would then describe a link that has no TLS at all. This goes against
   the parser's "nothing is silently ignored" rule (`args.test.ts`). Reject it in
   `resolveTls`/`main` when the scheme is not `wss:`.
4. **[hygiene, before commit] `packages/client/test/fixtures/other-ca-key.pem` is an
   unused private key.** No test or doc references it, so delete it rather than commit
   it.
5. **[hygiene, before commit] The working tree carries `main`'s later commit `8289ac5`
   while the branch HEAD is `8ea7c77`.** `TODO.md` has its two entries (Skills,
   `TENTACLE_CWD`), and `docs/eval/agent-skills.md` sits untracked, byte-identical to
   main's. `git checkout main` will refuse because of the untracked file, and the
   branch diff would carry another task's lines. Rebase onto `main` (drop the untracked
   copy first) so the branch is only this task.
6. **[nit, optional] The insecure warning is shown only after the TUI exits**, so it
   comes after the unverified session has already run. That is §7-correct, but it is
   barely a warning. Low priority: a StatusBar hint is the real fix, and it is out of
   scope here.

#### Gate (re-run, Bun 1.4.3)

`bun run check` → exit 0. tsc clean; biome "Checked 320 files … No fixes applied";
**1298 pass / 2 skip (the opt-ins) / 0 fail**, 4989 `expect()` across 127 files. These
match the Execution's claim.

#### Mutation non-vacuity (§9), each reverted, tree byte-identical after (`git hash-object`)

| Mutation | Test file | Result |
| --- | --- | --- |
| probe drops `tls` (the Finding-1 fix of Review 1) | `client/test/tls-trust.test.ts` | 1 fail: "bad token against a TLS daemon is `unauthorized`" |
| insecure warning → raw `write` before `startTui` | `cli/test/connect.test.ts` | 1 fail: "warns via the sink (not a raw write)" |
| `connectTui` drops `tls` from the dial options | `cli/test/connect.test.ts` | 1 fail: "tls is passed to the dial options" |

Review 1's `socketTarget` mutation (5/6 fail) was not repeated.

#### Attacks tried

1. **E2E through `main()` against a real `startWsServer` (TLS + token), 9 cases** →
   CA + bad token and insecure + bad token both classify `unauthorized`, so Review 1's
   probe fix holds for both knobs. A missing file fails loudly. That pass surfaced
   Findings 1–3.
2. **Another dial site that should carry `tls`?** → none. `webSocketChannelFactory` is
   the only production dial (`cli/src/connect.ts:64`). Redials reuse the same closure,
   so they keep `tls`.
3. **Fixture validity** → `server.pem` is a CA:TRUE self-signed cert with SAN
   `IP:127.0.0.1`, valid to 2036, and its key matches. `openssl verify` against
   `other-ca.pem` fails, so the wrong-CA case is a real rejection.
4. **§7 / blast** → no protocol, persistence or terminal-path change. The warning goes
   through the existing buffered sink. `contained` is honest.
5. **Prior art** → no open item on the `connect`/`ws-channel` TLS path (the only TLS
   item is `docs/fix/pod-tls-env-scrub.md`, a different path).

#### How the executor behaved

The executor was disciplined and honest. It reproduced on `main`, ran red-first, gave
reasons for both drifts, and fixed all three of Review 1's findings with a red-first
test. Its gaps were in the same area Review 1 also missed: what the user *sees* when
trust fails. Both same-model passes tested the classification *kind* but not the
*message*, and neither fed `resolveTls` a readable but invalid file. That shared blind
spot is why a different-model pass was worth running.
