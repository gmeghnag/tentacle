- **The slash commands are one file each, with a registry behind them.** Every
  built-in command (`/help`, `/clear`, `/compact`, `/rename`, `/sessions`,
  `/close`, `/model`, `/retry`, `/attach`, `/copy`, `/save`, `/tokens`, `/mcp`,
  `/skills`, `/agents`, `/settings`, `/exit`) now lives in its own
  `packages/tui/src/commands/<name>.ts` and declares only the slice of the
  command context it uses; `commands/registry.ts` is the one list they are
  derived from, so the palette, `/help` and the code that runs a command can no
  longer disagree. `dispatchCommand` keeps the shared guards (a skill activation
  mid-turn, a latched session switch, a session-mutating command mid-turn), and
  `/compact`/`/clear`'s machinery stayed in `App` as driver functions so the
  compaction and clear state keeps one owner. No user-visible behaviour changes.
