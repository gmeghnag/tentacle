/**
 * The interactive permission dialog's state, isolated from the App.
 *
 * Installs this App as the `PermissionBroker`'s requester: when a tool needs
 * approval the broker calls us, we surface a prompt (unless auto-accept is on)
 * and resolve the broker's promise with the user's choice. Auto-accept (Shift+
 * Tab) is mirrored in a ref so toggling it mid-session takes effect without
 * re-installing the requester.
 *
 * A prompt can end without a person's choice: its request is withdrawn (the
 * signal aborts — answered on another device, or its turn cancelled) or the
 * TUI unmounts. Both resolve `DISMISSED`: over RPC nothing is sent (the request
 * stays pending for another client); in-process the gate reads it as a refusal.
 */
import {
  DISMISSED,
  type PermissionBroker,
  type PermissionRequest,
  type PermissionResponse,
} from "@tentacle/core";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export interface PermissionChoice {
  readonly label: string;
  readonly response: PermissionResponse;
}

/**
 * Whether auto-accept (Shift+Tab) may answer `req`. Never a project-hooks
 * trust request (docs/feat/hooks-project-trust.md): trusting a repo's code is
 * a human decision, not a tool call to wave through.
 */
export function autoApproves(req: PermissionRequest): boolean {
  return req.kind !== "hooks_trust";
}

/** Whether the dialog shows the "writes confined here" row: tool calls only, not a trust request. */
export function permissionShowsCwd(req: PermissionRequest): boolean {
  return req.kind !== "hooks_trust";
}

/** At most this many detail rows in the dialog (a hooks trust request lists several). */
export const MAX_DETAIL_ROWS = 10;

/**
 * The dialog's detail rows: one for a tool (its subject, or "—"); for a hooks
 * trust request, each line of `detail`, capped at `MAX_DETAIL_ROWS` (the last
 * row then says how many were left out). The component truncates each row.
 */
export function permissionDetailLines(req: PermissionRequest): string[] {
  if (req.kind !== "hooks_trust") {
    return [req.detail ? req.detail : "—"];
  }
  const lines = (req.detail ?? "—").split("\n");
  if (lines.length <= MAX_DETAIL_ROWS) {
    return lines;
  }
  const kept = lines.slice(0, MAX_DETAIL_ROWS - 1);
  return [...kept, `… ${lines.length - kept.length} more lines`];
}

/** The trust menu: 4 choices when the laptop stores decisions, else this session only. */
function hooksTrustChoices(req: PermissionRequest): PermissionChoice[] {
  const input = req.input as { storeBacked?: unknown } | null;
  const storeBacked = input !== null && typeof input === "object" && input.storeBacked === true;
  return storeBacked
    ? [
        { label: "Trust for this session", response: { allowed: true, scope: "once" } },
        { label: "Always trust this project", response: { allowed: true, scope: "session" } },
        { label: "Don't trust", response: { allowed: false } },
        { label: "Never for this project", response: { allowed: false, scope: "session" } },
      ]
    : [
        { label: "Trust for this session", response: { allowed: true, scope: "once" } },
        { label: "Don't trust", response: { allowed: false } },
      ];
}

/** The arrow-menu options for a request: once / always (scoped) / deny. */
export function buildPermissionChoices(req: PermissionRequest): PermissionChoice[] {
  if (req.kind === "hooks_trust") {
    return hooksTrustChoices(req);
  }
  const always = req.suggestion
    ? `Yes, and don't ask again for \`${req.suggestion.prefix}\` commands`
    : "Yes, and don't ask again this session";
  return [
    { label: "Yes", response: { allowed: true, scope: "once" } },
    { label: always, response: { allowed: true, scope: "session" } },
    { label: "No", response: { allowed: false } },
  ];
}

export interface PermissionController {
  /** The request currently awaiting a choice, or null. */
  readonly pending: PermissionRequest | null;
  /** The menu options for `pending` (empty when idle). */
  readonly choices: PermissionChoice[];
  /** Highlighted option index. */
  readonly selected: number;
  readonly setSelected: Dispatch<SetStateAction<number>>;
  /** Resolve the pending request with `response` and clear the prompt. */
  answer(response: PermissionResponse): void;
  /** Auto-accept mode: `"ask"` tools run without prompting. */
  readonly autoApprove: boolean;
  /** Toggle auto-accept; granting a prompt already on screen when turning on. */
  toggleAutoApprove(): void;
}

export function usePermissionBroker(permissions?: PermissionBroker): PermissionController {
  const [pending, setPending] = useState<PermissionRequest | null>(null);
  const [selected, setSelected] = useState(0);
  const [autoApprove, setAutoApprove] = useState(false);
  const resolveRef = useRef<((r: PermissionResponse) => void) | null>(null);
  const autoApproveRef = useRef(false);
  const pendingRef = useRef<PermissionRequest | null>(null);

  const answer = useCallback((response: PermissionResponse) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    pendingRef.current = null;
    setPending(null);
    resolve?.(response);
  }, []);

  const toggleAutoApprove = useCallback(() => {
    const next = !autoApproveRef.current;
    autoApproveRef.current = next;
    setAutoApprove(next);
    // If a request is on screen when auto-accept turns on, grant it immediately
    // — unless auto-accept may not answer it (a hooks trust request).
    if (next && resolveRef.current && pendingRef.current && autoApproves(pendingRef.current)) {
      answer({ allowed: true, scope: "once" });
    }
  }, [answer]);

  useEffect(() => {
    if (!permissions) {
      return;
    }
    permissions.setRequester((req, options) => {
      const signal = options?.signal;
      if (signal?.aborted) {
        return Promise.resolve(DISMISSED);
      }
      // Auto-accept mode: grant without prompting (not remembered — scope once).
      if (autoApproveRef.current && autoApproves(req)) {
        return Promise.resolve({ allowed: true, scope: "once" });
      }
      return new Promise<PermissionResponse>((resolve) => {
        const onAbort = (): void => {
          // Withdrawn: close the dialog only if it is still this request's.
          if (resolveRef.current === settle) {
            resolveRef.current = null;
            pendingRef.current = null;
            setPending(null);
          }
          resolve(DISMISSED);
        };
        const settle = (response: PermissionResponse): void => {
          signal?.removeEventListener("abort", onAbort);
          resolve(response);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        resolveRef.current = settle;
        pendingRef.current = req;
        setSelected(0);
        setPending(req);
      });
    });
    return () => {
      // Unmounting is not a decision: resolve a dangling request DISMISSED.
      resolveRef.current?.(DISMISSED);
      resolveRef.current = null;
      permissions.reset();
    };
  }, [permissions]);

  const choices = pending ? buildPermissionChoices(pending) : [];
  return { pending, choices, selected, setSelected, answer, autoApprove, toggleAutoApprove };
}
