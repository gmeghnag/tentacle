/**
 * The operator's controls are two files (docs/feat/session-apps-host.md D9):
 * `kill-switch` and `takedowns`. Parsing is pure; the reader is injected and
 * re-reads at most once per staleness window.
 */
import { decodeBase64Url, isAppId } from "@tentacle/protocol";

export type OperatorFileName = "kill-switch" | "takedowns";

export type OperatorFileRead =
  | { readonly kind: "absent" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "error" };

/** `publish` refuses create/update; `all` also serves only the maintenance page. */
export type KillMode = "off" | "publish" | "all";

/** Anything the operator may have meant as "stop" but we cannot read is `all`. */
export function parseKillSwitch(read: OperatorFileRead): { mode: KillMode; invalid: boolean } {
  if (read.kind === "absent") {
    return { mode: "off", invalid: false };
  }
  const word = read.kind === "text" ? read.text.trim() : "";
  if (word === "publish" || word === "all") {
    return { mode: word, invalid: false };
  }
  return { mode: "all", invalid: true };
}

export interface Takedowns {
  /** App id → the operator's reason. */
  readonly apps: ReadonlyMap<string, string>;
  /** Publisher key → the operator's reason. */
  readonly keys: ReadonlyMap<string, string>;
}

export const NO_TAKEDOWNS: Takedowns = { apps: new Map(), keys: new Map() };

/** Lines `app <id> <reason>` or `key <key> <reason>`; `#` comments and blanks skipped. */
export function parseTakedowns(text: string): Takedowns & { readonly invalid: number[] } {
  const apps = new Map<string, string>();
  const keys = new Map<string, string>();
  const invalid: number[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const match = /^(app|key)\s+(\S+)\s+(\S.*)$/.exec(line);
    const kind = match?.[1];
    const value = match?.[2] ?? "";
    const reason = match?.[3] ?? "";
    if (kind === "app" && isAppId(value)) {
      apps.set(value, reason);
    } else if (kind === "key" && value.length === 43 && decodeBase64Url(value)?.length === 32) {
      keys.set(value, reason);
    } else {
      invalid.push(i + 1);
    }
  }
  return { apps, keys, invalid };
}

export interface OperatorState {
  readonly kill: KillMode;
  readonly takedowns: Takedowns;
}

export function createOperatorFiles(options: {
  readonly read: (name: OperatorFileName) => OperatorFileRead;
  readonly now: () => number;
  readonly staleMs: number;
  readonly log: (line: string) => void;
}): { current(): OperatorState } {
  let state: OperatorState = { kill: "off", takedowns: NO_TAKEDOWNS };
  let readAt: number | undefined;
  /** What each file last read as, so a change is logged once. */
  const last = new Map<OperatorFileName, string>();

  const changed = (name: OperatorFileName, read: OperatorFileRead): boolean => {
    const signature = read.kind === "text" ? `text:${read.text}` : read.kind;
    const before = last.get(name);
    last.set(name, signature);
    return before !== signature;
  };

  const refresh = (): void => {
    const killRead = options.read("kill-switch");
    if (changed("kill-switch", killRead)) {
      const kill = parseKillSwitch(killRead);
      if (kill.invalid) {
        options.log("operator-file kill-switch invalid (failing closed: all)");
      }
      if (kill.mode !== state.kill) {
        options.log(`kill ${kill.mode}`);
      }
      state = { ...state, kill: kill.mode };
    }
    const takedownRead = options.read("takedowns");
    if (changed("takedowns", takedownRead)) {
      if (takedownRead.kind === "error") {
        // Keep what we last read: losing the file must not unblock anyone.
        options.log("operator-file takedowns unreadable");
      } else {
        const parsed = parseTakedowns(takedownRead.kind === "text" ? takedownRead.text : "");
        for (const line of parsed.invalid) {
          options.log(`operator-file takedowns line ${line} invalid`);
        }
        state = { ...state, takedowns: { apps: parsed.apps, keys: parsed.keys } };
      }
    }
  };

  return {
    current(): OperatorState {
      const at = options.now();
      if (readAt === undefined || at - readAt >= options.staleMs) {
        readAt = at;
        refresh();
      }
      return state;
    },
  };
}
