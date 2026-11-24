/**
 * What a slash command may touch: the ports App hands it, one capability each
 * (docs/feat/app-decomposition.md S2). `dispatchCommand` receives the whole
 * object; every `commands/<name>.ts` declares a `Pick<>` of exactly the fields
 * it uses, so a new command that needs an existing capability edits NOTHING
 * shared — and one that needs a new capability edits this file and App's
 * construction of it (stated, not hidden; plan H4(3)).
 *
 * Two field kinds, and the difference is a SAFETY property (plan H3):
 * - a plain value/callback keeps the identity rule it has in App today (a
 *   `useCallback` keeps its dep array, a prop keeps being a prop);
 * - a `Live<T>` is a ref: it is read AT COMMAND TIME, never at render time, so
 *   two keys delivered with no render between them behave as they always did.
 * A getter (`() => boolean`) is a ref read too, for a fact the command layer may
 * ask about but must not own.
 *
 * Nothing here is React, and nothing here is a snapshot of a render.
 */
import type { WorkflowRow } from "@tentacle/protocol";
import type { AppProps, SessionController } from "../app-types.ts";
import type { SlashSkill } from "../commands.ts";
import type { OpenPanel } from "../panel.ts";
import type { ScheduleDockRow } from "../schedule-view.ts";
import type { SkillsSync } from "../skills-sync.ts";
import type { DisplayState } from "../state.ts";
import type { CatalogueView } from "../workflow-view.ts";

/** A ref, read when the command runs (never a value captured at render). */
export interface Live<T> {
  current: T;
}

export interface CommandContext {
  /** Append a system line (scrolls to the bottom and flushes the frame). */
  /** `level: "warn"` marks a harness line the person should notice (docs/feat/harness-notices.md S2). */
  readonly pushNotice: (text: string, level?: "warn") => void;
  /** Put `text` back in the input after any draft, and say why. */
  readonly restoreInput: (text: string, why: string) => void;
  /** The PROMPT's input line: its history, the recall index, and the draft. */
  readonly historyRef: Live<string[]>;
  readonly histIndexRef: Live<number>;
  readonly draftRef: Live<string>;
  /** The current session — read at command time. */
  readonly sessionRef: Live<SessionController | null>;
  /**
   * The session's armed scheduled wakes, as this TUI last reported them
   * (docs/feat/cron-tool.md S5): `/schedule` opens on them, and the panel's
   * delete is the daemon's echo, never a local edit.
   */
  readonly schedulesRef: Live<readonly ScheduleDockRow[] | undefined>;
  /**
   * The session's workflow runs, as this TUI last reported them
   * (docs/feat/workflows-ui.md D3): `/workflow` opens on them and picks the run
   * `stop`/`resume` act on. `undefined` = no run feed (never "no run").
   */
  readonly workflowsRef: Live<readonly WorkflowRow[] | undefined>;
  /**
   * The project's workflows as the last catalogue read answered (slice 2b / D8):
   * `/workflow` paints them, `run <name>` takes the hash the user saw, and the
   * section's own facts (the folder, the `not versioned` sentence) come from it.
   */
  readonly workflowCatalogueRef: Live<CatalogueView>;
  /**
   * Ask for a fresh catalogue read (coalesced). `/workflow` calls it: an editor
   * outside tentacle is seen at the next of D8's moments, and this is one.
   */
  readonly refreshCatalogue: () => void;
  /**
   * Put a prepared command in the input (a catalogue row that needs inputs, D8):
   * `/workflow run <name> <req>=` filled in, with the panel closed.
   */
  readonly prefill: (text: string) => void;
  /** The display state (`running`, the transcript rows, the token totals). */
  readonly stateRef: Live<DisplayState>;
  /**
   * A compaction holds the session right now (`/compact`'s own latch, or
   * another device's). A read, not the machinery: the refs behind a compaction
   * stay App-side, in `startCompaction` (plan M5).
   */
  readonly busyCompacting: () => boolean;
  /** The session a `/settings sync` is in flight on. */
  readonly syncingRef: Live<SessionController | null>;
  /** A session switch is latched (`switchingRefusal` refuses meanwhile). */
  readonly switchingRef: Live<boolean>;
  /** The last prompt sent, for `/retry`; and whether it named images. */
  readonly lastUserRef: Live<string | null>;
  readonly lastHadImagesRef: Live<boolean>;
  /** The merged built-in + skill vocabulary, as the palette and `/help` show it. */
  readonly skills: () => readonly SlashSkill[];
  /** The skill cache: `/help` and `/skills` settle/refresh it; the unknown path asks if it is stale. */
  readonly skillsSync: SkillsSync;
  /** Start a turn with `text` (a skill activation or a `/retry`). */
  readonly run: (text: string, opts?: { readonly skill?: string }) => Promise<void>;
  /** `/quit`'s decision and its confirmation (`quitCommandStep`). */
  readonly requestQuit: (confirmed: boolean) => void;
  /** `/compact`'s machinery: an App-level driver (it owns the compaction refs, plan M5). */
  readonly startCompaction: () => void;
  /** `/clear`'s machinery: an App-level driver (it owns the clear refs, plan M5). */
  readonly requestClear: () => void;
  /** `/move`'s machinery: an App-level driver (it owns the hop's turn-boundary refs). */
  readonly requestHop: (raw: string) => void;
  /** Resolve `raw` once more, after the skill list was asked again. */
  readonly reResolve: (raw: string) => void;
  /** Quit the TUI (Ink's `useApp().exit`). */
  readonly exit: () => void;
  /** The `'sessions'` directory, when the runtime has one. */
  readonly sessions: AppProps["sessions"];
  /** Open a list panel: its loading state, then whatever the load resolves to. */
  readonly openPanel: (
    initial: OpenPanel,
    load: () => Promise<OpenPanel>,
    describe: (error: unknown) => string,
  ) => void;
  /** The MCP servers' status, when the runtime reports it. */
  readonly mcpStatus: AppProps["mcpStatus"];
  /** The dock's Ctrl+T toggle (`/agents`: the key and the command cannot disagree). */
  readonly toggleAgents: () => void;
  /** `/attach <path>`'s body (the attachments own it). */
  readonly attachCommand: (raw: string) => void;
  /** Write a text to the clipboard. */
  readonly clipboard: (text: string) => Promise<void>;
  /** Save a file (the host's or Bun's). */
  readonly saveFile: (path: string, content: string) => Promise<void>;
  /** The project directory `/save` writes under. */
  readonly cwd: string;
  /** The model label the status bar shows (`/model`). */
  readonly shownModel: string;
  /** Take the frame now (a notice was written straight into `stateRef`). */
  readonly flushNow: () => void;
  /** Back to the bottom of the transcript. */
  readonly setScrollOffset: (offset: number) => void;
  /** Ask the daemon for the session's open context figure. */
  readonly askContext: (session: SessionController | null) => void;
}
