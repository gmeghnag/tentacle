/**
 * `/move` (docs/feat/session-hop.md, slice H1): the pure grammar of the command
 * that moves a live session to another target. Parsing only — nothing is built,
 * dialled or asked here; the plan that decides whether this spec may run at all
 * is `cli/src/hop-plan.ts`.
 */

/** The engines a hop can join (the same union as `TargetBadge`'s). */
export type HopEngine = "kubernetes" | "docker" | "podman";

/** An EXISTING workload a hop joins (D7): docker/podman have no container part. */
export interface HopWorkload {
  readonly engine: HopEngine;
  readonly name: string;
  /** k8s only: the container in the pod. */
  readonly container?: string;
}

/**
 * One hop, with every default resolved (`keep` defaults to true, decision 5).
 * The shape is the `move_session` tool's input after parsing (D9), so a typed
 * `/move` and a proposed move are the same thing everywhere downstream.
 * `keep` is about the workload we LEAVE: `--rm` deletes it, if this hop created it.
 */
export type HopSpec =
  | { readonly target: "local"; readonly keep: boolean }
  | { readonly target: "container"; readonly image?: string; readonly keep: boolean }
  | { readonly target: "attach"; readonly workload: HopWorkload; readonly keep: boolean };

export type HopParse =
  | { readonly kind: "spec"; readonly spec: HopSpec }
  /** `/move cancel`: abort the hop in flight at its next phase boundary. */
  | { readonly kind: "cancel" }
  /** One line to show instead; nothing was built. */
  | { readonly kind: "error"; readonly text: string };

export const HOP_USAGE =
  "Usage: /move local [--keep|--rm] · /move container [<image>] [--keep|--rm] · /move attach <engine>:<name>[/<container>] [--keep|--rm] · /move cancel";

export const HOP_ENGINES: readonly HopEngine[] = ["docker", "podman", "kubernetes"];

/** The longest name any engine takes (a k8s pod's DNS-1123 limit). */
export const HOP_WORKLOAD_PART_MAX = 253;

/**
 * What one part of a workload may contain: the union of what the engines accept
 * (docker/podman `[a-zA-Z0-9][a-zA-Z0-9_.-]*`, a k8s DNS-1123 label is a subset)
 * and NOTHING else — no `:`, no `/`, no whitespace, no control or bidi byte. A
 * name reaches a badge, a notice and an engine call, and it may come from a pod
 * (AGENTS §7), so the grammar is fixed here, once, for both paths.
 */
const HOP_WORKLOAD_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** What was wrong with a proposed workload, as the one fact the caller words. */
export type HopWorkloadProblem = "engine" | "name" | "container" | "containerName" | "chars";

export type HopWorkloadCheck =
  | { readonly kind: "ok"; readonly workload: HopWorkload }
  | { readonly kind: "bad"; readonly problem: HopWorkloadProblem };

/**
 * The ONE workload validator, shared by the typed `/move attach` grammar and the
 * proposed `move_session` tool (D9) — so the two paths cannot accept different
 * things: docker/podman have no container part, k8s at most one, every part is
 * named and charset-clean. Pure; each caller words its own error line.
 */
export function hopWorkload(engine: string, name: string, container?: string): HopWorkloadCheck {
  if (!HOP_ENGINES.includes(engine as HopEngine)) {
    return { kind: "bad", problem: "engine" };
  }
  if (name === "") {
    return { kind: "bad", problem: "name" };
  }
  if (container !== undefined && engine !== "kubernetes") {
    return { kind: "bad", problem: "container" };
  }
  if (container === "") {
    return { kind: "bad", problem: "containerName" };
  }
  for (const part of container === undefined ? [name] : [name, container]) {
    if (part.length > HOP_WORKLOAD_PART_MAX || !HOP_WORKLOAD_PART.test(part)) {
      return { kind: "bad", problem: "chars" };
    }
  }
  return {
    kind: "ok",
    workload:
      container === undefined
        ? { engine: engine as HopEngine, name }
        : { engine: "kubernetes", name, container },
  };
}

