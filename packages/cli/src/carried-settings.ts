/**
 * What the laptop carries into a pod, and how a pod daemon overlays it
 * (docs/feat/config-carry.md). Pure: the one place that classifies a key.
 *
 * P (pinned): the laptop decides; it beats the pod's file and env.
 * W (workspace): the laptop's value is the LOWEST layer; the pod's own env and
 * file win. "Unset" is read from `sources`, never from the value, or a pod's
 * explicit default would lose to the laptop.
 *
 * Settings flow laptop → pod and create no effect on the laptop, so a pin is
 * policy for honest pods, never security (AGENTS §7). What comes back is a
 * report a laptop filters through this table: a hostile pod gets a false notice
 * at worst, with names this table holds and only numbers, booleans and enum
 * values: never its text.
 */
import {
  ExecutionModeSchema,
  type SessionSettings,
  type SessionSettingsReport,
} from "@tentacle/protocol";
import { type TentacleConfig, composeSystemPrompt } from "./config.ts";

type Key = keyof SessionSettings;
type Value<K extends Key> = NonNullable<SessionSettings[K]>;
type SourceKey = Exclude<keyof TentacleConfig["sources"], "apiKey">;

interface Row<K extends Key> {
  readonly class: "P" | "W";
  /** The user's name for it: the only thing a notice prints. */
  readonly configKey: string;
  readonly source: SourceKey;
  readonly read: (config: TentacleConfig) => SessionSettings[K];
  readonly write: (config: TentacleConfig, value: Value<K>) => TentacleConfig;
  /** A P key the laptop left out of `settings` on purpose. Absent → the pod's value stands. */
  readonly absent?: (config: TentacleConfig) => TentacleConfig;
}

/**
 * Keyed by the wire schema's keys, so a key added to the wire does not compile
 * until it is classified. `autoWake` is not here: only the laptop's TUI reads it.
 */
export const CARRIED: { readonly [K in Key]: Row<K> } = {
  contextWindow: {
    class: "P",
    configKey: "model.contextWindow",
    source: "contextWindow",
    read: (c) => c.contextWindow,
    write: (c, v) => ({ ...c, contextWindow: v }),
  },
  autoTitle: {
    class: "P",
    configKey: "model.autoTitle",
    source: "autoTitle",
    read: (c) => c.autoTitle,
    write: (c, v) => ({ ...c, autoTitle: v }),
    // The pod's own config never turns titles on.
    absent: (c) => ({ ...c, autoTitle: false }),
  },
  subagentsEnabled: {
    class: "P",
    configKey: "subagents.enabled",
    source: "subagentsEnabled",
    read: (c) => c.subagentsEnabled,
    write: (c, v) => ({ ...c, subagentsEnabled: v }),
  },
  subagentMaxIterations: {
    class: "P",
    configKey: "subagents.maxIterations",
    source: "subagentMaxIterations",
    read: (c) => c.subagentMaxIterations,
    write: (c, v) => ({ ...c, subagentMaxIterations: v }),
  },
  subagentExecution: {
    class: "P",
    configKey: "subagents.execution",
    source: "subagentExecution",
    read: (c) => c.subagentExecution,
    write: (c, v) => ({ ...c, subagentExecution: v }),
  },
  subagentMaxParallel: {
    class: "P",
    configKey: "subagents.maxParallel",
    source: "subagentMaxParallel",
    read: (c) => c.subagentMaxParallel,
    write: (c, v) => ({ ...c, subagentMaxParallel: v }),
  },
  agentTaskDescription: {
    class: "P",
    configKey: "subagents.agentTaskDescription",
    source: "agentTaskDescription",
    read: (c) => c.agentTaskDescription,
    write: (c, v) => ({ ...c, agentTaskDescription: v }),
    // The laptop has no custom text: the neutral default, never the pod's.
    absent: ({ agentTaskDescription: _dropped, ...c }) => c,
  },
  loadAgentsMd: {
    class: "W",
    configKey: "loadAgentsMd",
    source: "loadAgentsMd",
    read: (c) => c.agentsMdEnabled,
    write: (c, v) => ({ ...c, agentsMdEnabled: v }),
  },
  loadSkills: {
    class: "W",
    configKey: "loadSkills",
    source: "loadSkills",
    read: (c) => c.skillsEnabled,
    write: (c, v) => ({ ...c, skillsEnabled: v }),
  },
  maxIterations: {
    class: "W",
    configKey: "maxIterations",
    source: "maxIterations",
    read: (c) => c.maxIterations,
    write: (c, v) => ({ ...c, maxIterations: v }),
  },
  contextAwarenessEnabled: {
    class: "W",
    configKey: "contextAwareness.enabled",
    source: "contextAwarenessEnabled",
    read: (c) => c.contextAwareness.enabled,
    write: (c, v) => ({ ...c, contextAwareness: { ...c.contextAwareness, enabled: v } }),
  },
  contextAwarenessStepPercent: {
    class: "W",
    configKey: "contextAwareness.stepPercent",
    source: "contextAwarenessStepPercent",
    read: (c) => c.contextAwareness.stepPercent,
    write: (c, v) => ({ ...c, contextAwareness: { ...c.contextAwareness, stepPercent: v } }),
  },
  contextResetEnabled: {
    class: "W",
    configKey: "contextReset.enabled",
    source: "contextResetEnabled",
    read: (c) => c.contextReset.enabled,
    write: (c, v) => ({ ...c, contextReset: { ...c.contextReset, enabled: v } }),
  },
  contextResetMaxPerMessage: {
    class: "W",
    configKey: "contextReset.maxPerMessage",
    source: "contextResetMaxPerMessage",
    read: (c) => c.contextReset.maxPerMessage,
    write: (c, v) => ({ ...c, contextReset: { ...c.contextReset, maxPerMessage: v } }),
  },
  maxInlineOutputChars: {
    class: "W",
    configKey: "tools.maxInlineOutputChars",
    source: "maxInlineOutputChars",
    read: (c) => c.maxInlineOutputChars,
    write: (c, v) => ({ ...c, maxInlineOutputChars: v }),
  },
  redactSecrets: {
    class: "W",
    configKey: "tools.redactSecrets",
    source: "redactSecrets",
    read: (c) => c.redactSecrets,
    write: (c, v) => ({ ...c, redactSecrets: v }),
  },
  dedupOutput: {
    class: "W",
    configKey: "tools.dedupOutput",
    source: "dedupOutput",
    read: (c) => c.dedupOutput,
    write: (c, v) => ({ ...c, dedupOutput: v }),
  },
  tabulateJson: {
    class: "W",
    configKey: "tools.tabulateJson",
    source: "tabulateJson",
    read: (c) => c.tabulateJson,
    write: (c, v) => ({ ...c, tabulateJson: v }),
  },
  summarizeLargeOutput: {
    class: "W",
    configKey: "tools.summarizeLargeOutput",
    source: "summarizeLargeOutput",
    read: (c) => c.summarizeLargeOutput,
    write: (c, v) => ({ ...c, summarizeLargeOutput: v }),
  },
  toolExecution: {
    class: "W",
    configKey: "tools.execution",
    source: "toolExecution",
    read: (c) => c.toolExecution.mode,
    write: (c, v) => ({ ...c, toolExecution: { ...c.toolExecution, mode: v } }),
  },
  toolMaxParallel: {
    class: "W",
    configKey: "tools.maxParallel",
    source: "toolMaxParallel",
    read: (c) => c.toolExecution.maxParallel,
    write: (c, v) => ({ ...c, toolExecution: { ...c.toolExecution, maxParallel: v } }),
  },
};

