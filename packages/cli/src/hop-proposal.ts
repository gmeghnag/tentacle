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
import type { HopSpec } from "@tentacle/tui";
import { hopWorkload } from "@tentacle/tui";
import { z } from "zod";
import { untrustedText } from "./untrusted-text.ts";

/** The tool whose success proposes a hop (D9). */
export const MOVE_SESSION_TOOL = "move_session";

const engineSchema = z.enum(["kubernetes", "docker", "podman"]);
const workloadSchema = z.object({
  engine: engineSchema,
  name: z.string().min(1),
  container: z.string().min(1).optional(),
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
    // control byte never reaches a badge or an engine call).
    const checked = hopWorkload(
      input.workload.engine,
      input.workload.name,
      input.workload.container,
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
      ? `${spec.workload.engine}:${untrustedText(spec.workload.name)}${
          spec.workload.container ? `/${untrustedText(spec.workload.container)}` : ""
        }`
      : spec.target === "container"
        ? spec.image === undefined
          ? "a container (the default image)"
          : `a container running ${untrustedText(spec.image)}`
        : "local";
  const why = reason === undefined || reason === "" ? "" : ` — ${untrustedText(reason)}`;
  const remove = spec.keep ? "" : " (and remove the workload this hop created)";
  return `_the model proposes moving this session to ${where}${remove}${why}_`;
}
