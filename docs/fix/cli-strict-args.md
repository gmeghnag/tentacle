# fix/cli-strict-args — unknown CLI flags are silently ignored or sent to the model; `-n` is not a namespace

> **Status:** review done (in-context) — awaiting the owner's OK to commit/merge
> **Branch:** `fix/cli-strict-args`
> **Size:** S–M · **Blast:** cross-module (the CLI argument dispatch for every command; no protocol, persistence or runtime change) · **Suited:** any model executes; standard in-context Review

## Context

*— claude-opus-5-5, 2026-10-20*

Found by the `feat/config-profiles` repro. The owner also asked that `run`
and `attach` accept `-n` / `--namespace` **anywhere** in the command
(before or after the pod name or image), never only right after the subcommand.

`parseFlags` (`packages/cli/src/flags.ts:18-45`) accepts anything: an
unknown `--x` is stored and never read; a short `-x` becomes a
**positional**; `--resume` takes the next word as its value. `main` then
dispatches on `args[0]` (`main.ts:140-590`), and anything that is not a
known command or mode is a one-shot prompt (`args.join(" ")`, `main.ts:584`).

**Repro** (`.tentacle/tmp/cli-flags/repro.ts`): a fake k8s API server
(`TENTACLE_K8S_SERVER`) logs the first pod request (namespace + name) and
refuses it; `fetch` is spied for model requests.

```ts
// What does `main` do with each argv? A fake k8s API server logs the first pod
// request (namespace + name); fetch is spied for model requests (one-shot).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const seen: string[] = [];
const k8s = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    seen.push(`${req.method} ${u.pathname}`);
    return new Response(JSON.stringify({ kind: "Status", code: 403, message: "stop here" }), { status: 403 });
  },
});
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/chat/completions")) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    seen.push(`MODEL prompt=${JSON.stringify(body.messages?.at(-1)?.content)}`);
    throw new Error("stop here");
  }
  return realFetch(input, init);
}) as typeof fetch;

process.env.TENTACLE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "flags-"));
process.env.TENTACLE_K8S_SERVER = `http://127.0.0.1:${k8s.port}`;
process.env.TENTACLE_K8S_TOKEN = "t";
process.env.TENTACLE_POD_BIN = "/bin/sh"; // never built/sent: the first request is refused
delete process.env.TENTACLE_POD_NAMESPACE;
const { main } = await import("../../../packages/cli/src/main.ts");

