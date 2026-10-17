# Pod delete-on-exit — fix plan

> **Status:** done — shipped 2026-10-15 · legacy doc (pre-AGENTS §10), not retrofitted to the four sections

## Bug
Closing the TUI with Ctrl+C (SIGINT) orphans the pod. `terminal.ts`'s signal
handler calls `process.exit(130/143)` **before** `startTui` resolves, so
`main.ts`'s `finally { runtime.dispose() }` (the only place `deletePod` runs)
never executes. The async `deletePod` is never fired.

## Fix (approved design)
Register a `process.on("exit")` safety net that deletes the pod via a
**detached, fire-and-forget child** running `bun -e`. `process.exit` fires
`exit` handlers on **every** path (SIGINT/SIGTERM/normal/crash), so this covers
all of them uniformly. The child does a single `DELETE /pods/<name>` with a
client-side timeout and is `detached`+`unref`'d, so:
- it never blocks exit (the apiserver answers DELETE immediately; kubelet
  teardown happens after the 200);
- a pod stuck in Terminating doesn't keep the child alive (the child only does
  the HTTP call, not the wait);
- the child self-terminates on its timeout if the HTTP hangs.

## Verified assumptions (probed)
- `Bun.spawn({detached:true})` + `.unref()` → child survives `process.exit`.
- `Bun.spawn` works inside a `process` `exit` handler.
- A compiled binary canNOT self-execute as `bun -e` → the child must be the
  real `bun` on PATH (the injection flow already requires bun on the laptop).

## Changes
1. `packages/k8s/src/pod-cleanup.ts` (NEW):
   - `export interface PodDeleteOptions { server; namespace; podName; token?;
     tls? }` (`tls` = `{ca?,cert?,key?,rejectUnauthorized?}`).
   - `buildPodDeleteScript(): string` — a STATIC bun script that reads
     `TENTACLE_POD_DELETE_*` env vars (url/token/tls) and does
     `fetch(url, {method:"DELETE", ...tls, signal: AbortSignal.timeout(5000)})
     .catch(()=>{})`. Secrets stay in env (not in the `-e` string visible in `ps`).
   - `spawnPodDelete(options, spawn = Bun.spawn): void` — sets the env, spawns
     `["bun", "-e", script]` with `{detached:true, stdio:["ignore","ignore","ignore"]}`
     (Bun's `stdio` is a MUTABLE `[In,Out,Err]` tuple, not the `"ignore"`
     shorthand — see "As-built deviations" below), `.unref()`,
     swallows all errors (best-effort). Injectable `spawn` for tests.
2. `packages/k8s/src/client.ts`:
   - `KubeClientOptions.tls?` (new, optional) + `KubeClient.tls` field.
   - `KubeClient.deletePodBestEffort(name): void` → `spawnPodDelete({...})`.
3. `packages/k8s/src/kube-auth.ts`: populate `tls` in the returned options
   (it already computes the `tls` object).
4. `packages/k8s/src/index.ts`: export `pod-cleanup.ts`.
5. `packages/cli/src/pod-runtime.ts`:
   - `PodCluster.deletePodBestEffort(name): void` (new).
   - `startPodRuntime`: right after `createPod` succeeds,
     `registerPodCleanup(deps.kube, name, deps.log)` → `process.once("exit",
     () => kube.deletePodBestEffort(name))`. Extracted to a testable helper.
   - Keep the existing `disposeTransport` `deletePod` (clean path) + the
     pre-ready catch `deletePod` (they coexist; a duplicate DELETE is a 404 no-op).
6. Tests:
   - `packages/k8s/test/pod-cleanup.test.ts` (NEW): `buildPodDeleteScript`
     contains the DELETE + timeout; `spawnPodDelete` (fake `spawn`) is called
     with `["bun","-e",…]`, `detached:true`, and the right env (url/token/tls).
   - `packages/cli/test/pod-runtime.test.ts`: `FakeCluster.deletePodBestEffort`
     records calls; a test captures the registered `exit` listener (monkey-patch
     `process.on`), runs `startPodRuntime`, fires the listener, asserts
     `deletePodBestEffort(name)` was called.

## Validation loop
`bun run typecheck` + `bun run lint` + `bun test` — must be green.

## As-built (shipped, 2026-10-15)
- **Status: SHIPPED** — all changes above are in the working tree, validated
  (typecheck + lint clean; 519 pass / 0 fail / 1 skip at commit). `registerPodCleanup`
  uses `process.once("exit", …)` (a pod is created once per process).
- **Deviation — `stdio` is a tuple, not `"ignore"`.** `bun-types` declares
  `stdio?: [In, Out, Err]` (a *mutable* tuple); the `"ignore"` shorthand is not
  accepted and a `readonly` tuple is not assignable to the mutable one. So
  `PodDeleteSpawnOptions.stdio` is `["ignore", "ignore", "ignore"]` and the test
  asserts `toEqual(["ignore", "ignore", "ignore"])`. (`detached: true` is
  accepted by the type as-is.)
- **Deviation — the `Bearer` test assertion.** `buildPodDeleteScript` legitimately
  contains the static header prefix `"Bearer " + token` (a prefix, not a secret),
  so the test asserts `not.toMatch(/Bearer [A-Za-z0-9]/)` (no *literal* token
  inlined) rather than `not.toContain("Bearer ")`.
- The delete-on-exit child and the single-line startup rendering (§9 of
  `docs/feat/pod-binary-injection.md`) are independent: the child only needs `bun`
  on PATH, and the rendering only affects the laptop-side log.
