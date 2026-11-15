/**
 * The pure rules of the shared auto-accept link (docs/feat/session-auto-accept.md
 * D4). No socket, no renderer: each test names the mutation that turns it red.
 */
import { describe, expect, test } from "bun:test";
import { createAutoAcceptHandle } from "../src/auto-accept-link.ts";

/** A link with a scripted `send`. */
function rig(shared = true) {
  const sent: boolean[] = [];
  const answers: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  const handle = createAutoAcceptHandle({
    shared,
    initial: false,
    send: (on) => {
      sent.push(on);
      return new Promise<{ on: boolean }>((resolve, reject) => {
        answers.push({
          resolve: () => resolve({ on }),
          reject,
        });
      });
    },
  });
  return { handle, sent, answers, link: handle.link };
}

describe("the auto-accept link", () => {
  test("set applies LOCALLY at once, then sends (OFF must bite before the round trip)", async () => {
    const r = rig();
    r.handle.sync(false);
    const pending = r.link.set(true);
    expect(r.link.current()).toBe(true);
    expect(r.sent).toEqual([true]);
    r.answers[0]?.resolve();
    await pending;
  });

  test("not shared: no method is ever sent and set returns nothing", () => {
    // Mutation: send anyway → `sent` is non-empty.
    const r = rig(false);
    expect(r.link.set(true)).toBeUndefined();
    expect(r.link.current()).toBe(true);
    expect(r.sent).toEqual([]);
    // And a daemon's snapshot never confirms it on its own (`shared()` false).
    r.handle.sync(true);
    expect(r.link.shared()).toBe(false);
  });

  test("a snapshot without the bit never confirms sharing (a pod)", () => {
    const r = rig(false);
    r.handle.sync(true);
    expect(r.link.shared()).toBe(false);
    expect(r.link.current()).toBe(true);
  });

  test("an unconfirmed link sends nothing even with the bit on (an older daemon)", () => {
    // Mutation: `shared: () => options.shared` (the bit alone) → a set is sent
    // to a daemon that never said it shares it.
    const r = rig(true);
    expect(r.link.shared()).toBe(false);
    expect(r.link.set(true)).toBeUndefined();
    expect(r.sent).toEqual([]);
  });

  test("updates apply in arrival order, own echoes included", () => {
    const r = rig();
    r.handle.sync(false);
    const seen: boolean[] = [];
    r.link.onChange((on) => seen.push(on));
    r.handle.receive(true, "laptop");
    r.handle.receive(false, "phone");
    r.handle.receive(true, "laptop");
    expect(r.link.current()).toBe(true);
    expect(seen).toEqual([true, false, true]);
    expect(r.handle.lastBy()).toBe("laptop");
  });

  test("an OFFLINE OFF is never undone by the daemon's older ON (pendingSet wins)", async () => {
    // Mutation: drop `pendingSet` → the re-attach snapshot's ON is adopted.
    const r = rig();
    r.handle.sync(true);
    const pending = r.link.set(false);
    // The drop happens before the daemon acknowledged it.
    r.handle.dropped();
    r.handle.sync(true); // the daemon still says ON
    expect(r.link.current()).toBe(false);
    // It went out again (the first frame was lost with the socket).
    expect(r.sent).toEqual([false, false]);
    r.answers[1]?.resolve();
    r.answers[0]?.reject(new Error("socket closed"));
    await pending?.catch(() => {});
  });

  test("an ACKNOWLEDGED set adopts the daemon's snapshot on re-attach (its copy wins)", async () => {
    const r = rig();
    r.handle.sync(true);
    const pending = r.link.set(true);
    r.handle.receive(true);
    r.answers[0]?.resolve();
    // Away and back: the daemon's copy is the truth now (someone else turned it off).
    r.handle.sync(false);
    expect(r.link.current()).toBe(false);
    await pending?.catch(() => {});
  });

  test("a set that failed is still re-sent after a drop (the decision is not lost)", async () => {
    const r = rig();
    r.handle.sync(true);
    const pending = r.link.set(true);
    r.answers[0]?.reject(new Error("boom"));
    await pending?.catch(() => {});
    r.handle.dropped();
    r.handle.recovered();
    expect(r.sent).toEqual([true, true]);
    r.answers[1]?.resolve();
  });

  test("a flip made BEFORE the daemon confirmed sharing survives the snapshot", () => {
    // The bug the real `connect` stack found (connect-functest-a): a Shift+Tab
    // pressed before the session's first open answered was undone by the
    // snapshot, so the TUI went on deciding OFF. Mutation: return without
    // recording `pendingSet` → the snapshot's `false` wins.
    const r = rig(true);
    expect(r.link.shared()).toBe(false);
    expect(r.link.set(true)).toBeUndefined();
    expect(r.link.current()).toBe(true);
    expect(r.sent).toEqual([]);
    // The open answers: it shares, and its value is the OLD one.
    r.handle.sync(false);
    expect(r.link.current()).toBe(true);
    expect(r.link.shared()).toBe(true);
    expect(r.sent).toEqual([true]);
    r.answers[0]?.resolve();
  });

  test("confirming a session this link already agrees on STILL tells its consumers", () => {
    // A consumer that read this link BEFORE the daemon confirmed sharing (the
    // TUI's routing feed, bound at an unconfirmed `/sessions` attach) holds ITS
    // OWN value; an OFF session equals this link's initial `false`, so an
    // "only on change" notify would leave that consumer on the laptop's ON
    // (session-auto-accept.md Review round 1, HIGH 1). Mutation: notify only
    // from `apply` → `seen` is empty and the feed keeps `true`.
    const r = rig(true);
    const seen: boolean[] = [];
    r.link.onChange((on) => seen.push(on));
    r.handle.sync(false);
    expect(seen).toEqual([false]);
    expect(r.link.shared()).toBe(true);
    expect(r.link.current()).toBe(false);
  });

  test("a RE-attach is silent when nothing moved (the confirmation is one event)", () => {
    const r = rig(true);
    r.handle.sync(false);
    const seen: boolean[] = [];
    r.link.onChange((on) => seen.push(on));
    r.handle.sync(false);
    r.handle.sync(false);
    expect(seen).toEqual([]);
  });

  test("no change, no listener: an update to the value it already has is silent", () => {
    const r = rig();
    r.handle.sync(false);
    let calls = 0;
    r.link.onChange(() => {
      calls++;
    });
    r.handle.receive(false);
    expect(calls).toBe(0);
  });
});
