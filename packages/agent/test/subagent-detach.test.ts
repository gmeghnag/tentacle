import { describe, expect, test } from "bun:test";
import type {
  PermissionRequest,
  PermissionRequestOptions,
  PermissionRequester,
  PermissionResponse,
} from "@tentacle/core";
import { DISMISSED } from "@tentacle/core";
import { subagentRequester } from "../src/subagent.ts";

// docs/feat/subagent-detach.md T14 + Q-C: a foreground child's ask is withdrawn
// (and `dismissed`) when the child MOVES to the background, and re-asked ONCE on
// the background path — with the `sa-N` id and the child's own signal. A human's
// refusal is never `dismissed`, so it is never re-asked.

const REQ: PermissionRequest = {
  tool: "shell",
  level: "ask",
  title: "Run a shell command",
  input: {},
};

interface Seen {
  readonly options: PermissionRequestOptions | undefined;
}

/** A requester that records every ask and answers from a script. */
function spy(answers: readonly PermissionResponse[]): {
  requester: PermissionRequester;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const requester: PermissionRequester = async (_req, options) => {
    seen.push({ options });
    return answers[seen.length - 1] ?? answers.at(-1) ?? { allowed: false };
  };
  return { requester, seen };
}

const AGENT = { type: "general", description: "map repo" };

describe("T14: subagentRequester and a child that may move", () => {
  test("while foreground: the ask carries `withdraw`, no `agent.id`", async () => {
    const withdrawn = new AbortController();
    const spyReq = spy([{ allowed: true }]);
    const requester = subagentRequester(spyReq.requester, "call-1", AGENT, {
      move: { withdrawn: withdrawn.signal, background: () => undefined },
    });
    await requester(REQ);
    expect(spyReq.seen).toHaveLength(1);
    expect(spyReq.seen[0]?.options?.withdraw).toBe(withdrawn.signal);
    expect(spyReq.seen[0]?.options?.agent).toEqual(AGENT);
    expect(spyReq.seen[0]?.options?.agent).not.toHaveProperty("id");
    expect(spyReq.seen[0]?.options?.toolCallId).toBe("call-1");
    expect(spyReq.seen[0]?.options?.origin).toBe("subagent");
  });

  test("a moved child's ask carries `agent.id` and the CHILD's signal, not the turn's", async () => {
    const turn = new AbortController();
    const own = new AbortController();
    const spyReq = spy([{ allowed: true }]);
    const requester = subagentRequester(spyReq.requester, "call-1", AGENT, {
      move: { withdrawn: turn.signal, background: () => ({ id: "sa-1", signal: own.signal }) },
    });
    await requester(REQ);
    expect(spyReq.seen[0]?.options?.agent).toEqual({ ...AGENT, id: "sa-1" });
    expect(spyReq.seen[0]?.options?.signal).toBe(own.signal);
    // No `withdraw` on the background path: it is the 6a path, held apart from any turn.
    expect(spyReq.seen[0]?.options).not.toHaveProperty("withdraw");
  });

  test("`dismissed` + moved re-asks ONCE on the background path", async () => {
    const own = new AbortController();
    // The move lands DURING the first ask (its `withdraw` fires): that ask is
    // answered `dismissed`, and the child is already `sa-2` by then.
    let moved = false;
    const seen: Seen[] = [];
    const answers: PermissionResponse[] = [DISMISSED, { allowed: true }];
    const requester: PermissionRequester = async (_req, options) => {
      seen.push({ options });
      if (seen.length === 1) {
        moved = true;
      }
      return answers[seen.length - 1] ?? { allowed: false };
    };
    const wrapped = subagentRequester(requester, "call-1", AGENT, {
      move: {
        withdrawn: new AbortController().signal,
        background: () => (moved ? { id: "sa-2", signal: own.signal } : undefined),
      },
    });
    expect(await wrapped(REQ)).toEqual({ allowed: true });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.options?.agent).toEqual(AGENT);
    expect(seen[0]?.options?.withdraw).toBeDefined();
    expect(seen[1]?.options?.agent).toEqual({ ...AGENT, id: "sa-2" });
    expect(seen[1]?.options?.signal).toBe(own.signal);
  });

  test("a `dismissed` with NO move yet is a refusal, not a re-ask (a TUI unmounted)", async () => {
    const spyReq = spy([DISMISSED]);
    const requester = subagentRequester(spyReq.requester, "call-1", AGENT, {
      move: { withdrawn: new AbortController().signal, background: () => undefined },
    });
    expect(await requester(REQ)).toEqual(DISMISSED);
    expect(spyReq.seen).toHaveLength(1);
  });

  test("a plain refusal + moved is NOT re-asked: a human said no", async () => {
    let moved = false;
    const seen: Seen[] = [];
    const requester: PermissionRequester = async (_req, options) => {
      seen.push({ options });
      moved = true;
      return { allowed: false };
    };
    const wrapped = subagentRequester(requester, "call-1", AGENT, {
      move: {
        withdrawn: new AbortController().signal,
        background: () =>
          moved ? { id: "sa-3", signal: new AbortController().signal } : undefined,
      },
    });
    expect(await wrapped(REQ)).toEqual({ allowed: false });
    expect(seen).toHaveLength(1);
  });

  test("no move control: exactly today's ask (no `withdraw` key)", async () => {
    const spyReq = spy([{ allowed: true }]);
    const requester = subagentRequester(spyReq.requester, "call-1", AGENT);
    await requester(REQ);
    expect(spyReq.seen[0]?.options).not.toHaveProperty("withdraw");
    expect(spyReq.seen[0]?.options?.agent).toEqual(AGENT);
  });
});
