# eval/client-tls-trust — `connect` trusts a self-signed daemon: `--ca-cert` and `--insecure-skip-tls-verify`

> **Status:** eval (Context + Review; self-contained, promotion-ready)
> **Branch:** none until promoted (then `feat/client-tls-trust`)
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

- `connect` path: `connect` (`main.ts:158`) → `connectTui` (`cli/src/connect.ts:38`) →
  `connectWebSocket(url, { token })` (`connect.ts:50`) → `new WebSocket(target, init)`
  (`client/src/ws-channel.ts:60,74-77`). Today `init` carries only the token headers —
  the `tls` object is simply not passed.
- `connectWebSocket`'s `ConnectOptions` is `{ readonly token?: string }`
  (`ws-channel.ts:54-57`); adding an optional field is backwards-compatible.
- `connectTui`'s `ConnectOptions` is `{ url, token? }` (`cli/src/connect.ts:10-13`).
- The server already serves `wss://` (`ws-server.ts:240`) and the client URL is
  user-supplied (`connect ws(s)://host:port`, `main.ts:77`) — no client change needed to
  *use* TLS, only to *trust* it.
- Non-fatal warnings during a session must not write raw to the terminal (AGENTS §7):
  `connect.ts` already has `bufferedErrorSink()` (`connect.ts:22-36`) that flushes
  peer-error lines only after the TUI exits — the insecure-TLS warning rides the same
  sink.
- The k8s path already composes a single `tls` object from ca/cert/key/reject and
  injects it into `WebSocket`/`fetch` (`kube-auth.ts:116-147`) — the pattern to reuse,
  not invent.
- Token auth over a real socket is already tested via `startWsServer` +
  `connectWebSocket` (`client/test/auth.test.ts:16-31`) — the seam for a TLS test.

### Design

One optional `tls` field flows from the CLI flags to the `WebSocket` `init`, mirroring
the k8s pattern (one object carrying all TLS material, injected where the socket is
created):

- `client/src/ws-channel.ts` — extend `ConnectOptions` with
  `readonly tls?: { readonly ca?: string; readonly rejectUnauthorized?: boolean }`;
  compose `init` as `{ headers?, ...tls }` so the token header and TLS coexist
  (`ws-channel.ts:74-77` today builds `init` from the token only).
- `cli/src/connect.ts` — extend its `ConnectOptions` with the same `tls` field and pass
  it through to `deps.connect` (`connect.ts:50`); emit the insecure-TLS warning through
  the existing `bufferedErrorSink` when `tls.rejectUnauthorized === false`.
- `cli/src/main.ts` — in the `connect` branch (`main.ts:160-171`):
  - `--ca-cert PATH` → `Bun.file(PATH).text()` (PEM contents; a missing/unreadable file
    fails loudly at startup, before any socket, with a clear error);
  - `--insecure-skip-tls-verify` → boolean flag;
  - build `tls` only if either is set: `{ ca? }`, `{ rejectUnauthorized: false }`, or both.
  - `--ca-cert` and `--insecure-skip-tls-verify` may be combined; the insecure flag alone
    is the documented dev path.
- No change to `serve`, the daemon, the protocol, or any transport — additive on the
  `connect` side only.

### Files (smallest diff, dependency order: client → cli)

1. `packages/client/src/ws-channel.ts` — `ConnectOptions.tls` + `init` composition.
2. `packages/cli/src/connect.ts` — `ConnectOptions.tls` pass-through + warning.
3. `packages/cli/src/main.ts` — `--ca-cert` / `--insecure-skip-tls-verify` parsing +
   `connect` usage text (currently `main.ts:77`).
4. `README.md` — one line in the *Remote control* section documenting both client flags
   (and that `--ca-cert` is the trust anchor, distinct from the server's `--tls-cert`).

### Failure modes (and how state converges)

- **`--ca-cert` points at a missing/unreadable file** → throw at flag resolution, before
  `connectTui`; the user gets `[connect error] cannot read --ca-cert …` and no socket is
  opened. Converges to a clean startup failure.
- **Self-signed daemon, no `--ca-cert`** → `connectWebSocket` rejects with the existing
  `failed to connect to <url>` (`ws-channel.ts:82`); the user is pointed at `--ca-cert`
  by the README. No silent success.
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
- Existing `auth.test.ts` (token over a real socket) must stay green — the `init`
  composition must not regress the no-TLS, token-only path.

## Execution

(empty until promoted)

## Review

*— qwen3.8-27b-q6, 2026-10-20*

**Verdict: approved to promote** (`git mv` → `docs/feat/client-tls-trust.md` + open
branch `feat/client-tls-trust`).

- **Load-bearing assumption holds and is proven, not asserted:** the `init.tls`
  mechanism and the `rejectUnauthorized` (not `disableTlsCerts`) corollary were measured
  on Bun 1.4.3, with `fetch` as the error oracle. This is the one thing a Bun bump
  could break; re-verify the table before executing if Bun is upgraded.
- **Design is the reuse-existing-seams shape (§7):** one `tls` object composed in
  `ws-channel.ts` and injected where the socket is created, exactly like
  `kube-auth.ts:137`. No new transport, no protocol change, no §7 invariant touched.
  Blast stays `contained`: leaf code in `client` + flag parsing in `cli`; no public API
  beyond an additive optional field, no persisted format, no terminal/IO change.
- **Naming is consistent with the repo:** `--insecure-skip-tls-verify` matches the
  existing internal `insecureSkipTlsVerify` (`kubeconfig.ts:19`); `--ca-cert` is
  kubectl-vocabulary and clearly distinct from the server-side `--tls-cert` (flagged in
  the README to pre-empt the confusion).
- **Failure modes converge to clean failures** (startup throw for a bad CA path;
  `failed to connect` for handshake/TLS mismatch); the insecure-mode warning uses the
  existing §7-compliant `bufferedErrorSink`, not a raw `stdout.write`.
- **Test non-vacuity is designed in:** the wrong-CA rejection and the
  `rejectUnauthorized`-vs-`disableTlsCerts` mutation both pin the exact property, not a
  correlate.
- **Honest caveats left for the executor:** (a) `--ca-cert` still enforces hostname/SAN
  verification — the fixture and any real cert must carry the right SAN/IP; (b)
  `NODE_EXTRA_CA_CERTS` remains a working global fallback (mention it in the README, do
  not remove anything).
- **Suited:** `contained` + `Size S` → a weaker model may execute; standard in-context
  Review (no mandatory fresh-context pass).

*— qwen3.8-27b-q6, 2026-10-20*
