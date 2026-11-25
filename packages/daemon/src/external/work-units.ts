/**
 * An external caller's view of its units of work (docs/feat/a2a.md,
 * Unification §4; protocol-neutral per the owner's decision of 2026-11-25).
 * READ-ONLY: it reads `HostedSession.workUnits()` — the session log's own
 * record — and keeps nothing. No store, no index on disk, no write: a task is
 * a projection of a unit, never a fourth record beside turns, runs and
 * sub-agents.
 *
 * Owner scoping is by session id (`external/session-ids.ts`): only the
 * caller's `<protocol>-<caller>-*` sessions are read; a phone session or
 * another caller's is never visited.
 */
import type { WorkUnit } from "@tentacle/core";
import { contextIdOf } from "./session-ids.ts";

/** A unit, addressable by an external caller. */
export interface CallerUnit {
  /** A turn's `turnId`; a run's `origin` (the turn id it was started under). */
  readonly taskId: string;
  readonly contextId: string;
  readonly sessionId: string;
  readonly unit: WorkUnit;
}

/** What the projection reads of the host: its live sessions' units. */
export interface UnitSource {
  values(): Iterable<{ readonly id: string; workUnits(): WorkUnit[] }>;
}

/**
 * The addressable units of ONE session, by task id. A turn is addressed by its
 * own id; a run by its `origin`, unless a turn of that id exists (the turn
 * wins: a run the model started inside a caller's turn is part of that task).
 * A run with no origin is not addressable. Among same-id units the later one
 * (`workUnits()` order: ended oldest first, then live) wins.
 */
export function addressableUnits(units: readonly WorkUnit[]): Map<string, WorkUnit> {
  const byId = new Map<string, WorkUnit>();
  for (const unit of units) {
    if (unit.kind === "turn") {
      byId.set(unit.id, unit);
    }
  }
  const turns = new Set(byId.keys());
  for (const unit of units) {
    if (unit.kind === "workflow" && unit.origin !== undefined && !turns.has(unit.origin)) {
      byId.set(unit.origin, unit);
    }
  }
  return byId;
}

/** Every addressable unit of the caller's live contexts (one `contextId` when given). */
export function callerUnits(
  source: UnitSource,
  protocol: string,
  caller: string,
  contextId?: string,
): CallerUnit[] {
  const out: CallerUnit[] = [];
  for (const session of source.values()) {
    const context = contextIdOf(protocol, caller, session.id);
    if (context === null || (contextId !== undefined && context !== contextId)) {
      continue;
    }
    for (const [taskId, unit] of addressableUnits(session.workUnits())) {
      out.push({ taskId, contextId: context, sessionId: session.id, unit });
    }
  }
  return out;
}

/** The caller's unit addressed by `taskId`, if any of its live contexts holds it. */
export function findCallerUnit(
  source: UnitSource,
  protocol: string,
  caller: string,
  taskId: string,
): CallerUnit | undefined {
  for (const session of source.values()) {
    const context = contextIdOf(protocol, caller, session.id);
    if (context === null) {
      continue;
    }
    const unit = addressableUnits(session.workUnits()).get(taskId);
    if (unit !== undefined) {
      return { taskId, contextId: context, sessionId: session.id, unit };
    }
  }
  return undefined;
}
