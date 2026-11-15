import { MOVE_SESSION_DECLINED_HINT } from "@tentacle/tools";
/**
 * The move a TOOL proposed (docs/feat/session-hop.md D9), pure: watch our own
 * turn's events for a `move_session` call that succeeded, and turn its
 * arguments into a `HopSpec` the owner is then asked about at turn end.
 *
 * Everything here treats the arguments as POD-SUPPLIED TEXT, on every origin
 * (AGENTS §7): they are parsed strictly, never trusted, and the resulting
 * proposal carries no effect of its own — the laptop asks, through the single
 * broker, and only the owner's Yes builds anything. A malformed call is said
 * out loud (`notice`), never silently dropped.
 */
import type { SessionEvent } from "@tentacle/tui";
import type { HopSpec, HopWorkload } from "@tentacle/tui";
import { hopWorkload, workloadText } from "@tentacle/tui";
import { z } from "zod";
import type { KubeNamespace } from "./engine-select.ts";
import { untrustedText } from "./untrusted-text.ts";

/** The tool whose success proposes a hop (D9). */
export const MOVE_SESSION_TOOL = "move_session";

const engineSchema = z.enum(["kubernetes", "docker", "podman"]);
const workloadSchema = z.object({
  engine: engineSchema,
  name: z.string().min(1),
  container: z.string().min(1).optional(),
  /** OD1: k8s only, a DNS-1123 label (re-checked by `hopWorkload` below). */
  namespace: z.string().min(1).optional(),
});

/**
 * `move_session`'s arguments as the tool's own schema declares them (D9). Strips
 * unknown fields (`zod`'s default), so a newer daemon's extra argument is
 * ignored rather than fatal — the same forward-compatibility rule the wire has.
 */
export const hopProposalSchema = z.object({
  target: z.enum(["local", "container", "attach"]),
  image: z.string().min(1).optional(),
  workload: workloadSchema.optional(),
  keep: z.boolean().optional(),
  /** Why the model proposes it: shown to the owner, never a precondition. */
  reason: z.string().optional(),
});

export type HopProposalInput = z.infer<typeof hopProposalSchema>;

export const HOP_PROPOSAL_INVALID =
  "_the model proposed a move this client cannot read — nothing moved_";

/** What one turn's events have shown so far: a `move_session` call still open. */
export interface HopProposalWatch {
  /** Tool-call ids of a `move_session` start whose result has not arrived. */
  readonly open: Readonly<Record<string, string>>;
}

export const NO_HOP_PROPOSAL: HopProposalWatch = { open: {} };

export type HopProposalStep =
  | { readonly kind: "none" }
  /** A hop the owner may approve at turn end. */
  | { readonly kind: "proposed"; readonly spec: HopSpec; readonly reason?: string }
  /** A call that finished successfully but whose arguments are not a move: said, not swallowed. */
  | { readonly kind: "invalid" };

/**
 * Fold ONE event of a turn into the watch, and say what it proposes. `own` is
 * the TUI's own-turn fact: another device's turn never proposes a hop here (its
 * owner is being asked on their own terminal).
 */
export function hopProposalStep(
  watch: HopProposalWatch,
  event: SessionEvent,
  own: boolean,
): { readonly watch: HopProposalWatch; readonly step: HopProposalStep } {
  if (!own) {
    return { watch, step: { kind: "none" } };
  }
  if (event.type === "tool_start") {
    if (event.name !== MOVE_SESSION_TOOL) {
      return { watch, step: { kind: "none" } };
    }
    return {
      watch: { open: { ...watch.open, [event.id]: event.arguments } },
      step: { kind: "none" },
    };
  }
  if (event.type !== "tool_result") {
    return { watch, step: { kind: "none" } };
  }
  const args = watch.open[event.id];
  if (args === undefined) {
    return { watch, step: { kind: "none" } };
  }
  const { [event.id]: _done, ...rest } = watch.open;
  const next = { open: rest };
  // A refused or failed call proposes nothing (its own text already says why).
  if (event.result.isError === true) {
    return { watch: next, step: { kind: "none" } };
  }
  const spec = hopSpecOf(args);
  if (spec === null) {
    return { watch: next, step: { kind: "invalid" } };
  }
  return {
    watch: next,
    step: {
      kind: "proposed",
      spec: spec.spec,
      ...(spec.reason !== undefined ? { reason: spec.reason } : {}),
    },
  };
}

/**
 * The arguments as a `HopSpec`, or `null` when they are not one: strict parse,
 * then the cross-field rules a move must satisfy (`attach` names a workload;
 * `local`/`container` name none). `keep` defaults to true (decision 5).
 */
