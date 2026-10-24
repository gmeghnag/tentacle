# feat/version-mismatch-notice — Version mismatch: say who is older and what to do; `attach` replaces an older tentacle in the container

> **Status:** implementation
> **Branch:** `feat/version-mismatch-notice`
> **Size:** M · **Blast:** cross-module (protocol additive field + daemon handshake + client handshake + cli `attach` + one TUI notice; no `PROTOCOL_VERSION` bump, no persisted format, no §7 invariant changed) · **Suited:** strong model executes (it touches the handshake every runtime shares and the `attach` injection on a user-owned container); fresh-context Review recommended, red-teaming "Protocol: one shared truth" (forward compat of `initialize`) and "a pod is not trusted"

## Context

*— claude-opus-5-5, 2026-10-24*

**Why.** `TODO.md:723-751` (owner, 2026-10-24): today a protocol skew ends in
one line from the daemon, `protocol version mismatch: client 10, daemon 11`
(`packages/daemon/src/connection.ts:236-241`, code `VersionMismatch` = -32002,
`packages/protocol/src/jsonrpc.ts:31`). It names no tentacle version and no
action. Task 2a (`session-archive.md`) bumps `PROTOCOL_VERSION` 10 → 11
(`packages/protocol/src/version.ts:7`) — the first real skew users will meet —
so this task lands **before 2a** (after 2b, which does not touch the wire).

**Owner-approved wording (verbatim, commands in double quotes):**

- client older: `protocol version mismatch: client 10 (tentacle 0.1.0), daemon 11 (tentacle 0.2.0) — update this client: "tentacle update"`
- daemon older: `protocol version mismatch: client 11 (tentacle 0.2.0), daemon 10 (tentacle 0.1.0) — update the daemon: run "tentacle update" on that host and restart "tentacle serve"`
- `attach`: `the container had tentacle 0.1.0; replaced with 0.2.0 (this laptop's)`; say "container", never "pod".

**Constraints.**
- The DAEMON writes the advice from facts it has (both protocol numbers), so an
  OLD client that prints the message verbatim shows it — today's client does
  (`packages/cli/src/main.ts:239` `[connect error] ${error.message}`,
  `:573` `[pod] failed: …`, `packages/client/src/link-machine.ts:93-94`
  `incompatible daemon: ${message}`).
- A NEW client meeting an OLD daemon (no versions) shows a clear notice decided
  from the error CODE plus the daemon's structured report (its presence), never
  by parsing the text (owner principle).
- Never guess: an old client sends no tentacle version → the daemon says only
  what it knows.

**Paths that must show it** (task brief §4): `connect` at start; a reconnect
after the daemon was upgraded (TUI link status); `attach` (start + reconnect);
`run` (impossible by construction for a release build — proved below, and
where it is NOT impossible); the in-process worker (same build — proved).

**Repro** (2026-10-24; script in `.tentacle/tmp/version-mismatch-notice-plan/repro.ts`,
resolved through the workspace packages): proves the two wire facts the design
stands on — an `RpcError`'s `data` survives the round trip, and an unknown
`initialize` param is stripped, not refused, by today's daemon.

```ts
import { InitializeParamsSchema, Method } from "@tentacle/protocol";
import { DomainErrorCode, RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";

const [a, b] = createChannelPair();
new RpcPeer(a, {
  onRequest: (method, params) => {
    console.log("daemon saw params:", JSON.stringify(params));
    throw new RpcError(DomainErrorCode.VersionMismatch, "protocol version mismatch: client 10, daemon 11", {
      client: { protocol: 10 },
      daemon: { protocol: 11, tentacle: "0.2.0" },
      update: "client",
    });
  },
  onNotification: () => {},
});
const client = new RpcPeer(b, { onRequest: () => null, onNotification: () => {} });
try {
  await client.request(Method.Initialize, {
    protocolVersion: 10,
    clientCapabilities: { streaming: true },
    clientInfo: { name: "tentacle", version: "0.1.0" },
  });
} catch (e) {
  const err = e as RpcError;
  console.log("client got:", err.code, err.message, JSON.stringify(err.data));
}
console.log("schema strips clientInfo:", JSON.stringify(InitializeParamsSchema.parse({
  protocolVersion: 11, clientCapabilities: {}, clientInfo: { name: "tentacle", version: "0.2.0" },
})));
```

```
daemon saw params: {"protocolVersion":10,"clientCapabilities":{"streaming":true}}
client got: -32002 protocol version mismatch: client 10, daemon 11 {"client":{"protocol":10},"daemon":{"protocol":11,"tentacle":"0.2.0"},"update":"client"}
schema strips clientInfo: {"protocolVersion":11,"clientCapabilities":{"streaming":true}}
```

The missing capability itself (no versions, no action in the message) is
visible at `connection.ts:239`; the executor's red tests (below) are the
executable repro of it.

## Implementation

*— claude-opus-5-5, 2026-10-24*

### Load-bearing assumption

**A structured report on the `VersionMismatch` error reaches the client intact,
and a new `initialize` param is invisible to an old daemon** — so the daemon can
carry both versions + the decision (`data`) and the advice (`message`), and the
client can learn its version without breaking any existing daemon.

Proof: handler throw → `sendErrorResponse(id, error.code, error.message, error.data)`
(`packages/transport/src/peer.ts:358-359`), serialized with `data` when present
(`peer.ts:470-474`), rebuilt on the client as `new RpcError(code, message, e.data)`
(`peer.ts:439-442`). Params are a strip schema: `InitializeParamsSchema = z.object({…})`
(`packages/protocol/src/session.ts:68-71`, no `.strict()`), validated before the
handler (`peer.ts:337-339`) → an unknown `clientInfo` is dropped. Both confirmed
by the Repro output above.

### Preconditions

- The version check is the first thing `initialize` does after the
  already-initialized guard (`connection.ts:232-241`); nothing in the handshake
  depends on the client's tentacle version.
- The daemon cannot import the CLI's version (`APP_VERSION`,
  `packages/cli/src/version.ts:53`; `"dev"` from source); every daemon is built
  in the cli package: `startDaemon` (`packages/cli/src/serve.ts:81,115`),
  `startStdioDaemon` (`serve.ts:224,237`), the worker (`packages/cli/src/worker.ts:91`).
  So the version is INJECTED into `SessionHost` (`SessionHostOptions`,
  `packages/daemon/src/session-host.ts:48-85`), like `skills` is.
- `tentacle --version` prints `tentacle ${APP_VERSION}\n` (`main.ts:209-211`).
- Release pod binaries are only ever injected at exactly `APP_VERSION`:
  `resolvePodBinary` release branch refuses any other marker
  (`packages/cli/src/pod-binary-build.ts:265-276`, `podBinaryProblem` `:196-216`).
  From source (`"dev"`) or with `TENTACLE_POD_BIN` it injects whatever is there
  (`:259-264`, `:278-308`); a dev-built binary carries the **package** version
  (`cliVersion()` `:143-146`, compiled in at `:111-113`), NOT `"dev"`.
- `attach` today: probe `tentacle --version` on PATH; exit 0 → reuse, else inject
  to `binPath` and exec by that absolute path (`packages/cli/src/pod-runtime.ts:470-516`).
  In-TUI notices exist for `attach` (`deps.notify`, `pod-runtime.ts:395`, wired
  `main.ts:570`; `NoticeHub` buffers before the TUI subscribes, `notice-hub.ts:2-9`).
- A reconnect re-runs the handshake (`remote-client.ts:862-868`); a
  `VersionMismatch` is terminal (`link-machine.ts:92-95`) → `stop()` emits ONE
  `stopped` status (`remote-client.ts:808-815`, idempotent via `stopError`). The
  TUI shows it only in the StatusBar, **truncated** to one row
  (`packages/tui/src/link-status.ts:38-44`, `components/StatusBar.tsx:90`
  `wrap="truncate-end"`) — the advice sits at the END of the line, so on a
  normal-width terminal it is cut off. Today's per-session `linkClosed`
  (`remote-client.ts:817-819` → `remote-session.ts:488-489`) only fails an
  ACTIVE turn; idle, the user sees nothing else.
- `run`: fresh pod (`pod-runtime.ts:285`), `checkPodBinaries` before any create
  (`:281`, `pod-binary-build.ts:225-242`), injection always (`:308`), daemon exec'd
  by the injected absolute path (`:336`).
- Worker: the same build — `buildBinary` bundles `main.ts` and `worker.ts` as two
  entrypoints of ONE binary (`pod-binary-build.ts:101-104`); from source both
  import the same `@tentacle/protocol` module. One `PROTOCOL_VERSION` constant.

### Design

**Protocol (`@tentacle/protocol`, additive, `PROTOCOL_VERSION` stays 10).**

