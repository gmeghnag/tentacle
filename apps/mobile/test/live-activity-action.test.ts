/**
 * The Live Activity ACTION path (docs/feat/mobile-live-activity.md Design 7,
 * slice L11): what an Approve / Deny tap in an activity actually does.
 *
 * The security rule, and the whole reason this module exists as its own tested
 * unit: **an activity's tap can never be trusted for WHAT it answers.** A button
 * carries only `{action, activityId}`; the `requestId` and the options come from
 * re-opening the activity's CURRENT content-state in JS, with the pinned
 * computer key, and only then is the answer handed to task 17's coordinator
 * (`answerDecision`, the ONE path to `session/resolve_permission`).
 *
 * So the failure modes are the point of the suite:
 *  - a FORGED or unopenable state sends NOTHING (F6): a relay can put anything
 *    in a clear field, and the intent's own parameters are peer input;
 *  - an activity that is no longer `asking` sends NOTHING (the ask settled while
 *    the lock screen was stale — the daemon would refuse it anyway, but not
 *    dialing at all is better: no Face ID prompt for nothing);
 *  - Approve ALWAYS goes through Face ID (decision 14), never a shortcut because
 *    the tap came from a lock screen;
 *  - Deny sends without Face ID but still only for a `reject_once` the state
 *    actually offered.
 */
import { describe, expect, test } from "bun:test";
import { type ActivityContent, encodeBase64Url } from "@tentacle/protocol";
import { sealActivity } from "@tentacle/transport/push";
import { publicKeyOf } from "@tentacle/transport/push";
import { type LaActivityLike, decideActivityAction } from "../src/live-activity-action.ts";

const COMPUTER_SK = new Uint8Array(32).fill(5);
const COMPUTER_PK = publicKeyOf(COMPUTER_SK);
const COMPUTER_ID = "0123456789abcdef";
const SLOT = "00112233445566778899aabb";
const KID = "tzHqlSe8ME5A";

const asking: ActivityContent = {
  v: 1,
  slot: SLOT,
  seq: 3,
  at: 1_731_000_000_000,
  kind: "asking",
  computer: "mac-mini",
  project: "tentacle",
  title: "fix the live activity",
  turnId: "t1",
  startedAt: 1_730_999_980_000,
  tool: "Shell",
  ask: {
    requestId: "req-1",
    tool: "Shell",
    preview: "rm -rf build",
    options: [
      { optionId: "allow_once", kind: "allow_once" },
      { optionId: "reject_once", kind: "reject_once" },
    ],
  },
};

/** Seal `content` for the activity, as the daemon would — the shape the app opens. */
function sealedOf(content: ActivityContent): LaActivityLike {
  const sealed = sealActivity(
    new TextEncoder().encode(JSON.stringify(content)),
    COMPUTER_SK,
    publicKeyOf(new Uint8Array(32).fill(6)),
    SLOT,
    (length) => new Uint8Array(length).fill(1),
  );
  return {
    id: "activity-1",
    attributes: { v: 1, k: KID, slot: SLOT },
    contentState: { v: 1, e: encodeBase64Url(sealed.enc), c: encodeBase64Url(sealed.ciphertext) },
    computerId: COMPUTER_ID,
  };
}

/** The keys the phone pinned at pairing (one per computer). */
const keys = () => [
  {
    computerId: COMPUTER_ID,
    publicKey: COMPUTER_PK,
    kid: KID,
    pushKey: publicKeyOf(new Uint8Array(32).fill(6)),
  },
];

const baseDeps = (over: Record<string, unknown> = {}) => ({
  activities: [sealedOf(asking)],
  keys: keys(),
  openContent: (activity: LaActivityLike) => {
    // The real implementation re-opens the seal (`openActivity`); the tests below
    // override THIS to simulate a forged state, so the module's own trust
    // boundary is what is under test rather than the crypto (pinned in L1/L10).
    void activity;
    return asking;
  },
  coordinator: {
    calls: [] as { computerId: string; sessionId: string; requestId: string; allowed: boolean }[],
    async answer(input: {
      computerId: string;
      sessionId: string;
      requestId: string;
      allowed: boolean;
    }) {
      this.calls.push(input);
      return "sent" as const;
    },
  },
  ...over,
});

