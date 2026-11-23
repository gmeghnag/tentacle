# fix/protocol-bump-pin — a protocol bump edits the pin too; no hand-written versions in tests

Type: fix · Size: S · Blast: cross-module (merge tooling + tests) · Suited: Opus plan → DeepSeek exec → Opus review

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-23*

Found 23/11 04:15 merging `feat/agent-workflows`, the first `PROTOCOL_VERSION` bump since `docs/feat/protocol-version-at-merge.md` (24 → 25): (1) `bun run protocol:bump` (`scripts/protocol-bump.ts`) wrote `packages/protocol/src/version.ts` but NOT the single pin `expect(PROTOCOL_VERSION).toBe(N)` in `packages/protocol/test/version.test.ts:30`, although its design says «a bump is 2 hunks — version.ts and version.test.ts — produced by the same command» (`docs/feat/protocol-version-at-merge.md:~187`); (2) 7 test files had hand-written `protocolVersion: 24` / `.toBe(24)` (`packages/client/test/pairing.test.ts`, `packages/daemon/test/{relay-link,relay-link-push,device-accept,project-pairing,ws-device-route}.test.ts`, `packages/cli/test/serve-devices.test.ts`) — green on every branch, red only after the merge. Both were hand-fixed in the merge (`4ceba7b3`, now `PROTOCOL_VERSION`). Owner 23/11 ~13:25: run it.

Goal: (a) `protocol:bump` also rewrites the pin line (and its test proves it, red first); (b) a guard test that FAILS on any hand-written protocol version literal in tests outside `version.test.ts` (e.g. `protocolVersion: <digits>`, `toBe(<digits>)` next to `protocolVersion`, `PROTOCOL_VERSION`-equal literals) — cheap, deterministic, no false positives on unrelated numbers (prove it on today's tree: zero hits; mutation: add `protocolVersion: 25` to a test → red). Keep `toBeGreaterThanOrEqual(n)` floors (they are by design).

## Implementation

## Execution

## Review