- `InitializeParams.clientInfo?: { name: string; version: string }` — optional.
  `name` `^[a-z][a-z0-9-]{0,31}$`, `version` the marker charset
  `^[0-9A-Za-z.+-]{1,64}$` (`version.ts:17`). **Lenient by construction**: the
  field is `ClientInfoSchema.optional().catch(undefined)` so a malformed
  `clientInfo` from a future/odd client degrades to "unknown", never to an
  `InvalidParams` that would hide the real `VersionMismatch` (see Failure modes).
- `VersionMismatchDataSchema` (exported, used by daemon to build and client to
  read):
  `{ client: { protocol: int, tentacle?: string }, daemon: { protocol: int, tentacle?: string }, update: "client" | "daemon" }`.
  Not a method/update → `UPDATE_CLASS` untouched. Documented next to
  `DomainErrorCode.VersionMismatch` as the error's `data`.
- **Why no bump** (AGENTS §7): a new optional field + an error `data` an older
  peer ignores; nothing changes meaning. Mixed pairs: old client ↔ new daemon →
  no `clientInfo` (daemon omits the client's tentacle); new client ↔ old daemon
  of the same protocol → `clientInfo` stripped (Repro), handshake succeeds.

**Daemon — a pure module `packages/daemon/src/version-mismatch.ts`.**

```ts
export interface DaemonIdentity { readonly tentacle: string; readonly kind: "serve" | "container" | "worker" }
export function versionMismatch(
  client: { protocol: number; tentacle?: string; name?: string },
  daemon: { protocol: number; identity?: DaemonIdentity },
): { message: string; data: VersionMismatchData }
```

- `update` = `client.protocol < daemon.protocol ? "client" : "daemon"` — a fact
  (protocol numbers only grow), never a semver guess on tentacle versions.
- message = today's line with ` (tentacle X)` after each side WHEN KNOWN, then
  ` — ` + advice:
  - `update: "client"`: `update this client: "tentacle update"` when
    `name` is absent or `"tentacle"` (every client that predates `clientInfo` is
    the CLI — the app does not exist yet); any other `name` → `update this client`
    (the seam the mobile app's task extends with its own advice).
  - `update: "daemon"`, `kind` `serve` (or `worker`, unreachable): the owner
    wording `update the daemon: run "tentacle update" on that host and restart "tentacle serve"`.
  - `update: "daemon"`, `kind` `container` (`serve --stdio`, the `run`/`attach`
    daemon): `update the container's tentacle: run "tentacle attach" again from an up-to-date laptop (it replaces an older one)` — **owner question Q1**.
- `Connection.initialize` (`connection.ts:236-241`): on mismatch,
  `const { message, data } = versionMismatch({ protocol: params.protocolVersion, tentacle: params.clientInfo?.version, name: params.clientInfo?.name }, { protocol: PROTOCOL_VERSION, identity: this.host.identity })`
  and `throw new RpcError(DomainErrorCode.VersionMismatch, message, data)`.
  Synchronous, no new await (§7 "Don't serialize the RPC peer" untouched).
- `SessionHostOptions.identity?: DaemonIdentity`, exposed read-only as
  `SessionHost.identity`. Absent (tests) → no tentacle on the daemon side either.
- Wired in cli: `startDaemon` → `{ tentacle: APP_VERSION, kind: "serve" }`,
  `startStdioDaemon` → `kind: "container"`, worker → `kind: "worker"`.

**Client — a pure module `packages/client/src/version-mismatch.ts`.**

- `RemoteClientOptions.clientInfo?: { name; version }`, sent in `handshake`
  (`remote-client.ts:675-681`). `createLocalRuntime` (`local-runtime.ts:237`) and
  `connectTui` (`connect.ts:113`) pass `{ name: "tentacle", version: APP_VERSION }`.
- `explainVersionMismatch(error: unknown): Error | null` — `null` unless
  `code === VersionMismatch`. If `VersionMismatchDataSchema.safeParse(error.data)`
  succeeds → the daemon wrote the advice: return the error unchanged (the message
  is shown verbatim, same as an old client). If it fails (the daemon predates
  this task) → `new RpcError(code, `${message} — ${OLD_DAEMON_ADVICE}`, data)`
  where `OLD_DAEMON_ADVICE` = `the daemon runs an older tentacle (it does not report its version): update the daemon: run "tentacle update" on that host and restart "tentacle serve"`.
  Deciding "daemon older" from the ABSENCE of `data` is a deduction, not a text
  parse: every daemon built from this task on reports `data` (pinned by a daemon
  test), so a report-less daemon predates this task, i.e. protocol ≤ 10; the
  client is ≥ 10 and they differ ⇒ the daemon is older. **Owner question Q2**
  (alternative: neutral "update both to the same version").
- Applied ONCE, in `handshake`'s rejection (`.catch` → rethrow the explained
  error). Both consumers then get it for free: the start path
  (`connect.ts:120` → `main.ts:239`; `local-runtime.ts:242` → `main.ts:528/573`)
  and the reconnect path (`dial` → `redial(error)` → `terminalReason`,
  `link-machine.ts:93-94`, unchanged).

**TUI — the full reason, once, as a notice.**

- Pure: `packages/tui/src/link-status.ts` gains
  `stoppedNotice(status: LinkStatusView): string | null` — the reason for a
  `stopped` status other than `closed`/`disconnected`
  (e.g. `Link stopped: incompatible daemon: protocol version mismatch: … — update this client: "tentacle update"`), else `null`.
- `App.tsx`: one `useEffect` on `link?.onLinkStatus` that, when
  `stoppedNotice` is non-null, does what the notice feed does
  (`App.tsx:395-399`: `appendNotice` + `flushNow`). The StatusBar keeps its
  one-row indicator. `stop()` fires once (`remote-client.ts:809-811`), so no
  dedupe state is needed; the effect still keeps the last notified reason to be
  safe across a re-subscribe. Applies to every runtime (connect, attach, run,
  worker) — one session path (§7).

**`attach` — replace a container tentacle that is not the laptop's.**

- Pure: `packages/cli/src/container-version.ts`:
  - `parseVersionLine(stdout): string | undefined` — `tentacle <v>` with `<v>`
    matching `MARKER_VERSION_RE`; anything else → `undefined` (unknown).
  - `expectedContainerVersion({ appVersion, podBinOverride, readMarker })`:
    - release (`appVersion !== "dev"`, no `TENTACLE_POD_BIN`) → `appVersion`
      (exactly what `resolvePodBinary` would inject, `pod-binary-build.ts:269-276`);
    - `TENTACLE_POD_BIN` set → `readBinaryVersion(override)`
      (`version-marker.ts:106`, reads the marker without executing; arch-free, one
      file); no marker → `undefined`;
    - dev without override → `undefined` (**owner question Q3**).
  - `containerDecision(probe, expected)` →
    `{ kind: "reuse" } | { kind: "inject" } | { kind: "replace"; had: string | undefined }`:
    probe failed → inject (today); probe ok and (`expected === undefined` or
    `found === expected`) → reuse (today); probe ok and differs (incl. unparsable
    output) → replace.
- **Comparison = exact string equality of the version**, not semver: the laptop
  can only inject its own exact build (release resolver refuses anything else),
  so "differs" means "not what I would run" in both directions (a NEWER
  container tentacle is also replaced — the laptop's protocol is the one its
  client speaks; owner: "when that version differs"). Two dev builds at the same
  package version are not told apart → Q3; the daemon's message still catches a
  protocol skew there.
- `startAttachRuntime` (`pod-runtime.ts:494-516`): `replace` runs the SAME
  `injectAgentBinary` as `inject` (serve by absolute `binPath`), then
  `deps.notify?.(`the container had tentacle ${had ?? "of an unknown version"}; replaced with ${expected} (this laptop's)`)`
  and, piped, the same line via `deps.log`. On injection failure while replacing:
  `throw new Error(`the container has tentacle ${had}, this laptop ${expected}; replacing it failed: ${cause} — re-run with --bin-dir <a writable directory, e.g. /tmp>, or install tentacle ${expected} in the container image`)`.
  A plain `inject` failure keeps today's error unchanged.
- **Replace-in-place safety**: the install command becomes
  `mkdir -p D && head -c N > P.new && chmod 755 P.new && mv -f P.new P`
  (`pod-binary.ts:166-174`). Writing over a binary that an older daemon (a
  previous attach's `serve --stdio` that has not exited) is executing fails on
  Linux with `ETXTBSY`; a rename over it does not. Shared with `run` (fresh pod,
  harmless). If the executor judges this out of scope, it is the one item to
  keep — without it the very case this task targets (an old tentacle in the
  container) can fail.

**`run` and the worker — no new code; proofs.**

- `run`, release build: `checkPodBinaries` (`pod-runtime.ts:281`) + the release
  resolver (`pod-binary-build.ts:269-276`) ⇒ the injected marker is `APP_VERSION`;
  fresh pod (`:285`), exec'd by that absolute path (`:336`) ⇒ the daemon IS the
  laptop's build ⇒ same `PROTOCOL_VERSION`. **Not** impossible in dev or with
  `TENTACLE_POD_BIN` (a stale `dist/pod-bin` cache, `:292-307`) — there the
  daemon's new message (`kind: "container"`) or the client's old-daemon notice
  shows it. Stated in the doc, not hidden.
- Worker: one binary / one source tree (Preconditions) ⇒ equal constant. No
  mismatch path exists; the existing in-process tests already handshake.

**Seams left for later tasks.** 2a bumps to 11 and needs nothing here (its
v10 ↔ v11 skew now speaks). The mobile app sends `clientInfo.name` of its own and
extends `versionMismatch`'s client-advice branch. Task 8/9 (secure channel,
pairing) wrap the channel below `initialize`; they do not touch this.

### Files

In dependency order:

1. `packages/protocol/src/session.ts` — `ClientInfoSchema`, `clientInfo` on
   `InitializeParamsSchema` (lenient `.optional().catch(undefined)`).
2. `packages/protocol/src/jsonrpc.ts` (or a new `version-mismatch.ts` re-exported
   from `index.ts`) — `VersionMismatchDataSchema` + type; regenerate
   `packages/protocol/schema/protocol.json` if `json-schema.ts` covers it.
3. `packages/daemon/src/version-mismatch.ts` (new, pure) + export.
4. `packages/daemon/src/session-host.ts` — `identity` option + getter.
5. `packages/daemon/src/connection.ts:236-241` — use `versionMismatch`.
6. `packages/client/src/version-mismatch.ts` (new, pure) + export.
7. `packages/client/src/remote-client.ts` — `clientInfo` option, sent at
   `:677-680`; `handshake` rejection through `explainVersionMismatch`.
8. `packages/cli/src/serve.ts` (`:115`, `:237`), `packages/cli/src/worker.ts:91`
   — `identity`.
9. `packages/cli/src/local-runtime.ts:237`, `packages/cli/src/connect.ts:113` —
   `clientInfo`.
10. `packages/cli/src/container-version.ts` (new, pure).
11. `packages/cli/src/pod-binary.ts:166-174` — temp + `mv` install.
12. `packages/cli/src/pod-runtime.ts:470-523` — decision, replace, notice, error.
13. `packages/tui/src/link-status.ts` — `stoppedNotice`; `packages/tui/src/App.tsx`
    — the effect.
14. Docs: this doc; a line in `docs/feat/pod-exec-attach.md` (preflight now
    compares versions); `TODO.md` entry → link this doc.

### Failure modes

- **Old client (no `clientInfo`) ↔ new daemon** → message without the client's
  tentacle, advice still correct (protocol numbers). Converges: user updates.
- **New client ↔ old daemon, different protocol** → no `data` → client appends
  the old-daemon advice (start: printed; reconnect: notice + StatusBar).
- **New client ↔ old daemon, same protocol** → `clientInfo` stripped (Repro),
  session works.
- **Malformed `clientInfo`** (too long, control chars) → `.catch(undefined)`:
  treated as absent; never `InvalidParams`, never echoed into the message.
- **A future client whose `initialize` fails THIS daemon's schema** (e.g. 2a or
  later changing `clientCapabilities`) → `InvalidParams` before the version
  check (`peer.ts:337-339`) — the skew would be hidden. Constraint for 2a and
  later: `initialize` params stay parseable by every daemon (only additive,
  lenient fields). Recorded here and to be copied into `session-archive.md`'s
  preconditions; a protocol test pins that a v11-shaped `initialize` with an
  extra field still reaches the version check.
- **Equal protocol, different tentacle** → no mismatch at all, by design (the
  protocol is the compatibility contract). `attach` still replaces (release).
- **Hostile container daemon** (§7 "a pod is not trusted") → it can write any
  `message`/`data`; the client only uses `data` as a boolean "the daemon
  reported" and prints `message` as today (`main.ts:573`). Escape sequences in a
  daemon message are a pre-existing exposure of every error path, not widened
  here (debt, below). A forged `data` cannot create approvals or effects.
- **Replace: container not writable** (`/usr/local/bin` read-only, non-root) →
  the clear error with `--bin-dir` advice; nothing deleted (user-owned, §7 pod
  lifecycle).
- **Replace: old daemon still running the file** → temp + `mv` (above).
- **Replace: unparsable `--version` output** (a different program named
  `tentacle`, a pre-marker build) → treated as "differs" → replaced; notice says
  "of an unknown version".
- **Image ships `tentacle` earlier on PATH than `binPath`** → each attach
  re-probes the image's old one and replaces again (89 MB each time): correct,
  wasteful. Debt; a later fix probes `binPath` first.
- **Reconnect after the container's daemon changed** → same handshake path →
  terminal → one notice.
- **Notice racing the TUI mount** → `NoticeHub` buffers; the link-status effect
  subscribes on mount — a `stopped` emitted before mount is missed by the
  effect. Mitigation: the start-path failure throws before `startTui`
  (`connect.ts:120`, `local-runtime.ts:242`), so pre-mount stops are printed by
  `main.ts`; post-mount stops reach the effect. Pinned by tests.

### Tests

Every test red first on today's code; each with a named mutation.

**protocol** (`packages/protocol/test/session.test.ts`)
- P1 `clientInfo` valid round-trips; malformed → parsed as absent (no throw).
  *Red:* field does not exist (stripped). *Mutation:* drop `.catch` → malformed throws.
- P2 a v11-shaped initialize (`protocolVersion: 11`, unknown extra field) parses
  (the forward-compat constraint).

**daemon** (`packages/daemon/test/version-mismatch.test.ts`, pure; plus
`integration.test.ts:239-247` extended)
- D1 client older, both versions → exactly the owner's first line.
- D2 daemon older, `serve` → exactly the owner's second line.
- D3 no `clientInfo` → `client 10, daemon 11 (tentacle 0.2.0) — update this client: "tentacle update"`; no `(tentacle` after the client.
- D4 `kind: "container"` → the container advice; non-`tentacle` name → `update this client`.
- D5 (integration) every `VersionMismatch` from `Connection` carries `data`
  passing `VersionMismatchDataSchema` — the invariant Q2's deduction rests on.
  *Red:* today `data` is undefined. *Mutation:* swap the `<` in `update` → D1/D2 fail;
  drop `data` from the throw → D5 fails.

**client** (`packages/client/test/version-mismatch.test.ts`; `remote.test.ts`)
- C1 `explainVersionMismatch`: with valid `data` → same message; without →
  message + old-daemon advice; other codes → `null`.
- C2 `RemoteClient` sends `clientInfo` in `initialize` (fake daemon peer records params).
- C3 start: a fake daemon rejecting with no `data` → `initialize()` rejects with the advice appended.
- C4 reconnect: a factory whose second daemon rejects `VersionMismatch` with
  `data` → status `{ state: "stopped", reason: "incompatible daemon: …update this client: \"tentacle update\"" }` (deterministic clock, as in `remote.test.ts`).
  *Mutation:* skip `explainVersionMismatch` in `handshake` → C3 fails; C4 still
  passes (daemon text) — proving the daemon, not the client, owns the advice.

**cli**
- A1 (`container-version.test.ts`, pure) `parseVersionLine`, `expectedContainerVersion` (release / override with/without marker / dev), `containerDecision` table.
- A2 (`pod-runtime.test.ts`, release harness `:799-897`, `appVersion: "0.3.0"`):
  probe answers `tentacle 0.2.0` → injection runs, daemon exec'd by
  `/usr/local/bin/tentacle`, `notify` got `the container had tentacle 0.2.0; replaced with 0.3.0 (this laptop's)`.
  *Red:* today reuses (`exec:…:tentacle serve`). *Mutation:* compare with `!==` inverted → A2 and A3 fail.
- A3 probe answers `tentacle 0.3.0` → reuse, no `head -c` (today's `:572-605` behaviour, now pinned with a version).
- A4 replace whose install exits 1 → the error names both versions, "container", and `--bin-dir`; never `delete:`.
- A5 `pod-binary.test.ts:170-201` updated: install command writes `P.new` then `mv -f`. *Mutation:* revert to `> P` → fails.
- A6 `run` release: `:844` (stale bin fails before create) and `:853` (exact bytes) already pin the "impossible by construction" proof — cite, no new test.
- A7 `connect.test`/`main.test`: `connectTui` with a fake dial whose daemon has
  no `data` → the thrown message carries the advice (what `main.ts:239` prints).

**tui** (`packages/tui/test/link-status.test.ts`; `app.test.tsx`)
- T1 `stoppedNotice`: terminal reason → text; `closed`/`disconnected`/`up`/`reconnecting` → `null`.
- T2 (`app.test.tsx`, ink-testing-library, width 80) a fake `LinkFeed` emits a
  `stopped` with a long mismatch reason → the frame contains `"tentacle update"`
  (wrapped in the transcript). *Red:* today only the truncated StatusBar row
  exists → the substring is absent. *Mutation:* return `null` from
  `stoppedNotice` → T2 fails.

Gate before done: `bun test`, `bun run typecheck`, `bun run lint` (baseline clean, AGENTS §6).

**Open questions for the owner** (each with a recommendation):
- **Q1** Container daemon older (`serve --stdio`): the owner's daemon wording
  says `restart "tentacle serve"`, wrong for a container. Recommend:
  `update the container's tentacle: run "tentacle attach" again from an up-to-date laptop (it replaces an older one)`.
- **Q2** New client ↔ report-less (old) daemon: recommend stating "the daemon
  runs an older tentacle" (a deduction pinned by D5), over a neutral "update both".
- **Q3** `attach` from a source (`dev`) build without `TENTACLE_POD_BIN`:
  recommend keep today's reuse (no reliable expected version without resolving /
  building the binary first); the daemon's message still catches a protocol skew.

## Execution

*— claude-opus-5-5, 2026-10-24*

**Premises re-verified after 2b** (the plan was written on `main` before 2b
merged). Every premise holds; only line numbers moved: `Connection.initialize`
is now `connection.ts:236-260` (was 232-241), `SessionHostOptions` ends at
`session-host.ts:~104`, `handshake` is `remote-client.ts:694-708`, `stop()`
`:827-840`, `dial()` `:861-900`, `startDaemon`'s host is built in
`reloadedHost` (`serve.ts:138`), `startStdioDaemon`'s at `serve.ts:316`, the
worker's at `worker.ts:91`, the attach preflight at `pod-runtime.ts:470-516`,
the install command at `pod-binary.ts:163-175`. One premise was imprecise:
`MARKER_VERSION_RE` lives in `packages/cli/src/version.ts:17`, not in the
protocol's `version.ts` (the plan's "`version.ts:17`" meant the cli one) — the
protocol cannot import it, so `ClientInfoSchema.version` repeats the same regex
literal.

