/**
 * Who answers a detached run's permission asks (docs/feat/detached-relay.md,
 * DR-3): the relay's one broker's requester, pure. Off, an ask is HELD until it
 * is withdrawn, with the tool not run: nobody decided. `--auto-accept`: a tool
 * ask of the relay's own turn is allowed once and logged. A pod is not trusted
 * (AGENTS §7), so nothing here outlives the call, and a hooks trust ask or
 * another client's turn is never answered.
 *
 * The own-vs-foreign test here is `RemoteSession.ownsTurn` — the turns the relay
 * MINTED — and never the wider `autoAcceptsTurn`
 * (docs/fix/autoaccept-wake-turns.md A8). A detached run exists only on a pod,
 * where no daemon wakes on its own: the relay starts its own wake turns, and
 * they are already `own`. So a pod-supplied `wake-…` id is FOREIGN here, which
 * is exactly the rule AGENTS §7 asks for. Do not wire `autoAcceptsTurn` (or a
 * prefix check) into it; `relay-policy.test.ts` pins it.
 */
import { DISMISSED, type PermissionRequester, type PermissionResponse } from "@tentacle/core";
import { autoApproves, ownRequest } from "@tentacle/tui";
import type { RelayEvent } from "./relay-state.ts";
import { untrustedText } from "./untrusted-text.ts";

export interface RelayPolicy {
  readonly requester: PermissionRequester;
  /** The session's own-vs-foreign test; until it is bound, no request is own. */
  bindOwnsTurn(owns: (turnId: string) => boolean): void;
  /**
   * A hand-over is prepared (docs/feat/detached-handover.md): every ask is
   * held, auto-accept included, so the relay never decides under the
   * attaching TUI's prompt.
   */
  freeze(): void;
  /** The hand-over aborted: the asks the freeze held go back through the same decision, once. */
  thaw(): void;
}

export function relayPolicy(options: {
  readonly autoAccept: boolean;
  readonly emit: (event: RelayEvent) => void;
  readonly log: (line: string) => void;
}): RelayPolicy {
  let owns: (turnId: string) => boolean = () => false;
  let frozen = false;
  /** The asks held by the freeze, each with its one re-decision. */
  const held = new Set<() => void>();
  return {
    bindOwnsTurn(test) {
      owns = test;
    },
    freeze() {
      frozen = true;
    },
    thaw() {
      frozen = false;
      for (const decide of [...held]) {
        held.delete(decide);
        decide();
      }
    },
    requester(req, request) {
      const signal = request?.signal;
      if (signal?.aborted) {
        return Promise.resolve(DISMISSED);
      }
      const auto = (): boolean =>
        options.autoAccept && autoApproves(req, ownRequest(request?.turnId, owns));
      const accept = (): PermissionResponse => {
        options.log(
          `auto-accepted (once): ${untrustedText(`${req.tool}: ${req.title} ${req.detail ?? ""}`)}\n`,
        );
        return { allowed: true, scope: "once" };
      };
      if (!frozen && auto()) {
        return Promise.resolve(accept());
      }
      options.emit({ type: "ask_raised", tool: untrustedText(req.tool) });
      return new Promise<PermissionResponse>((resolve) => {
        let done = false;
        const finish = (response: PermissionResponse): void => {
          if (!done) {
            done = true;
            held.delete(decide);
            options.emit({ type: "ask_gone" });
            resolve(response);
          }
        };
        const decide = (): void => {
          if (auto()) {
            finish(accept());
          }
        };
        if (frozen) {
          held.add(decide);
        }
        signal?.addEventListener("abort", () => finish(DISMISSED), { once: true });
      });
    },
  };
}