const cases: string[][] = [
  ["--namespace", "dev", "run", "--image", "busybox"].slice(2),
  ["run", "--image", "busybox", "--namespace", "dev", "mypod"],
  ["run", "-n", "dev", "--image", "busybox", "mypod"],
  ["run", "--image", "busybox", "mypod", "-n", "dev"],
  ["run", "--image", "busybox", "--namspace", "dev"],
  ["attach", "mypod", "--namespace", "dev"],
  ["attach", "--namespace", "dev", "mypod"],
  ["attach", "-n", "dev", "mypod"],
  ["attach", "mypod", "-n", "dev"],
  ["attach", "--resume", "mypod", "-n", "dev"],
  ["attach", "mypod", "--contaner", "x", "-n", "dev"],
  ["--frobnicate", "say", "hi"],
];
for (const args of cases) {
  seen.length = 0;
  const out: string[] = [];
  const code = await main(["bun", "tentacle", ...args], { write: (t) => out.push(t) });
  const err = out.join("").split("\n").find((l) => /error|usage|\[pod\]/i.test(l)) ?? "";
  console.log(`${args.join(" ").padEnd(46)} → exit=${code} ${seen[0] ?? "(no request)"}  ${err.trim().slice(0, 90)}`);
}
k8s.stop(true);
process.exit(0);
```

Output on `main` (`3dcd5fa`), 2026-10-20. The first case is a harness slip
and is equivalent to `run --image busybox`:

```
run --image busybox                            → exit=1 POST /api/v1/namespaces/default/pods  [pod] creating tentacle-4d1fcd75 (image busybox) in namespace default…
run --image busybox --namespace dev mypod      → exit=1 POST /api/v1/namespaces/dev/pods  [pod] creating mypod (image busybox) in namespace dev…
run -n dev --image busybox mypod               → exit=1 POST /api/v1/namespaces/default/pods  [pod] creating -n (image busybox) in namespace default…
run --image busybox mypod -n dev               → exit=1 POST /api/v1/namespaces/default/pods  [pod] creating mypod (image busybox) in namespace default…
run --image busybox --namspace dev             → exit=1 POST /api/v1/namespaces/default/pods  [pod] creating tentacle-ec6afb05 (image busybox) in namespace default…
attach mypod --namespace dev                   → exit=1 GET /api/v1/namespaces/dev/pods/mypod  [pod] attaching to mypod in namespace dev…
attach --namespace dev mypod                   → exit=1 GET /api/v1/namespaces/dev/pods/mypod  [pod] attaching to mypod in namespace dev…
attach -n dev mypod                            → exit=1 GET /api/v1/namespaces/default/pods/-n  [pod] attaching to -n in namespace default…
attach mypod -n dev                            → exit=1 GET /api/v1/namespaces/default/pods/mypod  [pod] attaching to mypod in namespace default…
attach --resume mypod -n dev                   → exit=1 GET /api/v1/namespaces/default/pods/-n  [pod] attaching to -n in namespace default…
attach mypod --contaner x -n dev               → exit=1 GET /api/v1/namespaces/default/pods/mypod  [pod] attaching to mypod in namespace default…
--frobnicate say hi                            → exit=1 MODEL prompt="--frobnicate say hi"  [error] Error: stop here
```

Characterization:
- **Trigger:** any unknown or short flag, and `--resume` followed by a
  positional.
- **Magnitude:** the command runs anyway, against the **wrong
  namespace** or a **pod named `-n`** (`run` *creates* it), or the flag text
  goes to the model.
- **Collateral:** none reported; every such mistake is silent.
- Already correct: the long `--namespace` works before or after the
  positional.

## Implementation

*— claude-opus-5-5, 2026-10-20*

### Load-bearing assumption

**Every flag a command reads is known at its call site**, so a closed per-command
spec can reject everything else without losing a working flag. Verified by
listing every lookup (`main.ts` + `flags.ts`):
- `connect`: `token`, `token-command`.
- `serve`: `stdio`, `model-proxy`, `host`, `port`, `tls-cert`,
  `tls-key`, `token`, `token-command`, and the five limits
  (`parseServeLimits`, `flags.ts:83-125`).
- `run`: `namespace`, `image`, `bin-dir`, `resume`.
- `attach`: `namespace`, `container`/`-c`, `bin-dir`, `resume`.
- TUI: `-i`/`--interactive`, `resume`, `in-process`, `no-worker`.
- `--plain`: none.

### Preconditions

- Session uids are UUIDs (`~/.config/tentacle/sessions/<uuid>.json`); a pod
  name never has that shape in practice.
- `extractGlobalOptions` (config-profiles) already takes `--profile` off the
  front before dispatch.

### Design

- **Parser:** a pure `parseArgs(args, spec)` in `flags.ts` replaces
  `parseFlags`. The spec is `{ values, bools, optional, positional:{min,max} }`,
  and a flag may have a short alias (`namespace:-n`, `container:-c`,
  `interactive:-i`). It returns the same `{flags, bools, positional}`, or
  `{ok:false, error}`. Rules:
  - `--k v`, `--k=v`, `-s v`, `-s=v`, **anywhere** in the arguments.
  - A value flag needs a value that does not start with `-` (use `--k=-x` to
    pass one).
  - A bool with `=v` is an error.
  - An unknown `--x`/`-x` is `unknown option -x`.
  - A repeat (`-n a --namespace b`) is an error.
  - Too many or too few positionals is an error.
  - `--` ends the options.
  - `--resume` (optional value) takes the next word **only if it is a UUID**;
    `--resume=<uid>` is always explicit.
- **Dispatch** (`main.ts`), by `args[0]`:
  - `connect`/`serve`/`run`/`attach`: its spec.
  - `--plain`: no other arguments.
  - `--`: a one-shot prompt of the rest.
  - Any other `-…`: the TUI spec (so `tentacle --in-process` is the TUI, not
    a prompt).
  - Anything else: a one-shot prompt, whose text is kept verbatim. A
    `--resume` inside a prompt no longer flips to the TUI.
  - The hand-rolled `-c` loop in `attach` goes away.
- **Help:** `-n` is documented for `run`/`attach`, and `--` for prompts that
  start with `-`.

### Files

1. `packages/cli/src/flags.ts`: `parseArgs` + the specs; `parseFlags`
   removed; `extractGlobalOptions` treats any leading `-…` as a mode.
2. `packages/cli/src/main.ts`: the dispatch above.
3. Tests: `packages/cli/test/args.test.ts` (new),
   `serve-limits.test.ts` (helper), `global-options.test.ts` (cases).
4. Docs: this file, `TODO.md`.

### Failure modes

| Case | Outcome |
|---|---|
| `run -n dev …`, `… mypod -n dev`, `attach -n dev pod`, `attach pod -n dev` | Namespace `dev`, pod `mypod`/`pod`. |
| A typo (`--namspace`, `--contaner`, `-x`) | `[error] unknown option --namspace (tentacle run)`, exit 1, no cluster call. |
| `attach --resume mypod` | Resume latest, pod `mypod`. |
| `attach --resume <uuid> mypod` | Resume `<uuid>`, pod `mypod`. |
| `-n` with no value / `-n --image x` | `-n needs a value`. |
| `-n a --namespace b` | Error: given more than once. |
| `attach a b`, `run a b` | Unexpected argument. |
| `tentacle --frobnicate hi` | Unknown option; nothing reaches the model. |
| `tentacle -- --weird prompt` | One-shot prompt `--weird prompt`. |
| `tentacle fix the --resume docs` | One-shot prompt, verbatim. |

### Tests

Red first.
- `args.test.ts`: the `parseArgs` rules table.
- End to end through `main`, against the same fake k8s server as the repro
  (namespace and pod name per argv; unknown option → no request).
- One-shot unknown option → exit 1 and no model request.
- Then the real cluster (owner: namespace `test00`), read-only: `attach` to a
  missing pod, with `-n test00` before and after the name.

## Execution

*— claude-opus-5-5, 2026-10-20*

1. Repro on `main` (Context).
2. `args.test.ts` written first: red (the module had no `parseArgs`/`ARGS`).
   The end-to-end half is the repro itself, turned into assertions.
3. `flags.ts`: `parseArgs` + `ARGS` (one closed spec per command) + `cliMode`
   + `USAGE`; `parseFlags` removed. `extractGlobalOptions` treats any leading
   `-…` as a mode.
4. `main.ts`: the mode is decided once and its arguments are parsed **before**
   config, cluster or model; every branch reads `parsed`. The hand-rolled `-c`
   loop in `attach` is gone. `isStdioDaemon` reads the parsed bool. The
   one-shot prompt is `prompt` (`--` stripped).
   - Drift from the plan: `serve`'s argument errors now also come before the
     config load (planned: after).
   - Two test-only fixes: a `connect` case missing its URL, and a
     `noDelete` lint.
5. `serve-limits.test.ts`: its helper now goes through `parseArgs(…, ARGS.serve)`.
   "Needs a value" comes from the parser, with the same wording.
6. Mutations, each reverted:
   - **M1** no short aliases → 6 red.
   - **M2** unknown flags tolerated → 2 red.
   - **M3** `--resume` takes any word → 3 red.
   - **M4** the prompt keeps `--` → 1 red.
   - **M5** parse errors not enforced in `main` → 2 red.
   - **M6** repeats allowed → 1 red.
7. Gate: `bun run check` → tsc clean, Biome clean, **1246 pass, 2 skip
   (opt-in), 0 fail**.
8. Repro after the fix (fake API server):

```
run -n dev --image busybox mypod               → exit=1 POST /api/v1/namespaces/dev/pods  [pod] creating mypod (image busybox) in namespace dev…
run --image busybox mypod -n dev               → exit=1 POST /api/v1/namespaces/dev/pods  [pod] creating mypod (image busybox) in namespace dev…
run --image busybox --namspace dev             → exit=1 (no request)  [error] unknown option --namspace
attach -n dev mypod                            → exit=1 GET /api/v1/namespaces/dev/pods/mypod  [pod] attaching to mypod in namespace dev…
attach mypod -n dev                            → exit=1 GET /api/v1/namespaces/dev/pods/mypod  [pod] attaching to mypod in namespace dev…
attach --resume mypod -n dev                   → exit=1 GET /api/v1/namespaces/dev/pods/mypod  [pod] attaching to mypod in namespace dev…
attach mypod --contaner x -n dev               → exit=1 (no request)  [error] unknown option --contaner
--frobnicate say hi                            → exit=1 (no request)  [error] unknown option --frobnicate
```

9. Real cluster (owner's, namespace `test00`), read-only: `attach` to a missing
   pod. With `-n test00 nope-pod`, `nope-pod -n test00` and
   `--resume nope-pod --namespace=test00`, each reported
   `pod "nope-pod" not found in namespace "test00"`.
   `nope-pod -n test00 --contaner x` gave `unknown option --contaner` with no
   API call. `kubectl get pods -n test00` stayed empty. `run` was not exercised
   live: it creates a pod and needs a TTY for its TUI. The fake server pins
   its namespace.

## Review

*— claude-opus-5-5, 2026-10-20*

In-context Review (cross-module, S–M). Adversarial checks:

- **Nothing a command reads was dropped:** the specs were built from the
  lookup list in the load-bearing assumption. The pod runtime's own child
  command (`serve --stdio --model-proxy`, `pod-runtime.ts:328`, `:522`) fits
  `ARGS.serve`. `__delete-pod`, `--help` and `--version` are dispatched before
  parsing and are unchanged.
- **Behaviour changes, intended:**
  - `tentacle --in-process` (and any other leading `-…`) is now the TUI, not a
    one-shot prompt of that text.
  - A `--resume` inside a one-shot prompt no longer switches to the TUI.
  - `--resume <word>` takes the word only when it is a UUID; otherwise use
    `--resume=<uid>`, which is always explicit.
  - A value that starts with `-` needs the `=` form.
- **Still accepted:** `--help`/`--version` ignore trailing arguments. Harmless.
