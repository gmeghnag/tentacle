/**
 * docs/feat/shell-jobs-panel.md — Review finding 5 (fix round 1): a
 * `background_exit` is a pod-supplied frame like any other, and its `jobId` and
 * `command` are unbounded strip-schema strings (`protocol/src/updates.ts`). They
 * reach the transcript's notice (`appendBackgroundExit` ⇒ Ink) and the dock's
 * pill, so the CLIENT must make them safe — the same gate `boundJobOutput` uses
 * for a row and a job's output (AGENTS §7: a pod is not trusted; never write raw
 * to the terminal).
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { Method, PROTOCOL_VERSION } from "@tentacle/protocol";
import { Notification } from "@tentacle/protocol";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { JOB_COMMAND_MAX } from "../src/jobs.ts";
import { updateToEvent } from "../src/mapping.ts";
import { type BackgroundExitNotice, RemoteClient } from "../src/remote-client.ts";

/** Control characters (C0, DEL, C1). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** The invisible format classes (bidi overrides, zero-width). */
const FORMAT = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A client attached to a daemon that sends exactly what the test says. */
async function rig(): Promise<{
  send: (update: unknown) => void;
  exits: BackgroundExitNotice[];
  close: () => void;
}> {
  const [daemonCh, clientCh] = createChannelPair();
  let seq = 0;
  const peer = new RpcPeer(daemonCh, {
    onRequest: async (method: string) => {
      if (method === Method.Initialize) {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { tools: true, permissions: true },
        };
      }
      if (method === Method.Open) {
        return { sessionId: "s1", epoch: "e", created: true, resync: false };
      }
      return {};
    },
  });
  const client = new RemoteClient(clientCh, new PermissionBroker());
  await client.initialize();
  const session = client.newSession(undefined, "s1", undefined, { attach: {} });
  await session.open();
  const exits: BackgroundExitNotice[] = [];
  client.onBackgroundExit((n) => exits.push(n));
  return {
    send: (update) =>
      peer.notify(Notification.SessionUpdate, { sessionId: "s1", seq: ++seq, update }),
    exits,
    close: () => client.close(),
  };
}

describe("a hostile `background_exit` is gated by the CLIENT (review 5)", () => {
  test("an id with OSC/ED and a 400-char id: no control, no format char, bounded", async () => {
    const r = await rig();
    const hostileId = "bg-9\u001b]0;PWNED\u0007\u001b[2J";
    const longId = `bg-${"W".repeat(400)}`;
    r.send({
      type: "background_exit",
      jobId: hostileId,
      command: "x",
      status: "exited",
      exitCode: 0,
    });
    r.send({
      type: "background_exit",
      jobId: longId,
      command: `c${"\u001b[2J".repeat(100)}`,
      status: "exited",
      exitCode: 0,
    });
    await tick();

    expect(r.exits).toHaveLength(2);
    for (const notice of r.exits) {
      expect(CONTROL.test(notice.jobId)).toBe(false);
      expect(FORMAT.test(notice.jobId)).toBe(false);
      expect(CONTROL.test(notice.command)).toBe(false);
      expect(FORMAT.test(notice.command)).toBe(false);
    }
    // Bounded: a 400-char id cannot wrap the transcript over six rows.
    expect(r.exits[1]?.jobId.length).toBeLessThanOrEqual(200);
    expect(r.exits[1]?.command.length).toBeLessThanOrEqual(JOB_COMMAND_MAX);
    r.close();
  });

  test("the SECOND door (`updateToEvent`) gates the same two strings", async () => {
    // `mapping.ts` builds the same notice for a turn-scoped path; both doors share
    // `gateExitText`, so a fix in one cannot leave the other open.
    const event = updateToEvent(
      {
        type: "background_exit",
        jobId: "bg-9\u001b]0;PWNED\u0007\u001b[2J",
        command: `x${"\u202e".repeat(10)}${"y".repeat(400)}`,
        status: "exited",
        exitCode: 0,
      },
      new Map(),
    );
    expect(event).not.toBeNull();
    const notice = event as { jobId: string; command: string };
    expect(CONTROL.test(notice.jobId)).toBe(false);
    expect(FORMAT.test(notice.jobId)).toBe(false);
    expect(FORMAT.test(notice.command)).toBe(false);
    expect(notice.jobId.length).toBeLessThanOrEqual(200);
    expect(notice.command.length).toBeLessThanOrEqual(JOB_COMMAND_MAX);
  });
});