/** What a workload part may hold, for a line about a name that does not. */
export const HOP_NAME_USAGE =
  "a workload name may hold only letters, digits, '.', '_' and '-' (no ':' or '/')";

/** The one line an `attach` with no readable `<engine>:<name>` gets. */
export const HOP_ATTACH_USAGE =
  "Use /move attach <engine>:<name> — the engine is one of docker, podman, kubernetes (for example docker:<name>)";

/** `/move <text>` → the hop it names, or the one line to show instead. */
export function parseHopCommand(raw: string): HopParse {
  // `tokens[0]` is the command itself (`/move`): the slash dispatch hands the
  // whole line over, exactly as `/settings` and `/attach` read theirs.
  const args = raw
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "")
    .slice(1);
  const target = args[0];
  if (target === undefined) {
    return { kind: "error", text: HOP_USAGE };
  }
  // `/move cancel` aborts the hop in flight at its next boundary: whatever else
  // the line says is not a target to build.
  if (target === "cancel") {
    return { kind: "cancel" };
  }
  const flags = readFlags(args.slice(1));
  if (flags.kind === "error") {
    return { kind: "error", text: HOP_USAGE };
  }
  const keep = flags.keep ?? true;
  if (target === "local") {
    return flags.words.length === 0
      ? { kind: "spec", spec: { target: "local", keep } }
      : { kind: "error", text: HOP_USAGE };
  }
  if (target === "container") {
    if (flags.words.length > 1) {
      return { kind: "error", text: HOP_USAGE };
    }
    const image = flags.words[0];
    return {
      kind: "spec",
      spec:
        image === undefined ? { target: "container", keep } : { target: "container", image, keep },
    };
  }
  if (target === "attach") {
    if (flags.words.length !== 1) {
      return { kind: "error", text: HOP_USAGE };
    }
    const workload = parseWorkload(flags.words[0] ?? "");
    if (typeof workload === "string") {
      return { kind: "error", text: workload };
    }
    return { kind: "spec", spec: { target: "attach", workload, keep } };
  }
  return { kind: "error", text: HOP_USAGE };
}

type FlagRead =
  | { readonly kind: "ok"; readonly words: readonly string[]; readonly keep?: boolean }
  | { readonly kind: "error" };

/**
 * The positional words and the ONE `keep` flag a line may carry. `--keep` and
 * `--rm` are the same decision said two ways (default keep, decision 5), so
 * both together — or a flag this build does not know — is the usage, never a
 * silently ignored word.
 */
function readFlags(words: readonly string[]): FlagRead {
  const positional: string[] = [];
  let keep: boolean | undefined;
  for (const word of words) {
    if (word === "--keep" || word === "--rm") {
      if (keep !== undefined) {
        return { kind: "error" };
      }
      keep = word === "--keep";
      continue;
    }
    if (word.startsWith("--")) {
      return { kind: "error" };
    }
    positional.push(word);
  }
  return keep === undefined
    ? { kind: "ok", words: positional }
    : { kind: "ok", words: positional, keep };
}

/**
 * What the TUI does with a typed `/move` RIGHT NOW (docs/feat/session-hop.md
 * D3/D4). The TURN BOUNDARY is decided here, from facts the TUI owns (its turn,
 * its queued rows); every other refusal — a job, a sub-agent, a compaction, the
 * link, the target itself — is the plan's (`cli/src/hop-plan.ts`), measured when
 * the hop actually starts, so the two layers never disagree: this one only ever
 * defers or refuses what it can see.
 */
export type HopStep =
  | { readonly kind: "start"; readonly spec: HopSpec }
  /** D4: the turn in flight (or its queued messages) first; the hop waits. */
  | { readonly kind: "queue"; readonly spec: HopSpec }
  | { readonly kind: "cancel" }
  /** One line, and nothing happens. */
  | { readonly kind: "notice"; readonly text: string };

