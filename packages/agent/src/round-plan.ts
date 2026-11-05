/**
 * The round executor's pure planning (docs/feat/parallel-tools.md): which of a
 * round's calls may share a group, and — once a group is authorized — which of
 * its calls must wait for which. React-free, I/O-free, unit-tested.
 *
 * Safety is the scheduler's, never the grouping's: `planGroups` cuts the round
 * on the MODEL's input (before anything is asked), `dependencies` orders the
 * group's calls on their EFFECTIVE input (a `tool_call` hook may rewrite it).
 */
import type { ResourceKey, Tool } from "@tentacle/core";

/** `tools.execution`: how a round's calls may overlap. */
export type ExecutionMode = "sequential" | "read-only" | "parallel";

/** A call's concurrency class: its resource keys, or `"exclusive"`. */
export type CallClass = readonly ResourceKey[] | "exclusive";

/** A call's run state inside its group, for `nextRunnable`. */
export type CallState = "pending" | "running" | "settled";

/**
 * The class of a call to `tool` with `input`: total. An unknown tool, a tool
 * with no `concurrency`, a key function that throws or returns something
 * that is not a key list → `"exclusive"`.
 */
export function classOf(tool: Tool | undefined, input: unknown): CallClass {
  const concurrency = tool?.concurrency;
  if (concurrency === undefined || concurrency === "exclusive") {
    return "exclusive";
  }
  try {
    const keys = concurrency(input);
    if (keys === "exclusive" || !Array.isArray(keys)) {
      return "exclusive";
    }
    for (const key of keys) {
      if (
        typeof key !== "object" ||
        key === null ||
        (key.mode !== "read" && key.mode !== "write") ||
        typeof key.resource !== "string"
      ) {
        return "exclusive";
      }
    }
    return keys;
  } catch {
    return "exclusive";
  }
}

/** Read-class: non-empty keys, all `read`. */
export function isReadClass(cls: CallClass): boolean {
  return cls !== "exclusive" && cls.length > 0 && cls.every((key) => key.mode === "read");
}

/** Whether `cls` may share a group in `mode`. */
function admissible(cls: CallClass, mode: ExecutionMode): boolean {
  switch (mode) {
    case "sequential":
      return false;
    case "read-only":
      return isReadClass(cls);
    case "parallel":
      return cls !== "exclusive";
  }
}

/**
 * Cut a round into contiguous groups of call indexes, in call order, covering
 * every call once: maximal runs of consecutive admissible calls (read-only:
 * read-class; parallel: non-exclusive), every other call alone. `sequential`
 * or `maxParallel <= 1` → every call alone.
 */
export function planGroups(
  classes: readonly CallClass[],
  mode: ExecutionMode,
  maxParallel: number,
): number[][] {
  const groups: number[][] = [];
  let run: number[] = [];
  const flush = (): void => {
    if (run.length > 0) {
      groups.push(run);
      run = [];
    }
  };
  classes.forEach((cls, index) => {
    if (maxParallel > 1 && admissible(cls, mode)) {
      run.push(index);
      return;
    }
    flush();
    groups.push([index]);
  });
  flush();
  return groups;
}

/** Two classes conflict: `exclusive` with anything; else a shared resource with a write. */
function conflicts(a: CallClass, b: CallClass): boolean {
  if (a === "exclusive" || b === "exclusive") {
    return true;
  }
  return a.some((ka) =>
    b.some((kb) => ka.resource === kb.resource && (ka.mode === "write" || kb.mode === "write")),
  );
}

/**
 * For each call of a group (its EFFECTIVE classes, in call order), the earlier
 * calls it must wait for: those it conflicts with. A class no longer
 * admissible in `mode` (a hook turned a read into a write) counts as
 * `"exclusive"`: it waits for every earlier call, every later one waits for it.
 */
export function dependencies(classes: readonly CallClass[], mode: ExecutionMode): number[][] {
  const effective = classes.map((cls) => (admissible(cls, mode) ? cls : "exclusive"));
  return effective.map((cls, i) => {
    const deps: number[] = [];
    for (let j = 0; j < i; j++) {
      const earlier = effective[j];
      if (earlier !== undefined && conflicts(earlier, cls)) {
        deps.push(j);
      }
    }
    return deps;
  });
}

/**
 * The next call to start: the lowest-index `pending` call whose dependencies
 * have all settled, while fewer than `cap` are running. Deterministic.
 */
export function nextRunnable(
  deps: readonly (readonly number[])[],
  states: readonly CallState[],
  cap: number,
): number | undefined {
  const running = states.filter((s) => s === "running").length;
  if (running >= cap) {
    return undefined;
  }
  for (let i = 0; i < states.length; i++) {
    if (states[i] === "pending" && (deps[i] ?? []).every((d) => states[d] === "settled")) {
      return i;
    }
  }
  return undefined;
}
