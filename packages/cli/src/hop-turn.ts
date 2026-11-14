/**
 * The turn-end half of H5 (docs/feat/session-hop.md D9): a proposal the model made
 * (`hopProposalStep`'s `proposed`) becomes ONE `session_hop` broker prompt when the
 * turn ends, and what the owner answers becomes a spec to move — or nothing at all.
 *
 * Everything here is PURE: the request it returns is data, and the caller asks it
 * through the single broker (the facade's `shared.permissions`, AGENTS §7). That
 * split is what makes the security properties testable without a terminal:
 *
 *   - it is asked ONCE per turn, and only for the OWN turn's proposal (`own`): the
 *     owner is asked on their own terminal, never for another device's move;
 *   - the only accepted answer is yes with `scope: "once"` — an approval that came
 *     back as `"session"` is coerced to a one-time yes, so nothing pod-originated
 *     creates a lasting approval (AGENTS §7);
 *   - auto-accept cannot answer it (`autoApproves` excludes `session_hop`), and this
 *     module never consults auto-accept: there is no path from it;
 *   - a refusal, a dismissal, or no answer at all builds NOTHING, and leaves the
 *     `[move declined]` line for the next prompt (review M7).
 */
import type { PermissionRequest, PermissionResponse } from "@tentacle/core";
import type { HopSpec, SessionEvent } from "@tentacle/tui";
import {
  type HopPromptFacts,
  MOVE_DECLINED_LINE,
  NO_HOP_PROPOSAL,
  hopPromptDetail,
  hopPromptTitle,
  hopProposalStep,
} from "./hop-proposal.ts";
import { untrustedText } from "./untrusted-text.ts";

// The declined line lives beside the prompt it belongs to, and is re-exported here
// so a caller has ONE module for D9's turn-end facts (review M7).
export { MOVE_DECLINED_LINE };

/** What one turn's end decided about a proposal. */
export type HopProposalOutcome =
  /** Nothing was proposed (or it was not this TUI's turn): the turn ends as it would. */
  | { readonly kind: "none" }
  /** A proposal the owner approved — as `once`. `spec` is what to build. */
  | { readonly kind: "approved"; readonly spec: HopSpec }
  /** Refused, dismissed or unaskable: nothing is built, and the model is told. */
  | { readonly kind: "declined"; readonly line: string };

/**
 * The prompt a proposal raises: a `session_hop` request, laptop-originated (D9).
 * The detail is the laptop's own text (`hopPromptDetail`), and the same request
 * shape carries D6's mount-gate warnings when they apply — ONE prompt, not two
 * (review M6).
 */
export function hopPromptRequest(spec: HopSpec, facts: HopPromptFacts = {}): PermissionRequest {
  return {
    kind: "session_hop",
    tool: "move_session",
    level: "ask",
    title: hopPromptTitle(),
    detail: hopPromptDetail(spec, facts),
    // The plan is already in the detail; nothing downstream parses this text.
    input: null,
  };
}

/**
 * The owner's answer read as a decision. `allowed` is the ONLY thing that matters
 * and a `dismissed` answer is never a yes: an approval with `scope: "session"` (a
 * frontend that answered from a stale menu) is still a ONE-TIME yes.
 */
export function hopProposalOutcome(
  spec: HopSpec,
  response: PermissionResponse,
): HopProposalOutcome {
  if (response.allowed !== true || response.dismissed === true) {
    return { kind: "declined", line: MOVE_DECLINED_LINE };
  }
  return { kind: "approved", spec };
}

/** One turn, watched: the open `move_session` calls, and the last proposal made. */
export interface HopTurnWatch {
  readonly watch: Parameters<typeof hopProposalStep>[0];
  /** The last proposal whose `tool_result` said it succeeded. */
  readonly proposal?: { readonly spec: HopSpec; readonly reason?: string };
  /** A call that finished "successfully" with arguments no move could use. */
  readonly invalid: boolean;
  /** The turn is over: no later event belongs to it. */
  readonly ended: boolean;
}

export const NO_HOP_TURN: HopTurnWatch = {
  watch: NO_HOP_PROPOSAL,
  invalid: false,
  ended: false,
};

/**
 * One event in, one watch out. `own` is the App's own-turn fact: a FOREIGN turn's
 * `move_session` is never asked about here (its owner is being asked on their own
 * terminal), and a child's call cannot arrive as one — a child's events are
 * `subagent_tool`, and it is not offered the tool at all.
 */
export function hopTurnStep(state: HopTurnWatch, event: SessionEvent, own: boolean): HopTurnWatch {
  if (state.ended || !own) {
    return state;
  }
  const out = hopProposalStep(state.watch, event, true);
  if (out.step.kind === "proposed") {
    return {
      watch: out.watch,
      proposal: {
        spec: out.step.spec,
        ...(out.step.reason !== undefined ? { reason: out.step.reason } : {}),
      },
      invalid: state.invalid,
      ended: false,
    };
  }
  if (out.step.kind === "invalid") {
    return { ...state, watch: out.watch, invalid: true };
  }
  return { ...state, watch: out.watch };
}

/** The turn is over: the same watch, closed (a late event is not this turn's). */
export function hopTurnEnd(state: HopTurnWatch): HopTurnWatch {
  return state.ended ? state : { ...state, ended: true };
}

/**
 * The ONE thing to ask at a turn's end, or `none`. `ask` is injected, never
 * imported: this module must not touch a broker itself, and a test's spy is the
 * single-broker proof (AGENTS §9). A proposal whose result never arrived is not a
 * proposal (the model may still be calling it), so `ended` is what gates this.
 */
export async function hopAskAtTurnEnd(
  state: HopTurnWatch,
  facts: (spec: HopSpec) => HopPromptFacts,
  ask: (request: PermissionRequest) => Promise<PermissionResponse>,
): Promise<HopProposalOutcome> {
  const proposed = state.proposal;
  if (!state.ended || proposed === undefined) {
    return { kind: "none" };
  }
  const shown: HopPromptFacts = {
    ...facts(proposed.spec),
    // The model's own words, last and labelled in the detail (M6). It is
    // POD-SUPPLIED on every origin, so `hopPromptDetail` sanitizes it.
    ...(proposed.reason !== undefined ? { reason: proposed.reason } : {}),
  };
  const response = await ask(hopPromptRequest(proposed.spec, shown));
  return hopProposalOutcome(proposed.spec, response);
}

/** The line a COMMITTED move leaves for the next prompt: where, and what was reset. */
export function moveGuideLine(where: string): string {
  return `[session moved to ${untrustedText(where)} — background jobs, MCP tools and approvals were reset]`;
}