const KEYS = Object.keys(CARRIED) as Key[];

/** The laptop's resolved values (env > active profile > global), defaults included. */
export function carriedSettings(config: TentacleConfig): SessionSettings {
  const settings: Record<string, unknown> = {};
  for (const key of KEYS) {
    const value = CARRIED[key].read(config);
    if (value !== undefined) {
      settings[key] = value;
    }
  }
  return settings as SessionSettings;
}

export interface AppliedSettings {
  /** The config this session's agent is built from. */
  readonly config: TentacleConfig;
  /** For `session/open`'s result; absent with no `settings` (a bare open). */
  readonly report?: SessionSettingsReport;
  /** P keys the pod's own env or file set to something else: for the daemon's log, not the laptop's. */
  readonly pinnedOver: readonly string[];
}

/**
 * The pod's config with the laptop's `settings` laid over it. `settings` absent
 * (a bare open on a proxy daemon): the pod's values, titles off.
 */
export function applyCarried(
  config: TentacleConfig,
  settings: SessionSettings | undefined,
): AppliedSettings {
  if (settings === undefined) {
    return { config: { ...config, autoTitle: false }, pinnedOver: [] };
  }
  let next = config;
  const stamped: Partial<Record<SourceKey, "carried">> = {};
  const overridden: Record<string, unknown> = {};
  /** Carried W keys the pod sets itself, whatever the value: an apply cannot change them. */
  const containerKeys: Key[] = [];
  const pinnedOver: string[] = [];
  const overlay = <K extends Key>(key: K): void => {
    const row: Row<K> = CARRIED[key];
    const carried = settings[key] as Value<K> | undefined;
    const set = config.sources[row.source] !== "default";
    if (row.class === "W") {
      if (carried === undefined) {
        return;
      }
      if (set) {
        containerKeys.push(key);
        if (row.read(config) !== carried) {
          overridden[key] = row.read(config);
        }
        return;
      }
    } else if (carried === undefined) {
      next = row.absent?.(next) ?? next;
      if (set && row.read(config) !== row.read(next)) {
        pinnedOver.push(key);
      }
      return;
    } else if (set && row.read(config) !== carried) {
      pinnedOver.push(key);
    }
    next = row.write(next, carried);
    stamped[row.source] = "carried";
  };
  for (const key of KEYS) {
    overlay(key);
  }
  return {
    config: recomposed({ ...next, sources: { ...next.sources, ...stamped } }, config),
    report: {
      carried: settings,
      overridden: overridden as SessionSettings,
      ...(containerKeys.length > 0 ? { containerKeys } : {}),
    },
    pinnedOver,
  };
}