export function hopSpecOf(
  args: string,
): { readonly spec: HopSpec; readonly reason?: string } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(args);
  } catch {
    return null;
  }
  const parsed = hopProposalSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const input = parsed.data;
  const keep = input.keep ?? true;
  const out = (spec: HopSpec): { readonly spec: HopSpec; readonly reason?: string } => ({
    spec,
    ...(input.reason !== undefined && input.reason !== "" ? { reason: input.reason } : {}),
  });
  if (input.target === "attach") {
    if (input.workload === undefined) {
      return null;
    }
    // The SAME workload validator the typed `/move attach` uses, so the two
    // paths cannot accept different grammars (and a pod-supplied `:`,`/` or
    // control byte never reaches a badge or an engine call). The namespace (OD1)
    // is checked by that same call, so a bad one is null here too.
    const checked = hopWorkload(
      input.workload.engine,
      input.workload.name,
      input.workload.container,
      input.workload.namespace,
    );
    if (checked.kind !== "ok") {
      return null;
    }
    return out({ target: "attach", workload: checked.workload, keep });
  }
  // A workload is `attach`'s, and an image is `container`'s: a target that names
  // either where it has no meaning is a malformed call, not a defaulted one.
  if (input.workload !== undefined) {
    return null;
  }
  if (input.target === "container") {
    return out(
      input.image === undefined
        ? { target: "container", keep }
        : { target: "container", image: input.image, keep },
    );
  }
  if (input.image !== undefined) {
    return null;
  }
  return out({ target: "local", keep });
}

/**
 * The one line the owner reads before approving a proposal: what would move,
 * where to, and — `keep: false` — that the workload would be DELETED. Every
 * part of it that a daemon supplied (`reason`, a workload name, an IMAGE) is
 * sanitized HERE (AGENTS §7: pod-supplied text is pod-supplied on every
 * origin). The image is always named: it is the argument that decides what code
 * runs with the owner's folder mounted (D6), so hiding it would hide the only
 * part of the prompt that matters.
 */
export function proposalNotice(spec: HopSpec, reason?: string): string {
  const where =
    spec.target === "attach"
      ? workloadText(spec.workload)
      : spec.target === "container"
        ? spec.image === undefined
          ? "a container (the default image)"
          : `a container running ${untrustedText(spec.image)}`
        : "local";
  const why = reason === undefined || reason === "" ? "" : ` — ${untrustedText(reason)}`;
  const remove = spec.keep ? "" : " (and remove the workload this hop created)";
  return `_the model proposes moving this session to ${where}${remove}${why}_`;
}

/** The title of the prompt a proposed move raises (D9). The laptop's words only. */
export function hopPromptTitle(): string {
  return "Move this session?";
}

/** What D9's `session_hop` detail is built from — facts, never the model's prose. */
export interface HopPromptFacts {
  /** The container engine a `container` hop would build. Default `docker` (the local default). */
  readonly engine?: HopPromptEngine;
  /** The host folder `planWorkspace` would bind-mount. Absent: nothing is mounted. */
  readonly mount?: string;
  /** The workload this session LEAVES, when a hop back would decide its fate (`delete`/`kept`). */
  readonly workload?: string;
  /**
   * OD3: the k8s namespace's PROVENANCE (which fact decided it), so a live test
   * answers "why that namespace" from the prompt itself. The name is already in
   * the label (`workloadText`); this is the `(from …)` half.
   */
  readonly namespace?: KubeNamespace;
  /**
   * D6's mount-gate `ask` text. Merged into THIS detail (review M6): the owner
   * answers one question, not two, and the gate's warning cannot be missed
   * because it arrived as a second prompt while this one was open. Set ONLY for
   * an `ask`: a Yes here also answers the gate, so the build does not re-ask
   * (`mountConfirmed`, H5 review finding 2).
   */
  readonly gate?: string;
  /**
   * The gate's `proceed` WARNINGS (a case-reachable mask). Shown here so the owner
   * is not surprised later; nothing to answer, so no build-time prompt follows.
   */
  readonly gateWarnings?: string;
  /** The model's own reason (D9). POD-SUPPLIED: sanitized, and always LAST. */
  readonly reason?: string;
}

