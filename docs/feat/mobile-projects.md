# feat/mobile-projects — a phone is paired per `serve` (project), and the app lists each paired project under its computer

> **Status:** implementation (plan written, **not approved**)
> **Branch:** `feat/mobile-projects` (this doc; umbrella if Owner Q11 = split: `feat/project-pairing` (a) then `feat/mobile-projects-app` (b))
> **Size:** L · **Blast:** load-bearing (device authorization model, on-disk registry + pairing-window formats, the relay dial gate, `tentacle pair` / `devices`, the `/e2e` route, the app's Keychain records and Computers screen) · **Suited:** a strong executor; mandatory fresh-context Review that red-teams "a pod is not trusted", "on-disk records are versioned separately", "protocol: one shared truth" and "don't serialize the RPC peer" (§7)
> **Changelog:** `changelog.d/mobile-projects.changed.md` — draft: `- **Pairing is per project.** \`tentacle pair\` pairs the phone with the \`serve\` of the folder it runs in, and only that one; the app lists each paired project under its computer with its own status. A \`serve\` with no paired device never dials the relay. \`tentacle devices\` groups by project, and \`revoke\` acts on one project. A phone paired before keeps working for the project it already used, with no re-pairing.`

## Context

*— claude-opus-5-5, 2026-11-20*

**The trigger (owner, 2026-11-20).** A second `tentacle serve` in `~/assistant`
(port 4001, relay on), next to the one in `~/tentacle` (port 4000): the phone
does not show it. Daemon-side discovery is done (`feat/sibling-discovery`,
merged `867cc497`: `<configDir>/daemons/<pid>.json`, `daemon/discover` +
`daemon/discovery`, `packages/client/src/discovery.ts`, `RemoteClient.discover`
`remote-client.ts:1322`), but the app never calls it: `apps/mobile/src/` has no
`discover(` call, and `computer-rows.ts:7-10` still says "one `serve` = one
project in 11a" — one row per computer, labelled by the last session's `cwd`.

**The owner decision this task serves (2026-11-20, overrides decision 7 of
`docs/eval/mobile-app.md:134-145`, `docs/feat/device-pairing.md` "one identity
and one registry per computer", and the device-facing half of
`docs/feat/sibling-discovery.md`):**

> "Ogni tentacle serve con relay ha bisogno dell'abbinamento all'app, niente
> discovery automatica delle altre sessioni: mi sembra più sicuro."

So:

- a phone reaches a `serve` (a project = a `cwd`) **only if it was paired to
  THAT serve** (`tentacle pair` run in that folder); a pairing in `~/tentacle`
  grants nothing on `~/assistant`;
- the app lists only the projects it is paired to — **no automatic discovery**
  of unpaired daemons;
- a `serve` with no device paired to IT never dials the relay;
- unpairing / revoking a project (from the phone or with `tentacle devices`)
  affects only that serve;
- today's already-paired phone keeps working on `~/tentacle` **without
  re-pairing**, and needs a pairing for `~/assistant`.

**Evidence: today every paired key is authorized on every `serve` of the
computer, every `serve` dials the relay, and one QR mixes every serve's
addresses.** Repro (2026-11-20, `bun .tentacle/tmp/mobile-projects/repro.ts`
from the worktree, Bun 1.4.3, `main` = `e5598d40`; imports by relative path
because the worktree has no workspace links):

```ts
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { DeviceAuthority, addDevice, loadOrCreateIdentity } from "../../../packages/daemon/src/index.ts";
import { generateStaticKeypair, systemRandom } from "../../../packages/transport/src/noise-channel.ts";
import { pairAddresses } from "../../../packages/cli/src/pair-addresses.ts";

const cfg = mkdtempSync(join(import.meta.dir, "cfg-"));
loadOrCreateIdentity(cfg, { name: "MacBook" });
const phone = generateStaticKeypair(systemRandom);
addDevice(cfg, { publicKey: phone.publicKey, name: "iPhone" }); // `tentacle pair` run in ~/tentacle
// Two serves of the same computer: ~/tentacle and ~/assistant. Neither knows its project.
const tentacle = new DeviceAuthority({ configDir: cfg });
const assistant = new DeviceAuthority({ configDir: cfg });
console.log("1. tentacle authorize:", JSON.stringify(tentacle.authorize(phone.publicKey)));
console.log("2. assistant authorize:", JSON.stringify(assistant.authorize(phone.publicKey)));
console.log("3. assistant wantsReachability (dials relay):", assistant.wantsReachability());
const qr = pairAddresses({
  records: [
    { pid: 1, host: "192.168.1.20", port: 4000, tls: false, cwd: "/u/tentacle", startedAt: 1, addresses: ["wss://relay.example/d/AAAAAAAAAAAAAAAAAAAAAA/e2e"] },
    { pid: 2, host: "192.168.1.20", port: 4001, tls: false, cwd: "/u/assistant", startedAt: 2, addresses: ["wss://relay.example/d/BBBBBBBBBBBBBBBBBBBBBB/e2e"] },
  ],
  interfaces: [],
});
console.log("4. one QR (pair in ~/tentacle) carries:", JSON.stringify(qr));
tentacle.stop(); assistant.stop();
```

```
1. tentacle authorize: {"kind":"device","id":"d54fc77f39b12a46","allow":true,"maxMessageBytes":33554432}
2. assistant authorize: {"kind":"device","id":"d54fc77f39b12a46","allow":true,"maxMessageBytes":33554432}
3. assistant wantsReachability (dials relay): true
4. one QR (pair in ~/tentacle) carries: {"ok":true,"addresses":["ws://192.168.1.20:4000/e2e","ws://192.168.1.20:4001/e2e","wss://relay.example/d/AAAAAAAAAAAAAAAAAAAAAA/e2e","wss://relay.example/d/BBBBBBBBBBBBBBBBBBBBBB/e2e"]}
```

(1)+(2): the key paired "in ~/tentacle" is a device on `~/assistant` too.
(3): `~/assistant` dials the relay because *some* device is in the
computer-wide registry. (4): `tentacle pair` puts every live serve's addresses
in one QR, so the phone's single record races both daemons and lands on
whichever answers first (`openComputer` → `firstAnswering(computer.addresses…)`,
`apps/mobile/src/connection.ts:325`). All three must change.

**Mockup** (gitignored, not committed):
`/Users/gmeghnag/tentacle/.tentacle/tmp/mobile-projects/mockups/index.html` —
"0 — oggi"; variant **A** (recommended: computer header + one row per paired
project in its band, "Pair a project on this Mac" as the band's last row);
**B** (flat "Projects" list); **C** (two levels, Computers → Projects); and for A:
a project appearing when its pairing completes, a stopped `serve`, a computer
offline, project → its session list, the pair flow on the Mac and on the phone,
an unpaired running `serve` NOT shown, a per-project revoke.

## Implementation

*— claude-opus-5-5, 2026-11-20*

### Load-bearing assumption

**The phone can keep ONE pinned computer key and reach each project with a
project's OWN device key, because device authentication is decided per socket by
`authorize(remoteStatic)` in the one `serve` that socket reached, before any RPC
frame exists — so scoping the registry entry to a project, and checking that
scope in that serve's `DeviceAuthority`, makes "paired to this serve" true
without re-pairing the existing phone and without a second session path.**

Proof, in the code as it stands:

1. **One computer identity, shared, read by every serve.** `serve` builds its
   authority from `config.configDir` (`packages/cli/src/serve.ts:671-691`:
   `loadOrCreateIdentity(configDir, …)` then `new DeviceAuthority({ configDir })`);
   `configDir` never depends on `cwd` (`sibling-discovery.md` load-bearing proof,
   `packages/config/src/load.ts:497-508`). The phone pins THAT key per record
   (`computer-store.ts:44-45` `computerKey`, `connection.ts:234-240`
   `pinnedKey`) and the pairing result names it (`pairing-handler.ts:192-206`:
   `computer.id = deviceIdOf(identity.publicKey)`). **So the identity can stay
   per computer**: the phone authenticates the computer exactly as today, for
   every project.
2. **Authorization is one function, per serve process, per socket.**
   `DeviceAuthority.authorize` (`device-authority.ts:161-180`) is the only
   verdict: known key → `device`; unknown + a live window → `pairing`; else
   deny. It runs inside the serve the socket reached (the `/e2e` route,
   `ws-server.ts:323`; the relay accept legs use the same authority,
   `serve.ts:1019-1033` `authority: devices`). Each serve has its own instance
   (one per process). **So adding "and the entry's project is mine" to that one
   function scopes every path** (direct and relay) at once.
3. **The relay gate and push already go through the same authority.** The link
   dials only while `authority.wantsReachability()` (`relay-link.ts:512`,
   `device-authority.ts:194-203`: `devices.size > 0 || hasWindow()`); push
   registrations are filtered by the authority snapshot (`push-notifier.ts:75-82`).
   **So a scoped snapshot makes "a serve with no device paired to IT never dials
   the relay" and "it pushes only to its own devices" fall out**, with no change
   in `relay-link.ts` or the notifiers.
4. **The device key is already per pairing on the phone.** `StoredComputer.deviceKey`
   is "this phone's private static key FOR THIS computer (Owner Q2)"
   (`computer-store.ts:63-65`), generated fresh by each pairing
   (`pairing-flow.ts:483-509` `keypair` → `store.add(record, privateKey)`). Making
   it "FOR THIS project" is a change of the record's KEY (computer → computer +
   project), not of the dial path: `openComputer(stored)` takes one record and
   dials its addresses with its key (`connection.ts:252-330`) — a project record
   is dialled by the very same function. **No re-pairing of the existing phone:**
   its record keeps its key and its id; the daemon binds that key's legacy entry
   to the project it first connects to (Design §3).
5. **Each serve already has its own stable public id and relay address.** The
   relay secret lives in the project's store (`relay-secret.ts:9-13`: "a
   different `cwd` gets its own (one address per daemon)"), the store is
   `<configDir>/daemon/<projectKey(cwd)>/` (`serve.ts:193`, `:530`), and the relay
   address is `/d/<relayIdOf(secret)>/e2e` (`serve.ts:986-989`,
   `protocol/src/relay.ts:532-541`). **So a project's relay address already names
   exactly one serve**; only the direct address (`ws://host:port/e2e`) does not.

What is NOT proven by reading and is the executor's first red test: that a
`pairing` verdict for an already-known key on another project's serve is safe
(it is the key that is unknown *to this project*, so the existing pairing-only
`Connection` gate applies unchanged — `device-pairing.md` Design "`Connection`
(9b/9c, minimal)").

### Preconditions

- **P1 — `authorize` stays side-effect free** (it runs on every replayed Noise
  message 1, `device-pairing.md` P2; `device-authority.ts:155-160`). Anything
  that WRITES (legacy adoption, §3) happens on the resolve, where a handshake
  really completed — the route already touches `seen/` there.
- **P2 — the registry has one writer: the CLI** (`pair` accept, `revoke`,
  `reset`) under `registry.lock` (`device-pairing.md` Design table;
  `device-store.ts:464,515,567`). Serves only read it. This plan keeps that: the
  only daemon-written file is the legacy adoption record, created exclusively
  (`wx`, the `claimPairing` precedent, `device-store.ts:921-966`).
- **P3 — on-disk records are versioned apart from the wire, and an unknown
  version is refused, never written** (AGENTS §7; `readRegistry` refuses
  `v !== DEVICE_STORE_VERSION`, `device-store.ts:412`; `readSession` ignores an
  unknown `v`, `:797-799`). A **v2** registry and **v2** pairing window are
  therefore read by an older build as "refused" (registry → deny everyone, fail
  closed; window → no window) — the safe direction (Failure modes F9).
- **P4 — a serve knows its project.** `config.cwd` and `projectKey(cwd)` are in
  scope where the authority is built (`serve.ts:584-585`, `:671-691`);
  `projectKey` = `<basename>-<sha256(realpath)[:12]>`
  (`agent/src/session-store.ts:151-160`), and one serve per project is enforced
  by the store lock (`sibling-discovery.md` P8).
- **P5 — the relay link re-checks `wantsReachability` on every attempt**
  (`relay-link.ts:226-230,510-512`), so a window opened later in that project
  starts the dial, and a revoke of the last device stops it.
- **P6 — `daemon/discover` is per connection and synchronous**
  (`connection.ts:611-621`); the connection knows its principal
  (`ConnectionOptions.principal`, used at `connection.ts:529-533`). Filtering the
  snapshot by principal is local to that method — no lock, no await (§7 "don't
  serialize the RPC peer").
- **P7 — strip schemas, unknown pairing-payload params ignored.**
  `DevicePairResultSchema` is a plain `z.object` (`protocol/src/device.ts:55-58`:
  an unknown field is dropped on parse by an older client); the payload parser
  ignores unknown params (`protocol/src/pairing.ts:15,194`). Additive fields cost
  no `PROTOCOL_VERSION` bump.
- **P8 — the device route matches one exact path** (`ws-server.ts:92-93`
  `DEVICE_ROUTE = "/e2e"`, `:323` `pathname === DEVICE_ROUTE`) and any other path
  is refused before upgrade — a 404 is not a Noise verdict, so the phone's
  diagnosis cannot read it as `revoked` (`link-diagnosis.ts:1-17`).
- **P9 — pods never see the config dir** (`workspace-mount.ts:709`,
  `device-pairing.md` P4): every new file is under `<configDir>/devices/` or the
  project store, both hidden from a mounted workspace. Device routes exist only
  on `serve` (`device-pairing.md` P3).
- **P10 — the app's view logic lives in pure modules** (`computer-rows.ts`,
  `computer-status.ts`, `session-list.ts` are React-free and unit-tested; the
  screen maps rows to elements, `ComputersScreen.tsx:72-245`).

### Design

#### 1. What moves (daemon side)

| Today | After |
|---|---|
| identity: one per computer (`devices/identity.json`) | **unchanged** (Owner Q2) |
| registry `v1`: `{ id, name, publicKey, pairedAt }`, every entry valid on every serve | registry **`v2`**: same + `project?: { key, cwd }`. An entry WITH `project` is valid only on the serve whose `projectKey(cwd)` equals `key`. An entry WITHOUT it is a **legacy** entry (only ever produced by reading a v1 file) → §3 |
| pairing window `v1` `{ sid, codeHash, expiresAt, pid }`, seen by every serve | window **`v2`**: + `project: { key, cwd }`; only that project's serve treats an unknown key as `pairing`, and `claimPairing` / `PairHandler` refuse a window of another project (`invalid_code`, no oracle) |
| device key on the phone: one per computer | **one per project** (each pairing makes a new key → a new registry entry) (Owner Q1) |
| relay id / relay address | **unchanged** — already per project (Proof 5) |
| direct address `ws://host:port/e2e` | **`ws://host:port/s/<serveId>/e2e`**, `serveId` = the project's relay id (Owner Q5). `/e2e` keeps working for legacy records |
| `daemon/discover` to a device: self + siblings | **self only** (address refresh); a token client: unchanged (Owner Q4) |
| `wantsReachability`: any device or any window on the computer | any device **of this project** or a window **of this project** (falls out of the scoped snapshot) |
| `tentacle pair`: QR = every live serve's addresses | QR = **only the serve of the folder it runs in** (`--project <dir>` to name another), + `p=<label>`; no live serve there → refuse, exit 1 (Owner Q6) |
| `tentacle devices` / `revoke` | grouped by project; `revoke` acts on one project (Owner Q7) |
| `devices reset` | **unchanged**: computer-wide (new identity + empty registry) (Owner Q13) |

Versions (P3): `REGISTRY_VERSION = 2` and `PAIRING_SESSION_VERSION = 2` become
their own constants; `identity.json`, claim, decision and `seen/` stay at
`DEVICE_STORE_VERSION = 1` (unchanged shapes; bumping them would make an older
build refuse the identity for no reason). The v2 registry is written only by the
new CLI (first `pair` / `revoke` after the upgrade); until then the v1 file is
read by the new build as "all entries legacy".

`dedupeName` (`device-store.ts:545`) dedupes **within a project**: the same
phone is "iPhone di Gabriel" in every project, never "(2)".

#### 2. `DeviceAuthority` (the one verdict)

`new DeviceAuthority({ configDir, project: { key, cwd } })` (the cli passes
`projectKey(config.cwd)` and `config.cwd`). The snapshot's `devices` becomes the
set of ids **valid here**:

- v2 entry with `project.key === mine` → valid;
- legacy entry → valid iff its adoption record (§3) names my key, **or** it has no
  adoption record yet (then the verdict is `device` with `adopt: true`, and the
  route adopts on resolve);
- anything else → not valid (an entry of another project is, to this serve, an
  unknown key).

`authorize`: valid → `device`; else a live window **of my project** → `pairing`;
else deny. `wantsReachability`: valid devices > 0 (**legacy entries not yet
adopted do NOT count** — else every serve would keep dialling the relay for a
phone that will never come, which is exactly the owner's complaint) or a window of
my project. `knows(id)`: valid here. The poll's "close live sockets whose id is
gone" compares against the scoped set, so a revoke of project P closes only P's
sockets on P's serve (on Q's serve that id was never live).

`hasLivePairing(configDir, { project })` filters by project; it stays a pure
read (P1).

#### 3. The already-paired phone (migration, no re-pairing)

The owner's phone holds ONE record (id = computer id, its key) whose addresses
came from a QR printed while `~/tentacle` was the serve(s) running
(`pairAddressesOf` reads live records, `pair.ts:166-186`). On the new build its
registry entry is **legacy**. Rule (Owner Q3): **a legacy entry is adopted by the
first project whose serve completes a device handshake with it, and by that one
only.**

- On the resolve of a `device` verdict with `adopt: true`, the route calls
  `adoptLegacy(configDir, id, project)` = exclusive create (`wx`) of
  `devices/adopted/<id>.json` `{ v: 1, project: { key, cwd }, at }`.
  - created, or EEXIST naming my project → proceed (a normal device connection);
  - EEXIST naming another project → **close the socket at once** (before any
    RPC frame is dispatched: the `Connection` is built after this check), audit
    `legacy-device-bound-elsewhere <id8> <project>`; later dials are denied by
    `authorize` (the snapshot now sees the record).
- The phone's record only knows `~/tentacle`'s addresses, so in practice
  `~/tentacle` adopts it — it keeps working, no re-pairing — and `~/assistant`
  denies it (its key is unknown THERE), so `~/assistant` needs `tentacle pair`.
- A race (two serves resolve the same legacy key at once — only possible if the
  old QR carried both serves' addresses) has one winner by `wx`; the loser's socket
  closes; the phone's `firstAnswering` already raced and kept one. The person then
  pairs the other project.
- `revoke` removes the adoption record with the device (`removeDevices` already
  drops `push/<id>.json` and `live/<id>.json`, `device-store.ts:656-657`).
- `tentacle devices` shows a legacy entry under its adopted project, or under
  "Not yet used (paired before per-project pairing — binds to the first project
  it connects to)".
- On the phone, the legacy record keeps its id; when it connects, the app calls
  `daemon/discover`, reads `self.cwd`, and writes `project` into that record
  (§6), so it is grouped like any other project record.

Why not "first `serve` start adopts" or "all live projects adopt": the daemon
cannot know which project the phone used except by the phone actually using it;
adopting at handshake is the one rule backed by an event, and it never widens
access beyond one project.

#### 4. Wire (protocol) — additive, no `PROTOCOL_VERSION` bump

- `DevicePairResult` gains **`project?: { key: string ≤ 128, cwd: line(4096), label: line(64) }`**
  (strip schema; older client drops it — P7). Always sent by the new daemon.
- `DevicePairParams` gains **`perProject?: true`**. A new daemon **refuses a pair
  without it** with `PairingRefused{ reason: "update_app" }` (Owner Q9): an older
  app would store the new pairing under the computer id and **overwrite** its
  existing record (`pairing-flow.ts:496-509`, re-pair keeps the id), losing the
  key of the project it already had. An unknown `reason` already shows as a
  generic refusal on an older app (`device-pairing.md` "Protocol"). An older
  daemon drops the field (strip) and pairs computer-wide, as today.
- Pairing payload gains **`p=<label>`** (≤ 64, `line`); ignored by an older app
  (P7). The phone shows it before the human answers, and refuses (saves nothing)
  when `result.project.label` disagrees.
- `daemon/discover` / `daemon/discovery`: **same schema**; to a `device`
  principal the snapshot is `{ rev, daemons: [self] }`. A pre-existing app never
  called it; `connect` (token) keeps the full list.
- Direct address `ws(s)://host:port/s/<serveId>/e2e`: it still ends in `/e2e`,
  so `isPairingAddress` (`protocol/src/pairing.ts:122`) and `MAX_PAIRING_ADDRESSES`
  hold unchanged; a test pins it.

No `protocol.d/` note: nothing changes meaning for a peer that does not use the
new fields — an older app + newer daemon fails cleanly at `device/pair`
(`update_app`), an older daemon + newer app pairs computer-wide (F10). If Review
finds a non-additive change, it gets a `protocol.d/<slug>.md` note; the number is
never edited on the branch. `protocol.json` regenerated with
`bun run schema:export` (drift test).

#### 5. Daemon route + `serve` + CLI

- `ws-server.ts`: the device route matches `/e2e` **and** `/s/<serveId>/e2e`; a
  `/s/<other>/e2e` → **404 before upgrade** (P8) — a stale direct address that now
  lands on another project's serve reads as "not here", never as a Noise
  `denied` → `revoked`. `/e2e` stays (legacy records, and `pair --address` URLs a
  person typed).
- `serve.ts`: the relay secret (= `serveId`) is read/created **whether or not the
  relay is on** (a local file in the project store, under the store lock; no
  relay contact — `relay-secret.ts` is already per store); the daemon record's
  own addresses use the `/s/<serveId>/e2e` form; `DeviceAuthority` gets
  `{ key: projectKey(cwd), cwd }`; `PairHandler` gets the same project.
- `pair.ts`: resolve the target project = `--project <dir>` else `process.cwd()`
  (realpath, `projectKey`); pick the **live** daemon record whose `projectKey(cwd)`
  matches (freshest by heartbeat if several, `sibling-discovery` freshness);
  none → `No \`tentacle serve\` is running in <dir> — start it there first, then
  run \`tentacle pair\` again.` exit 1. QR addresses = that record only (+
  `--address`), `p=<basename(cwd)>`. The window is written with the project. The
  prompt names it: `Add 'iPhone di Gabriel' to project assistant? It must show
  482 913. [y/N]`. `addDevice` writes `project`.
- `devices-cmd.ts`: list grouped by project (cwd + label), legacy group as in §3;
  a running serve with no device gets one dim line ("… running with no paired
  device (relay not dialled)") from the live records. `revoke <name|id-prefix>`:
  scope = `--project <dir>`, else the cwd's project if it has a match, else a
  computer-wide match only if it is unique; ambiguous → refuse, listing
  `project · name · id8` (Owner Q7). `--all-projects` revokes every entry of that
  name.

#### 6. App (pure modules first; components only render)

- **Record** (`computer-store.ts`): `PairedComputer` gains optional
  `computerId` (absent = `id`, a legacy record), `project?: { key, cwd, label }`.
  New records' id = `projectRecordId(computerId, projectKey)` =
  `${computerId}.${hex16(sha256(projectKey))}` (Keychain-safe). Optional fields
  → `STORE_VERSION` stays 1 (the `thisDeviceName` precedent, `computer-store.ts:49-57`);
  an older app reading a new record sees a "computer" per project — harmless.
  New `setProject(id, project)` (refused for an unlisted id, like `setPush`).
- **Pairing** (`pairing-flow.ts`): sends `perProject: true`; on success stores
  under `projectRecordId(result.computer.id, result.project.key)` (a re-pair of
  the SAME project replaces — Owner Q7 of 11b — another project adds); an old
  daemon's result without `project` → stored as today (id = computer id).
  `p=` ≠ `result.project.label` → failure "This code is for 'X'", nothing saved.
- **View-model** (new pure `project-rows.ts`, replacing `computerRows`'s 1:1
  mapping; `computer-rows.ts` keeps the per-record probe/diagnosis decision):
  `projectSections(records, probes, diagnoses, now)` →
  `[{ computerId, name, state: online|offline|attention, running, total, rows: ProjectRow[] }]`.
  - group by `computerId ?? id`, order = Keychain index order (rows never move
    when a state changes);
  - `ProjectRow = { id, label, cwd?, state, word, count }`, `state` ∈
    `working | idle | new | stopped | unreachable | revoked | maybe-reset | broken`;
    `word` is the WRITTEN status (colour-blind rule): Working / Idle / New /
    Stopped / Not reachable / Access removed / Needs pairing again / Saved key damaged;
  - `working` = some entry of the probe is running a turn; `new` = 0 sessions;
  - `stopped` vs `unreachable`: `stopped` iff another project of the same computer
    answered, or the dial saw the relay's `4404` (no daemon registered for that
    id, `mobile-relay.md` F2); else `unreachable`;
  - section `state`: `online` if ≥1 row answered; `attention` if every row is
    revoked/maybe-reset/broken; else `offline`; `running/total` → "2 of 3
    projects running" (only when total ≥ 2);
  - a legacy record's label: `project.label`, else `projectLabel(entries)` as
    today (`session-list.ts`).
- **Link diagnosis** (`link-diagnosis.ts`): a relay close `4404` (the stream opened,
  then closed before the handshake) is a new observation `absent` that does NOT
  count toward `MAYBE_RESET_STREAK` (`link-diagnosis.ts:34`) — today 3 polls of a
  stopped project over the relay would read as "maybe reset". The executor first
  checks that the close code reaches `openComputer`'s `confirm` error (test).
- **Address refresh**: after each successful dial, `client.discover()` (MethodNotFound
  → nothing); `self.addresses` folded into the record with the existing pure
  `discovery.ts` retention rules (announced first, known kept 30 days); `self.cwd`
  fills `project` on a legacy record. One write per change, not per dial.
- **Live behaviour**: a stopped/unreachable project is re-probed every 15 s while
  the Computers screen is foreground, and on app foreground (Owner Q12); a newly
  paired project is inserted when the pairing flow resolves (`onPaired`) and
  marked "Paired just now" for 4 s (pure `justPaired(id, now)`).
- **Screen** (`ComputersScreen.tsx`, variant A): per section the existing header
  (name + dot + word + "· N of M projects running"), a band with one `Row` per
  project (folder / dashed folder when not ok, title, footnote sub-line = dot +
  word + count, chevron), then "Pair a project on this Mac" (opens an instruction
  sheet → scanner). Tap = open its session list (or retry, when not ok); long-press
  / … = project sheet: Try again · Pair again · Remove "<label>" from this iPhone
  (local only, Owner Q8). The bottom footnote becomes: "Run `tentacle pair` in a
  project's folder. Only the projects you pair show up here." The session list
  title = project label, subtitle = computer · cwd.

#### 7. Docs this task updates (on its branch)

`docs/eval/mobile-app.md` decision 7 (a dated "superseded by owner 2026-11-20 —
see docs/feat/mobile-projects.md" note, original text kept), `device-pairing.md`
Context decision 7 and Design table (same note), `sibling-discovery.md` (device
principals get self only), `README`/`ARCHITECTURE.md` lines on pairing if any
say "per computer" (`rg -n "per computer|every daemon of" README.md ARCHITECTURE.md docs/feat`).

### Files

Dependency order (protocol → daemon → client → cli → app):

1. `packages/protocol/src/device.ts` (`project?` on the result, `perProject?` on
   params, `update_app` reason), `pairing.ts` (`p` param), tests; `schema/protocol.json`
   via `bun run schema:export`.
2. `packages/daemon/src/device-store.ts` (registry v2 + `project`, window v2 +
   `project`, `hasLivePairing({project})`, `claimPairing` project check,
   `adoptLegacy` / `readAdoption`, `removeDevices` drops adoption, per-project
   `dedupeName`), `device-authority.ts` (project option, scoped snapshot,
   `adopt` verdict), `device-accept.ts` / `ws-server.ts` (`/s/<id>/e2e`, 404 on
   mismatch, adopt on resolve), `pairing-handler.ts` (project in result, window
   project check, `perProject` gate), `connection.ts` (`discover` filters to self
   for a device principal), `discovery` source exposes `self`.
3. `packages/client/src/pairing.ts` (`perProject: true`, `p` surfaced to `onCompare`).
4. `packages/cli/src/serve.ts` (project into authority/handler, serve id always,
   `/s/<id>/e2e` in the record), `pair.ts` + `pair-addresses.ts` (project
   target, one record, refusal), `devices-cmd.ts` (grouping, scoped revoke),
   `flags.ts` (`--project`, `--all-projects`).
5. `apps/mobile/src/computer-store.ts`, `computers.ts`, `pairing-flow.ts`,
   `link-diagnosis.ts`, new `project-rows.ts`, `computer-rows.ts`,
   `computer-status.ts`, `session-list` caller (title/subtitle),
   `screens/ComputersScreen.tsx`, the screen's controller (probe per record,
   15 s re-probe, discover fold), `pair-copy.ts`.
6. `apps/mobile/e2e/flows/` + `e2e/pair-cli.ts` (cwd/project option), docs (§7),
   `changelog.d/mobile-projects.changed.md`.

### Failure modes

| # | Case | Design answer | Converges to |
|---|---|---|---|
| F1 | A project's `serve` stops | its socket drops; the row's probe fails; another project answers or the relay says `4404` → `Stopped` (greyed, dashed folder, word written); not counted as maybe-reset | re-probe every 15 s / on foreground → back to Idle/Working by itself (mockup A2) |
| F2 | It restarts on another port / the LAN IP changes | the relay address is stable (per-project secret); the direct `/s/<id>/e2e` of the old port 404s (never `revoked`); after any successful dial `discover` self refreshes the addresses (`discovery.ts` retention) | reachable again with no re-pairing |
| F3 | Another project's serve now holds the old port | `/s/<otherId>/e2e` → 404 before upgrade: "not here", next address | never mis-authenticated, never `revoked` |
| F4 | The serve that used to announce siblings is down but a sibling is up | moot: no project depends on another for addresses — each record dials its own | each row independent |
| F5 | Two computers | sections keyed by `computerId`; same folder name on two Macs = two rows under two headers; identities differ | — |
| F6 | Stale daemon records (`daemons/<pid>.json` of a crashed serve, pid reused) | `pair` picks a record by project only among live+fresh records (`sibling-discovery` heartbeat freshness); no live one → refuse with the start hint | `pair` never prints a dead serve's addresses |
| F7 | A project with zero sessions | row "New · no sessions yet"; its session list shows only "New session" | — |
| F8 | Older daemon (no discovery, no per-project) | `discover` → MethodNotFound → keep stored addresses; `device/pair` result without `project` → record stored computer-wide (today's behaviour) | works as today, one row |
| F9 | Mixed builds on one computer (an old `serve` still running after the CLI wrote registry v2) | the old build refuses v2 (P3): denies every device, `wantsReachability` false → stops dialling the relay; one audit line | fail CLOSED; restart that serve with the new build (documented in the changelog) |
| F10 | Older app + new daemon | `device/pair` without `perProject` → `PairingRefused{update_app}`; the old app shows its generic refusal | nothing overwritten; update the app |
| F11 | Legacy key reaches a second project first (old QR had both addresses) | `wx` adoption: one winner; the loser's socket closes before any frame; `tentacle devices` shows where it is bound | the person pairs the other project |
| F12 | `pair` in project P while a phone dials project Q | Q's authority sees no window of Q → deny; P's window is invisible to Q; a claim on a window of another project → `invalid_code` | single-use code cannot be spent cross-project |
| F13 | Revoke in P while the phone is live on P and Q | P's poll closes P's sockets only (scoped snapshot); Q's key is a different entry | P row → "Access removed" + Pair again / Remove; Q unaffected (mockup A7) |
| F14 | Remove project from the phone | Keychain item + index entry of that record only (existing crash-safe order) | the Mac keeps the entry until `revoke` (footnote says so) |
| F15 | `devices reset` | new identity + empty registry + adoption records cleared (computer-wide, unchanged) | every project row → "Needs pairing again" |
| F16 | Unreadable / unknown-version registry or adoption record | registry: deny all (unchanged F14 of 9a); an unreadable adoption record = "bound elsewhere" (deny), never rewritten | fail closed; human fixes or `devices reset` |
| F17 | The phone's `p=` and the daemon's project disagree (a QR for another folder / tampered paste) | the app refuses and saves nothing; the SAS still guards the key exchange | nothing stored |
| F18 | Pod / workspace process | every new file is under `<configDir>` (hidden from mounts, P9); device routes exist only on `serve` | unchanged trust boundary |

### Tests

Red first for each property; the mutation named is the one that must turn it red.

**protocol** — `DevicePairResult` with/without `project` parses; an older
schema (copy) strips it; payload `p=` round-trip, absent `p` ok, a control char
refused; `/s/<id>/e2e` passes `isPairingAddress` and a sample set agrees.

**daemon** (`device-store.test.ts`, `device-authority.test.ts`, route tests with
the existing fakes):
- a key paired to P: `device` on P's authority, **deny** on Q's (mutation: skip
  the project comparison) — this is the repro's (1)+(2) turned into an assertion;
- a window of P: `pairing` on P, deny on Q (mutation: unfiltered `hasLivePairing`);
- `wantsReachability`: false on Q with a device on P; false with only an unadopted
  legacy entry; true with a window of Q (mutations: count all devices; count
  legacy);
- legacy: v1 file → all legacy; first resolve on P creates `adopted/<id>.json`;
  Q then denies; the same key resolving on P and Q concurrently → exactly one
  adoption, the loser's socket closed before any frame (mutation: `w` instead of
  `wx`); adoption happens on RESOLVE, not on `authorize` (a replayed message 1
  alone writes nothing — mutation: adopt in `authorize`);
- v2 registry round-trip; unknown `v: 3` refused and untouched; an old-build
  reader (v1 constant) refuses v2 (fail closed);
- `claimPairing` / `PairHandler`: a window of another project → `invalid_code`;
  pair without `perProject` → `update_app`; the result carries `project`;
- route: `/s/<mine>/e2e` handshakes, `/s/<other>/e2e` → 404 before upgrade,
  `/e2e` still works (mutation: accept any `/s/*`);
- `daemon/discover` from a device principal → only `self`; from a token → all
  (mutation: no principal filter);
- revoke of P closes P's live socket and not Q's; push to Q's device is not sent
  by P's notifier (`knows` scoped).

**cli** (`pair.test.ts`, `devices-cmd.test.ts`, `pair-addresses.test.ts`):
`pair` in P prints only P's addresses (the repro's (4) inverted — mutation: all
records) and `p=<label>`; no live serve in the folder → exit 1 with the hint;
`--project <dir>`; prompt names the project; `addDevice` writes `project`;
`devices` grouping incl. legacy group and the "no paired device" line; `revoke`
scoping (cwd default, ambiguous refusal, `--all-projects`).

**app** (pure, `bun test apps/mobile/test/…`):
- `project-rows.test.ts`: grouping by computer; Keychain order kept when states
  change (mutation: sort by state); written word for every state; `stopped` vs
  `unreachable` (sibling answered / 4404 / neither); section state + "N of M"
  only for M ≥ 2; zero sessions → `new`; legacy label fallback;
- `computer-store.test.ts`: two project records of one computer coexist; re-pair
  of the same project replaces; legacy record (no `computerId`/`project`) still
  reads; `setProject` refused for an unlisted id;
- `pairing-flow.test.ts`: `perProject: true` sent; record id = `projectRecordId`;
  old-daemon result → computer id; `p` mismatch → failure, store untouched
  (mutation: save before the check);
- `link-diagnosis.test.ts`: three `4404`s → not `maybe-reset` (mutation: count
  `absent`);
- discover fold: `self.addresses` merged by `discovery.ts` rules; `self.cwd` fills
  a legacy record's `project` once.

**E2E** (`bun run e2e:mobile`, Maestro; the harness already starts real
`serve`s, `e2e/flows/05-start-serve.js`, and pairs in-process, `e2e/pair-cli.ts`):
new flow `NN-projects.yaml` with **two serves in two temp cwds sharing one config
dir**: pair A (pair-cli with `cwd: A`) → Computers shows A only while B runs (no
B row) → pair B → B row appears under the same computer → stop B → B "Stopped",
A unaffected → start B → B back → `revoke` in A → A "Access removed", B online →
open B → its (empty) session list with "New session". Plus a legacy-migration
flow: seed a v1 registry + a legacy phone record for A, start both serves →
A opens with no pairing, B absent.

**Gate before done:** `bun run check` (typecheck → lint → test) green, lint
baseline clean (AGENTS §6), `bun run e2e:mobile` (decision 20).

### Owner questions

**Owner answers (20/11): ALL recommendations accepted** — Q1 one key per project · Q2 identity per computer · Q3 adoption at first connection · Q4 discover self-only for devices · Q5 `/s/<serveId>/e2e` · Q6 `pair` targets its folder, refuses without a serve · Q7 revoke scoping as proposed · Q8 Remove = local only · Q9 refuse old app (`update_app`) · Q10 variant A · Q11 split: (a) `feat/project-pairing` (protocol + daemon + CLI) then (b) `feat/mobile-projects-app` (app + E2E) after (a) merges · Q12 15 s + on foreground · Q13 `devices reset` stays computer-wide. Implementation APPROVED.

1. **Phone device key: one per project** (each `tentacle pair` makes a new key
   and a new registry entry bound to that project), or one key per computer with
   a list of projects on its entry? *Recommendation: one per project* — revoke /
   remove / push stay "one entry = one key = one serve", a key leaked from one
   project's record opens nothing else, and the daemon store code barely changes
   (`addDevice` + a field).
2. **The computer identity stays per computer** (one Noise key in
   `devices/identity.json` for every serve), not per serve? *Recommendation: keep
   it per computer* — every serve shares the same config dir and uid, so per-serve
   keys add no isolation, and changing them would invalidate today's phone
   (and the push/Live Activity sealing that uses the identity).
3. **Migration of today's phone:** a legacy entry is **adopted by the first
   project it completes a handshake with** (exclusive, once), or an explicit
   `tentacle devices adopt <dir>`, or re-pair everything? *Recommendation:
   adoption at first connection* — `~/tentacle` keeps working with zero steps,
   `~/assistant` needs a pairing, and it never grants more than one project.
4. **`daemon/discover` for a phone:** keep it as **self-only** (the daemon's own
   current addresses — decision 3's "addresses may change, no re-pairing") or drop
   it for devices? *Recommendation: self-only*; siblings stay for token clients
   (`connect`).
5. **Direct addresses name their serve** (`ws://host:port/s/<serveId>/e2e`,
   serveId = the project's relay id, created even with the relay off)?
   *Recommendation: yes* — otherwise a port reused by another project's serve
   makes the phone show "Access removed" for a project that was only restarted.
6. **`tentacle pair` targets the folder it runs in** (`--project <dir>` to name
   another) and refuses when no `serve` runs there? *Recommendation: yes*.
7. **`tentacle devices revoke`:** scope = `--project <dir>`, else the current
   folder's project, else a unique match; ambiguous → refuse with the list;
   `--all-projects` for "this phone everywhere"? *Recommendation: yes.*
8. **"Remove from this iPhone" on a project:** local only (as today, Q5 of 11b),
   or also revoke itself on the Mac (a new `device/unpair` the daemon would have
   to write to the registry — a second registry writer)? *Recommendation: local
   only* for this task; the sheet says how to revoke on the Mac.
9. **Older app + new daemon:** refuse the pairing (`update_app`) rather than let
   the old app overwrite its existing record? *Recommendation: refuse.*
10. **Variant:** A (computer header + one row per paired project), B (flat
    "Projects"), or C (two levels)? *Recommendation: A.*
    **Owner (20/11): A.** Mockup: https://claude.ai/artifact/4SieEVXHnqma7mxDjEDXqS
11. **Split** into (a) `feat/project-pairing` — protocol + daemon + CLI (L,
    load-bearing) — then (b) `feat/mobile-projects-app` — app + E2E (M,
    cross-module), this doc as umbrella (the device-pairing precedent)?
    *Recommendation: yes*; (b) starts after (a) merges.
12. **Re-probe cadence** of a stopped / unreachable project while the Computers
    screen is visible: 15 s, plus on app foreground? *Recommendation: 15 s.*
13. **`tentacle devices reset` stays computer-wide** (new identity, every project
    must be paired again)? *Recommendation: yes* — it is the "my Mac's key
    leaked" button; a per-project reset is `revoke`.

## Execution

### (a) feat/project-pairing

*— deepseek (the `tentacle --profile deepseek` executor, per commit `1f6ce6f8`), 2026-11-20* — signature corrected in fix round 1 (review F3): it read `claude-opus-5-5`, which did not write this section.

**Load-bearing check, re-run first: HOLDS.** The Context repro, re-pointed at
this worktree (`.tentacle/tmp/project-pairing/repro.ts`), gave the same four
lines on the base commit (P-key `device` on both serves, `assistant`
`wantsReachability: true`, one QR with both serves' addresses). That is the
red baseline. `authorize` is the only verdict, it runs per socket in the serve
that socket reached, and the direct route and the relay route both call the
same `acceptDevice` (`ws-server.ts`, `relay-link.ts:769`), so scoping that one
function scopes both.

**As built, in dependency order:**

1. **protocol.** `device.ts`: `DevicePairParams.perProject?: true`,
   `DevicePairResult.project?: {key ≤128, cwd line(4096), label line(64)}`
   (strip schemas), and the `update_app` reason. `pairing.ts`: optional `p=`
   (parse + format; an invalid one is refused as `name`, so no new refusal
   kind). `schema/protocol.json` regenerated (`bun run schema:export`; the
   drift test is green). No `protocol.d/` note: the changes are additive.
2. **daemon store** (`device-store.ts`). `REGISTRY_VERSION = 2` (reads v1+v2,
   writes v2; a legacy entry stays without `project` across a rewrite; a v1
   file that carries a `project` is malformed). `PAIRING_SESSION_VERSION = 2`
   (the window carries `project`). `findPairing` / `hasLivePairing` /
   `claimPairing` take a **required** project key. Adoption API:
   `adoptLegacy` / `readAdoption` / `readAdoptions` / `clearAdoptions` under
   `devices/adopted/<id>.json`. `removeDevices` drops the adoption,
   `dedupeName` dedupes within a project, `addDevice` writes `project`, and
   `DaemonRecord.serveId?` is added.
3. **daemon authority** (`device-authority.ts`). A `project` option is
   required. The snapshot holds `devices` (mine, plus legacy entries adopted by
   me) and `adoptable` (legacy, no adoption yet → `device` with `adopt: true`).
   `wantsReachability` and `knows` count only `devices`. The stamp includes the
   `adopted/` dir. The poll keeps `adoptable` sockets alive.
4. **daemon route.** `device-accept.ts` adopts on the RESOLVE, before
   `new Connection`; if another project won, the audit line is
   `legacy-device-bound-elsewhere <id8> <key>` and the channel closes.
   `pairing-handler.ts`: the `perProject` gate (`update_app`, spends no
   attempt), project-scoped find/claim/`registryHas`, `project` in the result,
   and a shared `projectLabel()`. `ws-server.ts`: a pure `deviceRouteOf()`;
   `/s/<other>/e2e` → 404 before the limiter. `connection.ts`:
   `daemon/discover` returns self only to a `device` principal (snapshot and
   notifications).
5. **client** (`client/src/pairing.ts`). `perProject` is an option, and
   `onCompare` gets `info.project` (the `p=` label). The `update_app` copy is
   added.
6. **cli.** `serve.ts`: the authority gets `{projectKey(cwd), cwd}`; the
   `relay.json` serve id is read even with the relay off (from the project
   store); `serveId` goes into the route and the record. `pair-addresses.ts`
   `urlFor` → `/s/<serveId>/e2e` (used by `pair` and the discovery
   announcement). `pair.ts`: `pairTargetOf` (`--project` or cwd, live+fresh
   record by `projectKey`) or a refusal with the start hint; the QR carries
   ONE record plus `--address` and `p=<label>`; the window and the registry
   entry carry the project; the prompt names it. `devices-cmd.ts`: grouped
   list (legacy groups, "running with no paired device" lines) and scoped
   `revoke` (`--project`, then the cwd's project, then a unique computer-wide
   match, else refuse with `project · name · id8`; `--all-projects`); `reset`
   also clears the adoptions. `flags.ts` / `main.ts`: `--project` and
   `--all-projects`.
7. **docs (§7):** dated "superseded" notes in `docs/eval/mobile-app.md`
   decision 7, the `device-pairing.md` on-disk layout, and
   `sibling-discovery.md` (self-only for devices). `README` / `ARCHITECTURE`
   have no "per computer" line. Changelog: `changelog.d/project-pairing.added.md`.

**Drift from Implementation (and why):**

- **`perProject` is OPT-IN in `pairDevice`, not always sent** (Files 3 said
  "`perProject: true`"). Today's app stores a pairing under the computer id. If
  the shared client sent the flag, the new daemon would pair it and the app
  would overwrite the record it already has, which is exactly what F10/Q9
  prevent. The app opts in in (b), together with per-project storage. A test
  pins it (M15).
- **Outside daemon/CLI, two minimal touches:** `apps/mobile/src/pairing-flow.ts`
  gains one `update_app` entry (its exhaustive `Record<PairingRefusedReason…>`
  would not compile otherwise). In the mobile tests, the `DeviceAuthority` /
  `openPairing` / `addDevice` call sites got the now-required `project`
  argument. Nothing else in the app changed.
- **Adoption is tmp + `link`, not `writeFileSync(wx)`.** It is still exclusive
  (EEXIST), and a concurrent reader never sees a half-written record. A
  half-written one would read as "unreadable" and be denied.
- **Several live records for one folder → the newest `startedAt`** among the
  records the heartbeat says are fresh (`DEFAULT_STALE_AFTER_MS`). The plan said
  "freshest by heartbeat"; the freshness filter does that, and the tie-break is
  by start time.
- **`addDevice` refuses the same key for another project** (or a legacy key),
  instead of returning the existing entry. One entry = one key = one serve
  (Q1).
- **Required types:** `project` is required on the authority, the handler,
  `openPairing` and the three window lookups. That way no call site can fall
  back to computer-wide.
- With the relay OFF and an unusable `relay.json`, the notice reads
  `serve id unavailable (direct device address stays /e2e)`, and the route
  answers only `/e2e`.

**STOP — plan gap the split did not cover (decision needed).** Two mobile test
files drive the real daemon through the app's own code:

- `apps/mobile/test/pairing-e2e.test.ts` calls `runPairing`, which does not
  send `perProject`, so it now gets `update_app`.
- `apps/mobile/e2e/pairing.ts` (used by `e2e-pairing.test.ts` and
  `pairing-e2e.test.ts`) calls `pairCommand` with no `--project` and no live
  serve record in a project, so it now gets the "No `tentacle serve` is
  running" refusal.

Both outcomes are this slice's intended behaviour (F10, Q6), and the
files to change are (b)'s (§6 "Pairing", `e2e/pair-cli.ts` "cwd/project
option"). I could not run them here: this worktree has no `apps/mobile`
workspace links (`Cannot find module '@tentacle/agent'`, the same on the base
commit), so their exact gate result is unverified. I expect them to be red. The
choice:

- **(i)** move the §6 "Pairing" bullet (`perProject` + `projectRecordId`
  storage + the `p` check) and the e2e harness's project option into (a);
- **(ii)** accept those tests red until (b) merges;
- **(iii)** something else.

I did not pick one.

**Tests** (all green, the touched files only, 405 pass / 0 fail):

- new `packages/daemon/test/project-pairing.test.ts` (21);
- new `packages/cli/test/devices-projects.test.ts` (8);
- new cases in `protocol/test/{device-pair,pairing-payload}.test.ts`,
  `client/test/pairing.test.ts`, `cli/test/{pair,serve-relay}.test.ts`;
- the existing device/relay/pair suites, adapted (the `project` argument;
  `v: 3` as the "unknown" registry version; `/s/<id>` addresses; grouped
  `devices` output).

**Q3 proof (zero steps for today's phone), through the real route:**
`project-pairing.test.ts` "the first handshake on P adopts the key…". The
setup is a v1 registry with one legacy key and no re-pairing. A real Noise
handshake goes through `acceptDevice` on P's authority, then `initialize` is
served. Then `adopted/<id>.json` names P, Q's authority denies the key, and P
`wantsReachability`.

**Mutations** (`.tentacle/tmp/project-pairing/mutate.ts`: apply, run the named
test, restore):

```
M1 skip project comparison: KILLED (red) pass=0 fail=1
M2 unfiltered hasLivePairing: KILLED (red) pass=0 fail=1
M3a reachability counts all entries: KILLED (red) pass=0 fail=1
M3b reachability counts legacy: KILLED (red) pass=0 fail=1
M4 adopt in authorize: KILLED (red) pass=0 fail=1
M5 overwrite instead of exclusive create: KILLED (red) pass=0 fail=1
M6 route accepts any /s/*: KILLED (red) pass=0 fail=2
M7 discover: no principal filter: KILLED (red) pass=0 fail=1
M8 perProject gate dropped: KILLED (red) pass=0 fail=1
M9 window project not checked by claim: KILLED (red) pass=0 fail=1
M10 revoke scope: Q's socket closed too: KILLED (red) pass=0 fail=1
M11 pair publishes every live record: KILLED (red) pass=0 fail=1
M12 pair picks any live record: KILLED (red) pass=0 fail=1
M13 revoke: computer-wide first: KILLED (red) pass=0 fail=1
M14 reset keeps adoptions: KILLED (red) pass=0 fail=1
M15 client always sends perProject: KILLED (red) pass=0 fail=1
M16 serve: computer-wide reachability: KILLED (red) pass=0 fail=1
```

(A first M11 was a no-op mutation, so it survived and proved nothing. I
rewrote it to really publish every record; it is now killed.)

**Gate:**

- `bunx biome check` on every changed file: clean (19 auto-formatted).
- `tsc -p packages/{daemon,client,protocol,cli}`: no error in a touched
  file (the per-package configs have unrelated errors in `tui`/`autowake`).
- Full `bun test` / typecheck / lint: left to the orchestrator.
- Unverified: the mobile tests (above).

### Fix round 1

*— claude-opus-5-5, 2026-11-20*

**F1 (HIGH, legacy phone off-LAN) — FIXED.** `device-authority.ts`
`wantsReachability` now counts `adoptable` too: every serve dials the relay
for an unadopted legacy phone until one project adopts it (then only the
adopter does; the stamp already covers `adopted/`). `knows` is unchanged
(push still only to `devices`). Snapshot comments updated.
- Red first (on the fix-less code): new `relay-link.test.ts` "today's phone
  over the relay: … first relay handshake adopts it" (v1 registry, real relay,
  real Noise + `initialize` over the relay, then `adopted/<id>.json` names the
  project and `knows` is true) → `timed out waiting for the link to register for
  a legacy phone`; the rewritten `project-pairing.test.ts` pin (was "dials
  nobody's relay", now "dials EVERY serve's relay until one adopts it", then Q
  stops after P adopts) → `expect(received).toBe(expected)`. 2 fail / 39 pass.
- Green: those 2 files + `cli/test/serve-push.test.ts` +
  `serve-hooks-trust.test.ts` → 56 pass / 0 fail (the 6 review reds included);
  `device-store`, `relay-link-push`, `relay-link-policy`, `serve-relay`,
  `device-authority` → 109 pass / 0 fail.
- Mutation (drop `|| this.snapshot.adoptable.size > 0`): the same 4 files →
  **48 pass / 8 fail** (the 6 serve tests + the 2 new) — KILLED; reverted.

**F2 (HIGH, mobile pairing e2e red) — PARTIAL; owner decision still needed.**
- Harness (test infra, no app production code): `e2e/pair-cli.ts` and
  `e2e/pairing.ts` gain `projectDir` (passed to `pairCommand`), `e2e/run.ts`
  passes the serve's `runDir`. The two test files write the live serve record
  `serve` writes (`writeDaemonRecord`, `cwd` = the project) and key the
  authority by `projectKey(cwd)` (what `pair` derives, Q6);
  `e2e-pairing.test.ts`'s simulated phone claims with `perProject: true`.
  `e2e-pairing.test.ts`: **7 pass / 0 fail** (was 3/4). Mutation (drop the
  `projectDir` pass-through in `pairing.ts`) → 3 pass / 4 fail — KILLED;
  reverted.
- `pairing-e2e.test.ts`: **2 pass / 7 fail** (was 0/9 of its own). The 7 drive
  the APP's `runPairing`, which does not send `perProject`, so the daemon
  answers `update_app` (Q9, pinned by M8) and `ok` is false. Making them green
  needs app production code, i.e. the §6 "Pairing" bullet — and doing that
  bullet as planned (records keyed `projectRecordId`) has an UNPLANNED ripple:
  the app matches the daemon's computer id against the record id
  (`notification-action.ts:174`, `notifications-expo.ts:163`,
  `push-manager.ts:311`), so a per-project id breaks push routing. The plan
  does not cover that, so I did not write it. Options for the owner:
  - **(i′) recommended, smallest:** in (a), `runPairing` sends `perProject:
    true` and keeps storing under `result.computer.id` (one record per
    computer until (b); pairing another project replaces it on the phone). Gate
    green; the transitional limit is explicit, and (b) brings per-project ids
    together with the id-match fix.
  - **(i)** the full §6 Pairing bullet in (a), after amending the plan for the
    id ripple (`computerId ?? id` at the three sites).
  - **(ii)** merge with these 7 red until (b) — AGENTS §4/§6 forbid it without
    the owner's explicit OK.

**F3 (MEDIUM, signature) — FIXED.** The (a) Execution signature now names
deepseek (per commit `1f6ce6f8`), with a note on the correction.

**Gate (this round, narrow):** `bunx biome check` on the 8 changed files:
clean. `tsc -p apps/mobile`: clean; `tsc -p packages/daemon`: no error in a
touched file. Full `bun run check`: left to the orchestrator's script —
expected red ONLY on the 7 `pairing-e2e.test.ts` tests above (F2).

### Fix round 2

*— claude-opus-5-5, 2026-11-20*

Review round 2: F1 and F3 FIXED (verified by the reviewer); one open HIGH (F2),
no MEDIUM; one note on accepted cost.

**F2 (HIGH, `pairing-e2e.test.ts` 7 red) — NOT FIXED: ESCALATED.** Fixing it needs app
production code (`pairing-flow.ts` `runPairing`), which is outside the approved
Implementation of slice (a) (Q11: the app belongs to (b)). Neither this doc nor
`TODO.md` records an owner choice among (i′) / (i) / (ii) (Fix round 1). The
executor rules forbid production code outside the approved plan, and §4/§6
forbid (ii) without explicit OK. So no code changed, and there is no red→green
or mutation to show. Decision needed from the owner: **(i′)** (recommended:
`runPairing` sends `perProject: true`, storage stays under `computer.id` until
(b); about 1 line + one `pairing-flow.test.ts` assertion), **(i)**, or **(ii)**.

**Accepted-cost note (review round 2) — DONE (doc only).**
`changelog.d/project-pairing.added.md` no longer says that a `serve` with no paired
device "never" dials the relay. It now says that every `serve` dials it until
a pre-upgrade phone first connects to one project, and that a stale old pairing
keeps that up until `devices revoke` / `reset`.

**Gate:** no code changed this round. Full `bun run check` is left to the orchestrator's
script, which is expected red ONLY on the 7 `pairing-e2e.test.ts` tests (F2).

### Fix round 1 (review round 3 → owner decision on F2, 22:10 · option (i′))

*— claude-opus-5-5, 2026-11-20*

One open finding, one change. F1/F3 were verified FIXED by review round 2/3.

**F2 (HIGH, `pairing-e2e.test.ts` 7 red) — FIXED, per the owner's (i′).**
`apps/mobile/src/pairing-flow.ts:495` — `runPairing`'s `pairDevice({…})` call now
sends `perProject: true` (with the comment naming why the daemon refuses without
it, and that storage stays under `result.computer.id` until (b)). **Nothing else of
(b):** the record id, `onPaired`, the link registry and the three id-match sites
(`notification-action.ts:174`, `notifications-expo.ts:163`, `push-manager.ts:311`)
are untouched, so push routing is exactly as before.

- **Red before green, on the property.** New
  `apps/mobile/test/pairing-flow-per-project.test.ts` (source guard over the
  `pairDevice` argument block: positive control `deviceKey`/`name`, then
  `perProject: true,`; plus the (i′) pin `id: result.computer.id,` and
  `not.toContain("id: result.project")`) → `expect(received).toContain("perProject: true,")`.
  The socket-level reds are the pre-existing ones: `pairing-e2e.test.ts` **2 pass /
  7 fail** (all `update_app`), measured at the start of this round.
- **Green:** `pairing-e2e.test.ts` + `e2e-pairing.test.ts` → **16 pass / 0 fail**
  (was 2/7 in the first file). With the guards/flow files:
  `pairing-flow{,per-project}`, `pairing-e2e`, `e2e-pairing`, `pairing-guards`,
  `pairing-wiring-guards`, `deep-link` → **68 pass / 0 fail**.
  `packages/client/test/pairing.test.ts` (the client's opt-in pin) →
  **17 pass / 0 fail**, unchanged.
- **Mutation (drop `perProject: true,` from the call):** the same 5-file set →
  **42 pass / 8 fail** = the 7 `pairing-e2e` reds + the new guard, i.e. KILLED;
  reverted, back to 68/0.
- **Drift from (i′)'s letter, and why:** the review asked for "one
  `pairing-flow.test.ts` assertion". I first wrote it there as a
  `mock.module("@tentacle/client/pairing")` spy on `pairDevice`; it passed alone,
  but Bun's `mock.module` is process-wide and `afterAll(mock.restore())` does not
  unload `pairing-flow.ts`'s already-bound `pairDevice`, so in a shared run it
  turned **6 real-daemon tests red** (`pairing-e2e`'s success/P9/Keychain/`n`/
  revoke/reset — measured 43 pass / 6 fail). A test file that poisons its
  neighbours is a gate bug, so the seam moved to a source guard in its own file
  (`pairing-flow-per-project.test.ts`) and the socket-level proof stays where it
  already was, in `pairing-e2e.test.ts`. Same property, same mutation, no
  process-wide fake.

**Changelog (doc only):** `changelog.d/project-pairing.added.md` no longer says
"the app needs an update to pair a new project" — this release's app does; an
older installed app is the one told to update.

**Gate (this round, narrow, as instructed — the orchestrator's script runs the
full one):** `bunx biome check` on the 2 changed files: clean.
`tsc -p apps/mobile --noEmit`: clean. Tests as listed above (the 4 app files I
touched/cover the change + the client's pairing pin). Full `bun test` /
repo typecheck / repo lint: **not run here**, by the round's token budget.

### (b) feat/mobile-projects-app

*— deepseek, 2026-11-21* (corrected in fix round 1, review (b) F4: this line read
`claude-opus-5-5`, but the orchestrator labels both commits that carry this work
`(deepseek)` — `0b65e100`, `f1df3dde`. The exact model id was not recorded.)

**Status: PARTIAL.** The app half is built and tested: the pure modules, the
store, the pairing, the screen and the wiring, with 12 mutations, all killed.
**Not done:** the Maestro flow `NN-projects.yaml`, the legacy-migration flow,
and the simulator screenshots A1–A7 (light + dark). The context budget ran out
before the simulator build, so `.tentacle/tmp/mobile-projects-app/screens/` is
empty.

**Load-bearing check, re-run first: HOLDS.** The repro was adapted to (a)'s API
(`.tentacle/tmp/mobile-projects-app/repro.ts`): one identity, two
`DeviceAuthority`s for projects P and Q.

```
add P: true
1. P authorize keyP: true
2. Q authorize keyP: undefined        (deny)
3. Q wantsReachability: false
add Q: true
4. Q authorize keyQ (second per-project key, same identity): true
5. P authorize keyQ: undefined        (deny)
```

There is one pinned identity and one device key per project, and each key is
valid only on its own serve. `openComputer(record)` dials one record with its
key, so a project record goes through the same function. There is no second
session path.

**As built, in dependency order:**

1. **Record** (`src/computer-store.ts`). `PairedComputer` gets optional
   `computerId` and `project {key?, cwd, label}`. Parse, `publicOf` and `add`
   carry both. A malformed value is dropped, and the record still reads as
   legacy.
   - New pure helpers: `projectRecordId` (`<cid>.<hex16(sha256(key))>`),
     `computerIdOf`, `isRecordOfComputer`.
   - New store methods `setProject` and `setAddresses`. Both refuse an
     unlisted id, never repair an unreadable item, and do not write when the
     value is unchanged.
   - `STORE_VERSION` stays 1. `computers.ts` exposes both methods.
2. **Pairing** (`src/pairing-flow.ts`).
   - New pure `recordFor`: a per-project result → `projectRecordId` +
     `computerId` + `project`; an older daemon's result → the computer id (F8).
   - New pure `projectMismatch` (F17), checked BEFORE `store.add`. Its reason is
     `project-mismatch`, and the message names both folders.
   - The review view shows `p=`. `done`, `onPaired` and the outcome carry the
     RECORD id.
   - `retireLegacy`: after the new record is stored, it removes the same
     computer's legacy record if its `project.cwd` matches (no duplicate row),
     and returns it as `superseded`.
   - `App.tsx`: `findExisting` matches key + project label, and `onDone`
     forgets the superseded record's memory and push state.
3. **Id ripple**. In `notification-action.ts:174` and `notifications-expo.ts:163`,
   the push match is now `isRecordOfComputer(record.id, claimed)`: the record's
   own id or `<claimed>.<hash>`. `push-manager.ts:311` is keyed by record id
   already, and each project record registers with its own serve, so it is
   unchanged.
4. **Link diagnosis** (`src/link-diagnosis.ts`, `src/connection.ts`).
   `DialObservation.absent` → `unreachable`, and the streak is left alone. The
   new `absent()` is reset by `ok()` and by any other observation.
5. **View-model** (new `src/project-rows.ts`).
   - `projectSections`: grouped by computer, in Keychain order, with a written
     word for every state.
   - A failing row is `stopped` iff a sibling answered or the relay closed
     `4404`; otherwise it is `unreachable`.
   - Section status reads "Online · N of M projects running" (only when
     M ≥ 2). An all-unreachable section gets the A4 note.
   - Also new: `justPaired` (4 s), `reprobeDelay` (15 s, or sooner when a
     "Paired just now" mark expires), `projectMenuActions` (Try again · Pair
     again · Remove "<label>" from this iPhone), `projectSheetMessage`,
     `removeProjectMessage`.
   - `ComputerProbe` gains `more` (the page had a cursor).
6. **Address refresh** (new `src/discover-fold.ts`). `discoveryPatch` uses
   `@tentacle/client`'s `mergeAddresses`: announced addresses first, then the
   known ones. It names a legacy record's project from `self.cwd`
   (label = basename), refuses a `self` with another cwd, and returns
   `undefined` when nothing changed. `App.tsx` runs `foldDiscovery(id, link)`
   after every `LINKS.open` and on later `daemon/discovery` frames.
7. **Screen + controller.**
   - `ComputersScreen.tsx` is variant A. Each computer gets a heading (dot +
     word + count) and a band with one row per project: dashed and dimmed when
     down; sub-line = dot + word + detail; "Paired just now" with a check. The
     band ends with "Pair a project on this Mac" (an instructions sheet, then
     Scan).
   - The new footnote: "Run `tentacle pair` in a project's folder. Only the
     projects you pair show up here."
   - `ComputersRoute` renders `loadSections()`. Tapping a row that is down
     retries it (stopped / unreachable) or opens the sheet.
   - The route re-probes every 15 s while focused, if something is down, and
     when the app returns to the foreground.
   - The probe reads 20 sessions (pinned included) for the count. Navigation
     passes the project label as the session list title.

**Drift from Implementation (and why):**

- **The `4404` does NOT reach `confirm`'s error** (the check §6 asked for):
  `WebSocketChannel.onClose()` carries no code
  (`packages/client/src/ws-channel.ts:51`). Instead of changing
  `@tentacle/client`, `openComputer` reads the code from its own
  `withDiagnostics` wrapper, through a new `onCloseCode` parameter. The
  socket's close listener runs before the channel's. The code is kept per
  address and read only for the channel that address opened. A test against a
  real relay pins this.
- **`RecordProject.key` is optional, and retiring the legacy record matches on
  `cwd`.** `daemon/discover` announces only `cwd` (`protocol/src/daemon.ts:91`),
  and the app cannot compute `projectKey`, which needs `realpath`.
- **No 30-day address expiry.** The record keeps no per-address stamps, so
  `discoveryPatch` treats every known address as seen now. Announced addresses
  come first, known ones are kept, and `mergeAddresses` caps the list.
  Follow-up: an `addressSeenAt` field on the record.
- **Pre-existing, out of scope:** `PushMessage.computer` is `identity.name`
  (`daemon/src/push-notifier.ts:337`, `cli/src/serve.ts:322-326`), but the app
  compares it to a record id. Not chased (§0); it needs its own fix task.
  **Not done:** when two projects of one Mac both decrypt a push, the right
  record is not chosen. The push directory carries no `cwd`, so the first
  record wins; fixing it is a directory-format change.
- **testIDs:** the existing `computer-<recordId>`,
  `computer-state-<recordId>-<state>`, `computer-menu-…` and
  `computer-remove-…` stay on the project row, instead of the mockup's
  `project-…`. Existing flows (15-revoked, 16-remove-computer) still match,
  and `band-screens.test.ts` pins `computer-${row.id}`. New testIDs:
  `computer-section-<cid>`, `computer-status-<cid>`,
  `computer-pair-project-<cid>`, `computer-pair-hint-<cid>`,
  `computer-pair-hint-scan`, `computer-retry-<id>`.
- **Not built:**
  - the 9 % accent fill and the 200 ms fade on a new row (`Row` has no
    background prop; only the text and the check are shown);
  - the session list subtitle "computer · cwd" (A5; only the title is set).

**Tests** (touched or covering files only). After the mutation run:
**140 pass / 0 fail** across 11 files. The screen guards (`band-screens`,
`header-wiring`, `icon-glass-wiring`, `computer-rows`, `computer-status`,
`computers`, `e2e-flows`) are green too.

- `computer-store`: +7.
- `pairing-flow-per-project`: the (i′) pin is replaced by `recordFor` /
  `projectMismatch` tests, +4.
- `pairing-e2e`: ids → `projectRecordId`, plus two real-daemon tests: "F17 …
  NOTHING stored" and "retires the legacy record".
- `notification-action`: +1. `link-diagnosis`: +2.
- New `link-absent-relay`: real relay, injected clock; three `4404`s never give
  `maybe-reset`.
- New `project-rows` (8) and new `discover-fold` (5).
- The `connection.test.ts` fakes gain `absent`.

**Mutations** (`.tentacle/tmp/mobile-projects-app/mutate.ts`). Each one is
applied, its test is run, and the file is restored from memory. `git status`
afterwards lists no mutated file.

```
M1 store add drops project fields: KILLED (red) pass=25 fail=1
M2 setProject writes every time: KILLED (red) pass=25 fail=1
M3 recordFor files under the computer id: KILLED (red) pass=10 fail=6
M4 save before the p= check: KILLED (red) pass=9 fail=2
M5 legacy record never retired: KILLED (red) pass=10 fail=1
M6 push: compare record id whole: KILLED (red) pass=25 fail=1
M7 diagnosis counts absent: KILLED (red) pass=8 fail=1
M8 connection ignores the 4404: KILLED (red) pass=0 fail=1
M9 rows sorted by state: KILLED (red) pass=4 fail=4
M10 siblings ignored (stopped only on 4404): KILLED (red) pass=6 fail=2
M11 never re-probe: KILLED (red) pass=7 fail=1
M12 discover: keep stored addresses: KILLED (red) pass=4 fail=1
```

For the new APIs the code was written before the tests, so these mutations are
the red evidence, not a pre-change run. The one exception is the (i′) source
pin: the per-project id turned it red, as intended, before it was replaced.

**Gate (narrow, per budget):**

- `bunx tsc -p apps/mobile --noEmit`: clean.
- `bunx biome check --write` on the 21 changed files: 0 issues (6
  reformatted).
- Full `bun test`, repo typecheck and repo lint: not run (the orchestrator
  runs them).
- No schema changed, so `protocol.json` was not regenerated.

**Remaining (next executor):**

1. The Maestro flow `apps/mobile/e2e/flows/NN-projects.yaml`. It needs two
   serves in two temp cwds sharing one config dir. Today `e2e/run.ts` /
   `05-start-serve.js` start one serve; `pair-cli.ts` already takes
   `projectDir`.
2. The legacy-migration flow: a v1 registry plus a legacy phone record.
3. The simulator screenshots A1–A7, light and dark, into
   `.tentacle/tmp/mobile-projects-app/screens/`.
4. `bun run e2e:mobile`.

### Fix round 1 (review (b))

*— claude-opus-5-5, 2026-11-21*

**F2 (MEDIUM) — FIXED (test only).** New real-daemon test in
`apps/mobile/test/pairing-e2e.test.ts`: "pairing project P KEEPS a legacy record
of the same computer that discover named project Q". The legacy record has the
computer's id and `project.cwd = <P>-q`. After pairing P, both ids are listed.
The guard was already right, so the red is the mutation (below).

**F3 (MEDIUM) — FIXED.** `apps/mobile/src/screens/ComputersScreen.tsx`: the
section header's single "…" (`rows[0]` only) is gone. Each project row now has
its own "…" as a `trailing` control (`trailingKind="control"`, so it is its own
VoiceOver element), with `computer-menu-<row.id>`, "More for <row.label>", and
`onMenu(row)`. Long-press is kept. Pin: `band-screens.test.ts` "every project row
has its OWN …". It was red on the old screen (`not.toContain("computer-menu-${first.id}")`)
and is green now. Flow 37 also taps project B's "…" on the simulator.

**F1 (HIGH) — PARTIAL.** Delivered: flow 37 (below), green on the iOS 26
simulator, and the flows this round touched:

```
run 1 (--only 37-projects,15-revoked,16-remove-computer):
37-projects FAIL 141 s · 15-revoked PASS 53 s · 16-remove-computer PASS 55 s
  37 failed at "computer-state-<B>-stopped is visible" (B still `new` after 60 s)
run 2 (--only 37-projects, after the flow change below): 37-projects PASS 144 s
GATE PASS — 1 passed, 0 failed
```

Shots `37-a1-two-projects`, `37-a2-pair-hint`, `37-a3-stopped`,
`37-a4-project-sheet` and `37-a5-revoked-one`, each light and dark, are in
`.tentacle/tmp/e2e-mobile/1795228927069/ios26/37-projects/2026-11-21_034747/37-projects/takeScreenshot/`.
The sandbox refused a copy into `.tentacle/tmp/mobile-projects-app/screens/`.
`37-a3-stopped-light` was checked by eye: one section, "1 of 2 projects
running", B "Stopped" with a dashed folder, A "Idle", and a "…" on each row.

**Open, for the owner (behaviour, not changed here):** run 1 showed that the
route probes only on focus, on a tap, on foreground, and on the 15 s timer, and
the timer runs only while a row is ALREADY stopped or unreachable
(`reprobeDelay`, `App.tsx` ~1025). A `serve` that stops while the screen sits idle
with every row ok is therefore seen only on the next foreground or navigation.
The plan's failure-mode F1 says "its socket drops → Stopped", but the screen holds
no socket per row. Flow 37 uses Q12's other trigger, a foreground (`pressKey:
home` + `launchApp: stopApp: false`). If the row should flip on its own, that is
a design change (poll while ok too, or hold a link per row), and it was not made
outside the approved Implementation.

**Not done:** the legacy-migration E2E flow. It needs a phone Keychain that
holds a pre-project record, which the harness can only produce by installing an
older build first. Its behaviour stays covered by the real-daemon unit tests:
"retires the legacy record", "first relay handshake adopts it", and F2's new
test. The full `bun run e2e:mobile` (all flows) was not run, only the three flows
this round touched.

Found while wiring it: the branch
broke the WHOLE existing E2E suite. `e2e/pairing.ts` `start()` returned the bare
computer id as `computerId`, but rows are now filed under
`projectRecordId(computer, projectKey(cwd))`. So every flow's
`computer-${output.computerId}` (about 60 uses, starting with `_pair.yaml`'s last
assert) named no row. Fixed:

- `start()` returns the row id when a project is paired. The hook test
  `e2e-pairing.test.ts` now expects `projectRecordId(…)`: red (`Expected
  "321284bf5f0c1019.4d850836811828bc"`, `Received "321284bf5f0c1019"`), then
  green.
- Flow 15 asserted the removed inline `computer-pair-again-<id>` (the only
  testID the new screen dropped, by a main-vs-branch diff). In §6 a revoked row's
  tap opens its sheet, so the flow now taps the row and asserts
  `computer-menu-pair-again-<id>`.
- Harness for two projects: `startServe(port, cwd = runDir)`; the
  `project-b-start` / `project-b-stop` hooks (B runs in `<run>/project-b`, same
  config dir, and keeps its port across restarts); `pair-start?project=b`
  (`PairWindowOptions.projectDir/address`). The flow-30 source pin in
  `e2e-escape-probes.test.ts` was updated to the `cwd` parameter (the default is
  still the run dir).
- New flow `37-projects.yaml` plus 4 scripts (`37-*.js`), registered in `FLOWS`
  after 36. Pair A, then pair B from the section's "Pair a project on this Mac".
  Both rows show `new|idle`. B's own "…" opens B's sheet. Stop B → B is `stopped`
  and A is untouched. Start B → B comes back with no tap (the 15 s re-probe).
  Revoke A's device, then relaunch → A is `revoked` and B is still `new|idle`.
  Shots `37-a1…a5`, light and dark.

**F4 (MEDIUM, process) — FIXED.** The `(b)` signature now reads `deepseek`,
from the orchestrator's commit labels, with a note. The exact id was not
recorded. This round is signed with my real id.

**Mutations** (`.tentacle/tmp/mobile-projects-app/mutate-fix1.ts`: apply, run the
test, restore from memory; `git status` afterwards lists no extra file):

```
F2 retireLegacy ignores cwd: KILLED (red) pass=11 fail=1
F3 row … opens the first row's sheet: KILLED (red) pass=35 fail=1
```

**Narrow gate:** `bunx tsc -p apps/mobile --noEmit` is clean. `bunx biome check`
on the 13 changed TS/JS files: 0 issues. Tests: `band-screens`, `computers`,
`pairing-e2e` (12/0), `e2e-pairing` (7/0), `e2e-gate`, `e2e-hooks-query`,
`e2e-escape-probes`, `e2e-session-capabilities`, `e2e-appearance`: all green.

## Review

*— claude-opus-5-5, 2026-11-20* (fresh context; scope: slice (a), `git diff main...HEAD`)

**Verdict: REQUEST-CHANGES.**

**Findings**

1. **HIGH: Q3 is broken off-LAN. Today's phone loses relay reach and push after the upgrade.**
   `packages/daemon/src/device-authority.ts:246` counts only `devices`, so an
   unadopted legacy entry never makes any serve dial the relay (pinned *as intended* by
   `packages/daemon/test/project-pairing.test.ts:213`). Adoption happens only on a
   completed handshake (`device-accept.ts:173`). So a phone that reaches its computer
   through the relay address on its record (cellular, or the serve restarted on a new
   port so the old direct `/e2e` is dead) gets `4404` forever. It is never adopted, and
   no push is sent (the push goes through the relay link). That is not "zero steps".
   The plan's Q3 proof (`project-pairing.test.ts` "first handshake on P adopts") only
   covers the direct route. **Reproduced through the real `serve` route by
   pre-existing tests that are now red**: `packages/cli/test/serve-push.test.ts` (4) and
   `serve-hooks-trust.test.ts` T13e/T13f (2) seed a legacy `addDevice` with no project, and
   time out on "the link to register". Mutation: count `adoptable` in
   `wantsReachability` turns those 6 green and only `:213` red. Direction: let
   unadopted legacy entries count toward reachability until adopted (the cost lasts
   only until the first connection; the adoption dir is already in the stamp). Then
   add a Q3 test over the relay leg.
2. **HIGH: the gate is red; `bun test` on the merge would fail.** Besides the 6
   above, `apps/mobile/test/pairing-e2e.test.ts` + `e2e-pairing.test.ts`: **13 fail /
   3 pass** (they DO run in this worktree, contrary to Execution's "cannot run"). The
   cause is `update_app` and the `pair` refusal with no live serve in the folder. The
   executor flagged this as STOP with no decision. Owner choice (i)/(ii) is needed
   before merge. AGENTS §4/§6 do not allow (ii) silently.
3. **MEDIUM: signature mismatch.** Commit `1f6ce6f8` says "exec (deepseek)", but
   Execution is signed `claude-opus-5-5`. §10 requires honest model signatures. Fix the
   signature.

**Gate (re-run by me):** `bun run lint` clean (2159 files) · `bun run typecheck`
clean · touched daemon/cli/client/protocol tests: **3419 pass / 6 fail / 2 skip**
(the 6 = finding 1) · mobile pairing e2e: 3 pass / 13 fail (finding 2). Full
`bun run check` not green.

**Premises spot-checked:** `authorize` is the single verdict, and the direct and relay routes
share `acceptDevice` (TRUE). The relay link gates on `wantsReachability` (`relay-link.ts:512`,
TRUE, and that is exactly finding 1). `readRelaySecret` creates the secret when it is missing, so `serveId`
exists with the relay off (TRUE, `cli/src/relay-secret.ts:89-91`).

**Attacks tried:** (a) legacy phone over the relay → **broken** (F1). (b) Adoption
race / half-written record → tmp+`link` is exclusive, and EEXIST re-reads the file. Holds. (c)
Adoption in `authorize` (P1) → only on resolve, before `new Connection`. Holds.
(d) `/s/<other>/e2e` → 404 before the limiter. Holds. (e) `discover` to a
device → self only, sync, no lock (§7 peer rule). Holds. (f) A socket live as
`adoptable` on Q when P adopts → the poll closes it (neither set). Holds.

**Executor behaviour:** thorough, with 17 mutations and an honest STOP on the mobile tests.
But it ran only the touched files, so it missed 6 red tests in untouched `serve-*` suites that
expose a plan-level gap. It also mis-stated that the mobile tests cannot run.
Same model family as the planner (opus), so a shared blind spot (the plan itself
chose "legacy does not count") survived both passes.

### Round 2

*— claude-opus-5-5, 2026-11-20* (fresh context; scope: `git diff HEAD~1`, commit `14b5a979`)

**Verdict: REQUEST-CHANGES.** The only blocker left is F2, and it needs an owner decision.

- **F1 — FIXED, verified.** `device-authority.ts:252` now counts `adoptable` in
  `wantsReachability`. The new relay-leg Q3 test (`relay-link.test.ts` "today's phone
  over the relay…") uses a v1 registry, a real relay and real Noise, and checks
  that the phone is adopted. My mutation (drop the `adoptable` clause): 4 files
  went from 56/0 to **48 pass / 8 fail**, so it is KILLED. I restored the file and the tree is clean. `knows` is unchanged, so
  pushes still go only to devices of this project. Q stops dialling once P adopts (pinned).
- **F2 — STILL OPEN (HIGH, gate).** `apps/mobile/test/pairing-e2e.test.ts`:
  **7 fail** (the app's `runPairing` sends no `perProject` and gets `update_app`).
  `e2e-pairing.test.ts` is green with the harness changes (`projectDir`, a live
  serve record, `perProject: true` on the simulated claim). The executor reports the
  id-match ripple (`notification-action.ts:174`, `notifications-expo.ts:163`,
  `push-manager.ts:311`) and proposes (i′): `runPairing` sends `perProject` but keeps
  `computer.id` storage until (b). That is sound and the smallest change, but it is the owner's call (§4/§6).
- **F3 — FIXED.** The Execution signature now names deepseek, with a note on the correction.
- **Regressions:** `bun run lint` is clean (2159 files) and `bun run typecheck` is clean.
  `packages/daemon/test` + cli `pair`/`devices-projects`/`serve-relay`: 1487 pass / 1
  skip / 1 fail. The fail is `serve-log-store.test.ts` S11 (the 200-SIGKILL chaos test), which this
  diff does not touch; it passes 22/0 when run alone, so it is load flakiness.
- **Accepted cost (not a finding):** a legacy entry that is never used again makes
  every serve dial the relay until someone runs `devices revoke` or `reset`. This is bounded, but the changelog should say it.

### Round 3

*— claude-opus-5-5, 2026-11-20* (fresh context; scope: `git diff HEAD~1`, commit `159bee19`)

**Verdict: REQUEST-CHANGES.** The verdict stands only because of the gate. The executor escalated F2 correctly.

- **Diff:** only `changelog.d/project-pairing.added.md` and this doc changed, with no code. There is
  nothing to mutate and no regression surface. `bun run lint` is clean (2159 files), and `bun run
  typecheck` is clean.
- **Accepted-cost note — DONE.** The changelog now says what the round-2 code does: every `serve`
  dials the relay until a pre-upgrade phone is adopted, and a stale pairing keeps that up until `revoke`/`reset`. Accurate.
- **F2 — STILL OPEN (HIGH, gate).** `apps/mobile/test/pairing-e2e.test.ts` re-run: **2 pass / 7 fail**
  (`update_app`), unchanged. The executor rightly refused app production code outside the approved
  slice (a) without an owner choice. **The owner must pick (i′) / (i) / (ii).** My recommendation is (i′):
  `runPairing` sends `perProject: true`, storage stays under `computer.id` until (b), plus one
  `pairing-flow.test.ts` assertion, red first. Then a Round 4 that verifies that single change by mutation.

### Owner decision on F2 (2026-11-20 22:10)

**(i′) chosen.** `runPairing` (app, `pairing-flow.ts`) sends `perProject: true`; the app keeps storing the record under `computer.id` until slice (b). Add the `pairing-flow.test.ts` assertion (red before green) and make `apps/mobile/test/pairing-e2e.test.ts` green. Nothing else of (b) in this slice.

### Round 2 (after the owner's pick (i′) for F2; the fourth pass overall)

*— claude-opus-5-5, 2026-11-20* (fresh context; scope: `git diff HEAD~1`, commit `a7899b67`)

**Verdict: PASS.**

- **F2 — FIXED, verified.** `apps/mobile/src/pairing-flow.ts:495` `perProject: true`;
  storage stays under `result.computer.id`, as (i′) specifies. Re-run: `pairing-e2e` +
  `pairing-flow-per-project` + `e2e-pairing` + `pairing-flow` = **38 pass / 0 fail**.
  My mutation (drop the line): **3 pass / 8 fail** (the 7 real-daemon `pairing-e2e` tests go back to
  `update_app`, and the source guard goes red too), so it is KILLED. I restored the file, and the tree is clean.
- **Gate:** full `bun test` = **15988 pass / 5 skip / 0 fail** (15993 tests, 1135 files). The
  branch adds no `skip`/`skipIf`, so the extra skips come from main. `bun run lint` is clean (2160 files), and
  `bun run typecheck` is clean.
- **Test quality:** `pairing-flow-per-project.test.ts` is a source-text guard (it gives its
  reason: `mock.module` is process-wide in Bun). It is weak on its own, but the behavioural proof is
  the real-daemon `pairing-e2e`, which the mutation shows dies with the line. Acceptable.
- **Note (accepted by the owner, not a finding):** under (i′), pairing a SECOND project replaces the
  phone's single record per computer, today's legacy record and key included. This lasts until (b)
  keys records per project. The changelog's "The app pairs per project now" claims more than
  that until (b) ships. Fine if (b) lands before the next `release`; otherwise state the limit there.

### Review — (b) feat/mobile-projects-app

*— claude-opus-5-5, 2026-11-21* (fresh context; scope `git diff main...HEAD`, slice (b); same model family as the
Execution's signature, though the commits say `deepseek` — see finding 4)

**Verdict: REQUEST-CHANGES.**

**Gate (re-run):** `bun test apps/mobile/test` 4115 pass / 0 fail (280 files); `bun run typecheck` clean;
`bun run lint` clean (2181 files). Full `bun test` not re-run.

**Findings**

1. **HIGH: the E2E half of the scope is not delivered.** There is no `apps/mobile/e2e/flows/NN-projects.yaml`, no
   legacy-migration flow, `bun run e2e:mobile` was not run, and `.tentacle/tmp/mobile-projects-app/screens/` does not
   exist (no A1–A7 light/dark). The Execution itself says PARTIAL. The plan's gate (§Tests "Gate before done",
   decision 20) is unmet, and so are the live behaviours that only the E2E pins: stop B → "Stopped", revoke A → B still
   online, the 15 s re-probe.
2. **MEDIUM: the guard on a destructive branch is not pinned.** `apps/mobile/src/pairing-flow.ts:519`
   (`entry.computer.project?.cwd === record.project.cwd` in `retireLegacy`). Mutation R2 replaced it with `true`, and
   `pairing-e2e.test.ts` stays green (11/0). Scenario: the phone holds a legacy record of Mac M whose discover named
   it Q (its key is adopted on Q). Pairing P with the guard regressed silently deletes the record of Q and its key. Q
   then has to be re-paired, with no error. Needed: a test where a same-computer legacy record with another `cwd`
   survives.
3. **MEDIUM: the section's "…" opens only the FIRST project's sheet.** `apps/mobile/src/screens/ComputersScreen.tsx:190-199`
   (`computer-menu-${first.id}`, "More for <first label>"). With two or more projects, the only visible control for
   project 2+'s Try again / Pair again / Remove is a long-press (an ok row's tap opens it). §6 says
   "long-press / … = project sheet" per row. Scenario: a VoiceOver user, or anyone who doesn't know about long-press,
   cannot remove the second project.
4. **MEDIUM (process, §10):** `### (b)` Execution is signed `claude-opus-5-5`, but both branch commits are labelled
   `(deepseek)` (`0b65e100`, `f1df3dde`). The signature must name the model that did the work: §10's routing and
   review strength depend on it.

**Mutations (reviewer, in memory, restored; `git status` clean afterwards):** R1 `observe` does not reset `absent` →
KILLED (link-diagnosis 8/1). R2 `retireLegacy` ignores `cwd` → **SURVIVED** (F2). R3 discover folds another `cwd` →
KILLED. R4 `justPaired` never expires → KILLED. R5 drop `closeCodes.delete(address)` → survived (low: a stale code
matters only on a re-dial of the same address inside one `openComputer`; not raised).

**Attacks tried**
- **§7 one session path:** a project record dials through the same `openComputer`/`LINKS`; the `4404` is read from
  the app's own `withDiagnostics` wrapper, with no second channel. Holds.
- **§7 pure modules:** the states, words, grouping, re-probe delay and menu actions are in `project-rows.ts`. The
  App's `onOpen` branch (ok → open, stopped/unreachable → retry, else sheet) is small and inline: known App.tsx debt,
  not raised.
- **Push id ripple:** `openRoute` (`notification-action.ts:113`) still routes on `msg.computer`, and no project
  record has that id. It is moot today only because `PushMessage.computer` is `identity.name`, not the id: the
  pre-existing defect the Execution names. The fix task for it must also map claimed → record id here.
- **`stopped` vs `unreachable` with LAN + relay addresses:** `observe` resets `absent` on every observation, so the
  last failure wins. A lone project may flip between the two words from one poll to the next. This is cosmetic, and
  it never feeds `maybe-reset`. Not raised.
- **Same-basename projects (`~/a/app`, `~/b/app`):** `projectMismatch` and `findExisting` compare labels only. This
  follows the plan (`p=` is the label), and record ids are keyed by `project.key`, so nothing is overwritten. Not
  raised.

**What holds:** record ids per project with `STORE_VERSION` 1; F17 saves nothing (its real-daemon test passes);
the legacy record parses; `setProject`/`setAddresses` refuse an unlisted id and skip a no-op write; the
diagnosis's `absent` does not feed the streak (real relay test).

**Executor behaviour:** honest about the PARTIAL status and the drift (4404 path, no 30-day expiry, testIDs). The
gap is scope, not quality, plus one unpinned destructive guard and the signature mismatch.

### Round 2

*— claude-opus-5-5, 2026-11-21* (fresh-context reviewer; scope `git diff HEAD~2` = the fix round `b9c70b77` and the
gate fix `3d50cba7`)

**Verdict: APPROVE-WITH-NITS (PASS).**

**Gate:** `bun test apps/mobile/test` 4117 pass / 0 fail (280 files); `bun run typecheck` clean; `bun run lint` clean
(2185 files).

**Previous findings**
- **F2 — FIXED.** The new real-daemon test "KEEPS a legacy record … named project Q" is in place. Mutation R2 (the
  `cwd` guard → `true`) is now KILLED: `pairing-e2e` 11/1.
- **F3 — FIXED.** `ComputersScreen.tsx` gives each row its own "…" (`computer-menu-${row.id}`, `trailingKind="control"`),
  and the header "…" is gone. Mutation R6 (the row "…" opens `section.rows[0]`) is KILLED: `band-screens` 35/1. Screenshot
  `37-a5-revoked-one-dark` checked by eye: two rows with a "…" each, A "Access removed" with a dashed folder, B "New",
  "1 of 2 projects running".
- **F4 — FIXED.** The `(b)` signature now reads `deepseek`, with a note explaining the correction.
- **F1 — mostly delivered.** Flow `37-projects.yaml` exists, and the Execution logs it green on the iOS 26 simulator.
  Ten shots (a1–a5, light and dark) exist under the worktree's
  `.tentacle/tmp/e2e-mobile/1795228927069/…/takeScreenshot/` (verified on disk).
  The Execution also caught and fixed a regression this branch had introduced in the harness: `pairing.ts` `start()`
  returned the computer id, not the row id, which broke every flow's `computer-${output.computerId}`.

**Regressions on the diff:** none found. The harness changes are additive (`project-b-*` hooks, `pair-start?project=b`,
`startServe(port, cwd = runDir)`), and the two source pins in `e2e-flows.test.ts` were updated to match.

**Residual (not blocking; for the owner/orchestrator):**
1. The full `bun run e2e:mobile` was not run, only flows 37, 15 and 16. Run it before merge: the record-id change in
   `pairing.ts` reaches every flow.
2. There is no legacy-migration E2E flow. The reason given is that the harness can't seed a pre-project Keychain
   record. Unit and real-daemon tests cover the behaviour.
3. Only shots a1–a5 exist, not A1–A7, and they are not in `.tentacle/tmp/mobile-projects-app/screens/`.
4. The Execution's open question is a real gap against failure mode F1. A `serve` that stops while every row is ok is
   noticed only on foreground or navigation, because the 15 s timer runs only once a row is already down. This needs
   an owner decision.