/**
 * The turn boundary (D4), as ONE rule (docs/feat/app-decomposition.md S11):
 * **a hop may start only at a TRUE idle** — this TUI's own turn over AND the
 * daemon's queue empty, because the messages already queued run before anything
 * else does.
 *
 * It is a named function because two paths ask it: `hopStep` decides what a TYPED
 * `/move` does right now, and `hopIfQueued` re-checks it at the first idle before
 * starting the hop that waited. Written out twice (the pre-S11 shape), the two
 * copies are exactly how the typed path and the queued path drift into
 * disagreeing — one starting a hop mid-turn, or one leaving it queued forever.
 * `queued` is a COUNT compared to zero: a truthiness test would read a count as a
 * flag, which is the same bug in a different disguise.
 */
export function hopReady(input: { readonly running: boolean; readonly queued: number }): boolean {
  return !input.running && input.queued <= 0;
}

/**
 * `/move …` → what to do now. `available`: this TUI got a `hop` feed (D8: only a
 * local worker or a hop target; `run`/`attach`/`connect` say so).
 */
export function hopStep(input: {
  readonly parse: HopParse;
  readonly available: boolean;
  readonly hopping: boolean;
  /** A `/move` already waits for the turn boundary (D4): the last one typed does not silently win. */
  readonly hopQueued: boolean;
  readonly running: boolean;
  readonly queued: number;
}): HopStep {
  if (!input.available) {
    return { kind: "notice", text: "not available here" };
  }
  switch (input.parse.kind) {
    case "error":
      return { kind: "notice", text: input.parse.text };
    case "cancel":
      // A cancel is about whatever waits or runs: both are the App's to stop.
      return input.hopping || input.hopQueued
        ? { kind: "cancel" }
        : { kind: "notice", text: "no move is running" };
    case "spec":
      if (input.hopping) {
        return { kind: "notice", text: "a move is already running" };
      }
      if (input.hopQueued) {
        return { kind: "notice", text: "a move is already queued" };
      }
      // A turn in flight ends first, and the messages the daemon already queued
      // run before it: the hop takes the first idle nobody is using (D4). The
      // rule is `hopReady` — the SAME one `hopIfQueued` re-checks at that idle.
      return hopReady({ running: input.running, queued: input.queued })
        ? { kind: "start", spec: input.parse.spec }
        : { kind: "queue", spec: input.parse.spec };
  }
}

/** The one line a queued `/move` gets (it is not forgotten, and not started). */
export const HOP_QUEUED_NOTICE =
  "_Move queued: it starts when the turn ends and the queued messages have run._";

/** `<engine>:<name>[/<container>]` → the workload, or the line explaining what was wrong. */
function parseWorkload(word: string): HopWorkload | string {
  const colon = word.indexOf(":");
  const engine = colon <= 0 ? "" : word.slice(0, colon);
  const parts = colon <= 0 ? [""] : word.slice(colon + 1).split("/");
  // A third `/part` is not a workload in ANY engine: name the rule it broke.
  if (parts.length > 2) {
    if (engine === "kubernetes") {
      return "one /container at most: /move attach kubernetes:<pod>/<container>";
    }
    return HOP_ENGINES.includes(engine as HopEngine)
      ? `${engine} has no container part — only kubernetes: names one: /move attach ${engine}:<name>`
      : HOP_ATTACH_USAGE;
  }
  const checked = hopWorkload(engine, parts[0] ?? "", parts[1]);
  if (checked.kind === "ok") {
    return checked.workload;
  }
  switch (checked.problem) {
    case "engine":
      return HOP_ATTACH_USAGE;
    case "container":
      return `${engine} has no container part — only kubernetes: names one: /move attach ${engine}:<name>`;
    case "containerName":
      return "a name is needed for the container: /move attach kubernetes:<pod>/<container>";
    case "chars":
      return HOP_NAME_USAGE;
    case "name":
      return engine === "kubernetes"
        ? "a name is needed: /move attach kubernetes:<pod>[/<container>]"
        : "a name is needed: /move attach <engine>:<name>";
  }
}