/**
 * The `session_hop` prompt's detail (D9, review M6): the FULL text the owner
 * reads before a proposed move is built. The laptop writes every line that
 * decides anything — the engine, the complete image reference, the host mount
 * path (read-write), the inject, the delete intent — and the only daemon-supplied
 * text (`reason`, a workload name, an image) reaches it through `untrustedText`,
 * the reason last and labelled as the model's words. It is the SAME prompt the
 * mount gate's `ask` uses, merged, so a hop never asks twice.
 */
export function hopPromptDetail(spec: HopSpec, facts: HopPromptFacts = {}): string {
  const lines: string[] = [];
  if (spec.target === "local") {
    // The one thing a hop to local means, and the reason it needs a yes at all:
    // after it, the agent's shell commands run on THIS machine, not in a box.
    lines.push("local — the agent will run commands on this machine");
  } else if (spec.target === "container") {
    lines.push(`a ${facts.engine ?? "docker"} container`);
    lines.push(
      spec.image === undefined ? "image: the default image" : `image: ${untrustedText(spec.image)}`,
    );
    if (facts.mount !== undefined) {
      // Read-write, and the HOST path: what becomes reachable from the image.
      lines.push(`mount: ${untrustedText(facts.mount)} (read-write)`);
    }
  } else {
    lines.push(`attach to ${workloadName(spec.workload)} — tentacle is injected into it`);
    if (spec.workload.engine === "kubernetes") {
      lines.push("your folder is NOT shared with this pod");
    }
  }
  // OD3: WHICH fact decided the namespace, right after the place it belongs to.
  if (facts.namespace !== undefined) {
    lines.push(namespaceTrace(facts.namespace));
  }
  if (facts.gate !== undefined && facts.gate !== "") {
    lines.push(untrustedText(facts.gate));
  }
  if (facts.gateWarnings !== undefined && facts.gateWarnings !== "") {
    lines.push(untrustedText(facts.gateWarnings));
  }
  // The fate of what we leave: said OUT LOUD both ways, because silence reads as
  // a delete — and a hop back is the only place a delete can happen (D5).
  if (facts.workload !== undefined) {
    lines.push(
      spec.keep
        ? `${untrustedText(facts.workload)} is kept (tentacle attach to return)`
        : `${untrustedText(facts.workload)} will be DELETED`,
    );
  }
  lines.push(
    "background jobs, MCP servers and session approvals are reset (auto-accept survives the move)",
  );
  if (facts.reason !== undefined && facts.reason !== "") {
    // LAST, and labelled: it is the model's own words, not a fact of the plan.
    lines.push(`the model's reason: ${untrustedText(facts.reason)}`);
  }
  return lines.join("\n");
}

/** The container engine a hop would build (docker is the local default; `podman` a config's). */
export type HopPromptEngine = "docker" | "podman";

/**
 * OD1/OD2: a PROPOSAL's namespace, resolved at the turn's end. `pinned` carries
 * the spec to show and build (its `workload.namespace` written in) plus the
 * provenance the prompt states; `failed` is a resolution that could not be made —
 * nothing is asked and nothing is built, and the model is told why (OD6).
 */
export type HopNamespacePin =
  | { readonly kind: "pinned"; readonly spec: HopSpec; readonly namespace?: KubeNamespace }
  /** `line`: the REASON (no brackets) — `hopWakeLine` renders `[move failed: …]`. */
  | { readonly kind: "failed"; readonly line: string };

/**
 * `<engine>:<ns>/<name>[/<container>]`, sanitized: names may be pod-supplied. ONE
 * label function (`workloadText`), so this prompt, the live row, the outcome and
 * the wake-up line cannot print the same workload differently (OD1).
 */
function workloadName(workload: HopWorkload): string {
  return workloadText(workload);
}

/**
 * OD3's provenance line: `namespace <ns> (from <source>; context <c>, <path>)`.
 * The kubeconfig path and context are named only when one was really consulted,
 * so a server/env/explicit answer never claims a file it did not read.
 */
export function namespaceTrace(namespace: KubeNamespace): string {
  const extra = [
    ...(namespace.context === undefined ? [] : [`context ${namespace.context}`]),
    ...(namespace.kubeconfig === undefined ? [] : [namespace.kubeconfig]),
  ];
  const from = extra.length === 0 ? namespace.source : `${namespace.source}; ${extra.join(", ")}`;
  return `namespace ${untrustedText(namespace.namespace)} (from ${from})`;
}

/**
 * D9's "the model is told": the refused proposal's line, prepended to the NEXT
 * prompt. It is conversation (saved with the message), so the model reads it in
 * the history and does not propose the same move again as if unanswered.
 */
export const MOVE_DECLINED_LINE = MOVE_SESSION_DECLINED_HINT;
