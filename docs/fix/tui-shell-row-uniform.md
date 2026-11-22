# fix/tui-shell-row-uniform — one shape for every tool row (TUI): no repeated outcome, command inside the `⎿` block

Type: fix · Size: S–M · Blast: contained (TUI rendering only) · Suited: DeepSeek exec + Opus review

## Context

Owner 2026-11-22 ~01:35 (screenshot of a TUI turn with three shell rows that carry an intent sentence): since feat/shell-intent-line the rows lost uniformity and repeat themselves:
1. the title shows `✓ 0.0s` / `✗ exit 1 0.2s` AND the body shows `⎿ exit=0` / `exit=1` — a repetition: «togliamolo»;
2. the command sits on its own line ABOVE the `⎿` block (`  │ $ memory_pressure …`), a shape no other tool row has, and misaligned.

Today (real frames, main 1791d22b):
```
● Uso memoria ✓ 0.0s
  │ $ memory_pressure 2>/dev/null | tail -3; echo ---; vm_stat | head -5
⎿ exit=0
  Pageouts: 77
```
Owner chose variant **B** (accepted directly, 01:45), shown to him as plain text:

compactShell OFF:
```
● Uso memoria 0.2s
⎿ $ memory_pressure 2>/dev/null | tail -3; echo ---; vm_stat | head -5
  Pageouts: 77

● Container in esecuzione 0.2s
⎿ $ podman ps 2>&1; echo ---; docker ps 2>&1
  exit=1
  Cannot connect to Podman. Please verify your connection …

● Read note/demo-agent.md 0.0s
⎿ # Demo agent
  Un agente che legge.
```
compactShell ON (beta): a successful shell row drops the `$` line, so `⎿` starts the output; a successful command with NO output is the title line alone; a failed one is shown in full (same as OFF):
```
● Uso memoria 0.2s
⎿ Pageouts: 77
  System-wide memory free percentage: 90%

● Creo la cartella dei log 0.0s

● Container in esecuzione 0.2s
⎿ $ podman ps 2>&1; echo ---; docker ps 2>&1
  exit=1
  Cannot connect to Podman. Please verify your connection …
```
Rules: no `✓` and no `✗ exit N` in ANY tool title (shell with or without intent); duration stays. `exit=N` is printed only when N ≠ 0 (as the first line after the `$` line). The `$ command` line is the first line of the `⎿` block, dimmed like today's command text; output follows at the block's indent (col 2). Edit/Write/Read rows unchanged (they already have this shape). The expanded view (ctrl+o) and the permission ask keep the verbatim command (the ask is a security rule of shell-intent-line — do NOT touch it). Colour-blind owner: success = no `exit=` line, failure = `exit=N` in text; colour only reinforces. Rows WITHOUT an intent sentence (`● Bash <cmd> 0.2s`) follow the same exit rule (no `exit=0`), the command stays in their title as today.
Phone: out of scope (owner said «da terminale»).

*— claude-opus-5-5 (orchestrator), 2026-11-22*

## Implementation

- Load-bearing assumption: all of this is decided in the pure TUI row builder (`packages/tui/src/render-lines.ts`, `itemLines` / the tool-row + shell-intent branches added by feat/shell-intent-line, and the compactShell gate). Verify by `rg -n "exit=|✓|compactShell|│ " packages/tui/src` before editing and cite file:line in Execution.
- Change only the view builder (pure); components untouched. Keep the blink OFF phase (`offPhaseRows`) working: the running row (no outcome yet) is unchanged.
- Tests (red on main first, then green): snapshot-style line tests for the four cases above (intent ok / intent fail / compactShell ok with output / compactShell ok without output) + a plain `Bash` row ok (no `exit=0`) + a failed plain `Bash` row (`exit=1` kept). Update existing tests that pinned `✓` / `exit=0` / `│ $`; say which in Execution. Also check `scripts/mockup-kit` TUI cases still generate (`bun run mockup-kit`) if they snapshot these rows.
- changelog.d/tui-shell-row-uniform.changed.md (one bullet).

## Execution

## Review