**Gate baseline** (before any edit, `bun run check`): typecheck clean, lint
clean (`Checked 422 files`), `2206 pass / 2 skip / 0 fail` (2208 tests, 178
files). Matches the expected baseline.

**Repro** (before any edit; `.tentacle/tmp/version-mismatch-notice/repro.ts`) —
a v11 client with `clientInfo` against today's v10 daemon, through the real
`Connection`:

```ts
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { Connection, SessionHost } from "@tentacle/daemon";
import { RpcPeer, createChannelPair } from "@tentacle/transport";

const [a, b] = createChannelPair();
const host = new SessionHost({ defaultCwd: process.cwd(), createAgent: () => { throw new Error("unused"); } });
new Connection(a, host);
const client = new RpcPeer(b, { onRequest: () => null, onNotification: () => {} });
try {
  await client.request("initialize", {
    protocolVersion: PROTOCOL_VERSION + 1,
    clientCapabilities: { streaming: true },
    clientInfo: { name: "tentacle", version: "0.2.0" },
  });
} catch (e) {
  const err = e as { code: number; message: string; data?: unknown };
  console.log("code:", err.code);
  console.log("message:", err.message);
  console.log("data:", JSON.stringify(err.data));
}
```

Before (`main` @ e494ef6):
```
code: -32002
message: protocol version mismatch: client 11, daemon 10
data: undefined
```
After (this branch):
```
code: -32002
message: protocol version mismatch: client 11 (tentacle 0.2.0), daemon 10 — update the daemon: run "tentacle update" on that host and restart "tentacle serve"
data: {"client":{"protocol":11,"tentacle":"0.2.0"},"daemon":{"protocol":10},"update":"daemon"}
```
(The repro's host has no `identity`, so the daemon side names only its protocol —
as designed; the real daemons below carry one.)

