/**
 * The Live Activity chain's daemon half, end to end (docs/feat/mobile-live-activity.md
 * Design 4/5, slice L8), through the REAL notifier the `serve` builds:
 *
 *  the session hook → the RULES (L6) → the CONTENT (L2) → the SEAL (L1) → the sink.
 *
 * The last step is the one that matters: the delivered `content-state` is OPENED
 * here with the device's own key, exactly as the widget's `LACore` does, so the
 * test proves the CONTENT really arrives — not merely that a frame was sent.
 * The relay's own half (the `liveactivity` frame becoming an Apple request with
 * the right topic suffix and push type) is `apps/relay/test/{apns,server-push}`.
 *
 * Assertions, and the failure each prevents:
 *  - the project shown is the BASENAME of the cwd, never the whole path (a lock
 *    screen must not print the home layout, Owner Q7);
 *  - the state opens ONLY for the activity it was sealed for (F7: a relay cannot
 *    move one session's state into another's activity);
 *  - the kid is the SEAL's own derivation, not a caller's claim.
 */
import { describe, expect, test } from "bun:test";
import { createLiveActivityNotifier } from "@tentacle/daemon";
import { RELAY_FEATURES, encodeBase64Url } from "@tentacle/protocol";
import type { PushEnvironment } from "@tentacle/protocol";
import { openActivity, publicKeyOf, pushKeyId } from "@tentacle/transport/push";
import { bindLiveActivityResend } from "../src/serve.ts";

const TOKEN = "a".repeat(64);
const DEVICE = "0123456789abcdef";
const SLOT = "00112233445566778899aabb";
const COMPUTER_SK = new Uint8Array(32).fill(7);
const COMPUTER_PK = publicKeyOf(COMPUTER_SK);

describe("relay features", () => {
  test("`liveactivity` is a feature this build knows and announces", () => {
    expect(RELAY_FEATURES).toContain("liveactivity");
    expect(RELAY_FEATURES).toContain("push");
  });
});

describe("the notifier's sealed state opens with the device's key (L1+L7)", () => {
  test("a start's content-state decodes to the content the rules chose", async () => {
    const deviceSk = new Uint8Array(32).fill(9);
    const devicePk = publicKeyOf(deviceSk);
    const deliveries: {
      event: string;
      contentState?: { e: string; c: string };
      attributes?: { k: string; slot: string };
    }[] = [];
    const notifier = createLiveActivityNotifier({
      now: () => 1_731_000_000_000,
      startAfterSeconds: 0,
      newSlot: () => SLOT,
      computer: () => ({ privateKey: COMPUTER_SK, name: "mac-mini" }),
      registrations: {
        registered: () => [DEVICE],
        read: () => ({
          deviceId: DEVICE,
          startToken: TOKEN,
          env: "sandbox" as PushEnvironment,
          enabled: true,
          registeredAt: 1,
        }),
        pushKeyOf: () => encodeBase64Url(devicePk),
        forget: () => {},
      },
      describe: () => ({ title: "fix the live activity", cwd: "/Users/x/tentacle" }),
      sink: async (delivery) => {
        deliveries.push({
          event: delivery.event,
          ...(delivery.contentState === undefined ? {} : { contentState: delivery.contentState }),
          ...(delivery.attributes === undefined ? {} : { attributes: delivery.attributes }),
        });
        return "sent";
      },
    });
    notifier.onPushEvent(
      "s1",
      { type: "update", update: { type: "turn_start", turnId: "t1", prompt: "go" } as never },
      { clients: 0, devices: [] },
    );
    notifier.tickForTest();
    for (let i = 0; i < 40; i++) await Promise.resolve();

    const [start] = deliveries;
    expect(start?.event).toBe("start");
    if (start?.contentState === undefined || start.attributes === undefined) {
      throw new Error("no start state");
    }
    // The kid is the one the seal derives, and the slot is the activity's own.
    expect(start.attributes.k).toBe(pushKeyId(COMPUTER_PK));
    expect(start.attributes.slot).toBe(SLOT);
    const opened = openActivity(
      {
        keyId: start.attributes.k,
        enc: Uint8Array.from(Buffer.from(start.contentState.e, "base64url")),
        ciphertext: Uint8Array.from(Buffer.from(start.contentState.c, "base64url")),
      },
      deviceSk,
      COMPUTER_PK,
      SLOT,
    );
    const content = JSON.parse(new TextDecoder().decode(opened)) as {
      kind: string;
      project: string;
      title: string;
      startedAt: number;
    };
    expect(content.kind).toBe("running");
    // The PROJECT is the basename of the cwd, never the whole path: a lock screen
    // shows a name, and a full path is a leak of the home layout (Owner Q7).
    expect(content.project).toBe("tentacle");
    expect(content.title).toBe("fix the live activity");

    // F7: the same bytes in ANOTHER activity do not open.
    expect(() =>
      openActivity(
        {
          keyId: start.attributes?.k ?? "",
          enc: Uint8Array.from(Buffer.from(start.contentState?.e ?? "", "base64url")),
          ciphertext: Uint8Array.from(Buffer.from(start.contentState?.c ?? "", "base64url")),
        },
        deviceSk,
        COMPUTER_PK,
        "ffeeddccbbaa998877665544",
      ),
    ).toThrow();
  });
});

/**
 * F3 at the `serve` boundary: the link's `ready` must reach the notifier's
 * `resendAll`, or an activity whose state changed while the link was down stays
 * wrong on the phone until the next event (F3's convergence by state).
 *
 * The wiring is `ServeLiveActivity.bindLink`, which is what `listen` calls once
 * the link exists. Mutation: drop `next?.bindLiveActivityReady(...)` in
 * `buildLiveActivity` → the callback never fires and this test sees no resend.
 */
describe("F3: the serve's wiring resends live states on every ready", () => {
  test("bindLink registers the resend, and it re-sends one state per live slot", async () => {
    // A notifier with one live slot, driven directly: what is under test is the
    // BINDING, so the notifier is a spy with the two methods the wiring uses.
    let resent = 0;
    let ready: (() => void) | undefined;
    const fakeLink = {
      bindLiveActivityReady(callback: () => void) {
        ready = callback;
      },
      liveActivityStatus: () => "on" as const,
      liveActivity: async () => "sent" as const,
      push: async () => "sent" as const,
      pushStatus: () => "on" as const,
    };
    const notifier = {
      resendAll() {
        resent += 1;
      },
      stop() {},
    };
    // The REAL function the serve's `bindLink` calls — not a re-implementation.
    bindLiveActivityResend(fakeLink, notifier);
    expect(ready).toBeDefined();
    ready?.();
    ready?.();
    // Every `ready` (a reconnect, too) resends: convergence by state, never by
    // replaying what the link missed.
    expect(resent).toBe(2);
  });
});
