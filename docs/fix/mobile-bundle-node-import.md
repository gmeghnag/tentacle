# fix/mobile-bundle-node-import — the phone bundle must reach no Node built-in

> **Status:** execution
> **Branch:** `fix/mobile-bundle-node-import`
> **Type:** fix · **Size:** S–M · **Blast:** cross-module · **Suited:** Opus exec, standard Review
> **Changelog:** none — the broken state never shipped in a release (it blocked the iOS build from `main`); internal build fix.

## Context

*— claude-opus-5-5, 2026-11-20*

Every iOS archive from `main` failed after the caps-before-first-message merge
(`cf6c6d80`). Metro (recorded in `TODO.md`, `.tentacle/tmp/mobile-ota/archive.log:72145`
of the 17:39 build — that log has since been overwritten by a later build):

```
Unable to resolve module node:crypto from packages/agent/src/session-store.ts
ARCHIVE FAILED
```

Cause: the merge added `packages/client/src/pending-capabilities.ts`, which
imports RUNTIME values (`CapabilityRefusal`, `applyCapabilityOp`) from the
`@tentacle/agent` barrel. The app bundles `@tentacle/client`, so Metro walks the
whole agent barrel (`session-store.ts`, `tool-output.ts` → `node:crypto`,
`node:fs`, …). A subpath export of `agent/src/capabilities.ts` would not help:
that module itself imports the `@tentacle/config` and `@tentacle/tools` barrels.

Gate gap: neither `bun run check` nor the mobile e2e gate bundles with Metro, so
nothing caught it.

**Repro** (2026-11-20, on `main` = `26dd1137`): the new regression test (below),
first run, before the fix — 19 chains, every one through `pending-capabilities.ts`;
first one shown:

```
$ bun test apps/mobile/test/bundle-node-free.test.ts
error: expect(received).toBe(expected)
- ""
+ "apps/mobile/index.ts
+   → apps/mobile/App.tsx
+   → packages/client/src/index.ts
+   → packages/client/src/pending-capabilities.ts
+   → packages/agent/src/index.ts
+   → packages/agent/src/session-store.ts
+   → node:crypto
   … (node:fs, node:path; tool-output.ts → node:crypto, node:fs, node:fs/promises; …)
(fail) mobile bundle graph > no Node built-in is reachable from the app entry
 1 pass
 1 fail
```

And Metro itself, the same import restored on the fixed branch
(`expo export --platform ios`, from `apps/mobile`):

```
Error: Unable to resolve module node:crypto from …/packages/agent/src/session-store.ts: No resolver is registered for the 'node:' …
>  8 | import { createHash } from "node:crypto";
EXIT 1
```

## Implementation

*— claude-opus-5-5, 2026-11-20*

### Load-bearing assumption

`@tentacle/core` is RN-safe and already in the app bundle: `apps/mobile/package.json`
depends on it, its only workspace dependency is `@tentacle/protocol`
(`packages/core/package.json`), and no file under `packages/core/src` imports
`node:` (`rg 'from "node:' packages/core/src` → none). Proven empirically by the
new test going green with core in the graph.

### Preconditions

- What the client needs is pure: `applyCapabilityOp` / `CapabilityRefusal` /
  `SessionCapabilities` / `CapabilityOp` (`packages/agent/src/capabilities.ts:26-111`
  before the fix). Its only non-local inputs: `expandToolName` (`packages/config/src/tool-groups.ts:56`,
  pure data over `TOOL_GROUPS`/`ALWAYS_ON_TOOLS`/`BUILTIN_TOOL_NAMES`) and
  `SKILL_TOOL_NAME` (`packages/tools/src/skill.ts:16`, `"skill"`), used only in
  the refusal's message.
- `ALWAYS_ON_TOOLS` is exactly `["skill"]` (`config/src/tool-groups.ts:14`), so
  `ALWAYS_ON_TOOLS.includes(op.name)` gives the same message as
  `op.name === SKILL_TOOL_NAME`.
- `@tentacle/config` does not depend on core today; core does not depend on
  config → adding `config → core` makes no cycle.

### Design

One source of truth, moved down to core; the old homes re-export:

1. `packages/core/src/tool-groups.ts` — the name table (`ALWAYS_ON_TOOLS`,
   `TOOL_GROUPS`, `BUILTIN_TOOL_NAMES`, `isToolGroup`, `expandToolName`,
   `groupOfTool`). `config/src/tool-groups.ts` imports + re-exports them and
   keeps the `tools.enabled` resolution (it needs `applyProfile`/`FileConfig`).
2. `packages/core/src/capabilities.ts` — `SessionCapabilities`,
   `NO_CAPABILITIES`, `CapabilityKind`, `CapabilityOp`, `CapabilityRefusal`,
   `applyCapabilityOp`. `agent/src/capabilities.ts` re-exports them (agent API
   unchanged) and keeps the projections (`projectTools`, `projectSystem`, …).
3. `client/src/pending-capabilities.ts` imports from `@tentacle/core`.
4. A deterministic graph test (below) closes the gate gap.

### Files

- `packages/core/src/tool-groups.ts` (new), `packages/core/src/capabilities.ts` (new),
  `packages/core/src/index.ts` (+2 `export *`).
- `packages/config/src/tool-groups.ts` (table removed, re-export), `packages/config/package.json`
  (+ `@tentacle/core`), `bun.lock`.
- `packages/agent/src/capabilities.ts` (pure core removed, re-export).
- `packages/client/src/pending-capabilities.ts` (import source).
- `apps/mobile/test/bundle-node-free.test.ts` (new).

### Failure modes

- *Someone re-adds a runtime import of a Node-reaching barrel to anything the
  app bundles* → the graph test fails with the chain (mutation below).