### As built, in the plan's order

1. **Protocol** — `packages/protocol/src/session.ts`: `ClientInfoSchema`
   (`name` `^[a-z][a-z0-9-]{0,31}$`, `version` `^[0-9A-Za-z.+-]{1,64}$`),
   `InitializeParamsSchema.clientInfo = ClientInfoSchema.optional().catch(undefined)`,
   and `VersionMismatchDataSchema` + type, with a comment on
   `InitializeParamsSchema` stating the forward-compat constraint.
   `jsonrpc.ts`: a doc comment on `DomainErrorCode.VersionMismatch` naming its
   `data`. `PROTOCOL_VERSION` stays 10. `schema/protocol.json` regenerated
   (`bun run schema:export`): `ClientInfo`, `InitializeParams.clientInfo` (not
   required), `VersionMismatchData`.
2. **Daemon** — new pure `packages/daemon/src/version-mismatch.ts`
   (`DaemonIdentity`, `versionMismatch`), exported from `index.ts`;
   `SessionHostOptions.identity?` + read-only `SessionHost.identity`;
   `Connection.initialize` throws `RpcError(VersionMismatch, message, data)`
   built by `versionMismatch` (synchronous, no new await).
3. **Client** — new pure `packages/client/src/version-mismatch.ts`
   (`explainVersionMismatch`, `OLD_DAEMON_ADVICE`), exported;
   `RemoteClientOptions.clientInfo?`, sent in `handshake`; the handshake's
   rejection goes through `explainVersionMismatch` once, so `initialize()` (start)
   and `dial()` → `redial` → `terminalReason` (reconnect) both get it.
4. **cli wiring** — `version.ts`: `CLIENT_INFO = { name: "tentacle", version: APP_VERSION }`;
   `identity` on the three hosts (`serve` / `container` / `worker`);
   `clientInfo: CLIENT_INFO` in `createLocalRuntime` (every RPC runtime: worker,
   `run`, `attach`) and `connectTui`.
5. **attach** — new pure `packages/cli/src/container-version.ts`
   (`parseVersionLine`, `expectedContainerVersion`, `containerDecision`);
   `pod-binary.ts`: install = `mkdir -p D && head -c N > P.new && chmod 755 P.new && mv -f P.new P`
   (shared with `run`); `pod-runtime.ts` `startAttachRuntime`: decision →
   reuse / inject / replace, the notice, and the replace-failure error.
6. **TUI** — `link-status.ts`: pure `stoppedNotice`; `App.tsx`: one effect on
   `link.onLinkStatus` appending it as a notice (`appendNotice` + `flushNow`,
   like the notices feed).
7. **Docs** — this section; `docs/feat/pod-exec-attach.md` (the preflight row
   now says it compares versions and replaces); `TODO.md` entry → link to this doc.

### Nuances decided while building (all of them)

- **`ZodCatch` added to the JSON-Schema exporter's `SUPPORTED_KINDS`**
  (`json-schema.ts`). Without it `bun run schema:export` throws on the lenient
  `clientInfo`. The library emits a `ZodCatch` as its inner schema
  (`zod-to-json-schema/…/parsers/catch.js`: `parseDef(def.innerType._def)`), i.e.
  the shape a sender must send; the receiver's "drop it if invalid" leniency is
  not part of that contract (the same stance the exporter takes on `default`).
  Not in the plan's Files list; the plan said "regenerate if `json-schema.ts`
  covers it" — it did not, so this one-line allowlist entry was needed.
- **`VersionMismatchDataSchema` lives in `session.ts`** (next to
  `InitializeParamsSchema`, the request whose error it is), not in `jsonrpc.ts`
  (the envelope file) nor a new file; the plan allowed either.
- **A non-CLI client's own name is shown**: the client side reads
  `(<clientInfo.name> <version>)`, e.g. `(tentacle-mobile 1.0.0)`. For the CLI
  (`name` absent or `"tentacle"`) this is exactly the owner's `(tentacle X)`.
  Writing `tentacle 1.0.0` for the app's own version would misstate it.
- **The daemon side always says `tentacle`** (it is always the tentacle binary).
- **No daemon identity** (test hosts only — every real daemon has one) → the
  daemon side is `daemon 10` with no parenthesis, advice from `kind` absent =
  the `serve` advice.
- **`kind: "worker"` advice** = the `serve` wording; unreachable (same build).
- **`tentacle` in `data` is optional on both sides** — the client's is absent
  when it sent no (valid) `clientInfo`; the daemon's when it has no identity.
- **`expectedContainerVersion` follows `resolvePodBinary`'s order**: the
  `TENTACLE_POD_BIN` override wins in a RELEASE build too (it does in the
  resolver: `pod-binary-build.ts:260-264`), so release + override → that file's
  marker, not `APP_VERSION`. An override with no marker, or unreadable → unknown
  → reuse (as today). Dev without override → unknown → reuse (Q3).
