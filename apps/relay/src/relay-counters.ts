/**
 * Log line → status counter (docs/feat/relay-status.md; pure). Every relay event
 * already writes one line, so the counters are read off the lines — BEFORE the
 * flood limiter, so a refusal flood is counted whole. A renamed line kind must be
 * renamed here too (`server-status.test.ts` pins the coupling over sockets).
 */

export const RELAY_COUNTERS = [
  /** Admitted phone dials (spliced-bound or held). */
  "dials",
  "registrations",
  /** Payload bytes handed to the other leg (counted in `server.ts`). */
  "bytesRelayed",
  "refusedRate",
  "refusedConcurrency",
  "refusedPending",
  "refusedHello",
  "refusedAccept",
  /** Not the frames Bun's `maxPayloadLength` closes: no handler ever sees them. */
  "refusedOversize",
  "refusedThrottled",
  /** Counted in `server.ts`: a ping past the limit writes no line. */
  "refusedPing",
  "pushesSent",
  "pushesFailed",
  "pushesRejected",
] as const;

export type RelayCounter = (typeof RELAY_COUNTERS)[number];

/** The counter a log line feeds, or `undefined` (most lines feed none). */
export function counterOfLogLine(line: string): RelayCounter | undefined {
  const [kind, second, third] = line.split(" ");
  switch (kind) {
    case "dial-open":
    case "dial-held":
      return "dials";
    case "ready":
      return "registrations";
    case "dial-refused":
      if (second === "rate") {
        return "refusedRate";
      }
      return second === "concurrency" ? "refusedConcurrency" : undefined;
    case "pending-refused":
      return "refusedPending";
    case "hello-refused":
      return "refusedHello";
    case "accept-refused":
      return "refusedAccept";
    case "phone-oversize-drop":
    case "frame-oversize":
    case "control-oversize":
    case "accept-oversize":
      return "refusedOversize";
    case "push-refused":
    case "liveactivity-refused":
      return third === "throttled" ? "refusedThrottled" : "pushesRejected";
    case "push-rejected":
    case "liveactivity-rejected":
      return "pushesRejected";
    case "push":
    case "liveactivity":
      // `push on: …` / `push off: …` are the start's lines, not a delivery.
      if (second === "on:" || second === "off:") {
        return undefined;
      }
      return third === "sent" ? "pushesSent" : "pushesFailed";
    default:
      return undefined;
  }
}
