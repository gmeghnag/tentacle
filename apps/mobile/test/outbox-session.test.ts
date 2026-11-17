/**
 * The driver's session port, for real (docs/feat/mobile-compose.md 13b, D4;
 * docs/feat/pdf-read.md D7) — the ONE place where an outbox item's documents
 * reach `RemoteSession.send`.
 *
 * The rest of the port is pinned against a real daemon (`outbox-link.test.ts`).
 * What is pinned HERE is the port's own translation of an item's fields into
 * `send`'s options, which the driver's fake port (`outbox-driver.test.ts`) and
 * the link harness both bypass: a dropped `documents` there is a PDF the person
 * attached and the daemon never learns about, with nothing said.
 *
 * Each test names the mutation that must turn it red.
 */
import { describe, expect, test } from "bun:test";
import type { RemoteClient, RemoteSession } from "@tentacle/client";
import type { AttachmentRef, DocumentContent } from "@tentacle/protocol";
import { outboxSessionOf } from "../src/outbox-session.ts";

/** One `send` call, as the port made it (the options `RemoteSession` got). */
interface Sent {
  readonly text: string;
  readonly options: {
    readonly turnId?: string;
    readonly attachments?: readonly AttachmentRef[];
    readonly documents?: readonly DocumentContent[];
  };
}

/** A `RemoteSession` that records the one call this port makes, and acks at once. */
function fakeSession(): { session: RemoteSession; client: RemoteClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const session = {
    sessionId: "s1",
    busy: false,
    // The driver's port drains the stream; the daemon's ack is all it waits for.
    async *send(
      text: string,
      _signal: AbortSignal | undefined,
      options: Sent["options"] & { readonly onAccepted?: () => void },
    ): AsyncGenerator<unknown> {
      sent.push({ text, options });
      options.onAccepted?.();
      yield { type: "text", delta: "ok" };
    },
    async attachDocument(): Promise<DocumentContent> {
      throw new Error("not used by these tests");
    },
  };
  return {
    session: session as unknown as RemoteSession,
    client: {} as unknown as RemoteClient,
    sent,
  };
}

/** A `document` block the client's own `attachDocument` answers (the wire's shape). */
const BLOCK: DocumentContent = {
  type: "document",
  kind: "pdf",
  name: "report.pdf",
  source: { type: "ref", id: "c".repeat(64), size: 2048 },
};

describe("the port's `prompt`", () => {
  test("an item's documents reach `session.send` (mutation: `documents.length === 0` → `>= 0` → red)", async () => {
    const { session, client, sent } = fakeSession();
    const port = outboxSessionOf(session, client, () => null);
    await port.prompt("read this", "turn-1", [], [], [BLOCK]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe("read this");
    expect(sent[0]?.options.turnId).toBe("turn-1");
    expect(sent[0]?.options.documents).toEqual([BLOCK]);
  });

  test("an item with no documents sends none — not even an empty list (an older daemon sees the same params)", async () => {
    const { session, client, sent } = fakeSession();
    const port = outboxSessionOf(session, client, () => null);
    await port.prompt("just text", "turn-2", [], [], []);
    expect(sent[0]?.options.documents).toBeUndefined();
    // Absent, never `[]`: the frame is the one every pre-D7 item already sent.
    expect("documents" in (sent[0]?.options ?? {})).toBe(false);
  });

  test("the call settles at the daemon's ack, so a turn that runs on does not hold the item", async () => {
    const { session, client } = fakeSession();
    const port = outboxSessionOf(session, client, () => null);
    await port.prompt("hello", "turn-3", [], [], undefined);
    // Reaching here IS the property (`untilAccepted` would hang otherwise).
    expect(true).toBe(true);
  });
});
