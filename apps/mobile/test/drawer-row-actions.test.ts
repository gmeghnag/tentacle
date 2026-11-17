/**
 * Pin / delete from a drawer row (docs/feat/mobile-session-actions.md S2).
 * The decisions about the wire are `rowActionErrorText`'s; this pins the flow
 * around them: the call goes to the row's OWN computer, never queued, one action
 * per row in flight, a success re-reads that list, `SessionDeleted` on a delete
 * is a success, and deleting the OPEN session navigates to the next row (or the
 * empty drawer).
 */
import { describe, expect, test } from "bun:test";
import { DomainErrorCode, JsonRpcErrorCode } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import {
  type DrawerRowActionsDeps,
  createDrawerRowActions,
  rowActionErrorText,
} from "../src/drawer-row-actions.ts";

interface Sent {
  readonly kind: "pin" | "delete";
  readonly computerId: string;
  readonly sessionId: string;
  readonly pinned?: boolean;
}

function harness(
  over: Partial<DrawerRowActionsDeps> = {},
  answers: { pin?: () => Promise<boolean>; remove?: () => Promise<void> } = {},
) {
  const sent: Sent[] = [];
  const reread: string[] = [];
  const navigated: (string | null)[] = [];
  const deps: DrawerRowActionsDeps = {
    pin: (computerId, sessionId, pinned) => {
      sent.push({ kind: "pin", computerId, sessionId, pinned });
      return answers.pin?.() ?? Promise.resolve(pinned);
    },
    remove: (computerId, sessionId) => {
      sent.push({ kind: "delete", computerId, sessionId });
      return answers.remove?.() ?? Promise.resolve();
    },
    reread: (computerId) => reread.push(computerId),
    navigate: (nextRowId) => navigated.push(nextRowId),
    currentId: () => "open-1",
    nextAfterCurrent: () => "next-1",
    ...over,
  };
  const actions = createDrawerRowActions(deps);
  return { actions, sent, reread, navigated };
}

describe("row actions: pin", () => {
  test("pin goes to the ROW's computer, as a set (not a toggle), then re-reads that list", async () => {
    const { actions, sent, reread } = harness();
    await actions.pin("computer-b", { id: "s1", pinned: false });
    expect(sent).toEqual([
      { kind: "pin", computerId: "computer-b", sessionId: "s1", pinned: true },
    ]);
    expect(reread).toEqual(["computer-b"]);
    expect(actions.state().error).toBeNull();
  });

  test("a pinned row unpins (the same set, the other value)", async () => {
    const { actions, sent } = harness();
    await actions.pin("a", { id: "s1", pinned: true });
    expect(sent).toEqual([{ kind: "pin", computerId: "a", sessionId: "s1", pinned: false }]);
  });

  test("offline: the error reaches the drawer and the list is not re-read", async () => {
    const { actions, reread } = harness(
      {},
      {
        pin: () => Promise.reject(new Error("not connected to the daemon")),
      },
    );
    await actions.pin("a", { id: "s1", pinned: false });
    expect(actions.state().error).toBe(
      "Not connected to this computer. Try again when it is back.",
    );
    expect(reread).toEqual([]);
    expect(actions.state().busy.size).toBe(0);
  });

  test("an older daemon's MethodNotFound says to update it (Rename and Delete still work)", async () => {
    const { actions } = harness(
      {},
      {
        pin: () => Promise.reject(new RpcError(JsonRpcErrorCode.MethodNotFound, "x")),
      },
    );
    await actions.pin("a", { id: "s1", pinned: false });
    expect(actions.state().error).toBe("Update tentacle on this computer to pin sessions.");
  });

  test("another daemon error keeps the daemon's own words", async () => {
    const { actions } = harness(
      {},
      {
        pin: () =>
          Promise.reject(
            new RpcError(
              JsonRpcErrorCode.InvalidParams,
              "at most 20 pinned sessions: unpin one first",
            ),
          ),
      },
    );
    await actions.pin("a", { id: "s1", pinned: false });
    expect(actions.state().error).toBe("at most 20 pinned sessions: unpin one first");
  });

  test("a second tap on the same row while one is in flight sends nothing", async () => {
    let release: (v: boolean) => void = () => {};
    const { actions, sent } = harness(
      {},
      {
        pin: () =>
          new Promise<boolean>((resolve) => {
            release = resolve;
          }),
      },
    );
    const first = actions.pin("a", { id: "s1", pinned: false });
    expect(actions.state().busy.has("s1")).toBe(true);
    await actions.pin("a", { id: "s1", pinned: false });
    expect(sent.length).toBe(1);
    release(true);
    await first;
    expect(actions.state().busy.has("s1")).toBe(false);
    expect(actions.state().busy.size).toBe(0);
  });

  test("another row is not blocked by the first one", async () => {
    const releases: (() => void)[] = [];
    const calls: string[] = [];
    const { actions } = harness({
      pin: (_computerId, sessionId) => {
        calls.push(sessionId);
        return new Promise<boolean>((resolve) => {
          releases.push(() => resolve(true));
        });
      },
    });
    const first = actions.pin("a", { id: "s1", pinned: false });
    const second = actions.pin("a", { id: "s2", pinned: false });
    expect(calls).toEqual(["s1", "s2"]);
    for (const release of releases) {
      release();
    }
    await Promise.all([first, second]);
  });
});

