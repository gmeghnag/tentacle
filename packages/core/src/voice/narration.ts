/**
 * `narration.ts` — a tool call narrated as ONE templated line
 * (docs/feat/voice-conversation.md §3, C2).
 *
 * F7 is the whole point: the line is built from the **tool name only**. Never an
 * argument, a path, a command, a result or a pod-supplied string. On the Mac in
 * `run`/`attach` the daemon is a pod and everything it sends is pod-supplied
 * (AGENTS §7 "a pod is not trusted"); on the phone the daemon is `serve`, which
 * is trusted, but the same code runs on both edges and the rule costs nothing.
 *
 * Two throttles, both from the design:
 * - ≤ 1 line per 5 s (a turn can call a dozen tools in a second);
 * - silent while a reply chunk is still queued — the voice is mid-sentence.
 *
 * The clock is INJECTED (`atMs`), as everywhere else in this core: the fold is
 * deterministic in media time, so the throttle is testable without waiting.
 */
import type { SpeechLang } from "./voice-lang.ts";

/** The narration tunables (§3). */
export const NARRATION_DEFAULTS = {
  /** 5 s minimum gap between two narrated lines. */
  minGapMs: 5000,
  /** What an unknown tool says (an MCP tool, a future tool, a pod's invention). */
  unknownLine: "working",
  /** The spoken form of an unknown tool, Italian (the English default's twin). */
  unknownLineIt: "Sto lavorando",
} as const;

/** key: the tool name (`shell`, `fs_read`, …; `agent_task`, …). */
const LINES = {
  en: {
    shell: "Running a command",
    shell_output: "Checking a command",
    shell_kill: "Stopping a command",
    fs_read: "Reading a file",
    fs_write: "Writing a file",
    fs_edit: "Editing a file",
    fs_multi_edit: "Editing some files",
    search: "Searching",
    agent_task: "Starting a sub-agent",
    skill: "Using a skill",
    context_reset: "Clearing the context",
  },
  it: {
    shell: "Eseguo un comando",
    shell_output: "Controllo un comando",
    shell_kill: "Fermo un comando",
    fs_read: "Leggo un file",
    fs_write: "Scrivo un file",
    fs_edit: "Modifico un file",
    fs_multi_edit: "Modifico alcuni file",
    search: "Cerco",
    agent_task: "Avvio un sotto-agente",
    skill: "Uso una competenza",
    context_reset: "Azzero il contesto",
  },
} as const;

/** The narration fold's state: when it last spoke, and what it has said. */
export interface NarrationState {
  /** The media time of the last spoken line, or null if it never spoke. */
  readonly lastAtMs: number | null;
  /** The lines spoken so far (display/debug: the strip can echo them). */
  readonly spoken: readonly string[];
}

export interface NarrateInput {
  /** The tool's NAME — the only text this module echoes. */
  readonly tool: string;
  /** The current media time in ms (injected: this fold reads no clock). */
  readonly atMs: number;
  /**
   * The model's raw arguments. Accepted so a caller cannot accidentally pass
   * them anywhere else, and IGNORED — the field exists to be dropped (F7).
   */
  readonly arguments?: unknown;
  /** A reply chunk is still waiting to be spoken: say nothing over it. */
  readonly replyQueued?: boolean;
  readonly lang?: SpeechLang;
}

export interface NarrateStep {
  readonly state: NarrationState;
  readonly line: string | null;
}

/** The templated line for a tool name, in `lang`; unknown → "working". */
export function narrationLine(tool: string, lang: SpeechLang = "en"): string {
  const table: Readonly<Record<string, string>> = LINES[lang];
  return Object.hasOwn(table, tool)
    ? (table[tool] as string)
    : lang === "it"
      ? NARRATION_DEFAULTS.unknownLineIt
      : NARRATION_DEFAULTS.unknownLine;
}

/**
 * One tool call → the next state and the line to speak (`null`: stay silent).
 * A line is spoken only when the gap allows it and the voice is not mid-reply.
 */
export function narrate(state: NarrationState, input: NarrateInput): NarrateStep {
  if (input.replyQueued === true) return { state, line: null };
  const last = state.lastAtMs;
  if (last !== null && input.atMs - last < NARRATION_DEFAULTS.minGapMs) {
    return { state, line: null };
  }
  const line = narrationLine(input.tool, input.lang ?? "en");
  return {
    state: { lastAtMs: input.atMs, spoken: [...state.spoken, line] },
    line,
  };
}
