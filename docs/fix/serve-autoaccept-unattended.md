# fix/serve-autoaccept-unattended — `serve` answers asks itself while auto-accept is on

> **Status:** context
> **Branch:** `fix/serve-autoaccept-unattended`
> **Size:** M · **Blast:** load-bearing (permission path, §7 single-broker / pod-not-trusted) · **Suited:** Opus plan, DeepSeek exec, one Opus fresh-context review
> **Changelog:** `changelog.d/serve-autoaccept-unattended.fixed.md`

## Context

**Problem (owner report, 2026-11-16, live).** A phone session on the Mac `serve`
(session `de3ef43f…`, auto-accept ON in its sidecar) was told "open ANSA then
CNN". ANSA opened; the next call `mcp__playwright__browser_tabs` raised a
permission ask at 15:38:52 and the turn has been stuck since: the sidecar shows
`turn.pending: [{ tool: "mcp__playwright__browser_tabs", resumable: true }]`
with `autoAccept: true`. The phone app had been closed; no TUI attached.

**Root cause (design, not a code slip).** `docs/feat/session-auto-accept.md` D1
(owner Q1 at the time): "The daemon *holds and broadcasts* the state; it never
*answers* an ask with it" — each attached client's requester answers. So with
no client attached, auto-accept does nothing and the turn waits forever. The
owner expected (and wants) the opposite: closing the app must not stop an
auto-accepted session.

**Owner decision (2026-11-16, supersedes D1/Q1 for `serve` only).** On a `serve`
daemon (trusted: the user's own host) a session with auto-accept ON is answered
BY THE DAEMON, so it keeps running with no client attached.

**Constraints (binding).**
- Only `serve` (`startDaemon`). Pod daemons (`serve --stdio`, `run`/`attach`),
  the relay and the in-process worker NEVER answer on their own: the trust bit is
  set the same fail-closed way as `daemonWakes` / the persister (AGENTS §7 "a pod
  is not trusted"; a daemon-side check is UX on a pod, so the pod path must not
  gain any auto-answer).
- Same scope as the clients' auto-accept today: whatever a client's auto-accept
  would NOT answer (e.g. `hooks_trust` asks, `hooks-trust.ts:8`) the daemon does
  not answer either. One shared predicate, not a second copy of the rule.
- Covers: an ask raised while ON; asks already pending when it is switched ON;
  a pending ask re-raised on reload (`docs/feat/suspended-turn-resume.md`) with
  the restored value ON; wake/cron turns (`docs/fix/autoaccept-wake-turns.md`).
- Attached clients stay coherent: an ask the daemon answered is resolved for
  every client (no stale prompt on the phone/TUI), and is NOT also answered by a
  client (no double resolve). Log/persist as today's client-side auto-accept does.
- Single-broker invariant (§7) holds for the laptop TUI paths that are not `serve`.

*— claude-opus-5-5 (orchestrator), 2026-11-16*

## Implementation

## Execution

## Review
