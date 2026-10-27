/**
 * The ONE place an `EngineEndpoint` becomes a `Dialer`: unix / tcp(+TLS) →
 * `socketDialer`, ssh → `sshDialer` (`dial-stdio`). Shared by the CLI's engine
 * wiring (slice C) and the exit-net child (`container-cleanup.ts`), so both
 * reach the engine through the same code path.
 */
import { type Dialer, socketDialer } from "./byte-duplex.ts";
import type { EngineEndpoint } from "./engine-endpoint.ts";
import { sshDialer } from "./ssh-dialer.ts";

export function dialerFor(ep: EngineEndpoint): Dialer {
  return ep.kind === "ssh" ? sshDialer(ep) : socketDialer(ep);
}
