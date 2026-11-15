/**
 * The agent's `move_session` tool (docs/feat/session-hop.md D9, slice H5): the
 * ONE way the model can ask for its session to be moved to another target.
 *
 * It has **no effect at all**, and that is the design, not a shortcut. The tool
 * validates its own arguments and answers one sentence; the laptop watches its
 * OWN turn's events (`cli/src/hop-proposal.ts`), and at the turn's end asks the
 * owner through the single broker — a `session_hop` prompt that auto-accept never
 * answers and nothing remembers. So a daemon — a pod especially, which is not
 * trusted (AGENTS §7) — cannot move anything by calling it, or by forging the
 * call: all a forged call can do is raise a prompt the owner reads and may refuse.
 *
 * The permission level is therefore `"none"`: there is no daemon-side effect to
 * authorize, and an `ask` here would put the same question in front of the owner
 * TWICE (once by the daemon's gate, once by the laptop's prompt) with the
 * daemon's copy being the one a standing approval could wave through.
 */
import type { Tool, ToolResult } from "@tentacle/core";
import { z } from "zod";

export const MOVE_SESSION_TOOL_NAME = "move_session";

/**
 * The longest `reason` the tool accepts. It ends up in the owner's prompt — a
 * pod-supplied text, sanitized there anyway — so a page-long paste is refused
 * here, where the model can see why, instead of being silently cut later.
 */
export const MOVE_SESSION_REASON_MAX = 500;

/**
 * What a workload name may contain, mirrored from the typed `/move` grammar
 * (`@tentacle/tui`'s `HOP_WORKLOAD_PART`, `hop-command.ts`) — the union of what
 * the engines accept, and nothing else: no `:`, no `/`, no whitespace, no control
 * or bidi byte. It is duplicated rather than imported because `@tentacle/tools`
 * may not depend on the TUI; the laptop's `hopSpecOf` remains the AUTHORITY and
 * re-checks every argument through `hopWorkload` before anything is built, so
 * the two cannot disagree about what is accepted (the stricter one refuses first).
 */
export const WORKLOAD_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The same 253-byte ceiling a k8s DNS-1123 name has (`HOP_WORKLOAD_PART_MAX`). */
export const WORKLOAD_PART_MAX = 253;

/**
 * The workload grammar, exported so `workload_shell` accepts EXACTLY the same
 * names as `move_session` — ONE spelling for both tools, never two that drift.
 */
export const workloadTargetGrammar = { part: WORKLOAD_PART, max: WORKLOAD_PART_MAX } as const;

/**
 * `container`/`namespace` are Kubernetes-only, enforced at parse for EVERY tool
 * that takes a workload (docs/fix/workload-shell-live.md D4). Exported as the
 * predicate so `workload_shell` reuses it rather than copying the rule.
 */
export const engineOnlyFields = (w: {
  readonly engine: string;
  readonly container?: string;
  readonly namespace?: string;
}): boolean =>
  w.engine === "kubernetes" || (w.container === undefined && w.namespace === undefined);

const workloadSchema = z
  .object({
    engine: z.enum(["kubernetes", "docker", "podman"]),
    name: z.string().min(1).max(WORKLOAD_PART_MAX).regex(WORKLOAD_PART),
    /** k8s only: the container in the pod (docker/podman have none). */
    container: z.string().min(1).max(WORKLOAD_PART_MAX).regex(WORKLOAD_PART).optional(),
  })
  .refine(engineOnlyFields, { message: "only a kubernetes workload names a container" });
/**
 * The tool's input, as the model is offered it: exactly the `HopSpec` the typed
 * `/move` produces, so a proposed move and a typed one are the same thing
 * everywhere downstream. Unknown fields are stripped (zod's default), so a newer
 * laptop's extra argument is ignored rather than fatal — the wire's own rule.
 */
export const moveSessionSchema = z
  .object({
    target: z.enum(["local", "container", "attach"]),
    /** `container` only: the image to run. Unset → this runtime's default image. */
    image: z.string().min(1).optional(),
    /** `attach` only: the workload to join. */
    workload: workloadSchema.optional(),
    /**
     * What happens to the workload this session LEAVES. Unset → keep it
     * (decision 5): deleting is always explicit.
     */
    keep: z.boolean().optional(),
    /** Why the model proposes it, shown to the owner. Never a precondition. */
    reason: z.string().max(MOVE_SESSION_REASON_MAX).optional(),
  })
  .refine((input) => input.workload === undefined || input.target === "attach", {
    message: 'a workload belongs to target "attach"',
  })
  .refine((input) => input.image === undefined || input.target === "container", {
    message: 'an image belongs to target "container"',
  })
  .refine((input) => input.target !== "attach" || input.workload !== undefined, {
    message: 'target "attach" needs a workload',
  });

export type MoveSessionInput = z.infer<typeof moveSessionSchema>;

/**
 * What the model reads back. One sentence, and the second half is the point: the
 * turn goes on either way, and a model that assumed the move would answer a
 * question about a session that is not where it thinks.
 */
export const MOVE_SESSION_PROPOSED =
  "Proposed; the user will be asked when this turn ends. Do not assume the move happened: nothing moves until they say yes, and this session stays where it is until then.";

/**
 * The line the laptop prepends to the NEXT prompt after the owner refused a
 * proposal (D9's "[move declined]"): the model is told, so it does not repeat the
 * request as if it had never been answered. Exported here so the tool's own
 * description and the laptop's line cannot drift apart.
 */
export const MOVE_SESSION_DECLINED_HINT =
  "[move declined] the user refused to move this session; do not propose the same move again unless something changed";

export const MOVE_SESSION_DESCRIPTION = `Propose moving this session to another target: "container" (a new docker/podman container running an image, with your working folder mounted read-write), "attach" (an EXISTING workload, by engine and name), or "local" (back to the user's own machine).

This tool only PROPOSES. It builds nothing and moves nothing, and it returns at once — the user is asked in their own terminal when this turn ends, and nothing moves until they say yes. Do not assume the move happened, and do not ask again in the same turn: there is one prompt per turn, and the answer arrives in your NEXT prompt (a refused move begins with \`${MOVE_SESSION_DECLINED_HINT.split("]")[0]}]\`). Use it when the work genuinely needs the other place — a tool or dependency that only the workload has, or a build that must run on the user's machine — never to tidy up or to escape a failure you could fix here.

After a move, background jobs, MCP servers and session-scoped approvals are reset, and auto-accept is turned off; say so when you tell the user what changed. Put the image in \`image\` (target "container") or the workload in \`workload\` (target "attach"), and set \`keep: false\` only if the workload this session is LEAVING should be deleted (the default keeps it).`;

export function createMoveSessionTool(): Tool<MoveSessionInput> {
  return {
    name: MOVE_SESSION_TOOL_NAME,
    description: MOVE_SESSION_DESCRIPTION,
    inputSchema: moveSessionSchema,
    // No daemon-side effect exists to authorize (see the module comment).
    permission: "none",
    // Alone, always: a proposal is one turn's fact, and a sibling call in the
    // same group could only make it ambiguous (docs/feat/parallel-tools.md).
    concurrency: "exclusive",
    async execute(input: MoveSessionInput): Promise<ToolResult> {
      // A direct caller (a registry without the agent loop's own validation, a
      // test) must not get "proposed" for arguments no move could use.
      const parsed = moveSessionSchema.safeParse(input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        return {
          content: `move_session was not proposed: invalid input (${where}${issue?.message ?? "invalid"})`,
          isError: true,
        };
      }
      return { content: MOVE_SESSION_PROPOSED };
    },
  };
}
