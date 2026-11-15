/**
 * A session tree's approvals and its ask lane (docs/feat/parallel-agents.md,
 * Design 3; PE-Q4): one store shared by the main agent's gate and every
 * sub-agent's, so one "Yes, always" covers the tree, and requests it does not
 * cover are asked one by one.
 *
 * The lane sits in the agent, BEFORE the requester: a waiter has no record
 * entry and has shown nothing, and no `Connection` handler ever waits on it
 * (AGENTS §7, "don't serialize the RPC peer").
 */
import type { PermissionRequest, Tool } from "@tentacle/core";
import { commandCoveredByPrefixes } from "./shell-prefix.ts";

/** `workload_shell`'s tool name (the grants store must key on it by name, not by import). */
const WORKLOAD_SHELL = "workload_shell";

/** `serial`'s answer when `signal` aborted before `fn` could run. */
export const ABORTED: unique symbol = Symbol("aborted");

function commandOf(input: unknown): string | undefined {
  const value =
    input && typeof input === "object" ? (input as Record<string, unknown>).command : undefined;
  return typeof value === "string" ? value : undefined;
}

/**
 * The identity of a `workload_shell` target: engine, namespace, name, container.
 *
 * It MUST agree with `@tentacle/tools`' `targetKey`, which the shell registry uses
 * — one spelling or an "always" could cover a different shell than the one it was
 * granted for. They are duplicated rather than imported because `@tentacle/agent`
 * may not depend on `@tentacle/tools` (the tools package depends on core, and the
 * agent wires the tools); a test in each package pins the same string, and the
 * field order below is the contract.
 */
export function workloadTargetKey(input: unknown): string | undefined {
  const target =
    input && typeof input === "object"
      ? (input as { target?: Record<string, unknown> }).target
      : undefined;
  if (target === undefined || target === null || typeof target !== "object") {
    return undefined;
  }
  const engine = target.engine;
  const name = target.name;
  if (typeof engine !== "string" || typeof name !== "string") {
    return undefined;
  }
  const ns = typeof target.namespace === "string" ? target.namespace : "";
  const container = typeof target.container === "string" ? target.container : "";
  return [engine, ns, name, container].join("|");
}

export class SessionGrants {
  /** Non-shell tools approved for the whole session. */
  private readonly grantedTools = new Set<string>();
  /** Approved shell command prefixes (e.g. `git commit`). */
  private readonly shellPrefixes: string[] = [];
  /**
   * `workload_shell` rules, keyed by the WORKLOAD they were granted on (D6):
   * a prefix approved in a dev container must never cover a prod pod.
   */
  private readonly workloadPrefixes = new Map<string, string[]>();
  private busy = false;
  private readonly waiters: (() => void)[] = [];

  /** Whether an existing session rule already covers this call. */
  covers(tool: Tool, input: unknown): boolean {
    if (tool.name === "shell") {
      const command = commandOf(input);
      return command !== undefined && commandCoveredByPrefixes(command, this.shellPrefixes);
    }
    if (tool.name === WORKLOAD_SHELL) {
      // Closing OUR OWN shell has no effect beyond the tool, so it never asks —
      // and the rule lives here so a `run` still does.
      if ((input as { action?: unknown } | null)?.action === "close") {
        return true;
      }
      const key = workloadTargetKey(input);
      const command = commandOf(input);
      if (key === undefined || command === undefined) {
        return false;
      }
      const prefixes = this.workloadPrefixes.get(key);
      return prefixes !== undefined && commandCoveredByPrefixes(command, prefixes);
    }
    return this.grantedTools.has(tool.name);
  }

  /**
   * Forget every approval (`/clear`, docs/feat/clear-keeps-jobs.md). The ask
   * lane (`busy`, `waiters`) is untouched: an ask in flight is not disturbed.
   */
  clear(): void {
    this.grantedTools.clear();
    this.shellPrefixes.length = 0;
    this.workloadPrefixes.clear();
  }

  /** Persist a session-scoped approval as the narrowest applicable rule. */
  remember(tool: Tool, request: PermissionRequest): void {
    if (tool.name === "shell" && request.suggestion) {
      if (!this.shellPrefixes.includes(request.suggestion.prefix)) {
        this.shellPrefixes.push(request.suggestion.prefix);
      }
      return;
    }
    if (tool.name === WORKLOAD_SHELL) {
      // NEVER falls through to `grantedTools`: one "always" for this tool would
      // otherwise approve EVERY command on EVERY workload (the bleed D6 forbids).
      // With no derivable prefix there is no rule to store — and no wider one.
      const key = workloadTargetKey(request.input);
      const prefix = request.suggestion?.prefix;
      if (key === undefined || prefix === undefined) {
        return;
      }
      const prefixes = this.workloadPrefixes.get(key) ?? [];
      if (!prefixes.includes(prefix)) {
        prefixes.push(prefix);
      }
      this.workloadPrefixes.set(key, prefixes);
      return;
    }
    this.grantedTools.add(tool.name);
  }

  /**
   * Run `fn` when the lane is free, in FIFO order, or answer `ABORTED` as soon
   * as `signal` aborts (a waiter never holds a cancel up, and `fn` never runs
   * after it). Released in `finally`: a throw in `fn` fails its caller alone.
   */
  async serial<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T | typeof ABORTED> {
    if (signal.aborted) {
      return ABORTED;
    }
    if (this.busy) {
      const admitted = await new Promise<boolean>((resolve) => {
        const admit = (): void => {
          signal.removeEventListener("abort", onAbort);
          resolve(true);
        };
        const onAbort = (): void => {
          this.waiters.splice(this.waiters.indexOf(admit), 1);
          resolve(false);
        };
        this.waiters.push(admit);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      if (!admitted) {
        return ABORTED;
      }
    } else {
      this.busy = true;
    }
    try {
      // Admitted and aborted in the same stretch: the lane passes on untouched.
      return signal.aborted ? ABORTED : await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) {
        next(); // the lane stays busy: handed over
      } else {
        this.busy = false;
      }
    }
  }
}