describe("a tap answers ONLY from the re-opened state", () => {
  test("Approve answers `allow_once` for the requestId the state carries", async () => {
    const deps = baseDeps();
    const outcome = await decideActivityAction(
      { action: "approve", activityId: "activity-1" },
      deps,
    );
    expect(outcome).toEqual({ do: "answered", allowed: true });
    expect(deps.coordinator.calls).toHaveLength(1);
    // The requestId came from the PLAINTEXT, never from the intent.
    expect(deps.coordinator.calls[0]).toMatchObject({
      computerId: COMPUTER_ID,
      sessionId: "t1",
      requestId: "req-1",
      allowed: true,
    });
  });

  test("Deny answers `reject_once` and sends nothing else", async () => {
    const deps = baseDeps();
    const outcome = await decideActivityAction({ action: "deny", activityId: "activity-1" }, deps);
    expect(outcome).toEqual({ do: "answered", allowed: false });
    expect(deps.coordinator.calls[0]).toMatchObject({ requestId: "req-1", allowed: false });
  });

  test("a FORGED / unopenable state sends NOTHING, and opens the session instead (F6)", async () => {
    // The mutation this kills: trust the intent's `requestId` (or the clear
    // fields) instead of re-opening — a relay could then make the phone answer an
    // ask that was never asked.
    const deps = baseDeps({ openContent: () => undefined });
    const outcome = await decideActivityAction(
      { action: "approve", activityId: "activity-1" },
      deps,
    );
    expect(deps.coordinator.calls).toHaveLength(0);
    expect(outcome.do).toBe("open");
  });

  test("an activity that is no longer `asking` sends NOTHING", async () => {
    const deps = baseDeps({ openContent: () => ({ ...asking, kind: "running", ask: undefined }) });
    const outcome = await decideActivityAction(
      { action: "approve", activityId: "activity-1" },
      deps,
    );
    expect(deps.coordinator.calls).toHaveLength(0);
    expect(outcome.do).toBe("open");
  });

  test("Approve with no `allow_once` offered sends NOTHING (a lasting rule is not reachable)", async () => {
    const ask = asking.ask;
    if (ask === undefined) throw new Error("fixture");
    const onlyAlways: ActivityContent = {
      ...asking,
      ask: { ...ask, options: [{ optionId: "a-always", kind: "allow_always" }] },
    };
    const deps = baseDeps({ openContent: () => onlyAlways });
    const outcome = await decideActivityAction(
      { action: "approve", activityId: "activity-1" },
      deps,
    );
    expect(deps.coordinator.calls).toHaveLength(0);
    expect(outcome.do).toBe("open");
  });

  test("the KIND is what decides, not the presence of an `ask` (a settled turn may still carry one)", async () => {
    // The daemon's `done` state can carry a stale `ask` object; believing it would
    // answer a request the daemon has already settled (F8). Mutation: drop the
    // `content.kind !== "asking"` clause → this answers, and the daemon refuses it.
    const deps = baseDeps({ openContent: () => ({ ...asking, kind: "done" }) });
    const outcome = await decideActivityAction(
      { action: "approve", activityId: "activity-1" },
      deps,
    );
    expect(deps.coordinator.calls).toHaveLength(0);
    expect(outcome.do).toBe("open");
  });

  test("a tap on an activity the phone does not know opens the app, sending nothing", async () => {
    const deps = baseDeps();
    const outcome = await decideActivityAction({ action: "approve", activityId: "nope" }, deps);
    expect(deps.coordinator.calls).toHaveLength(0);
    expect(outcome.do).toBe("open");
  });

  test("a computer whose key is not pinned sends NOTHING (a revoked computer)", async () => {
    const deps = baseDeps({ keys: [] });
    const outcome = await decideActivityAction(
      { action: "approve", activityId: "activity-1" },
      deps,
    );
    expect(deps.coordinator.calls).toHaveLength(0);
    expect(outcome.do).toBe("open");
  });
});
