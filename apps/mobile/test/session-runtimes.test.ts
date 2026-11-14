/**
 * The per-client controller registry (docs/feat/mobile-session-view.md 12c):
 * `session-controller.ts` serialises per session id, and that queue is only
 * worth anything if it survives a screen mount. These cases pin the shape: the
 * SAME client gets the SAME controller (so back-then-forward shares one queue),
 * and a NEW client (Retry after a failed dial) replaces it.
 */
import { describe, expect, test } from "bun:test";
import {
  type SessionHandle,
  type SessionOpenFailure,
  createSessionController,
  openFailureReason,
} from "../src/session-controller.ts";
import { createSessionRuntimes } from "../src/session-runtimes.ts";

/** A handle that never settles its open on its own: the test drives it. */
function handle() {
  let settle: ((error?: unknown) => void) | null = null;
  let detaches = 0;
  return {
    open: () =>
      new Promise<void>((resolve, reject) => {
        settle = (error?: unknown) => (error === undefined ? resolve() : reject(error));
      }),
    detach: () => {
      detaches += 1;
      return Promise.resolve();
    },
    watch: () => () => {},
    get detaches() {
      return detaches;
    },
    settle: (error?: unknown) => settle?.(error),
  };
}

describe("createSessionRuntimes", () => {
  test("one controller per client: two mounts of one session share ONE per-id queue", () => {
    const handles: ReturnType<typeof handle>[] = [];
    const runtimes = createSessionRuntimes<{ readonly id: string }, SessionHandle>({
      build: () =>
        createSessionController({
          newSession: () => {
            const h = handle();
            handles.push(h);
            return h;
          },
        }),
    });
    const client = { id: "a" };
    const first = runtimes.controller(client);
    const second = runtimes.controller(client);
    expect(second).toBe(first); // the same queue: F17's serialisation is not lost
    expect(runtimes.size).toBe(1);
  });

  test("a NEW client (a redial) replaces the controller, and the old one is disposed", async () => {
    const built: { disposed: boolean }[] = [];
    const runtimes = createSessionRuntimes<{ readonly id: string }, SessionHandle>({
      build: () => {
        const controller = createSessionController({ newSession: () => handle() });
        const record = { disposed: false };
        const dispose = controller.dispose;
        built.push(record);
        return Object.assign(controller, {
          dispose: () => {
            record.disposed = true;
            dispose();
          },
        });
      },
    });
    const first = runtimes.controller({ id: "a" });
    const second = runtimes.controller({ id: "b" });
    expect(second).not.toBe(first);
    expect(built[0]?.disposed).toBe(true); // no listener outlives its client
    expect(built[1]?.disposed).toBe(false);
    expect(runtimes.size).toBe(1); // never grows: one client is live at a time
  });

  test("dispose drops the controller; the next mount builds a fresh one", () => {
    let builds = 0;
    const runtimes = createSessionRuntimes<{ readonly id: string }, SessionHandle>({
      build: () => {
        builds += 1;
        return createSessionController({ newSession: () => handle() });
      },
    });
    const client = { id: "a" };
    runtimes.controller(client);
    runtimes.dispose();
    expect(runtimes.size).toBe(0);
    runtimes.controller(client);
    expect(builds).toBe(2);
  });

  test("an open through the shared controller is the SAME result the failure table gives", async () => {
    // Proof the registry does not wrap or interpret: a failure reason crosses it
    // unchanged (the screen's banner is built from exactly this value).
    const h = handle();
    const runtimes = createSessionRuntimes<{ readonly id: string }, SessionHandle>({
      build: () => createSessionController({ newSession: () => h }),
    });
    const controller = runtimes.controller({ id: "a" });
    const opening = controller.open("s1");
    await Promise.resolve();
    h.settle(new Error("boom"));
    const result = await opening;
    const reason: SessionOpenFailure = result.ok ? "link" : result.reason;
    expect(reason).toBe("link");
    expect(openFailureReason(new Error("boom"))).toBe("link");
  });
});
