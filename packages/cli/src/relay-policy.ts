/**
 * Who answers a detached run's permission asks (docs/feat/detached-relay.md,
 * DR-3): the relay's one broker's requester, pure. Off, an ask is HELD until it
 * is withdrawn, with the tool not run: nobody decided. `--auto-accept`: a tool
 * ask of the relay's own turn is allowed once and logged. A pod is not trusted
 * (AGENTS §7), so nothing here outlives the call, and a hooks trust ask or
 * another client's turn is never answered.
 */
import { DISMISSED, type PermissionRequester, type PermissionResponse } from "@tentacle/core";
import { autoApproves, ownRequest } from "@tentacle/tui";
import type { RelayEvent } from "./relay-state.ts";
import { untrustedText } from "./untrusted-text.ts";

export interface RelayPolicy {
  readonly requester: PermissionRequester;
  /** The session's own-vs-foreign test; until it is bound, no request is own. */
  bindOwnsTurn(owns: (turnId: string) => boolean): void;
}

export function relayPolicy(options: {
  readonly autoAccept: boolean;
  readonly emit: (event: RelayEvent) => void;
  readonly log: (line: string) => void;
}): RelayPolicy {
  let owns: (turnId: string) => boolean = () => false;
  return {
    bindOwnsTurn(test) {
      owns = test;
    },
    requester(req, request) {
      const signal = request?.signal;
      if (signal?.aborted) {
        return Promise.resolve(DISMISSED);
      }
      if (options.autoAccept && autoApproves(req, ownRequest(request?.turnId, owns))) {
        options.log(
          `auto-accepted (once): ${untrustedText(`${req.tool}: ${req.title} ${req.detail ?? ""}`)}\n`,
        );
        return Promise.resolve({ allowed: true, scope: "once" });
      }
      options.emit({ type: "ask_raised", tool: untrustedText(req.tool) });
      return new Promise<PermissionResponse>((resolve) => {
        signal?.addEventListener(
          "abort",
          () => {
            options.emit({ type: "ask_gone" });
            resolve(DISMISSED);
          },
          { once: true },
        );
      });
    },
  };
}
