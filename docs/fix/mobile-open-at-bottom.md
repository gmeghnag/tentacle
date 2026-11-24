# fix/mobile-open-at-bottom — opening a session shows the transcript already at its end, no visible scroll

> **Status:** context
> **Branch:** `fix/mobile-open-at-bottom`
> **Size:** S–M · **Blast:** contained (app transcript list) · **Suited:** Sonnet triage+plan → Sonnet exec, Opus review
> **Changelog:** `changelog.d/mobile-open-at-bottom.fixed.md`

## Context

Owner 24/11: «quando apro una sessione su mobile vedo tutto lo scroll fino in fondo (per caso fa così perché si carica tutta la conversazione e renderizza realtime?), ed è un po' fastidioso per gli occhi. Possiamo aprire direttamente in fondo la conversazione?»

Symptom: on opening a session the transcript visibly scrolls from the top (or from mid-way) down to the end. Expected: the first frame the user sees is already the end of the conversation (latest messages), no animated travel; later follow behaviour (new content while at the bottom, scroll-up to read) unchanged.

Leads (unverified): the transcript list is `apps/mobile/src/screens/SessionScreen.tsx` (~:1914 `onContentSizeChange={onContentSize}`, comment ~:545) driven by the pure follow module `apps/mobile/src/follow.ts` (:69 «Not RN's scrollToEnd…», :353). Likely the list renders the whole history and follow chases the growing content height (virtualized cells measured late, estimated heights), possibly animated. Candidate fixes to weigh: keep the list hidden/opaque-0 until the first settle at the end; jump without animation for the initial catch-up; `inverted` list; render the tail first (`initialNumToRender` from the end / `initialScrollIndex`). AGENTS §1: characterise first (trigger: cold open vs reopen vs resume; magnitude: how far it travels; does it depend on transcript length?) — a simulator frame sequence or a follow.ts unit repro of the initial catch-up. If you use the simulator take `sim.lock` (`.tentacle/tmp/orchestration/sim.lock`, mkdir/rmdir) and release it.

*— orchestrator (claude-opus-5-5), 2026-11-24*

## Implementation

## Execution

## Review
