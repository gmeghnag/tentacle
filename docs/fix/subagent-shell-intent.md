# fix/subagent-shell-intent — a sub-agent's shell steps show their intent sentence

Type: fix · Size: S · Blast: contained (one label function; display only) · Suited: orchestrator

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-23*

Owner 23/11 ~17:10 (TUI screenshot of an `Agent` block, «Deep-dive CMCSA», 36 tool uses of raw `$ python3 - <<'EOF' …` / `$ grep -n …` lines): «mostriamo gli intents anche nei sub-agents? (se viene scritto, solo l'intent, altrimenti la chiamata al tool come ora)». The parent's shell rows already show the sentence (shell-intent-line); a child's steps are labelled daemon-side by `childToolLabel` (`packages/agent/src/subagent.ts`), which always printed `$ <command>`.

## Implementation · Execution

`childToolLabel("shell", args)` returns `shellIntent(args)` (core, the same sanitising/cut the parent rows use) when the call carries a sentence, else `$ <command>` as before. The label travels on `subagent_tool`, so the Mac TUI and the iPhone show it alike. Display only: permission asks keep the verbatim command (§7), untouched. Test: `packages/agent/test/subagent.test.ts` «a described shell call shows its intent sentence…» (red on main, green after; blank / non-string description → the command). `bun test packages/agent/test/subagent.test.ts` 39/0, `tsc --noEmit` clean, Biome clean.

## Review

*— claude-opus-5-5 (orchestrator), 2026-11-23* — S, contained: in-context review. Takes effect daemon-side: the owner's `~/assistant` serve needs a restart (new binary) to show it there.
