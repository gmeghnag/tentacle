/**
 * The interactive permission dialog's state, isolated from the App.
 *
 * Installs this App as the `PermissionBroker`'s requester: when a tool needs
 * approval the broker calls us, we surface a prompt (unless auto-accept is on)
 * and resolve the broker's promise with the user's choice. Auto-accept (Shift+
 * Tab) is mirrored in a ref so toggling it mid-session takes effect without
 * re-installing the requester.
 */
import type { PermissionBroker, PermissionRequest, PermissionResponse } from "@tentacle/core";
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

/** The arrow-menu options for a request: once / always (scoped) / deny. */
export function buildPermissionChoices(req: PermissionRequest): PermissionChoice[] {
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

  const answer = useCallback((response: PermissionResponse) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setPending(null);
    resolve?.(response);
  }, []);

  const toggleAutoApprove = useCallback(() => {
    const next = !autoApproveRef.current;
    autoApproveRef.current = next;
    setAutoApprove(next);
    // If a request is on screen when auto-accept turns on, grant it immediately.
    if (next && resolveRef.current) {
      answer({ allowed: true, scope: "once" });
    }
  }, [answer]);

  useEffect(() => {
    if (!permissions) {
      return;
    }
    permissions.setRequester((req) => {
      // Auto-accept mode: grant without prompting (not remembered — scope once).
      if (autoApproveRef.current) {
        return Promise.resolve({ allowed: true, scope: "once" });
      }
      return new Promise<PermissionResponse>((resolve) => {
        resolveRef.current = resolve;
        setSelected(0);
        setPending(req);
      });
    });
    return () => {
      // Resolve a dangling request (deny) and detach on unmount.
      resolveRef.current?.({ allowed: false });
      resolveRef.current = null;
      permissions.reset();
    };
  }, [permissions]);

  const choices = pending ? buildPermissionChoices(pending) : [];
  return { pending, choices, selected, setSelected, answer, autoApprove, toggleAutoApprove };
}
