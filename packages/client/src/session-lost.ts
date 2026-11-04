import { DomainErrorCode, RpcError } from "@tentacle/transport";

/** A command that must not cross a session recreate (its turn/request is gone). */
export class SessionLostError extends RpcError {
  constructor() {
    super(
      DomainErrorCode.UnknownSession,
      "the daemon lost the session (it was recreated): not re-sent",
    );
  }
}
