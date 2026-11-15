/**
 * The agent's `move_session` tool (docs/feat/session-hop.md D9, slice H5): the
 * ONE way the model can ask for its session to be moved to another target.
 *
 * It has **no effect at all**, and that is the design, not a shortcut. The tool
 * validates its own arguments and answers one sentence; the laptop watches its
 * OWN turn's events (`cli/src/hop-proposal.ts`), and at the turn's end asks the
 * owner through the single broker — a `session_hop` prompt that auto-accept
 * answers ONLY for a move it may answer (`hopAutoAcceptable`: anything but a move
 * toward local proposed from a workload) and that nothing remembers. So a daemon —
 * a pod especially, which is not trusted (AGENTS §7) — cannot move anything by
 * calling it, or by forging the call: all a forged call can do is raise a prompt
 * the owner reads and may refuse (or, under auto-accept, one the LAPTOP's own rule
 * answers — decided from facts only the laptop holds, never from the arguments).
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

/**
 * A k8s NAMESPACE (OD1): a DNS-1123 label — lowercase alphanumerics and `-`, at
 * most 63, starting and ending alphanumeric. Mirrored from `@tentacle/tui`'s
 * `HOP_NAMESPACE` (`hop-command.ts`, with the same reason `WORKLOAD_PART` is
 * duplicated: `@tentacle/tools` may not depend on the TUI, and `hopSpecOf`
 * re-checks every argument through `hopWorkload` before anything is built).
 */
const NAMESPACE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const NAMESPACE_MAX = 63;

/** The same 253-byte ceiling a k8s DNS-1123 name has (`HOP_WORKLOAD_PART_MAX`). */
export const WORKLOAD_PART_MAX = 253;

/**
 * The workload grammar, exported so `workload_shell` accepts EXACTLY the same
 * names as `move_session` — ONE spelling for both tools, never two that drift.
 */
export const workloadTargetGrammar = { part: WORKLOAD_PART, max: WORKLOAD_PART_MAX } as const;

const workloadSchema = z
  .object({
    engine: z.enum(["kubernetes", "docker", "podman"]),
    name: z.string().min(1).max(WORKLOAD_PART_MAX).regex(WORKLOAD_PART),
    /** k8s only: the container in the pod (docker/podman have none). */
    container: z.string().min(1).max(WORKLOAD_PART_MAX).regex(WORKLOAD_PART).optional(),
    /**
     * k8s only: the pod's namespace (OD1). Unset → the OD2 default rule, resolved
     * on the laptop at the turn's end and SHOWN before the move is applied, so a
     * model that omits it never gets a silent guess.
     */
    namespace: z
      .string()
      .max(NAMESPACE_MAX, `a namespace is at most ${NAMESPACE_MAX} characters`)
      .regex(NAMESPACE, "a namespace is lowercase letters, digits and '-' only")
      .describe("kubernetes only: the pod's namespace; omit to use your context's")
      .optional(),
  })
  .refine((w) => w.container === undefined || w.engine === "kubernetes", {
    message: "only a kubernetes workload names a container",
  })
  .refine((w) => w.namespace === undefined || w.engine === "kubernetes", {
    message: "only a kubernetes workload names a namespace",
  });

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
  "Proposed; it is applied when this turn ends (no prompt if auto-accept is on). Do not assume the move happened: a message at the start of the next turn tells you the result.";

/**
 * The line the laptop prepends to the NEXT prompt after the owner refused a
 * proposal (D9's "[move declined]"): the model is told, so it does not repeat the
 * request as if it had never been answered. Exported here so the tool's own
 * description and the laptop's line cannot drift apart.
 */
export const MOVE_SESSION_DECLINED_HINT =
  "[move declined] the user refused to move this session; do not propose the same move again unless something changed";

export const MOVE_SESSION_DESCRIPTION = `Propose moving this session to another place; it is applied when this turn ends. Use it for multi-step work that needs a workload's tools or files; a one-off check can stay a single kubectl/oc exec. Targets: "attach" an existing workload (kubernetes: namespace, pod, optional container; docker/podman: name), "container" (a new container with your folder mounted), "local" (the user's machine). Do not assume the move happened: a message in the new place tells you where you are. The user confirms it unless auto-accept is on; background jobs and MCP servers are reset.`;

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