- *Type-only imports* are erased by Metro's TS transform; the test uses
  `Bun.Transpiler.scanImports`, which drops `import type`, `export type` and
  all-`type` specifier lists — so a type-only `@tentacle/agent` import (e.g.
  `client/src/mapping.ts:10`) is correctly not followed. It is conservative
  otherwise (an import whose bindings are only used as types is still followed)
  → a false positive is possible, never a false negative of that kind.
- *Third-party packages* are leaves (Metro resolves them with RN fields); the
  test covers our workspace code, which is where this class of bug comes from.
- *Dynamic `import()` / `require()`* are followed too (Metro bundles them).
- *Asset requires* (`.html`, `.png`) are leaves.
- *An unresolvable relative import or a missing `exports` subpath* throws — the
  test cannot silently skip a branch of the graph.

### Tests

`apps/mobile/test/bundle-node-free.test.ts`: BFS from `apps/mobile/index.ts`,
following relative files (iOS platform extensions first, like Metro) and
workspace `@tentacle/*` via each package.json `exports` map (subpaths included);
any `node:` specifier or bare Node built-in (`builtinModules`) fails with the
import chain. A second case pins the walker's classification (non-vacuity).
~40 ms, no Metro.

## Execution

*— claude-opus-5-5, 2026-11-20*

As planned, in order: test (red, above) → core modules → config/agent
re-exports → client import → `bun install` (lock gains the config→core dep;
bun also canonicalises one blank line in `bun.lock`, kept as bun writes it —
`bun install --frozen-lockfile` passes).

Drift: `CapabilityRefusal`'s message keys on `ALWAYS_ON_TOOLS` instead of
`SKILL_TOOL_NAME` (core cannot import `@tentacle/tools`); same text for the only
always-on tool, `skill`.

Green:

```
$ bun test apps/mobile/test/bundle-node-free.test.ts
 2 pass
 0 fail
```

Mutation (`pending-capabilities.ts` imports from `@tentacle/agent` again) → the
test fails again with the `node:crypto`/`node:fs`/`node:path` chains, and
`expo export --platform ios` fails with `Unable to resolve module node:crypto`
(Context); reverted.

Real bundle, fixed tree (`apps/mobile`, `./node_modules/.bin/expo export --platform ios`):

```
› ios bundles (1):
_expo/static/js/ios/index-9a1db47282e126e1eb5d2420f8acae62.hbc (4.9MB)

› Files (1):
metadata.json (1.2KB)

Exported: ../../.tentacle/tmp/mbni/export
EXIT 0
```

Gate: `bun run check` → typecheck ✓, lint ✓ (`Checked 2160 files … No fixes
applied`, 0 errors), `15942 pass · 5 skip · 0 fail` (15947 tests, 1133 files).
The 5 skips are all opt-in: docker ×2 (`TENTACLE_DOCKER_TESTS`), k8s ×2
(`TENTACLE_K8S_SERVER`), slow ×1 (`TENTACLE_SLOW_TESTS`).

Unverified: a full Xcode archive (`ARCHIVE` path) was not run; `expo export`
runs the same Metro resolution that failed there. Verify with the next
mobile-ota build.

## Review

*— claude-opus-5-5, 2026-11-20*

**Verdict: APPROVE-WITH-NITS.** No HIGH/MEDIUM findings. Same model as the executor, fresh context only, so blind spots the two passes share can survive both (blast is cross-module, so that is acceptable).

**Gate (re-run):** `bun run typecheck` ✓; `bun run lint` ✓ (2160 files, 0 issues). Touched tests: `bundle-node-free` + `packages/client` + `packages/config` + agent capabilities → 1374 pass / 0 fail; `packages/core` + `daemon/test/tool-toggles` → 704 pass / 0 fail. I did not re-run the full suite.

**Premises:** all TRUE. On `main`, `pending-capabilities.ts:19` imports values from `@tentacle/agent`; `agent/src/index.ts:8` re-exports `session-store.ts`, and `session-store.ts:8` imports `node:crypto`. Nothing in `core/src` imports `node:`. Core depends only on protocol, so `config → core` adds no cycle. `ALWAYS_ON_TOOLS === ["skill"]`. The daemon's `instanceof CapabilityRefusal` (`hosted-session.ts:3094`) still sees ONE class, because agent re-exports core's.

**Attacks tried:**
1. *Does the walker drop any import form?* A scratch run of `Bun.Transpiler.scanImports` keeps `export {…} from`, `export * from`, dynamic `import()`, `require()`, side-effect imports and imports bound but never used. It drops only `import type`. It errs on the conservative side, as the doc claims.
2. *Is test 1 vacuous?* A scratch copy of the walker visits 394 files from `index.ts`, including `pending-capabilities.ts`, `core/src/{capabilities,tool-groups}.ts`, 31 client files and 12 transport files. It reaches 0 files under agent, config or tools, and finds 0 Node built-ins. On `main` the chain index → client → pending-capabilities → agent barrel → session-store → `node:crypto` exists in source, which matches the red run recorded in the doc.
3. *Did the error message drift?* For `skill`, the text is identical. The one test pinning that text (`config/test/tool-groups.test.ts:81`) passes.
4. In-tree mutations could not run: this session needs approval for them. Non-vacuity rests on (1) and (2) plus the executor's recorded red.

**Nits (not blocking):** test 2 ("non-vacuity") pins only `scanImports` and `resolveSpecifier`. If a change broke graph traversal (e.g. workspace resolution returning external), test 1 would turn green without testing anything. A cheap guard: assert that the visited set contains `packages/client/src/pending-capabilities.ts`. Third-party packages are treated as leaves, a gap the doc already states.

**Executor behaviour:** the plan was followed, the one drift is declared, and the Metro export was verified both red and green. The unverified Xcode archive is stated honestly.
