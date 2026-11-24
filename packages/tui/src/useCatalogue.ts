/**
 * The project's workflow catalogue, READ (docs/feat/workflows-ui.md D8, slice
 * 2b): the at-rest line and the `/workflow` panel's "Workflows" section both paint
 * what this hook fetched.
 *
 * No filesystem watcher and no polling (D8): a re-read happens at the moments that
 * can change the answer — the session opening or switching, a turn ending (the
 * model may have written or edited a file), a run ending (an approval moved), a
 * `workflow_approve` ask being answered, and `/workflow` being typed. An editor
 * outside tentacle is seen at the next of those; the panel says so.
 *
 * AGENTS §7: the coalescing rule is `workflow-view.ts`'s (`catalogueRefresh`), and
 * this hook only EXECUTES it — ONE request in flight per session, one more
 * scheduled if a trigger lands meanwhile, so a burst of turn ends is never a queue
 * of reads. It declares its own effects (it is a leaf hook, not `useSessionLink`,
 * whose contract is "no effects"); the pinned count in `App` is unaffected.
 */
import { type MutableRefObject, useCallback, useEffect, useRef } from "react";
import type { SessionController } from "./app-types.ts";
import {
  CATALOGUE_IDLE,
  type CatalogueRefresh,
  type CatalogueView,
  catalogueRefresh,
} from "./workflow-view.ts";

export interface CatalogueHost {
  /** The live session: the catalogue is that session's project's. */
  readonly sessionRef: MutableRefObject<SessionController | null>;
  /** The session's id, as a VALUE (a switch changes it: that is a trigger). */
  readonly sessionId: string | null;
  /** `st.running`: the render value that says whether a turn is in flight. */
  readonly running: boolean;
  /** The newest ENDED run's id (`null`: none): a run ending re-reads. */
  readonly endedRunId: string | null;
  /** Bumped by `/workflow`: a manual re-read. */
  readonly commandToken: number;
  /**
   * A `workflow_approve` ask is on screen RIGHT NOW: its falling edge is D8's
   * "an approval was answered" trigger (the approval state moved with it).
   */
  readonly approvalPending: boolean;
  /** The last answer, as a ref: a non-render caller (the command) reads it. */
  readonly catalogueRef: MutableRefObject<CatalogueView>;
  /** Write the answer: a render, so the line and the panel paint it. */
  readonly setCatalogue: (cat: CatalogueView) => void;
}

export interface CatalogueLayer {
  /** Re-read now, coalesced (`/workflow`, an answered approval). */
  readonly refreshCatalogue: () => void;
  /** The answer as of the last render (`frameLayout` and the panel read it). */
  readonly catalogue: CatalogueView;
  /** Forget the answer: a session switch, before its own read lands. */
  readonly resetCatalogue: () => void;
  /** The current binding, for a caller outside a render (`commands/workflow.ts`). */
  readonly refreshCatalogueRef: MutableRefObject<() => void>;
}

export function useCatalogue(host: CatalogueHost): CatalogueLayer {
  const {
    sessionRef,
    sessionId,
    running,
    endedRunId,
    commandToken,
    approvalPending,
    catalogueRef,
    setCatalogue,
  } = host;
  // The read's own state: at most one in flight, at most one scheduled.
  const stateRef = useRef<CatalogueRefresh>(CATALOGUE_IDLE);
  // A turn's START asks for nothing: only a SETTLING turn re-reads.
  const prevRunningRef = useRef(running);
  // An approval's ASK does not read; its ANSWER does (D8: the approval moved).
  const prevApprovalRef = useRef(approvalPending);

  /**
   * ONE read. The answer is written only if this TUI still follows the session it
   * was asked for (a switch mid-read must never paint one project's files on
   * another's line), and a failure changes nothing on screen — the last answer
   * stays (stale beats flicker, D8) and the next trigger asks again.
   */
  const read = useCallback(() => {
    const session = sessionRef.current;
    const settle = (): void => {
      stateRef.current = catalogueRefresh(stateRef.current, "settled");
      if (stateRef.current.inFlight) {
        readRef.current?.();
      }
    };
    if (session?.workflowCatalogue === undefined) {
      // No catalogue seam (a pod, an older daemon): NO answer, which paints
      // nothing — never an empty list claiming this project has no workflows.
      setCatalogue(undefined);
      settle();
      return;
    }
    const id = session.sessionId;
    void session.workflowCatalogue().then(
      (answer) => {
        if (sessionRef.current?.sessionId === id) {
          setCatalogue(answer);
        }
        settle();
      },
      () => settle(),
    );
  }, [sessionRef, setCatalogue]);
  const readRef = useRef<(() => void) | null>(null);
  readRef.current = read;

  /**
   * A trigger: start a read, or — while one is in flight — schedule exactly ONE
   * more (the rule is `catalogueRefresh`'s, in ONE pure place).
   */
  const refreshCatalogue = useCallback(() => {
    const before = stateRef.current;
    stateRef.current = catalogueRefresh(before, "trigger");
    if (!before.inFlight) {
      read();
    }
  }, [read]);
  const refreshCatalogueRef = useRef(refreshCatalogue);
  refreshCatalogueRef.current = refreshCatalogue;

  const resetCatalogue = useCallback(() => {
    stateRef.current = CATALOGUE_IDLE;
    setCatalogue(undefined);
  }, [setCatalogue]);

  // A turn SETTLING (not a turn starting) is a trigger: the model may have written
  // a file. `running` is the dependency; the previous value says which edge it was.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the deps ARE the trigger (D8); the body reads the ref that tracks the edge.
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = running;
    if (wasRunning && !running) {
      refreshCatalogue();
    }
  }, [running]);

  // An approval ANSWERED (its ask left the screen): the store may have kept it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: same — the ref tracks the edge.
  useEffect(() => {
    const wasPending = prevApprovalRef.current;
    prevApprovalRef.current = approvalPending;
    if (wasPending && !approvalPending) {
      refreshCatalogue();
    }
  }, [approvalPending]);

  // The session opening/switching, a run ending, `/workflow`: one read for the
  // group, never one per trigger in the same render. It also fires at MOUNT —
  // which is D8's "after the session opens" for a local session (one that never
  // has an id) and, for a remote one, again when its id settles after the eager
  // open (coalesced, so that is one read plus at most one more).
  // biome-ignore lint/correctness/useExhaustiveDependencies: same — these ARE the trigger list.
  useEffect(() => {
    refreshCatalogue();
  }, [sessionId, endedRunId, commandToken]);

  return {
    refreshCatalogue,
    catalogue: catalogueRef.current,
    resetCatalogue,
    refreshCatalogueRef,
  };
}
