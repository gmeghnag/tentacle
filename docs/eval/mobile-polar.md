# eval/mobile-polar — Live Polar H10 (and any BLE sensor) data from the iPhone to a tentacle

> **Status:** context (Implementation proposed, awaiting the owner's answers to *Owner questions*)
> **Branch:** none. An `eval` is committed directly to `main` (AGENTS §10). Approval = `git mv` to `docs/feat/mobile-sensors.md` + one branch per slice, in the slice order below.
> **Size:** L as an umbrella, split into **nine slices, each S or M** (table in *Design § Slices*). No slice is XL. · **Blast:** load-bearing as a whole: a new protocol surface (`sensor/*`), a new iOS background mode, health data at rest and on the wire. Per-slice blast is in the table. · **Suited:** Opus eval. Execution per slice, by blast. Any `load-bearing` slice gets an Opus plan and a **mandatory fresh-context Review**.
> **Changelog:** none for the eval. After promotion: `changelog.d/mobile-sensors.added.md`, written by the slice that makes it user-visible (S6).

## Context

*— claude-opus-5-5, 2026-11-20*

### The question being decided

**How should live data from a BLE sensor reach a tentacle model while the owner runs outdoors with only the iPhone? Which layers, which protocol surface, which tools, in what order? And which parts must be proven on the device before any code is written?**

The first sensor is the owner's Polar H10. The first use is a hands-free voice coach built with `feat/voice-conversation`. Owner decisions already taken (TODO.md row `eval/mobile-polar`, 2026-11-20). The eval does not reopen them:

1. **Native in the app.** Polar support is built into the mobile app with the official Polar BLE SDK. This is a deliberate exception to "mobile UI minimal". The Apple Watch comes later.
2. **Device-agnostic from day one.** There is a device registry and a pairing/connection lifecycle. All samples share one timestamped model (`hr`, `rr`, `ecg`, `acc`, …). Store-and-forward, the `sensor/*` protocol and the daemon tools all speak in terms of "sensor + channel", never "Polar". The Polar SDK is **one driver**. The standard BLE Heart Rate Service (0x180D) is a **second driver**, for any HR strap. A new device means a new driver, not a redesign.
3. **The model sees data only through daemon tools.** The tools form a `tool-toggles` group (e.g. `sensors`). The group is off when no strap is paired. Nothing is auto-injected. A threshold wake-up of a turn is optional.
4. **Privacy.** Health data triggers a warning when the model is not local.
5. **Explicitly rejected for live use:** HealthKit via Polar Flow, and Polar AccessLink (both are post-session only). **Parked:** a generic, package-declared phone-capabilities layer.

The TODO row leaves five points open: Mac parity, pods, battery budget, location in v1 or later, and the Watch path. Each is answered in *Design § Open points answered*.

### Evidence: what exists today (verified 2026-11-20)

| Fact | Where |
|---|---|
| **The app has one local native module.** It is an Expo module (`expo-module.config.json` → `TentacleSpeechModule`, Swift under `ios/`) plus a config plugin that is the single writer of its plist keys. This is the pattern a sensor module copies. | `apps/mobile/modules/tentacle-speech/{expo-module.config.json, app.plugin.js:1-19, ios/*.swift}`, registered at `apps/mobile/app.json:55` |
| **There is no `UIBackgroundModes` at all.** No `bluetooth-central`, no `audio`, no `location`, and no Bluetooth usage string. | `apps/mobile/app.json:18-25` (the whole `infoPlist`); `grep -rn UIBackgroundModes apps/mobile` (outside `node_modules`) finds nothing |
| **The app closes its socket when it goes to the background.** The foreground gate `suspend()` closes the live channel and holds redials. The only exception is `hold(ms)`, a bounded hold of ≤ 25 s for a notification action. | `apps/mobile/src/foreground-gate.ts:16-17, 49-68`; `docs/feat/mobile-relay.md:316-317, 369` (F14) |
| **Voice background is approved but not built.** `feat/voice-conversation` P2b plans `UIBackgroundModes: audio`, written by the speech plugin. While the mode is active, "the relay WebSocket and the outbox keep working". | `docs/feat/voice-conversation.md:201, 204, 211`; App Review 2.5.4 reasoning `:214-222` |
| **Device-scoped RPC already exists.** `device/push_register` and the `device/live_activity_*` methods are refused unless the connection's principal is `device`. The device id comes from the authenticated channel and is never a parameter. They run synchronously and take no lock (the "don't serialize the peer" rule). | `packages/daemon/src/connection.ts:516-580`; `packages/protocol/src/device.ts:1-27`; `packages/protocol/src/methods.ts:197-225` |
| **Per-device daemon stores exist.** Push registrations are stored at `<configDir>/devices/push/<id>.json`. `devices reset` / `removeDevices` reach that directory. | `packages/daemon/src/push-store.ts:2, 71-78` |
| **Frames are bounded.** A device connection's frames are capped at 8 MiB. | `packages/daemon/src/device-accept.ts:34, 187` |
| **Methods are free. Update kinds are classed.** A new method needs no `PROTOCOL_VERSION` bump, and an older peer answers `MethodNotFound`. Each `session/update` kind has one class in `UPDATE_CLASS`. A `display` kind is free to add, and an older client shows `unsupported` once. | `packages/protocol/src/updates.ts:535-582, 599-609`; `packages/protocol/src/watch.ts:19-22`; AGENTS §7 "Forward compatibility" |
| **A client declares the update kinds it understands** at `initialize`. | `packages/protocol/src/session.ts:221-233` |
| **Optional daemon tools are registered conditionally** on a host-supplied option. Example: `schedule_*` is registered only when `options.schedules` is passed, which happens in `serve` and the worker, never in a pod daemon. | `packages/cli/src/wiring.ts:443, 759-764` (also `workload_shell` `:747-757`, `chart` `:725`) |
| **Children are denied session-level tools by name.** A child agent never gets `chart`, `schedule_*`, `present`, … | `packages/agent/src/subagent.ts:402-420` |
| **Wake turns exist.** A background exit or a scheduled fire starts a `wake-` turn, and only the daemon may mint that prefix. | `packages/daemon/src/hosted-session.ts:438, 1037-1074`; `packages/daemon/src/connection.ts:1127-1128` |
| **Persistence rule.** Persist the conversation only: `ChatMessage`s and their typed facts. Pod daemons persist nothing. `serve` writes `<uid>.jsonl` and a sidecar through `SessionPersister`. | AGENTS §7; `packages/daemon/src/session-persister.ts:127, 153` |
| **`feat/tool-toggles` is being planned in parallel.** Its shape: `tools.enabled: { "<group or tool>": false }`, owner-approved group names, usable in a profile, a `/tools` panel, "a disabled tool never reaches the model (pods too)", "a sub-agent never re-enables a tool its parent has off", phone parity. | `TODO.md:1293-1316` |

**External facts.**

- Apple's Core Bluetooth background guide (archived, last updated 2013-09-18) covers `bluetooth-central`. With it, the system wakes the app for "updated characteristic values", connection changes and state changes. "Upon being woken up, an app has around 10 seconds to complete a task." Apps "should not use being woken up as an opportunity to perform extraneous tasks". Opting in to state preservation and restoration lets the system relaunch an app it terminated for memory into the background, with connections and subscriptions preserved. The guide does not cover a user force-quit. Source: `developer.apple.com/library/archive/documentation/NetworkingInternetWeb/Conceptual/CoreBluetooth_concepts/CoreBluetoothBackgroundProcessingForIOSApps/PerformingTasksWhileYourAppIsInTheBackground.html`.
- Polar BLE SDK README:
  - iOS 14+, installed by SPM or CocoaPods. SDK 8.x uses async/await, and RxSwift is no longer required.
  - Setup needs the background mode "Uses Bluetooth LE accessories" and `NSBluetoothAlwaysUsageDescription`.
  - The H10 provides HR + RR at 1 Hz, ECG at 130 Hz in µV, ACC at 25/50/100/200 Hz, an HR broadcast, and internal HR recording at 1 s.
  - The license permits private and commercial use with the notice kept.
  - Source: `github.com/polarofficial/polar-ble-sdk` + `documentation/products/PolarH10.md`.
- **Not confirmed from a source:** the H10's "2 simultaneous BLE connections", that the H10 advertises 0x180D (the SDK says HR is "sent through the BLE Heart Rate Service" but names no UUID), the behaviour after a force-quit, and whether network I/O inside a BLE wake keeps a WebSocket alive for a whole run. Spike S0 settles each of these on the owner's devices.

**Repro (capability missing), 2026-11-20:**

```
$ grep -rn "UIBackgroundModes\|NSBluetooth" apps/mobile --exclude-dir=node_modules
(no output)
$ grep -rn "sensor/" packages/protocol/src
(no output)
```

### Constraints

- **AGENTS §7 invariants this touches:**
  - one session path (no parallel transport: the phone's existing `RemoteClient` link carries `sensor/*`)
  - logic in pure modules
  - persistence rules (sensor samples are not conversation)
  - "a pod is not trusted"
  - protocol forward-compat
  - don't serialize the peer
- **Owner taste:**
  - The mobile UI stays minimal. Sensor UI lives in Settings plus one compact live view.
  - **The owner is colour-blind. Never encode meaning by hue alone.** A zone is always written ("Z3 · 152 bpm"), and a lost contact is a word and a glyph, not a grey.
  - Mac/phone parity is an owner rule (`voice-conversation.md:10`). Where the Mac cannot do something, it says so.
- **Health data.** It never goes to a pod, and never into a durable approval. A warning is shown when the model is remote. Tool output about ectopic beats is **indicative, never diagnostic**.
- **Pre-public.** Breaking changes are allowed, but the design below needs none (memory `project-pre-public-breaking-ok`).

## Implementation

*— claude-opus-5-5, 2026-11-20*

This is a proposal, not an approved plan. It becomes the feat doc's Implementation on promotion, after the owner answers the questions below.

### Load-bearing assumption

**With the screen locked and the app in the background for a whole run (≥ 60 min), the iPhone can stay a BLE central that receives the H10's 1 Hz notifications, and can push them to `serve` over the existing relay E2E link, with no more than one batch interval of delay.**

If this is false, "live data while running" degrades to "data after the run" (store-and-forward only), and the coach use case dies.

What is proven, and what is not:

1. **Receiving BLE in the background is documented.** `bluetooth-central` wakes the app on every characteristic update, with about 10 s per wake (Apple guide, above). The H10 notifies HR at 1 Hz (Polar H10 doc), so the app is woken every second and is never idle long enough to be suspended between wakes. *Proven by documentation. Not yet proven on the owner's iOS 18.3.1 phone.*
2. **The network path today is the opposite: the app closes the socket on background** (`foreground-gate.ts:16-17`). The design must therefore add a **sensor hold** to the gate. This is the same mechanism as the existing `hold(ms)` (`:56-68`), but held for as long as a recording is active rather than for ≤ 25 s. *A code fact, cited.*
3. **Sending over the network inside BLE wakes** is the unproven link. Apple's restraint clause ("not … extraneous tasks") allows work *related* to why the app was woken. Forwarding the sample that woke it is related, and that is the argument. Two things are not proven: whether a WebSocket stays usable across a 60-minute chain of ~10 s wakes, and whether iOS throttles it under Low Power Mode.
4. **Two fallbacks exist, and both are legitimate background purposes (App Review 2.5.4):**
   - **(a)** During a voice-coach run, `voice-conversation`'s `audio` mode is already active and keeps the app fully running (`voice-conversation.md:192, 211`). The coach case therefore holds whatever S0 says about (3).
   - **(b)** The `location` background mode with continuous updates, justified by a real pace/route feature, never as a keep-alive trick.

**Proof required before any code: spike S0, owner-assisted, on the owner's phone and H10.** It is the analogue of `voice-conversation`'s P1/E11. It is a throwaway dev build with `bluetooth-central` and the standard 0x180D driver only. The phone is locked for 60 min, outdoors, on cellular, with HR+RR forwarded every 10 s to a `serve` through the relay. The daemon logs `(sample time, receive time)`.

S0 passes if all of these hold:

- the gaps between consecutive receive times are p95 ≤ 2 × the batch interval, with no gap > 60 s that the link did not report as a drop;
- battery use is ≤ 5 %/h with HR+RR only;
- the daemon receives ≥ 99 % of samples within the run, and the rest arrive via store-and-forward after it.

S0 also records five more answers:

- whether 0x180D is visible next to the Polar SDK's connection (this settles "2 connections");
- what happens after an iOS memory kill (restoration);
- what happens after a force-quit;
- the same run with Low Power Mode on;
- whether ECG streaming at 130 Hz changes any of the numbers.

If S0 fails on (3) with no voice mode running, the plan does not change shape: Owner Q4 (location in v1) flips to "yes", and S0 is re-run with `location`.

### Preconditions

- **P1.** A paired phone already holds an authenticated, device-principal link to `serve` over the relay (`connection.ts:516-580`; `docs/feat/e2e-channel.md`). `sensor/*` rides it. No new transport is added (§7 one session path).
- **P2.** A new method is additive (`watch.ts:19-22`; AGENTS §7). `sensor/push` needs no `PROTOCOL_VERSION` bump. An older `serve` answers `MethodNotFound`.
- **P3.** Device-level requests already run synchronously, with no lock, beside a long `session/prompt` (`connection.ts:521-523`). `sensor/push` follows the same rule: an append into memory, never awaited on disk.
- **P4.** Optional tools are registered on a host option (`wiring.ts:759-764`). The `sensors` tools are registered only when `serve` passes `options.sensors`. A pod daemon and the in-process worker never pass it. This holds independently of `tool-toggles`, and is a §7 trust boundary, not a preference.
- **P5.** Children are denied session-level tools by name (`subagent.ts:402-420`). The `sensors` tools are added to that list. The parent can pass a reading into the child's task text.
- **P6.** `tool-toggles` (in planning) provides `tools.enabled.<group>` and the `/tools` panel. This eval only **registers a group named `sensors`**, does not redesign the toggle, and defines its default (Owner Q6).
- **P7.** Wake turns exist (`hosted-session.ts:438, 1037-1074`). The threshold wake-up (S8) reuses the scheduled-wake path. It does not add a second way to start a turn.

### Design

#### 1. Layers (every arrow is an existing seam unless marked NEW)

```
H10 ──BLE──► [driver: polar | hrs-0x180D] ──► SensorHub (native, Swift) ──► JS: sensor-core (pure TS)
                                                                         ├─► live view (offline)
                                                                         └─► outbox (on-disk, per channel seq)
                                                                                 │ NEW sensor/push (device principal)
                                                                                 ▼
                                    existing RemoteClient ⇄ relay E2E ⇄ serve: SensorStore (memory, bounded)
                                                                                 │
                                                       `sensors` tool group (serve sessions only) ──► model
```

- **Native, `apps/mobile/modules/tentacle-sensors/`.** This is an Expo module that copies `tentacle-speech`'s layout. It holds one `CBCentralManager`, owned by `SensorHub` with a restoration identifier, and a `SensorDriver` protocol:
  ```swift
  protocol SensorDriver {
    static var id: String { get }            // "polar" | "hrs"
    func matches(_ adv: Advertisement) -> Bool
    func connect(_ peripheral: CBPeripheral) async throws -> DeviceInfo
    var channels: [ChannelSpec] { get }      // what this device can stream
    func start(_ channel: ChannelKind, rate: Int?) async throws
    func stop(_ channel: ChannelKind) async
  }
  ```
  Drivers emit **normalised samples only** (below). Nothing above the driver knows "Polar".
  - `PolarDriver` wraps `PolarBleSdk` (SPM). It covers `hr`, `rr`, `ecg`, `acc`, `contact`, `battery`.
  - `HrsDriver` speaks GATT 0x180D / 0x2A37 directly. It covers `hr`, `rr` (when the strap sends RR) and `contact` (the sensor-contact bits), plus `battery` via 0x180F.
  - The JS bridge passes **batches** of samples (≤ 1 per second per channel for low-rate channels, one block per ECG/ACC packet). It never passes one event per sample.
- **Pure TS, `packages/core/src/sensors/`.** It is shared by the phone, the daemon and the TUI, like `core/src/voice/` (`voice-conversation.md:20`). It holds:
  - the sample model and its zod schemas (these live in `@tentacle/protocol`; core holds the logic);
  - zone computation;
  - the RR → HRV fold (RMSSD/SDNN over a window, artefact rejection);
  - the cadence fold from ACC;
  - the outbox reducer (seq, ack, retention, gaps);
  - the device registry reducer (`unpaired → pairing → paired(disconnected | connecting | streaming{channels}) → forgotten`);
  - the clock-offset estimator.
  All of it is React-free and unit-tested (§7 "logic lives in pure modules").
- **Phone app (`apps/mobile/src/`).** It adds:
  - a Settings section "Sensors": scan, pair, forget, the list of devices with written state, which computer receives the data (Owner Q2), and the privacy line;
  - a compact live view. It is reachable from the session header when a sensor is streaming, and also from Settings, so it works offline and without a session. It shows `152 bpm · Z3 tempo · contact ✓ · battery 80 %` and a sparkline. Zones are always written, and contact loss reads `no skin contact` with a glyph.
  - a recording toggle. "Recording" means streaming, plus the outbox, plus the gate's sensor hold.

#### 2. Sample model (one shape for every device)

```ts
// @tentacle/protocol  sensor.ts  (strip schemas, AGENTS §7)
SourceRef  = { device: DeviceId /* the phone, from the channel */, sensor: string /* stable per physical sensor: driver id + hardware id, e.g. "polar:A1B2C3D4", "hrs:<peripheral uuid>" */ }
SensorInfo = { sensor, driver: "polar" | "hrs" | string, name: line(64), model?: line(64), channels: ChannelKind[] }
ChannelKind = "hr" | "rr" | "ecg" | "acc" | "contact" | "battery" | string   // string: a newer phone's channel is kept, shown as unknown
Batch = {
  sensor: string, channel: ChannelKind,
  seq: number,              // per (sensor, channel), monotonic on the phone, survives app restarts (outbox state)
  t0: number,               // phone wall-clock ms of the first sample
  hz?: number,              // fixed-rate channels (ecg, acc): sample i is at t0 + i*1000/hz
  dt?: number[],            // event channels (hr, rr, contact, battery): ms offsets from t0
  v: number[] | number[][], // bpm | ms | µV | [x,y,z] mG | 0/1 | %
  gapBefore?: true,         // the phone dropped data before this batch (retention overflow, driver restart)
}
```

The values are typed per channel and validated with bounds: `hr` 20–250, `rr` 200–3000 ms. An out-of-range value is dropped by the core fold and counted. It is never "fixed".

#### 3. Wire surface `sensor/*` (all methods: additive, no bump)

| Method | Direction | Class / rule |
|---|---|---|
| `sensor/push {sentAt, sources: SensorInfo[], batches: Batch[]}` → `{acks: {sensor, channel, seq}[], window: {…}}` | phone → serve | **Device principal only** (the same gate as `connection.ts:525-535`). Synchronous append into `SensorStore`, no lock (P3). Bounded by the frame cap (8 MiB) and by a server-side per-call limit (e.g. ≤ 512 KB). |
| `sensor/state {}` → `{sources, acksHigh}` | phone → serve | After a (re)connect, the phone learns the daemon's high-water marks, so it re-sends only what the daemon lacks (dedup, F-3/F-4). |
| `sensor/capture {sensor, channel:"ecg", seconds}` | serve → phone | **S7, later.** The daemon asks the phone for an ECG snapshot. An older phone answers `MethodNotFound`, and the tool says "this phone cannot record ECG on request". |
| `sensors` (session/update) | serve → clients | **display**: the full state ("streaming · 152 bpm · 2 min ago"). It is free to add, and an older client shows `unsupported` once (`updates.ts:535`). It lets the TUI and the phone header show that the model *can* read sensors. Optional (S6). |

No `mandatory` or `blocking` kind is added, so this surface never needs a `protocol.d/` note.

#### 4. Daemon `SensorStore` (`packages/daemon/src/sensor-store.ts`)

- It is daemon-wide and keyed by `SourceRef`. Sensor data is **not session data**, so no session's log, sidecar or `history_replaced` ever carries it. AGENTS §7 "persist only the conversation" holds unchanged.
- **Bounded recent window, in memory (v1).** One ring per channel:
  - `hr`/`rr`/`contact`/`battery`: 12 h;
  - `acc`: 30 min raw plus a 1 Hz derived `cadence`/`movement` for 12 h;
  - `ecg`: the last 5 snapshots of ≤ 60 s each.
  - Limits are in samples, not time, so a misbehaving phone cannot grow the store. The defaults are proposed in Owner Q3.
- A daemon restart loses the window. The phone's outbox re-sends whatever it still retains (`sensor/state` → high-water 0). The source of truth for raw data is the phone. The daemon holds a cache for the model.
- **What *is* persisted:** a sensors tool's **result**, i.e. the summary the model read, because it is a `ChatMessage` like any tool output. This is the correct §7 behaviour, and it is called out to the owner (Owner Q5). Raw samples are never persisted daemon-side in v1.
- **Clock.** Each push carries the phone's `sentAt`. The daemon keeps `offset = min over the last N pushes of (recvAt − sentAt)` (NTP-lite, in core). Queries like "the last 10 min" are evaluated on phone time, `now − offset`. A skew above 2 s is reported in `sensor_status`, never silently corrected inside samples.

#### 5. Tools: the `sensors` group (`packages/tools/src/sensors.ts`)

Few tools, because token cost matters: `tool-toggles` exists because definitions eat context on qwen.

| Tool | What it returns |
|---|---|
| `sensor_status` | Sources, channels, last sample age, contact, battery, clock skew. |
| `sensor_read {channel, window, aggregate?}` | `hr`: avg/min/max/time-in-zone (zones from Owner Q7). `rr`: HRV (RMSSD, SDNN, artefact %). `acc`: cadence/movement. `respiration`: derived from RR (indicative). Every answer states its coverage ("54 of 60 s; 6 s no skin contact"). It never returns raw arrays beyond a small cap. A chart is the model's own `chart` call on the summary. |
| `sensor_ecg {seconds}` | **S7.** The latest snapshot, or a capture request to the phone. Its output carries the fixed line *"indicative only, not a diagnosis"*. Ectopic beats are reported as "possible irregular beats (n)". |

Registration and visibility:

- The tools are registered only when `options.sensors` is set (`serve` only, P4).
- The group is switchable as `sensors` (P6).
- Children never get it (P5).
- **"Off when no strap is paired"**: the tools stay registered (a turn's tool list must not churn on a BLE flap), but with no source ever seen, `tool-toggles`' effective state hides them (Owner Q6).

#### 6. Privacy

- **Remote model.**
  - **When the phone pairs its first sensor**, a one-time warning appears: *"Heart data goes to the model this computer uses. If that model is not on your computer, the provider receives it."*
  - **At the moment the `sensors` group becomes effective in a session whose model is not local**, a `context_note`-style display notice appears in the TUI and on the phone.
  - "Local" needs a definition (Owner Q8). The proposal is an explicit per-model `local: true` in config, rather than guessing from a loopback `baseUrl`, because an SSH tunnel makes loopback lie.
- **At rest.**
  - The phone's outbox is a file under the app's container with `NSFileProtectionCompleteUntilFirstUserAuthentication`. This is the strongest class that still lets the app write while the phone is locked during a run.
  - Retention: delete on ack, plus at most 24 h unacked.
  - The daemon writes nothing (v1).
- **Never to a pod** (P4, §7 "a pod is not trusted"). Health data in a pod would be "pod-supplied" and outside the identity boundary.

#### 7. Open points answered (the TODO's "Open for the eval")

- **Mac parity.**
  - The Mac has no strap. Parity means the **TUI reads what the phone sends**: a `serve` session driven from the Mac (`connect`) gets the same `sensors` tools (they run daemon-side), the same tool rows, and the `sensors` status line (S6).
  - A **local** Mac session (in-process worker) has no sensors, and `/tools` says why: *"sensors: phone data reaches `serve` only"*.
  - Mac BLE (CoreBluetooth on macOS with the same `HrsDriver`) is possible later as a new edge, not a redesign. It is not in v1 (Owner Q9).
- **Pods.** No sensor data in a pod session, ever. The data stays on `serve`. If the owner later wants a pod's agent to see heart data, the right shape is a laptop-side tool exposed to the pod session through the existing laptop-gated path, not shipping samples into the pod. Out of scope.
- **Battery budget.**
  - Targets, to be measured by S0 and then pinned in the README:
    - HR+RR streaming with upload: ≤ 5 %/h phone;
    - + ACC 25 Hz: ≤ 7 %/h;
    - ECG: on request only (S7), never continuous.
  - The levers, all implemented in the pure outbox:
    - **batch interval**: 10 s while a voice coach or a session screen is live, 60 s otherwise;
    - one push per interval for all channels;
    - phone-side reduction: ECG/ACC off unless asked, and ACC reduced to 1 Hz cadence/movement on the phone when the daemon has not asked for raw.
  - Cellular radio tail energy dominates, so batching matters more than payload size.
- **Location in v1 or later.** **Later, unless S0 fails** (Owner Q4). Location adds a permission, an App Review justification and a large battery cost. HR coaching does not need it. Pace and route are a real feature, but a second one. If S0 shows the link dies without it (and no voice mode), location moves into v1 as a real pace/route feature (2.5.4), never as a keep-alive.
- **Watch path (the H10's "2 BLE connections").**
  - The registry keys data by `(device, sensor)`, so a Watch edge is **a second device with its own drivers**, and the store needs no change.
  - If the phone and the Watch both stream the same strap, the daemon keeps both sources and the tools default to the **most recently active source per sensor id**. No merging, which avoids double-counting.
  - The "2 connections" claim is unverified (see External facts). S0 checks whether the Polar SDK connection and a 0x180D connection coexist.
  - A Watch app is Swift (watchOS) and would forward over the phone (WatchConnectivity) or over its own cellular link. That is a separate eval when the owner starts it.

#### 8. Slices (each is one branch, after promotion; order = dependency order)

| # | Slice | Type | Size | Blast | Suited |
|---|---|---|---|---|---|
| **S0** | **Spike (owner-assisted):** a throwaway dev build with `bluetooth-central` + the 0x180D read + a 10 s push to a logging endpoint. Measures the load-bearing assumption and records the numbers in this doc. No merge. | spike | S | contained (throwaway) | Opus + owner on device |
| S1 | **Protocol + pure core.** `@tentacle/protocol/src/sensor.ts` (the schemas, `sensor/push`, `sensor/state`); `packages/core/src/sensors/` (sample validation, outbox reducer, registry reducer, clock offset, zones, HRV, cadence folds); regenerate `protocol.json`. | feat | M | cross-module (new additive wire, no bump) | strong exec, standard review |
| S2 | **Daemon store + methods.** `sensor-store.ts` (rings, dedup by seq, high-water, limits), the device-principal handlers in `connection.ts`, the per-call limits. | feat | M | load-bearing (a new device-principal surface on the RPC peer; §7 "don't serialize") | Opus plan, **fresh-context review** |
| S3 | **The `sensors` tool group.** `packages/tools/src/sensors.ts` (`sensor_status`, `sensor_read`); `wiring.ts` registration on `options.sensors` (serve only); the deny-by-name in `subagent.ts`; the group name for `tool-toggles`. **Depends on feat/tool-toggles being merged.** | feat | M | load-bearing (the tool list the loop sends; the pod trust boundary) | Opus plan, **fresh-context review** |
| S4 | **Native module.** `modules/tentacle-sensors/` (`SensorHub`, `HrsDriver`, `PolarDriver`, restoration), its config plugin (`UIBackgroundModes: bluetooth-central`, `NSBluetoothAlwaysUsageDescription`; the single writer of those keys, merging with `audio` from P2b, never overwriting), the JS bridge with a **fake driver** for tests. | feat | M | load-bearing (a new background mode; App Review) | Opus plan, fresh-context review |
| S5 | **Phone outbox + upload.** The on-disk outbox (file protection), the foreground gate's **sensor hold** (`foreground-gate.ts`: `holdWhile(active)` beside `hold(ms)`), the uploader on the chosen computer's link, `sensor/state` resync. | feat | M | load-bearing (the gate is the ghost-attachment guard, `foreground-gate.ts:6-12`) | Opus plan, fresh-context review |
| S6 | **Phone UI + parity.** The Settings "Sensors" section (scan/pair/forget, written states), the live view (offline, written zones, sparkline), the privacy warning; the `sensors` display update + TUI/phone header line. Changelog fragment. | feat | M | cross-module | weaker model OK on the UI; standard review |
| S7 | **ECG on request.** `sensor/capture` (serve → phone), `sensor_ecg`, the snapshot ring, the "indicative" wording. | feat | S–M | cross-module | strong exec, standard review |
| S8 | **Threshold wake-up (optional).** A session-scoped rule ("wake me if HR > X for 60 s"), evaluated in `SensorStore` on append and fired through the scheduled-wake path (`wake-` turn). Rate-limited, and off when no turn-capable client is attached. | feat | M | load-bearing (it starts turns) | Opus plan, fresh-context review |

Order: S0 → (S1 → S2 → S3) ∥ (S4 → S5) → S6 → S7 → S8. S3 waits for `feat/tool-toggles`. S5 should land after, or together with, `voice-conversation` P2b. Both touch the gate and the plugin's `UIBackgroundModes`, so whichever lands second merges the key list, and the plugin test pins both.

### Files

The full list per slice is in the table. In dependency order, these are the files a promoted plan will touch:

1. `packages/protocol/src/sensor.ts` (new), `packages/protocol/src/methods.ts` (+3 method names, request schemas), `packages/protocol/src/updates.ts` (+`sensors` → `display`, S6), `packages/protocol/src/index.ts`, `packages/protocol/schema/protocol.json` (regenerated by `protocol:bump`, never by hand).
2. `packages/core/src/sensors/{sample,outbox,registry,clock,zones,hrv,cadence}.ts` (new).
3. `packages/daemon/src/sensor-store.ts` (new), `packages/daemon/src/connection.ts` (handlers beside `:525`), the `serve` host wiring that owns one `SensorStore`.
4. `packages/tools/src/sensors.ts` (new), `packages/cli/src/wiring.ts` (`options.sensors`, near `:761`), `packages/agent/src/subagent.ts` (deny list `:402-420`), the `tool-toggles` group table (wherever that task puts it).
5. `packages/client/src/remote-client.ts` (`sensorPush`, `sensorState`, and the `sensor/capture` handler, as with `pushRegister` `:1223`), `packages/client/src/mapping.ts` (the `sensors` update).
6. `apps/mobile/modules/tentacle-sensors/**` (new), `apps/mobile/app.json` (register the plugin; usage strings agreeing with it), `apps/mobile/src/foreground-gate.ts`, `apps/mobile/src/sensor-*.ts` (controller, outbox fs, settings), `apps/mobile/src/screens/*` (Settings section, live view).
7. `packages/tui/src/*` (the status line from the `sensors` update; `/tools` reason text).
8. Docs: `docs/feat/mobile-sensors.md` (this doc, promoted), `README.md` (battery numbers from S0), `changelog.d/mobile-sensors.added.md`.

### Failure modes

| # | Failure | Convergence |
|---|---|---|
| F1 | **Strap disconnects** (out of range, battery). | `SensorHub` reconnects with backoff, using CoreBluetooth's pending `connect` (it never times out, so the reconnect costs no battery). The registry shows `disconnected · since 14:02`. Samples resume with `gapBefore`. Tools report coverage, never interpolate. |
| F2 | **Skin contact lost** (the strap is still connected). | `contact=0` samples are kept. HR values during no-contact are flagged and excluded from aggregates. `sensor_read` says "6 s no skin contact". The live view shows the word and a glyph (colour-blind rule). |
| F3 | **Phone offline** (no cellular in a park). | The outbox keeps batches with seq. On reconnect, `sensor/state` returns the daemon's high-water, and the phone sends only `seq > high-water`, oldest first, ≤ 512 KB per call. **Dedup** happens on the daemon: `seq ≤ high-water` is ignored. Retention overflow (24 h or N MB) drops the oldest and marks `gapBefore`. That is never a silent drop: `sensor_status` shows "gap 13:10–13:25 (phone storage)". |
| F4 | **Relay drop / socket dies mid-push.** | The push has no ack, so the phone re-sends the same seqs. Dedup makes this idempotent. A partial apply is impossible because one call's batches are applied atomically in memory. |
| F5 | **iOS kills the app** (memory). | Restoration (`CBCentralManagerOptionRestoreIdentifierKey`) relaunches the app into the background with its subscriptions. The outbox seq state is on disk, so numbering continues. **Force-quit:** unverified (S0). The documented expectation is no relaunch, and the next launch shows "recording stopped at 14:31 (app was closed)". |
| F6 | **Two phones** paired to one `serve`. | Different `device` ids give different sources. `sensor_status` lists both. `sensor_read` defaults to the most recent active source per channel and names it in the answer. Two phones on **one strap**: different `(device, sensor)` keys, with the same rule. |
| F7 | **Clock skew** (the phone clock is wrong, or a time zone change mid-run). | Samples keep phone time. The daemon offset estimator maps "now" to phone time for queries. A skew > 2 s is reported in `sensor_status`. Monotonic seq, not time, drives dedup, so a clock jump cannot cause duplicates or losses. |
| F8 | **Bluetooth permission denied / BT off.** | The Settings section reads "Bluetooth is off for tentacle" with an "Open Settings" link. No scanning, no crash. The tools say "no sensor connected". |
| F9 | **Location denied** (only if Q4 brings location in). | HR is unaffected. Pace/route are absent, with a written notice. |
| F10 | **A pod session.** | No `options.sensors`, so no tools. `/tools` explains why. Nothing about sensors goes to a pod. |
| F11 | **Version skew: the phone is newer than `serve`.** | `sensor/push` gets `MethodNotFound`, and the phone shows "update tentacle on <computer> to receive sensor data" while the outbox keeps recording locally. **`serve` newer than the phone:** the daemon never calls `sensor/capture` unless the phone listed the capability. An older TUI shows the `sensors` display update as `unsupported` once, and tool rows render generically. |
| F12 | **Malicious or buggy phone floods `sensor/push`.** | Device principal only; per-call size cap; per-channel ring caps; a rate limit per device. Values out of physiological bounds are dropped and counted. The store can never grow unbounded. |
| F13 | **Daemon restart.** | The window is lost (memory only). The phone's `sensor/state` sees high-water 0 and re-sends what it retains (≤ 24 h). The model sees a re-filled window, with gaps only where the phone also dropped data. |
| F14 | **BLE flap during a turn.** | The tool list does not change mid-turn (the tools stay registered). The tool answers "no data since 14:02", never an error that aborts the turn. |
| F15 | **Remote model, the user unaware.** | Warnings at pairing and at the group's activation in a session (Design §6). The tools never run without the group being effective. |
| F16 | **Gate sensor hold leaks** (recording stopped but the socket stays held). | `holdWhile` is tied to the recording state in the pure controller. Stop, an error or app termination releases it. A test pins "stop ⇒ the next background suspends". |

### Tests

**Deterministic, AI-free (in `bun test`):**

- **Core** (`packages/core/test/sensors/*.test.ts`):
  - outbox reducer: seq monotonic across restart, ack trims, retention overflow sets `gapBefore`, resend after a lost ack is idempotent;
  - registry transitions;
  - clock offset under jitter and under a jump;
  - zones;
  - HRV against **recorded RR streams** (fixtures from S0's log, plus a published RR sample with known RMSSD);
  - artefact rejection;
  - cadence from a recorded ACC fixture;
  - every bound (empty window, a single sample, all-no-contact).
- **Protocol:** the schemas accept and strip unknown fields; `json-schema.test.ts` shows no drift; `sensors` is `display` in `UPDATE_CLASS`.
- **Daemon** (`sensor-store.test.ts`, `connection` tests):
  - a `token`/`pairing` principal is refused (mutation check: remove the gate, and the test fails);
  - dedup by seq; ring caps; per-call limit;
  - `sensor/push` does not wait on a running `session/prompt` (the same style as the existing concurrency tests).
- **Tools:**
  - `sensor_read` coverage text with gaps and no-contact;
  - the tools are **absent** when `options.sensors` is not passed (pod/worker);
  - a child never sees them (mutation: drop the deny entry, and the test fails);
  - a disabled `sensors` group never reaches the model (through `tool-toggles`' own seam).
- **Mobile JS** (`apps/mobile/test/`):
  - a **fake driver** replays recorded streams through the bridge interface: live view model (written zone text, contact word), uploader + outbox against a fake link (drop, reconnect, `MethodNotFound`);
  - the gate's `holdWhile` (suspend while held keeps the channel; release then suspend closes it);
  - the plugin writes `bluetooth-central` and keeps `audio` when both are present.

**Needs the device (owner-assisted, results pasted into the feat doc):**

- S0 (the load-bearing run);
- per slice S4/S5: pairing the real H10 and a generic 0x180D strap;
- a 60-min locked outdoor run with numbers (gaps, battery %/h);
- iOS memory-kill restoration (Xcode "simulate memory warning" / `kill -9` under debug);
- force-quit behaviour;
- Low Power Mode;
- S7: ECG capture while running.

None of this can run in CI, and the docs say so.

### Owner questions

1. **Start with spike S0 before any slice?** It is a throwaway dev build, owner-assisted outdoors: a 60-min locked run measuring the background BLE → relay path. *Recommendation: yes.* Everything rests on it, and it costs about half a day plus one run.
2. **Which computer receives the sensor data?** *Recommendation: one `serve` chosen in the phone's Settings → Sensors* (default: the computer the phone last attached to). It is never broadcast to every paired computer, so health data goes to one place.
3. **The daemon's recent window: memory only, with HR/RR 12 h, ACC 30 min raw (12 h derived), and the last 5 ECG snapshots?** *Recommendation: yes, memory only in v1.* The phone is the raw store. A daemon-side on-disk history is a later decision.
4. **Location (pace/route) in v1?** *Recommendation: no, later.* It flips to v1 only if S0 shows the link does not survive the background without it (and no voice mode is running). It would then come in as a real pace/route feature.
5. **Tool results persist like any tool output.** A `sensor_read` summary becomes part of the session log (`<uid>.jsonl`, on the laptop and on `serve`). Accept? *Recommendation: yes.* It is the §7 rule unchanged, and the alternative (scrubbing tool results) breaks resume. Raw samples are never persisted daemon-side.
6. **The `sensors` group default:** *Recommendation: off by default in config. Once the owner turns it on, it becomes effective only while some source has been seen on this `serve`.* The user opts in to health data once, and the turn's tool list never churns on a BLE flap.
7. **HR zones: from what?** *Recommendation: a max-HR value set in phone Settings, with the 5-zone % split* (the user can override it). It is stored on the phone, sent with `SensorInfo`, and used identically by the live view and the tools.
8. **What counts as a "local" model for the privacy warning?** *Recommendation: an explicit per-model `local: true` in config.* Absent means remote, so the warning shows. A loopback `baseUrl` is not trusted, because of SSH tunnels.
9. **Mac BLE in v1?** *Recommendation: no.* Mac parity is "the TUI reads and shows what the phone sends". A Mac `HrsDriver` edge is a later task.
10. **Build order relative to `feat/voice-conversation`:** *Recommendation: S0 now; S1–S3 after `feat/tool-toggles` merges; S4–S5 after voice-conversation P2b lands* (the shared gate and `UIBackgroundModes` key). The coach use case needs both anyway.
11. **Threshold wake-up (S8): build it in this umbrella or park it?** *Recommendation: park it until the coach has been used on real runs.* It starts turns, which is load-bearing, and a voice coach that asks "how am I doing" may make it unnecessary.

## Execution

## Review
