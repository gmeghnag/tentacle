/**
 * Centralised colour palette for the TUI, as chalk stylers.
 *
 * Tuned for a dark terminal (the common case): diff lines use dark background
 * tints with bright, readable foregrounds, and changed words get a brighter
 * tint on top. Values mirror Claude Code's vocabulary (claude orange, a blue
 * accent, a subtle grey) so the harness feels familiar. chalk auto-disables
 * colour when stdout is not a TTY, so the same strings degrade to plain text in
 * tests and pipes.
 */
import chalk from "chalk";

export const theme = {
  /** Claude brand orange — assistant bullets, highlights. */
  claude: chalk.rgb(215, 119, 87),
  /** Accent blue — in-progress / informational. */
  accent: chalk.rgb(99, 119, 255),
  /** De-emphasised grey for metadata, context, hints. */
  subtle: chalk.rgb(140, 140, 140),
  success: chalk.rgb(78, 201, 116),
  error: chalk.rgb(237, 84, 84),
  warn: chalk.rgb(224, 175, 74),
  diff: {
    /** Added line: dark-green background. */
    addBg: chalk.bgRgb(24, 54, 37),
    addFg: chalk.rgb(158, 224, 174),
    addGutter: chalk.rgb(96, 150, 112),
    /** Changed word within an added line: brighter green tint. */
    addWord: chalk.bgRgb(38, 110, 60).rgb(224, 255, 232),
    /** Removed line: dark-red background. */
    delBg: chalk.bgRgb(64, 28, 34),
    delFg: chalk.rgb(244, 170, 178),
    delGutter: chalk.rgb(170, 110, 118),
    /** Changed word within a removed line: brighter red tint. */
    delWord: chalk.bgRgb(140, 48, 58).rgb(255, 216, 221),
    /** Subtle dashed frame around a diff block. */
    border: chalk.rgb(88, 88, 96),
  },
} as const;

/** The dashed horizontal rule used as a diff frame's top/bottom border. */
export function dashedRule(width: number): string {
  return theme.diff.border("╌".repeat(Math.max(1, width)));
}