/**
 * `loadAgentsMd` and `loadSkills` were decided at load: when a carried value
 * flipped one, the prompt and the skill set are composed again, the same way a
 * start does (`composeSystemPrompt`), or a later context reset would disagree.
 */
function recomposed(next: TentacleConfig, loaded: TentacleConfig): TentacleConfig {
  if (
    next.agentsMdEnabled === loaded.agentsMdEnabled &&
    next.skillsEnabled === loaded.skillsEnabled
  ) {
    return next;
  }
  const skills = next.skillsEnabled ? next.skills : [];
  const { systemPrompt, agentsMdLoaded } = composeSystemPrompt({
    identity: next.promptIdentity,
    agentsMd: next.agentsMdContent,
    agentsEnabled: next.agentsMdEnabled,
    skills,
  });
  const { agentsPath, ...rest } = next;
  return {
    ...rest,
    ...(agentsMdLoaded && agentsPath !== undefined ? { agentsPath } : {}),
    systemPrompt,
    skills,
    skillDiagnostics: next.skillsEnabled ? next.skillDiagnostics : [],
  };
}

export const TEXT_DIFFERS = "(text differs)";

/** A value a notice may print. Any text is hidden: it could be the pod's (AGENTS §7). */
export function shown(key: Key, value: unknown): string | number | boolean {
  if (key === "agentTaskDescription") {
    return TEXT_DIFFERS;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  const mode = ExecutionModeSchema.safeParse(value);
  return mode.success ? mode.data : TEXT_DIFFERS;
}

/** A one-line JSON of these keys and values, under the config's own names. */
function valuesLine(keys: readonly Key[], values: SessionSettings): string {
  const entries = keys.map(
    (key) =>
      `${JSON.stringify(CARRIED[key].configKey)}: ${JSON.stringify(shown(key, values[key]))}`,
  );
  return `{ ${entries.join(", ")} }`;
}

/**
 * What the laptop tells the user about a session's report: ONE line each, only
 * what differs, for keys of THIS table. The `(/settings apply, or /clear)` hint is its own
 * field, so the TUI draws it grey beside the blue text.
 */
export interface SettingsNotice {
  readonly text: string;
  readonly hint?: string;
}

/** The drift notice's way out (docs/feat/session-settings-apply.md). */
export const DRIFT_HINT = "(/settings apply, or /clear)";

export function settingsNotices(
  mine: SessionSettings,
  report: SessionSettingsReport,
): SettingsNotice[] {
  const lines: SettingsNotice[] = [];
  // Only what differs from THIS laptop: a pod value equal to mine is not news.
  const overridden = KEYS.filter(
    (key) => report.overridden[key] !== undefined && report.overridden[key] !== mine[key],
  );
  if (overridden.length > 0) {
    lines.push({ text: `Container config: ${valuesLine(overridden, report.overridden)}` });
  }
  // An overridden key is not what the session keeps: the line above has its value.
  // Absent on the session's side: nothing to show, but for the description.
  const differing = KEYS.filter(
    (key) =>
      report.carried[key] !== mine[key] &&
      report.overridden[key] === undefined &&
      (report.carried[key] !== undefined || key === "agentTaskDescription"),
  );
  if (differing.length > 0) {
    lines.push({
      text: `Session settings: ${valuesLine(differing, report.carried)}`,
      hint: DRIFT_HINT,
    });
  }
  return lines;
}

/**
 * Sends each notice once per session and text, since a reconnect opens the
 * session again. `forget(sessionId)`: the session's settings changed (an apply,
 * docs/feat/session-settings-apply.md), so a later drift is news again.
 */
export function createSettingsNotifier(
  mine: SessionSettings,
  notify: (text: string, hint?: string) => void,
): ((notice: { readonly sessionId: string; readonly report: SessionSettingsReport }) => void) & {
  forget(sessionId: string): void;
} {
  const said = new Set<string>();
  const notice = ({
    sessionId,
    report,
  }: {
    readonly sessionId: string;
    readonly report: SessionSettingsReport;
  }): void => {
    for (const { text, hint } of settingsNotices(mine, report)) {
      const key = `${sessionId}\n${text}`;
      if (!said.has(key)) {
        said.add(key);
        notify(text, hint);
      }
    }
  };
  const forget = (sessionId: string): void => {
    for (const key of [...said]) {
      if (key.startsWith(`${sessionId}\n`)) {
        said.delete(key);
      }
    }
  };
  return Object.assign(notice, { forget });
}