describe("row actions: delete", () => {
  test("delete goes by id to the row's computer and re-reads its list; it does not navigate", async () => {
    const { actions, sent, reread, navigated } = harness();
    await actions.confirmDelete("a", { id: "other" });
    expect(sent).toEqual([{ kind: "delete", computerId: "a", sessionId: "other" }]);
    expect(reread).toEqual(["a"]);
    expect(navigated).toEqual([]);
  });

  test("deleting the OPEN session navigates to the next row the drawer chose", async () => {
    const { actions, navigated, reread } = harness();
    await actions.confirmDelete("a", { id: "open-1" });
    expect(navigated).toEqual(["next-1"]);
    expect(reread).toEqual(["a"]);
  });

  test("deleting the open session when no row is left navigates to null (the empty drawer)", async () => {
    const { actions, navigated } = harness({ nextAfterCurrent: () => null });
    await actions.confirmDelete("a", { id: "open-1" });
    expect(navigated).toEqual([null]);
  });

  test("the open check is READ BEFORE the await: a move during the delete still navigates", async () => {
    // Review finding 2: the open screen gets `session_closed{deleted}` while the
    // delete is in flight and moves away, so `currentId()` has changed by the
    // time the call resolves. Reading it after the await would skip `navigate`
    // and strand the person wherever the screen sent them (Owner Q2 says: go to
    // the row after the one deleted).
    let open: string | null = "open-1";
    const { actions, navigated } = harness(
      { currentId: () => open },
      {
        remove: () =>
          new Promise<void>((resolve) => {
            queueMicrotask(() => {
              open = "other-1";
              resolve();
            });
          }),
      },
    );
    await actions.confirmDelete("a", { id: "open-1" });
    expect(open).toBe("other-1");
    expect(navigated).toEqual(["next-1"]);
  });

  test("a session that was NOT open is not navigated to, even if one becomes current later", async () => {
    // The mirror case: `wasOpen` false must stay false, so no navigate.
    let open: string | null = "other-1";
    const { actions, navigated } = harness(
      { currentId: () => open },
      {
        remove: () =>
          new Promise<void>((resolve) => {
            queueMicrotask(() => {
              open = "deleted-row";
              resolve();
            });
          }),
      },
    );
    await actions.confirmDelete("a", { id: "deleted-row" });
    expect(navigated).toEqual([]);
  });

  test("a row already deleted elsewhere (SessionDeleted) is a SUCCESS: re-read, row gone", async () => {
    const { actions, reread, navigated } = harness(
      {},
      {
        remove: () => Promise.reject(new RpcError(DomainErrorCode.SessionDeleted, "gone")),
      },
    );
    await actions.confirmDelete("a", { id: "open-1" });
    expect(actions.state().error).toBeNull();
    expect(reread).toEqual(["a"]);
    // The open one is gone either way: the phone must not stay on it.
    expect(navigated).toEqual(["next-1"]);
  });

  test("a failed delete shows the reason and changes nothing (no navigation, no re-read)", async () => {
    const { actions, reread, navigated } = harness(
      {},
      {
        remove: () => Promise.reject(new Error("not connected to the daemon")),
      },
    );
    await actions.confirmDelete("a", { id: "open-1" });
    expect(actions.state().error).toBe(
      "Not connected to this computer. Try again when it is back.",
    );
    expect(reread).toEqual([]);
    expect(navigated).toEqual([]);
  });

  test("an older daemon's MethodNotFound has its own sentence", () => {
    expect(rowActionErrorText(new RpcError(JsonRpcErrorCode.MethodNotFound, "x"), "delete")).toBe(
      "Update tentacle on this computer to delete sessions.",
    );
  });

  test("a double tap on Delete sends one delete", async () => {
    let release: () => void = () => {};
    const { actions, sent } = harness(
      {},
      {
        remove: () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      },
    );
    const first = actions.confirmDelete("a", { id: "s1" });
    await actions.confirmDelete("a", { id: "s1" });
    expect(sent.length).toBe(1);
    release();
    await first;
  });
});

describe("row actions: the banner", () => {
  test("dismiss clears the error and notifies; a no-op when there is none", async () => {
    const { actions } = harness({}, { pin: () => Promise.reject(new Error("boom")) });
    let calls = 0;
    const off = actions.subscribe(() => {
      calls += 1;
    });
    actions.dismiss();
    expect(calls).toBe(0);
    await actions.pin("a", { id: "s1", pinned: false });
    expect(actions.state().error).toBe("boom");
    const before = calls;
    actions.dismiss();
    expect(actions.state().error).toBeNull();
    expect(calls).toBe(before + 1);
    off();
  });

  test("rowActionErrorText falls back on its own wording for a message-less failure", () => {
    expect(rowActionErrorText(new Error(""), "pin")).toBe("Couldn't pin the session.");
    expect(rowActionErrorText(undefined, "delete")).toBe("Couldn't delete the session.");
  });
});
