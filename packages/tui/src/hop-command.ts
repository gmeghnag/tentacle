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

/** `<engine>:<name>[/<container>]` → the workload, or the line explaining what was wrong. */
function parseWorkload(word: string): HopWorkload | string {
  const colon = word.indexOf(":");
  if (colon <= 0) {
    return HOP_ATTACH_USAGE;
  }
  const engine = word.slice(0, colon);
  if (!HOP_ENGINES.includes(engine as HopEngine)) {
    return HOP_ATTACH_USAGE;
  }
  const parts = word.slice(colon + 1).split("/");
  const name = parts[0] ?? "";
  if (engine !== "kubernetes") {
    if (parts.length > 1) {
      return `${engine} has no container part — only kubernetes: names one: /move attach ${engine}:<name>`;
    }
    return name === ""
      ? "a name is needed: /move attach <engine>:<name>"
      : { engine: engine as HopEngine, name };
  }
  if (parts.length > 2) {
    return "one /container at most: /move attach kubernetes:<pod>/<container>";
  }
  if (name === "") {
    return "a name is needed: /move attach kubernetes:<pod>[/<container>]";
  }
  const container = parts[1];
  if (container === undefined) {
    return { engine: "kubernetes", name };
  }
  return container === ""
    ? "a name is needed for the container: /move attach kubernetes:<pod>/<container>"
    : { engine: "kubernetes", name, container };
}
