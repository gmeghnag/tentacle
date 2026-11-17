/**
 * The transcript's artifacts: the daemon's list, the join onto the `present`
 * rows, and the one phase word the phone shows while it cannot have them
 * (docs/feat/model-artifacts.md D9, T9.1).
 *
 * Why pure: a card under a row is keyed by a CALL ID (`ArtifactMeta.callId`), and
 * the three ways a row can get one — a live tool result's `details`, a reloaded
 * transcript joined onto `artifact/list`, and no list at all (an older daemon) —
 * are exactly the decisions this app got wrong once. The screen maps the result
 * to elements and owns nothing but spacing (AGENTS §7).
 *
 * It is the phone's copy of the TUI's `artifacts-panel.ts`
 * (`artifactsByCall`/`joinKnownArtifacts`, joined in `artifact-join.ts` there):
 * the same rule, on the phone's row type, so the two frontends show a resumed
 * transcript the same way.
 */
import { ArtifactsUnsupportedError } from "@tentacle/client";
import type { ArtifactMeta } from "@tentacle/protocol";
import type { Row } from "./transcript-rows.ts";

/** The `present` tool's name as the wire sends it (`@tentacle/tools`' name). */
export const PRESENT_TOOL_NAME = "present";

/**
 * What this screen knows about the session's artifacts. `loading` is the first
 * state (nothing asked yet) — never `ready` with an empty list, which would claim
 * a session has no artifacts before anyone looked.
 */
export type ArtifactPhase = "loading" | "ready" | "unsupported" | "offline" | "error";

export interface ArtifactJoin {
  /** Every version the daemon listed, oldest first (the gallery folds them). */
  readonly list: readonly ArtifactMeta[];
  /** The card to attach per `present` call id: the NEWEST version of that call. */
  readonly byCall: ReadonlyMap<string, ArtifactMeta>;
  readonly phase: ArtifactPhase;
}

export const EMPTY_JOIN: ArtifactJoin = { list: [], byCall: new Map(), phase: "loading" };

/**
 * The version to show per `present` call: the NEWEST, so a re-presented artifact
 * reads as the card the live turn last showed (the TUI's own rule).
 */
export function artifactsByCall(artifacts: readonly ArtifactMeta[]): Map<string, ArtifactMeta> {
  const byCall = new Map<string, ArtifactMeta>();
  for (const meta of artifacts) {
    const seen = byCall.get(meta.callId);
    if (seen === undefined || meta.version >= seen.version) {
      byCall.set(meta.callId, meta);
    }
  }
  return byCall;
}

/** The join after the daemon answered: `ready`, with its list and its call index. */
export function withList(join: ArtifactJoin, list: readonly ArtifactMeta[]): ArtifactJoin {
  return { list, byCall: artifactsByCall(list), phase: "ready" };
}

/**
 * The join in another phase, KEEPING the list it already held: a link that drops
 * dims a gallery, it never empties one (the scheduled-wakes rule).
 */
export function withPhase(join: ArtifactJoin, phase: ArtifactPhase): ArtifactJoin {
  return { ...join, phase };
}

/** The phase a failed `artifact/list` reads as (never a message: the app log is exportable). */
export function phaseOfError(error: unknown): ArtifactPhase {
  // An older daemon answers `MethodNotFound`, which the client maps to its own
  // error class: retrying can never help, so it is `unsupported`, not `error`.
  if (error instanceof ArtifactsUnsupportedError) {
    return "unsupported";
  }
  if (error instanceof Error && /not connected to the daemon/i.test(error.message)) {
    return "offline";
  }
  return "error";
}

/**
 * Will a mount's join change anything? A card-less `present` row is the only
 * thing the list can fill, so a session with none (or a fresh live one) asks the
 * daemon nothing (the TUI's `needsArtifactJoin`).
 */
export function needsArtifactJoin(rows: readonly Row[]): boolean {
  return rows.some(
    (row) => row.kind === "tool" && row.name === PRESENT_TOOL_NAME && row.artifact === undefined,
  );
}

/**
 * `rows` with each card-less tool row's own card attached from `byCall`. A row
 * that already carries one is left alone — the live path's is the present call's
 * own answer, never a later guess — and the SAME array comes back when nothing
 * joined, so a no-op cannot re-render the transcript.
 */
export function joinRows(
  rows: readonly Row[],
  byCall: ReadonlyMap<string, ArtifactMeta>,
): readonly Row[] {
  if (byCall.size === 0) {
    return rows;
  }
  let changed = false;
  const next = rows.map((row) => {
    if (row.kind !== "tool" || row.artifact !== undefined) {
      return row;
    }
    const meta = byCall.get(row.id);
    if (meta === undefined) {
      return row;
    }
    changed = true;
    return { ...row, artifact: meta };
  });
  return changed ? next : rows;
}

/**
 * Whether the gallery may list this join, and if not, the phase to say it in:
 * an older daemon and a dropped link are both "there is nothing to show YET, and
 * here is why" — never an empty gallery, which would read as "no artifacts".
 */
export function galleryListable(
  join: ArtifactJoin,
):
  | { readonly ok: true; readonly list: readonly ArtifactMeta[] }
  | { readonly ok: false; readonly phase: Exclude<ArtifactPhase, "ready"> } {
  if (join.phase === "ready") {
    return { ok: true, list: join.list };
  }
  return { ok: false, phase: join.phase };
}
