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
  | {
      readonly kind: "approved";
      readonly spec: HopSpec;
      /**
       * The prompt this Yes answered already showed the mount gate's warning
       * (D9/M6): the build must not ask again (H5 review finding 2).
       */
      readonly gateAnswered?: true;
      /**
       * OD4's LOGGED allow-once: no human was asked (auto-accept answered it), so
       * the outcome line says so — the owner must be able to tell, after the fact,
       * that a move happened without a prompt.
       */
      readonly autoAccepted?: true;
    }
  /** Refused, dismissed or unaskable: nothing is built, and the model is told. */
  | { readonly kind: "declined"; readonly line: string };

/**
 * The prompt a proposal raises: a `session_hop` request, laptop-originated (D9).
 * The detail is the laptop's own text (`hopPromptDetail`), and the same request
 * shape carries D6's mount-gate warnings when they apply — ONE prompt, not two
 * (review M6).
 */
export function hopPromptRequest(
  spec: HopSpec,
  facts: HopPromptFacts = {},
  opts: { readonly auto?: boolean } = {},
): PermissionRequest {
  return {
    kind: "session_hop",
    tool: "move_session",
    level: "ask",
    title: hopPromptTitle(),
    detail: hopPromptDetail(spec, facts),
    // The LAPTOP's own verdict on whether auto-accept may answer this one
    // (docs/feat/session-hop-ux OD4). Set from `hopAutoAcceptable` and nothing
    // else: a daemon cannot reach this field (it is not on the wire).
    ...(opts.auto === true ? { hopAuto: true as const } : {}),
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
  shown: { readonly gate?: string } = {},
): HopProposalOutcome {
  if (response.allowed !== true || response.dismissed === true) {
    return { kind: "declined", line: MOVE_DECLINED_LINE };
  }
  // ONE prompt: a Yes to a detail that CARRIED the gate's warning answered the
  // gate too, so the build does not raise a second ask (H5 review finding 2).
  const gate = shown.gate !== undefined && shown.gate !== "";
  // OD4: `auto` is process-internal (`permission-ui.ts`'s requester sets it when it
  // skipped the dialog); it rides the outcome so the line can say `(auto-accepted)`.
  const autoAccepted = response.auto === true;
  return {
    kind: "approved",
    spec,
    ...(gate ? { gateAnswered: true as const } : {}),
    ...(autoAccepted ? { autoAccepted: true as const } : {}),
  };
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
  /**
   * OD4: where the proposed move comes FROM (the hop feed's own `place()`, a
   * laptop fact). It decides ONE thing — whether auto-accept may answer the prompt
   * (`hopAutoAcceptable`) — and nothing about the request's text. Absent: the
   * prompt is asked for as a human's (`hopAuto` unset).
   */
  origin?: { readonly kind: "local" } | { readonly kind: "workload" },
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
  const auto = origin !== undefined && hopAutoAcceptable(proposed.spec, origin);
  const response = await ask(hopPromptRequest(proposed.spec, shown, { auto }));
  return hopProposalOutcome(proposed.spec, response, shown);
}

/** Where the session is at, for the one message the model reads after a move. */
export type HopWakeFact =
  | {
      readonly kind: "moved";
      /** The place as ONE label (`workloadText`, OD1): `local`, `docker:box`, `kubernetes:<ns>/<pod>`. */
      readonly place: string;
      /** The daemon session's own cwd after the move; absent → the line says nothing about it. */
      readonly cwd?: string;
      /** Whether the laptop folder is visible there (OD6's `folder <shared|not shared>`). */
      readonly folder: HopFolderFate;
    }
  /** A proposed move that could not be built (the pin, the build or the commit failed). */
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "declined" };

/**
 * Whether the laptop's folder is shared with the new place: `shared` (a container
 * built with the mount), `not shared` (a pod, an existing workload nobody mounted
 * for) and `local` (it IS the laptop's).
 */
export type HopFolderFate = "shared" | "not shared" | "local";

/**
 * OD4: may auto-accept answer THIS proposed move? `spec.target === "local"` coming
 * FROM a workload is the ONE no — a pod asking to run commands on the laptop is
 * exactly what AGENTS §7 forbids answering without a human. Everything else is a
 * move between places the owner already authorised for this session, and OD4 says
 * answer it, logged allow-once.
 *
 * A pure function of two facts, both laptop-side: the spec, and the hop feed's own
 * `place()` (the origin). It is the ONLY producer of `hopAuto` — a test's mutation
 * (`return true`) makes the workload→local row fail.
 */
export function hopAutoAcceptable(
  spec: HopSpec,
  origin: { readonly kind: "local" } | { readonly kind: "workload" },
): boolean {
  return !(spec.target === "local" && origin.kind === "workload");
}

/**
 * The ONE message a session gets after a move (docs/feat/session-hop-ux OD6),
 * replacing `moveGuideLine`: where it is, what the folder is, what was reset, and
 * whether auto-accept is on — so the model neither guesses nor states a stale mode
 * (`ctx` is the TUI's LIVE value, read at render time). EVERY part of it that a pod
 * could have supplied (`place`, `cwd`, `reason`) goes through `untrustedText`,
 * because this text becomes part of the user message the model reads next.
 */
export function hopWakeLine(fact: HopWakeFact, ctx: { readonly autoAccept: boolean }): string {
  if (fact.kind === "failed") {
    return `[move failed: ${untrustedText(fact.reason)}]`;
  }
  if (fact.kind === "declined") {
    return MOVE_DECLINED_LINE;
  }
  const where = [
    `session moved to ${untrustedText(fact.place)}`,
    ...(fact.cwd === undefined ? [] : [`cwd ${untrustedText(fact.cwd)}`]),
    `folder ${fact.folder}`,
  ];
  return `[${where.join(" — ")}; background jobs and MCP servers were reset; auto-accept ${ctx.autoAccept ? "on" : "off"}]`;
}
