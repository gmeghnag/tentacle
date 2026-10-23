# feat/license-apache — Relicense the repo from MIT to Apache-2.0

> **Status:** execution
> **Branch:** `feat/license-apache`
> **Size:** S · **Blast:** contained · **Suited:** any model; standard Review

Type: feat · Size: S · Blast: contained · Suited: any model + standard Review

## Context

*— claude-opus-5-5 (orchestrator), 2026-10-23*

The repo was public under MIT from 2026-10-19 (no prior decision record: MIT
was the initial default). Owner decision (2026-10-23): **relicense to
Apache-2.0 from this commit on.** Reasons weighed:

- explicit patent grant from every contributor, with patent retaliation;
- explicit "no trademark rights" (§6) — protects the *tentacle* name, the
  `tentacle.so` domain and the relay service;
- inbound = outbound for contributions (§5);
- the Kubernetes / CNCF ecosystem standard (CNCF requires Apache-2.0).

Facts and constraints recorded:

- **The MIT grant on what was already published is irrevocable.** Copies
  obtained up to the parent of this commit stay usable under MIT; the change
  applies going forward. History is NOT rewritten (no amend / force-push: it
  would break clones and revoke nothing). At the decision: 0 forks, 5 stars.
- **Owner: no note about the change in `README.md`.**
- Neither MIT nor Apache-2.0 stops a third party from hosting a competing
  relay; that would need AGPL / BSL / FSL (not chosen).
- Apache-2.0 is GPLv3-compatible, not GPLv2-only-compatible (no impact today).

## Implementation

*— claude-opus-5-5 (orchestrator), 2026-10-23*

- `LICENSE` ← the official text from `https://www.apache.org/licenses/LICENSE-2.0.txt`
  (sha256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`).
- `NOTICE` (new): project name + `Copyright 2026 Gabriel Meghnagi` (the same
  holder as the former MIT line).
- `"license": "Apache-2.0"` (SPDX id) in the 16 `package.json`: root, the 14
  packages, `apps/mobile`.
- `docs/eval/mobile-app.md` (decision 18 and the summary) updated.
- Left as is, on purpose: `scripts/test/release.test.ts:118` (a fake package
  fixture, not the project's licence); historical mentions of "the public MIT
  release" in `TODO.md` / `docs/feat/tui-brand-color.md` (records of the time).

## Execution

*— claude-opus-5-5 (orchestrator), 2026-10-23*

Done as planned. Gate: see the commit's verification (`bun run lint` for the
JSON files; `bun test scripts` for the release fixture).

## Review

