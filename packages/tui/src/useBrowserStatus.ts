/**
 * The session's `browser/status`, read again whenever it may have changed
 * (docs/feat/browser-inspect.md B6a): on open/attach and every `capabilities`
 * report (both hand over a new `caps`), when a browser tool finishes (`doneKey`)
 * and when the `/browser` panel opens. Only a session that HAS the browser is
 * asked. The last read wins: an older answer landing late, or one for a session
 * switched away from, is dropped; a failed read clears the old one (unknown,
 * never a stale count). A tab the user closes in Chrome is seen at the next of
 * those moments (the plan's stated debt).
 */
import type { BrowserStatusResult } from "@tentacle/protocol";
import { useEffect, useRef, useState } from "react";
import type { SessionController } from "./app-types.ts";
import type { CapsView } from "./capability-toggles.ts";

export interface BrowserStatusHost {
  readonly sessionRef: { readonly current: SessionController | null };
  readonly caps: CapsView | undefined;
  /** `browserDoneKey` of the transcript. */
  readonly doneKey: number;
  readonly panelOpen: boolean;
  /** Every accepted answer (null: the read failed): an open panel follows it. */
  readonly onStatus: (status: BrowserStatusResult | null) => void;
}

interface Read {
  readonly session: SessionController;
  readonly status: BrowserStatusResult | null;
}

export function useBrowserStatus(host: BrowserStatusHost): {
  /** The CURRENT session's last read; null: none, or it failed. */
  readonly status: BrowserStatusResult | null;
  readonly statusRef: { readonly current: BrowserStatusResult | null };
} {
  const { sessionRef, caps, doneKey, panelOpen, onStatus } = host;
  const [read, setRead] = useState<Read | null>(null);
  const seqRef = useRef(0);
  const available = caps?.browser !== undefined;
  const session = sessionRef.current;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `caps`, `doneKey` and `panelOpen` are the triggers, not inputs
  useEffect(() => {
    seqRef.current += 1;
    const seq = seqRef.current;
    if (!available || !session?.browserStatus) {
      return;
    }
    const settle = (status: BrowserStatusResult | null): void => {
      if (seqRef.current === seq && sessionRef.current === session) {
        setRead({ session, status });
        onStatus(status);
      }
    };
    session.browserStatus().then(settle, () => settle(null));
  }, [session, available, caps, doneKey, panelOpen]);

  const status = available && read !== null && read.session === session ? read.status : null;
  const statusRef = useRef(status);
  statusRef.current = status;
  return { status, statusRef };
}
