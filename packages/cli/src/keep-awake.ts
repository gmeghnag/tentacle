/**
 * DR-9 (docs/feat/detached-relay-lifecycle.md): the relay holds a macOS sleep
 * assertion while a turn runs, so the Mac does not idle-sleep under it.
 * `caffeinate -i -w <relay pid>`: `-i` is idle sleep only (closing the lid still
 * sleeps it), `-w` ends it with the relay, a SIGKILL included. Everywhere else it
 * does nothing, and a failure only costs the assertion: never the run.
 */
import { spawn } from "node:child_process";

/** What is used of a spawned `caffeinate`. */
export interface AwakeChild {
  kill(): void;
  unref(): void;
  once(event: "error" | "exit", listener: () => void): void;
}

export interface KeepAwakeOptions {
  readonly platform: NodeJS.Platform;
  /** `detach.keepAwake`. */
  readonly enabled: boolean;
  /** The relay's pid. */
  readonly pid: number;
  /** Default: a real child, no stdio, not detached. */
  readonly spawn?: (command: string, args: readonly string[]) => AwakeChild;
  readonly log: (line: string) => void;
}

export interface KeepAwake {
  /** Idempotent. */
  set(wanted: boolean): void;
  /** For good: no later `set` starts one. */
  stop(): void;
}

/** Does this run hold the assertion at all? `run --detach` says so once, at launch. */
export function keepsAwake(platform: NodeJS.Platform, enabled: boolean): boolean {
  return platform === "darwin" && enabled;
}

export function createKeepAwake(options: KeepAwakeOptions): KeepAwake {
  const start =
    options.spawn ?? ((command, args) => spawn(command, [...args], { stdio: "ignore" }));
  let usable = keepsAwake(options.platform, options.enabled);
  let child: AwakeChild | null = null;
  const failed = (why: string): void => {
    if (usable) {
      options.log(`caffeinate unavailable, the Mac may sleep during a turn: ${why}`);
    }
    usable = false;
    child = null;
  };
  const drop = (): void => {
    child?.kill();
    child = null;
  };
  return {
    set(wanted) {
      if (!wanted) {
        drop();
        return;
      }
      if (!usable || child) {
        return;
      }
      try {
        const started = start("caffeinate", ["-i", "-w", String(options.pid)]);
        started.once("error", () => failed("it could not be started"));
        started.once("exit", () => {
          if (child === started) {
            child = null;
          }
        });
        started.unref();
        child = started;
      } catch (error) {
        failed(error instanceof Error ? error.message : String(error));
      }
    },
    stop() {
      usable = false;
      drop();
    },
  };
}