- **`parseVersionLine` accepts only `^tentacle <marker-charset>$`** (after
  trim); `tentacle dev` parses as `"dev"` (a dev build in the container), which
  then differs from a release laptop's version → replaced.
- **The replace-failure wrap excludes `PodBinaryError`**: if the LOCAL binary is
  not ready (missing/stale `<configDir>/bin`), the resolver's own
  "run `tentacle update`" error is kept unchanged — the `--bin-dir` advice would
  be wrong there. Only a failure after resolution (install exit ≠ 0, verify
  failure) gets the "the container has tentacle X, this laptop Y; replacing it
  failed: … — re-run with --bin-dir …" wrap. Pinned by a test + mutation.
- **The wrapped cause keeps its pre-existing `[pod <name>]` prefix**
  (`injectAgentBinary`'s message, shared with `run`). The new text this task
  writes says "container" only; renaming the injection's own messages is out of
  scope (it would also change `run`'s).
- **Piped mode logs the replace line bare** (`the container had …\n`), no
  `[pod]` tag, so no "pod" in the user-facing text; interactive mode shows it
  only as the in-TUI notice (`deps.notify`; `NoticeHub` buffers it until the TUI
  subscribes), matching how the piped/interactive split already works there.
- **The "replaced with X" notice says the expected version**, not the
  post-injection `--version` output (they are equal for a release binary; the
  verify label is still what the piped "attached" line prints).
- **`stoppedNotice` text = `Link stopped: <reason>`** (plan wording, no `⚠`).
  It fires for every terminal stop with a reason (version skew, rejected
  credentials, target gone), not only skews — the StatusBar truncates them all.
  The existing app test that emits a credentials stop now also gets that line in
  the transcript; it asserts only the StatusBar text, so it is unaffected.
- **The `last` guard in the TUI effect is defensive and not pinned by a test**
  (a client stops once, `stop()` is idempotent; a mutation removing it would not
  fail T2). Stated rather than hidden.
- **Constraint for 2a (recorded here, as asked)**: `initialize` params must stay
  readable by EVERY daemon — only additive, lenient fields; never make
  `InitializeParamsSchema` `.strict()` nor add a required field — otherwise an
  older daemon answers `InvalidParams` before its version check
  (`peer.ts` validates params before the handler) and the skew is hidden. Pinned
  by protocol test P2 (mutation `.strict()` → red) and stated in the
  `InitializeParamsSchema` comment. The 2a plan lives in the gitignored plans
  folder (`.tentacle/tmp/plans/session-archive.md`); I did not edit it — the
  owner/planner of 2a should copy this constraint into its Preconditions.

### Tests: red → green, and mutations

Red was shown on the ASSERTION (not an import error) by first adding a stub
module that reproduces today's behaviour (protocol: a temporary namespace
lookup), then implementing. Every mutation was reverted and proven
byte-identical with `shasum` (before = after).

| Test | Red (before) | Mutation → result |
|---|---|---|
| P1 `clientInfo` valid / malformed-as-absent (`protocol/test/session.test.ts`) | fail (`clientInfo` stripped) | drop `.catch(undefined)` → P1 fails |
| P2 later-protocol `initialize` with extra fields parses | **green on both** (a pin of today's strip behaviour, by design) | `.strict()` on `InitializeParamsSchema` → P2 fails |
| `VersionMismatchDataSchema` shape | fail (missing) | — |
| D1–D4 + no-identity, `daemon/test/version-mismatch.test.ts` (6) | 6 fail (stub = today's wording) | swap `<` → `>` in `update` → 7 fail incl. integration |
| D5 every refusal carries valid `data` (3 cases) + identity/clientInfo reach the message; `integration.test.ts` extended (message + `data`) | 4 fail | drop `data` from the throw → 5 fail |
| C1 `explainVersionMismatch` (4), C2 `clientInfo` sent, C3 start/old daemon, C4 reconnect/upgraded daemon, reconnect/old daemon (`client/test/version-mismatch.test.ts`) | 6 fail; C4 and "other errors → null" green (the daemon owns the advice — the plan's prediction) | skip `explainVersionMismatch` in `handshake` → C3 + reconnect/old-daemon fail, C4 still green |
| A7 `connectTui` start skew: advice thrown before mount, `clientInfo` = `APP_VERSION` sent (`cli/test/connect.test.ts`) | shown red by mutation (see drift) | `clientInfo` removed from `connectTui` → fails |
| `serve` wiring over a real socket: message names `(tentacle <APP_VERSION>)` + `serve` advice, `data` (`cli/test/serve-limits.test.ts`) | shown red by mutation (see drift) | drop `identity` from `startDaemon` → fails |
| A1 `container-version.test.ts` (9) | 4 fail (stub = reuse-whatever-answers); 5 green = today's reuse/inject/unknown, now pinned | `found === expected` → `!==` → 8 fail (A1 + A2/A3 + D4) |
| A2 older/newer replaced, notice + piped line, exec by `/usr/local/bin/tentacle`, never delete; unknown version replaced (`pod-runtime.test.ts`) | 3 fail | same mutation → fail |
| A3 (D4 rewritten) a container at THIS version: reuse, no `head -c`, no notice | green on both (today reuses) — pinned | same mutation → fails |
| A4 replace whose install exits 1 → the exact error (both versions, "container", `--bin-dir`), no daemon exec, no delete | fail | — |
| A4b replace with a stale LOCAL binary keeps the `tentacle update` error | fail | drop the `PodBinaryError` exclusion → fails |
| A5 install via `P.new` + `mv -f` (`pod-binary.test.ts` ×2, `pod-runtime.test.ts` ×2 updated) | 4 fail | revert to `> P` → 6 fail |
| A6 `run` release: `pod-runtime.test.ts` "a stale pod binary fails before any pod is created" + "binaries at the app version are injected" | existing, cited, no new test (plan) | — |
| T1 `stoppedNotice` (`tui/test/link-status.test.ts`) | 1 fail (stub `null`) | `stoppedNotice` → `null` = the stub → fails |
| T2 App: a long skew reason shown whole in the transcript, once (`tui/test/app.test.tsx`) | fail (only the truncated StatusBar row) | same → fails |

**Paths covered**: `connect` at start (A7 + C3), reconnect after a daemon
upgrade → stopped with the daemon's advice (C4) → TUI transcript notice (T2);
reconnect to an old daemon (client advice); `attach` start (A2–A4b; its
reconnect re-execs the SAME `serveBin` and handshakes through the same client
path, C4); `run` by construction (A6, cited) and NOT by construction in dev /
`TENTACLE_POD_BIN` (then the container daemon's `kind: "container"` message —
D4 + the Connection identity test — or the client's old-daemon advice shows it);
the worker: same build, one `PROTOCOL_VERSION` (no mismatch path; the existing
worker test still handshakes).

### Drift from the Implementation

- **cli wiring (step 4) was written before its two tests** (A7, `serve`). Their
  red was shown by mutation (removing the wiring) instead of a pre-edit run —
  equivalent evidence (each fails on its assertion without the wiring), but not
  the strict order.
- **`ZodCatch` in the exporter allowlist** (above) — a file the plan did not list.
- **`startStdioDaemon` (`kind: "container"`) and the worker (`kind: "worker"`)
  identity wiring are NOT pinned by a test**: driving `startStdioDaemon` needs
  the process's stdin/stdout, and the worker's kind is unreachable. Verified by
  reading + typecheck only. The container wording itself is pinned (D4 + the
  Connection identity test). To pin it: a test that injects the stdio streams
  into `startStdioDaemon` (it does not take them as parameters today).
- **ETXTBSY not verified empirically.** The rename-over-a-running-binary claim
  is Linux kernel behaviour; this laptop is macOS. A Linux check is ready in
  `.tentacle/tmp/version-mismatch-notice/etxtbsy.sh` (copy `sleep` to
  `/tmp/tentacle`, run it, try `head -c > /tmp/tentacle` (expected: "Text file
  busy"), then `> .new && mv -f` (expected: ok, old process still running)); run
  it with `podman run --rm -v <that dir>:/r:ro alpine:3 sh /r/etxtbsy.sh` — the
  container runtime needed an approval this run did not have.
- Test counts in the plan were per-family; as built: protocol +3, daemon +10
  (new file) + 1 extended, client +8, cli +9 (A1) +5 (attach) +1 (A7) +1
  (`serve`) with 1 rewritten (D4) and 4 updated (A5), tui +2 (T1) +1 (T2).

### Gate (end)

`bun run check`: typecheck clean; lint clean (`Checked 428 files … No fixes
applied`, 0 errors / 0 warnings — the 7 formatter/import-order findings on my
own files were fixed with `biome check --write` before the run); tests
`2246 pass / 2 skip / 0 fail` (2248 tests, 181 files) vs baseline
`2206 / 2 / 0` — +40 new tests, the same two opt-in skips, no new fail.

## Execution — follow-up 1

*— claude-opus-5-5, 2026-10-24*

This answers the Review's REQUEST-CHANGES, items 1–6 of the orchestrator's
follow-up brief. Review itself is left untouched.

1. **The client keys on whether `data` is present, not whether it validates**
   (Review finding 1). `client/src/version-mismatch.ts:31` is now
   `if (error.data !== undefined) return error`. Any report at all means the
   daemon postdates the report, so its message is shown as written. The advice
   is appended only when `data` is absent. The `VersionMismatchDataSchema`
   import is gone from the client. The schema comment
   (`protocol/src/session.ts:98`) now says its shape only GROWS (additive), like
   `initialize`. The test that pinned the wrong behaviour ("a report that does
   not validate counts as none") is replaced by "a report today's schema does
   not read (a later daemon) is still the daemon's own words". It covers five
   shapes: `{update:"both"}`, `{client:1}`, `"later"`, `0` and `null`.
   - *Nuance:* `null` counts as present. JSON can carry `"data": null`, and only
     a missing member means a daemon from before the report.
   - *Nuance:* the explained error no longer copies `data` (it is `undefined` on
     that path anyway).
2. **The old-daemon advice depends on the runtime** (finding 2). The new
   `DaemonKind = "serve" | "container"` type and `oldDaemonAdvice(kind)` are at
   `client/src/version-mismatch.ts:20`. `container` gets the owner-approved
   container wording: `the daemon runs an older tentacle (it does not report its
   version): update the container's tentacle: run "tentacle attach" again from an
   up-to-date laptop (it replaces an older one)`. The kind is a laptop-side fact,
   wired as follows:
   - `RemoteClientOptions.daemonKind` (`remote-client.ts:156`, default `serve`)
     reaches `explainVersionMismatch` in `handshake` (`:727`).
   - `LocalRuntimeDeps.daemonKind` (`local-runtime.ts:214,246`) carries it.
   - `startPodRuntime` and `startAttachRuntime` pass `"container"`
     (`pod-runtime.ts:371,611`).
   - `connect` and the worker keep `serve`. The worker's case is unreachable.
   - *Nuance:* for `run` the wording says "attach again". It is the
     owner-approved container text and was used as instructed. In `run`, a
     report-less daemon can only come from `TENTACLE_POD_BIN` without a marker
     or from a stale dev cache.
   - *Debt:* `OLD_DAEMON_ADVICE` is still exported; it equals
     `oldDaemonAdvice("serve")`.
3. **Orchestrator decision: a failed replace does not abort `attach`**
   (finding 3). See `pod-runtime.ts:539` and the pure `replaceFailedWarning` at
   `container-version.ts:55`. When the container's tentacle has a different
   version and replacing it fails, `attach` goes on with the container's own
   tentacle and warns. This covers both failure kinds: the install/verify
   failed, or the laptop's pod binary is missing or stale (`PodBinaryError`).
   The warning goes through `notify` (TUI) and, when piped, the log:
   `⚠ the container has tentacle X, this laptop Y; replacing it failed: <cause> —
   continuing with the container's tentacle X (a protocol mismatch is still
   refused). To replace it: <fix>`. The fix is chosen by failure kind:
   - local binary not ready → `run "tentacle update" on this laptop, then
     "tentacle attach" again`;
   - otherwise → `re-run "tentacle attach" with --bin-dir <…>, or install
     tentacle Y in the container image`.

   The `initialize` handshake still refuses a protocol skew with its full
   message, so nothing incompatible runs silently.
   - *Nuance (safety):* before falling back, `attach` re-probes the on-PATH
     `tentacle --version`. The rename might have happened before the verify
     failed, and then the PATH entry is the broken new binary. If the re-probe
     does not answer exit 0, the original injection error is rethrown. The
     daemon then runs the on-PATH `tentacle`, never the install path.
   - *Nuance:* a plain `inject` (nothing in the container) still fails as
     before.
   - The old A4/A4b tests (hard error) are replaced by five tests:
     - read-only dir + same protocol → attached through `tentacle serve`, with
       the exact warning on notify and log, no delete;
     - local binary stale + same protocol → attached, the warning says
       `tentacle update`;
     - read-only dir + a container daemon at another protocol → rejects with
       the daemon's full container mismatch message (the warning came first);
     - an old report-less container daemon → the container advice (item 2);
     - the replace broke the binary (verify and re-probe fail) → the
       injection's error, no daemon exec.
4. **Wording: "container" in this task's new text** (finding 4). The new
   strings are the warning, the notice, the replace line, the container
   advice and the messages in `versionMismatch`; none of them says "pod".
   **Debt:** two pre-existing, shared texts still say it: the `[pod <name>]`
   prefix of `injectAgentBinary`'s errors (embedded in the warning's `<cause>`)
   and `main.ts`'s `[pod] failed:` / `[pod] … attached` lines (shared with
   `run`). Renaming those is its own change.
5. **A hostile daemon's text in the stop notice** (finding 6; AGENTS §7). The
   notice now runs the reason through the repo's `oneLine`
   (`tui/src/commands.ts:48`: control, C1 and bidi/zero-width characters
   removed, whitespace collapsed) at `link-status.ts:71`. It is capped at
   `STOP_NOTICE_MAX = 1000` (`:54`) and ends in `…` when cut. The test uses
   CSI/OSC/BEL/CR-LF/RLO and a 10 KB reason.
   - *Nuance:* `oneLine` drops the ESC but keeps the printable rest, e.g.
     `[2J`. That is harmless text, the same policy as skill descriptions.
6. **A test for the `last` check** (finding 7). In the App test, the same stop
   emitted twice gives one transcript line.

**Not addressed:** Review finding 5 (a stop emitted before the App subscribes
reaches only the StatusBar) was not in this follow-up's brief. It stays an
open nit.

**Red → green.** I wrote new or changed tests first, ran them red on their
assertions (stubs reproduced the old behaviour where an export was new), then
fixed the code:
- client: 2 red (the "later daemon" test and the container advice);
- attach: 4 red (two attached-with-warning, skew, broken binary);
- tui: 1 red (sanitize).

Two tests were green on arrival because their code was written first (the
`daemonKind` wiring and the `last` guard). Their red is shown by mutation
below.

**Mutations** (each reverted; `shasum` identical before/after):

| Mutation | Result |
|---|---|
| client: present-check → "validates" (`update` must be client/daemon) | "later daemon" test fails |
| `handshake` ignores `daemonKind` | RemoteClient container test fails |
| `attach`: rethrow on a failed replace (the old abort) | 4 attach tests fail |
| `attach`: skip the re-probe exit check | broken-binary test fails |
| `daemonKind: "serve"` in run/attach | old-daemon container test fails |
| `stoppedNotice` without `oneLine` | sanitize test fails |
| `stoppedNotice` without the cap | sanitize test fails |
| App effect without `text === last` | twice-emitted test fails |

**Gate:** `bun run check`: typecheck clean; lint `Checked 428 files … No fixes
applied` (0/0); tests **2253 pass / 2 skip / 0 fail** (2255 tests, 181 files).
That is +7 over the first execution: client +2, attach +3 net (5 new, 2
replaced), tui +2. The same two opt-in skips; no new fail.

## Execution — follow-up 2

*— claude-sonnet-5-5, 2026-10-24*

Answers "Review — round 2" (Review untouched).

- **R2-1 / R2-2: one sanitiser for untrusted text.** New pure
  `cli/src/untrusted-text.ts` (`untrustedText`: the TUI's `oneLine`, exported
  by `@tentacle/tui`, plus a 1000-character cap ending in `…`). Used at:
  `container-version.ts` (`replaceFailedWarning`'s `cause`, the container's
  stderr, before `notify`/log), and `main.ts` for `[connect error]`
  and both `[pod] failed:` lines (`run` and `attach`).
  - *Decision:* I did **not** sanitise inside `NoticeHub`. It is the single
    notice sink, but it carries trusted notices too (some are multi-line) and
    `oneLine` would flatten them. The untrusted text is cleaned where it
    enters, at the three sites.
  - *Debt (unchanged):* the piped `deps.log` lines of `injectAgentBinary` and
    the StatusBar `disconnected: <reason>` are still unsanitised; record in
    `TODO.md` as "sanitise once at the cli write sink" as the reviewer said.
- **R2-3 done (one-liner plus an option):** after a failed replace, the
  warning names the re-probed version (`parseVersionLine(again.stdout)`, new
  `now` option in `replaceFailedWarning`), falling back to `had`.
- **Tests (red first, on assertions; `untrusted-text.ts` was a pass-through
  stub):** `cli/test/untrusted-text.test.ts` — the function (ANSI/BEL/RLO +
  10 KB); the warning with a hostile cause + 10 KB; a real `main(["connect",
  ws://…])` against a local WebSocket that answers `initialize` with a hostile
  10 KB error: `[connect error]` line has no control characters and is capped.
  `pod-runtime.test.ts`: "the rename landed and only the verify failed" (R2-3).
- **Mutations (reverted, `shasum` identical):** raw `cause` in the warning →
  the warning test fails; raw message at `[connect error]` → the main test
  fails; `now: undefined` → the R2-3 test fails.
- **Gate:** `bun run check`: typecheck clean, lint `Checked 430 files … No
  fixes applied`, tests **2257 pass / 2 skip / 0 fail** (+4 over follow-up 1).

## Review

> **Owner decision (2026-10-24): APPROVED** (M · cross-module → Opus executes, fresh-context Review). Q1 yes — container older: `… — update the container's tentacle: run "tentacle attach" again from an up-to-date laptop (it replaces an older one)` (replaces the approved "restart serve" wording for that case only). Q2 yes — new client, daemon without versions: "the daemon runs an older tentacle" (a deduction pinned by a test: every daemon from this task on sends `data`). Q3 yes — `attach` from a dev build without `TENTACLE_POD_BIN`: reuse the container's tentacle as today. Runs after 2b, before 2a.

### Orchestrator note (2026-10-24)

*— claude-opus-5-5 (orchestrator)*

- ETXTBSY repro (`.tentacle/tmp/version-mismatch-notice/etxtbsy.sh`) not run:
  no container engine is up on the laptop (podman machine and Docker Desktop
  both stopped), and starting a VM for it was not worth it. The new install
  (`head -c > P.new && chmod && mv -f P.new P`) is correct whether or not the
  old binary is running — rename replaces the directory entry, the running
  process keeps its inode — so the repro would only confirm that the OLD
  in-place write fails. Verify it on the first real `attach` to an older
  container (task 11's real-device checklist is the natural place).
- The constraint for 2a ("`initialize` params must stay readable by every
  daemon, or an `InvalidParams` would hide the `VersionMismatch`") is copied
  into the 2a plan's orchestrator note.

### Adversarial review

*— claude-opus-5-5 (reviewer, fresh context), 2026-10-24. Same model as the
executor and the orchestrator: only the context is fresh, so shared blind
spots can survive both passes.*

**Verdict: REQUEST-CHANGES.** One small fix is needed (finding 1); the rest are
nits. The design is sound, the owner's wording is used exactly, and every new
test I mutated fails as it should.

**Gate** (`bun run check`, run by me on the working tree): typecheck clean; lint
`Checked 428 files … No fixes applied` (0/0); tests **2246 pass / 2 skip /
0 fail** (2248 tests, 181 files). That matches Execution, and the two skips are
the opt-in ones.

#### Findings

1. **Medium: an invalid report is treated as a missing one, so the client
   blames the wrong side.** `packages/client/src/version-mismatch.ts:20`. The
   code checks whether `data` *validates*, but the owner's principle and the
   plan both rely on whether `data` is *present*. Any `data` at all means the
   daemon was built from this task on, so its message already carries the
   advice. Picture a later daemon whose `VersionMismatchData` no longer fits
   today's strip schema (a third `update` value, a changed field). It answers
   this client, and this client appends "the daemon runs an older tentacle",
   even when the daemon is newer. Trace (real `RemoteClient`, fake daemon
   with protocol 12 and `update: "both"`):
   `protocol version mismatch: client 10, daemon 9 — the daemon runs an older tentacle …`.
   The appended advice is a claim built from input that did not validate,
   which is what the brief means by "fail-loud beats synthesising". The test
   `client/test/version-mismatch.test.ts` "a report that does not validate
   counts as none" pins this wrong behaviour. Fix: append the advice only when
   `data === undefined`. When `data` is present (valid or not), show the
   daemon's message unchanged. Update that test to match, and add one line to
   the `VersionMismatchDataSchema` comment: its shape stays additive-only,
   like the `initialize` constraint.
2. **Low: in a container, the old-daemon advice names the wrong command.**
   `client/src/version-mismatch.ts:12`. `OLD_DAEMON_ADVICE` always says
   `restart "tentacle serve"`. That is wrong when the old, report-less daemon
   runs in a container, which can still happen with `attach` from a dev build
   (Q3: the container's tentacle is reused) or with `TENTACLE_POD_BIN` set and
   no marker. The client knows its runtime, so it could pass a hint. This only
   affects dev/override builds, so it can be deferred if recorded as debt.
3. **Low (owner trade-off; the doc should name it): `attach` can now fail
   where it used to work.** `pod-runtime.ts:497-547`. If the container's
   tentacle has a *different version at the same protocol* (it worked before),
   `attach` now fails hard in two cases:
   - replacing it fails (read-only directory);
   - a release laptop has no `<configDir>/bin` pod binary (`PodBinaryError`,
     pinned by A4b).

   In both cases the user gets an error with advice. Nothing is deleted and
   the container stays usable, but there is no fallback to the working
   tentacle. That follows the approved "replace when it differs". Failure
   modes only lists "not writable", though; the "local binary missing" case
   should be stated too.
4. **Nit: the word "pod" still appears in `attach` output.** The
   replace-failure message wraps `injectAgentBinary`'s `[pod <name>] …`
   cause, and `main.ts:573` prefixes it with `[pod] failed:`. So the
   user-facing text still says "pod". The new strings themselves say
   "container" only. The executor disclosed this, and it is pre-existing.
5. **Nit: a stop before the TUI subscribes reaches only the status bar.**
   `App.tsx:403-419`. `onLinkStatus` does not replay the current status
   (`remote-client.ts:381-384`), so a `stopped` emitted between a successful
   `initialize` and the App's mount effect never reaches the transcript. A
   reconnect needs a disconnect plus a backoff to happen first, so this is
   improbable. Not pinned.
6. **Nit: a hostile container daemon's message is now printed in full.** It
   now appears untruncated in the transcript (`stoppedNotice`). Escape
   sequences in it were already a known exposure (plan debt); this widens it
   slightly but does not create it.
7. **Nit: the `last` guard is not covered by any test** (disclosed).

#### Premise table

| Premise | Verdict |
|---|---|
| Symptom: no versions and no advice in the refusal (repro on `main`, in Execution) | TRUE (the old `connection.ts` throw, in the diff) |
| params are parsed before the handler, which receives the parsed data (`peer.ts:337-352`) | TRUE: `handler(method, parsedParams.data)`, so a `clientInfo` that failed `.catch` never reaches the message |
| `data` survives the round trip (`peer.ts:358-359`) | TRUE |
| `VersionMismatch` is terminal → `incompatible daemon: ${message}` (`link-machine.ts:92-95`) | TRUE |
| `--version` prints `tentacle ${APP_VERSION}` (`main.ts:209-211`) | TRUE |
| `main.ts:239` / `:573` print `error.message` | TRUE |
| StatusBar truncates (`StatusBar.tsx:90`) | TRUE |
| one binary, two entrypoints (`pod-binary-build.ts:101-104`) | TRUE |
| the override wins in release builds too (`pod-binary-build.ts:260-264`) | TRUE: `expectedContainerVersion` matches it |
| the daemon throws `VersionMismatch` in only one place (needed for the Q2 deduction) | TRUE: `grep` over `src` finds only `connection.ts:256` |

#### Mutations (all reverted; `shasum -c` over the 35 changed files gives all OK, and `git status --short` still lists 35 entries)

| Mutation | Result |
|---|---|
| `connection.ts`: send no `data` with the throw | D5 ×3, identity test, integration: **fail** |
| `client/version-mismatch.ts`: data check always true | C1 ×2, C3, reconnect/old daemon, A7: **fail** |
| `container-version.ts`: reuse any parsable version | A1 replace row, A2 ×2, A4, A4b: **fail** |
| `App.tsx`: drop `appendNotice` in the effect | T2: **fail** |

That is 16 failures across the 7 files, and each new property I mutated has a
test that kills it. Execution reports more mutations: `.strict()` → P2,
`.catch` → P1, `> P` → A5, `identity` → serve test. I did not re-run those.

#### Attacks tried

- **Malformed or hostile `clientInfo`** (control characters in `name`, a
  100 000-character `version`) against a real `Connection`: it is dropped and
  never echoed, `initialize` still answers `VersionMismatch`, and `data` is
  valid. **Holds.**
- **Hostile container `--version`** (OSC escape, 5 000-digit version, a second
  line): `containerDecision` returns `replace` with `had` undefined, so the
  notice says "of an unknown version" and no pod-supplied bytes reach the
  terminal. The worst a container can do is lie with `tentacle <expected>`
  and get its own binary reused, and it controls the workspace anyway. The
  replace only writes inside the container. **Holds.**
- **A future daemon with changed `data`** → finding 1. **Fails.**
- **No bump is honest:** an optional field plus error `data` that an old peer
  ignores. An old daemon strips `clientInfo` (Context repro). The `ZodCatch`
  export gives `clientInfo` as `$ref ClientInfo`, not required, which is the
  sender's contract and matches how `ZodDefault` is exported. **Holds.**
- **Raw terminal while Ink owns it:** the replace line goes through `deps.log`
  only when `!status` (piped) and through `notify`/`NoticeHub` otherwise. The
  link stop is an `appendNotice`. There are no new raw writes. **Holds.**
- **Single session path:** `clientInfo` is set in `createLocalRuntime` (worker,
  run, attach) and in `connectTui` only, and the explanation is applied once
  in `handshake`. There is no second path. **Holds.**
- **No serialized RPC peer, secrets via env:** the explanation is
  synchronous, with no new await or lock. The install command has no
  secrets. **Holds.**
- **Writing to a temp file, then `mv`:** I agree with the orchestrator that
  rename semantics hold whether the old binary is running or not. One narrow
  regression: a writable `P` in a directory that is *not* writable used to
  work and now fails, because `P.new` cannot be created. This is
  negligible, and the `--bin-dir` advice covers it. ETXTBSY was not run
  empirically: no container engine.

**What holds:** the owner's three lines verbatim, the Q1/Q2/Q3 decisions as
approved, and the forward-compat constraint for 2a (pinned by P2, written in
the schema comment).

**How the executor behaved:** honest and precise. All the drift is disclosed:
the cli wiring before its tests, `ZodCatch`, the untested container/worker
identity, ETXTBSY, and the `last` guard. Red was shown on assertions rather
than on import errors, and the gate counts are exact. The one miss (finding 1)
is a design slip of "present" vs "valid" that the executor's own test
enshrined. It is not concealment.

**Owner OK (2026-10-24)** on the orchestrator decision of follow-up 1 point 3:
when the container's tentacle has a different version and the replacement
fails, `attach` continues with it and shows a warning (the `initialize`
handshake still refuses a real protocol mismatch with the full message).

## Review — round 2

*— claude-opus-5-5 (reviewer, fresh context), 2026-10-24. Same model as the
executor, so shared blind spots are possible.*

**Verdict: REQUEST-CHANGES (narrow).** Round-1 findings 1, 2, 3, 4 and 7 are
closed. Finding 6 is closed only for the stop notice. Follow-up 1 added a
second path that puts text the container wrote into the transcript without
sanitising it (R2-1). That is a one-line fix. Everything else is ready to
merge.

**Gate** (`bun run check`, re-run by me on the restored tree): typecheck
clean; lint `Checked 428 files … No fixes applied` (0/0); tests
**2253 pass / 2 skip / 0 fail** (2255 tests, 181 files). Those match follow-up 1's counts, and the two skips are the
opt-in ones.

### Round-1 findings: closed?

| # | Status | Evidence (my own mutation, reverted) |
|---|---|---|
| 1 `data` present vs valid | **CLOSED.** `client/src/version-mismatch.ts:31` checks `error.data !== undefined` | mutation `if (error.data)` (treats `0`/`null` as absent) → "a report today's schema does not read … is still the daemon's own words" **fails** |
| 2 advice by runtime kind | **CLOSED.** Wiring: `pod-runtime.ts:371,611` → `local-runtime.ts:214,246` → `remote-client.ts:156,289,727` | mutation: `local-runtime.ts:246` drops the forwarding → "an old report-less container daemon gets the container advice, never `serve`" **fails** |
| 3 a failed replace does not abort `attach` | **CLOSED.** `pod-runtime.ts:534-560`: re-probe `tentacle --version`, `serveBin = "tentacle"`, warning. Both cases tested: same protocol → attached with a warning (`pod-runtime.test.ts:980,1007`); another protocol → refused at `initialize` with the full container message (`:1027`); re-probe fails → the injection's error, no exec (`:1099`) | mutation: drop `serveBin = "tentacle"` in the fallback (exec by the half-written path) → `:980`, `:1007`, `:1027`, `:1067` **fail** (4) |
| 4 "container", not "pod" | **CLOSED for this task's new strings.** The `[pod <name>]` cause and `main.ts:573` `[pod] failed:` are shared with `run` and recorded as debt | checked by reading |
| 6 sanitise the stop notice | **CLOSED for `stoppedNotice` only** (`link-status.ts:71` `oneLine` + `STOP_NOTICE_MAX` 1000). **Other paths are not covered: see R2-1/R2-2** | mutation: `oneLine` → `replace(/\s+/g," ")` → the hostile-reason test **fails** |
| 7 the `last` guard | **CLOSED** (the twice-emitted App test; the executor's mutation is recorded, I did not repeat it) | — |
| 5 a stop before the App subscribes | **OPEN. It does not block the merge.** `onLinkStatus` does not replay (`remote-client.ts:381-384`). A post-mount stop needs a disconnect plus a backoff first, a pre-mount failure is printed by `main.ts` before Ink mounts, and the StatusBar still shows the state. Record it as debt (replay the current status on subscribe, or read `client.linkStatus` in the effect) | — |

Mutation run: the 4 mutations together → 6 failing tests across the 3 files
(54 pass); all were reverted. `shasum -c` over the 35 changed files: all OK.
`git status --short`: 35 entries, as before.

### New findings

- **R2-1 (Low-Medium; §7 "a pod is not trusted"; needs a fix): the
  replace-failed warning puts the container's raw stderr in the transcript.**
  `packages/cli/src/container-version.ts:55-69` (`replaceFailedWarning`)
  embeds `cause` without sanitising it. `cause` comes from
  `injectAgentBinary`'s error, which carries `install.stderr` /
  `version.stderr`, both written by the container (`pod-binary.ts:191-209`).
  `pod-runtime.ts:553` sends the warning through `deps.notify` into the
  TUI's `NoticeHub` → `appendNotice` (`tui/src/state.ts:114`) →
  `noticeLines` (`render-lines.ts:395`). None of those sanitises. This path
  is **new in follow-up 1**: before, a failed replace was thrown and printed
  before Ink mounted. Trace (`.tentacle/tmp/version-mismatch-notice/round2-trace.test.ts`)
  with a cause holding OSC/BEL/CSI/RLO:
  `warning has ESC: true BEL: true RLO: true` and
  `transcript notice has ESC: true`; the stop notice gives
  `stoppedNotice has ESC: false`. The repo's policy is that every daemon
  string goes through `oneLine` (MCP and skills panels, now the stop notice),
  and this path breaks it. Fix: run `cause` through the same `oneLine` + cap
  in `replaceFailedWarning`. The cli cannot import the TUI's `oneLine`, so
  either share it or sanitise at the `NoticeHub`/`appendNotice` boundary,
  which covers every notice at once. Add a test with a hostile stderr.
- **R2-2 (debt, already there before this task): daemon text written before
  Ink mounts is not sanitised.** `main.ts:239` `[connect error] ${message}`
  and `:573` `[pod] failed: ${message}` write the daemon's mismatch message
  (or a container's stderr) raw to the terminal. Ink does not own the
  terminal yet, so the "never write raw while Ink owns it" rule holds, but a
  hostile container can still send escape sequences to the user's terminal.
  The same holds for the piped `deps.log` lines and for the StatusBar
  `disconnected: ${reason}` (truncated, not sanitised). This task does not
  widen the problem much: it already showed the daemon's message there.
  Record it in `TODO.md` as a separate fix (sanitise once at the cli's
  write sink).
- **R2-3 (nit): the warning can name the wrong version.** If the rename
  succeeded and only the verify failed (for example a verify timeout), the
  re-probe can answer with the NEW binary. The warning still says
  "continuing with the container's tentacle `<had>`". It could name the
  re-probed version (`again.stdout`). Rare; not blocking.

### Attacks tried (round 2)

- **A `null` / non-object `data`** → counts as present, the daemon's words
  are shown (test covers `null`, `0`, `"later"`). **Holds.**
- **A run/attach daemon without a report** → container advice. `connect`
  keeps `serve` (the default). **Holds.**
- **A failed replace with a protocol skew** → refused at `initialize` with
  the daemon's full container message after the warning. Nothing runs
  silently, nothing is deleted. **Holds.**
- **A replace that left a broken binary** → the re-probe fails and the
  original error is rethrown, so the daemon is never exec'd from a broken
  path. **Holds.**
- **Hostile container stderr** → R2-1. **Fails.**

**How the executor behaved:** precise and honest. Every item was addressed
as briefed, the nuances (`null` = present, `run` gets the "attach again"
wording) are disclosed, red was shown, mutations are listed, and finding 5 is
declared open. The miss is the same class as round-1 finding 6, on a path
the follow-up itself created: the sanitising was applied where the review
pointed, not at the sink every notice shares.
