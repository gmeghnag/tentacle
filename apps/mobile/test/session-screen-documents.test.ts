/**
 * A PDF picked on the phone, end to end through the SCREEN (docs/feat/pdf-read.md
 * D7): the compose half's pick, the chip's block, and the ONE folding prompt the
 * turn goes through — the same seam a photo takes (`promptWithRefs`).
 *
 * Why its own file: the hole this found is invisible from `compose-documents.test.ts`.
 * There the fake folding prompt took `documents` as a fifth argument; the SCREEN's
 * real `promptWithRefs(text, turnId, refs, photos)` had none, so the compose half's
 * block was silently dropped between the chip and the wire — and `own_prompt`
 * carried no labels either, so a PDF-only prompt drew an empty bubble.
 *
 * The session's `send` here records the WHOLE opts it was given, which is the only
 * place that fact is observable.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import type { AttachmentRef, DocumentContent, QueueState } from "@tentacle/protocol";
import type { PickedDocument } from "../src/compose-chips.ts";
import type { ComposeHandle, PickedPhoto } from "../src/compose-controller.ts";
import { createOutboxDriver } from "../src/outbox-driver.ts";
import type { OutboxFs } from "../src/outbox-store.ts";
import { createOutboxStore, outboxPaths } from "../src/outbox-store.ts";
import { createSessionController } from "../src/session-controller.ts";
import {
  type ComposeWiring,
  type SendableHandle,
  type SessionScreenState,
  createSessionScreen,
} from "../src/session-screen-controller.ts";

function memoryFs(): OutboxFs {
  const files = new Map<string, string>();
  return {
    read: async (path) => files.get(path) ?? null,
    write: async (path, text) => {
      files.set(path, text);
    },
    rename: async (from, to) => {
      const text = files.get(from);
      if (text === undefined) {
        throw new Error("missing");
      }
      files.delete(from);
      files.set(to, text);
    },
    remove: async (path) => {
      files.delete(path);
    },
    list: async (dir) => [...files.keys()].filter((path) => path.startsWith(`${dir}/`)),
  };
}

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n%fake\n");
const BLOCK: DocumentContent = {
  type: "document",
  kind: "pdf",
  name: "report.pdf",
  source: { type: "ref", id: "a".repeat(64), size: PDF_BYTES.length },
};
const PICK_PDF: PickedDocument = {
  kind: "document",
  file: "file:///o/pdfs/1-report.pdf",
  name: "report.pdf",
  size: PDF_BYTES.length,
  bytes: PDF_BYTES,
};

/** One `send` as the session received it (the wire's own view of the prompt). */
interface SentTurn {
  readonly prompt: string;
  readonly attachments?: readonly AttachmentRef[];
  readonly documents?: readonly DocumentContent[];
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await Bun.sleep(1);
  }
};

function harness() {
  const states: SessionScreenState[] = [];
  const brokers: PermissionBroker[] = [];
  const store = createOutboxStore(memoryFs(), outboxPaths("file:///o", "c1"), () => 1);
  const sent: SentTurn[] = [];
  const session = {
    queue: null as QueueState | null,
    queueListener: (_state: QueueState) => {},
    activity: null as ((activity: unknown) => void) | null,
  };
  const handle: ComposeHandle = {
    sessionId: "s1",
    attachImage: async (_bytes, meta) =>
      ({ id: "blob", mimeType: meta.mimeType, size: 3 }) as AttachmentRef,
    // The SESSION's seam, decided by the client's capability (D6): a fake that
    // answers the block the real one would (`document{ref}` for `upload`).
    attachDocument: async (_bytes, meta) => ({ ...BLOCK, name: meta.name }),
    send: async () => {},
    steer: async () => {},
    sendNow: async () => (async function* () {})(),
    onQueued: (listener) => {
      session.queueListener = listener;
      if (session.queue !== null) {
        listener(session.queue);
      }
      return () => {};
    },
    queued: () => session.queue ?? undefined,
    reclaim: async () => {},
    port: {
      upload: async (_bytes, meta) =>
        ({ id: "port", mimeType: meta.mimeType, size: 3 }) as AttachmentRef,
      prompt: async () => {},
      attachDocument: async (_bytes, meta) => ({ ...BLOCK, name: meta.name }),
      steer: async () => {},
      facts: () => Promise.resolve({ availability: "open", historyLength: 0, runningTurnId: null }),
    },
  };
  const driver = (folding: Parameters<ComposeWiring["driver"]>[0]) =>
    createOutboxDriver(async () => ({ ...handle.port, prompt: folding.prompt }), {
      persistence: {
        items: () => store.data.items,
        save: (items) => store.setItems(items),
        finish: (itemId) => store.removeItem(itemId),
      },
      readPhoto: async () => PDF_BYTES,
      mint: () => "k",
      ...(folding.onDraft === undefined ? {} : { onDraft: folding.onDraft }),
    });
  const screen = () => {
    const broker = new PermissionBroker(undefined, { holdUntilSet: true });
    brokers.push(broker);
    return createSessionScreen({
      sessionId: "s1",
      archived: false,
      title: "Alpha",
      project: "e2e-mac",
      controller: createSessionController<SendableHandle>({
        newSession: () => ({
          open: () => Promise.resolve(),
          detach: () => Promise.resolve(),
          watch: (listener) => {
            session.activity = listener as (activity: unknown) => void;
            return () => {
              session.activity = null;
            };
          },
          async *send(
            prompt: string,
            _signal?: AbortSignal,
            opts?: {
              readonly attachments?: readonly AttachmentRef[];
              readonly documents?: readonly DocumentContent[];
              readonly onAccepted?: () => void;
            },
          ) {
            // The one seam the turn goes through: what the daemon would be sent.
            sent.push({
              prompt,
              ...(opts?.attachments === undefined ? {} : { attachments: opts.attachments }),
              ...(opts?.documents === undefined ? {} : { documents: opts.documents }),
            });
            opts?.onAccepted?.();
            // The real client never re-delivers YOUR OWN prompt (`remote-session.ts`:
            // "our own prompt is already on screen"), so this stream starts at the
            // turn itself — the feed's `own_prompt` is the row's only source.
            yield { type: "text", delta: "echo" } as never;
            yield { type: "turn_end", reason: "end_turn" } as never;
          },
        }),
      }),
      broker,
      now: () => 1,
      onChange: (state) => states.push(state),
      compose: {
        computerId: "c1",
        store,
        driver: (folding) => driver(folding),
        photos: {
          pickFromLibrary: async (): Promise<readonly PickedPhoto[]> => [],
          takePhoto: async (): Promise<readonly PickedPhoto[]> => [],
        },
        documents: {
          pickPdf: async () => [PICK_PDF],
          documentsInput: () => ({ kind: "upload", maxBytes: 15 * 1024 * 1024 }),
        },
        handle: () => handle,
        draft: () => {},
        mint: () => "m",
      },
    });
  };
  return { screen, states, session, store, sent };
}

describe("a phone PDF reaches the wire (D7)", () => {
  test("the SESSION's send carries the documents and the bubble names the file", async () => {
    // MUTATION M5: the screen's folding prompt drops `documents` (its old
    // `promptWithRefs(text, turnId, refs, photos)`) → the prompt goes out with no
    // document at all, and the bubble has no row: both assertions red.
    const h = harness();
    const screen = h.screen();
    await screen.open();
    await settle();
    await screen.pickDocument();
    screen.setDraft("what does this say?");
    screen.press();
    await settle();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.prompt).toBe("what does this say?");
    expect(h.sent[0]?.documents).toEqual([{ ...BLOCK, name: "report.pdf" }]);
    // The transcript's own row: the person sees the file, never the block.
    const row = screen.state().transcript.rows.find((r) => r.kind === "user");
    if (row?.kind !== "user") {
      throw new Error("expected a user row");
    }
    expect(row.documents).toEqual(["[pdf: report.pdf]"]);
    expect(row.text).not.toContain("<file");
  });

  test("a PDF with no text is still a sendable message, and its row is the whole bubble", async () => {
    const h = harness();
    const screen = h.screen();
    await screen.open();
    await settle();
    await screen.pickDocument();
    screen.press();
    await settle();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.prompt).toBe("");
    expect(h.sent[0]?.documents).toHaveLength(1);
    const row = screen.state().transcript.rows.find((r) => r.kind === "user");
    if (row?.kind !== "user") {
      throw new Error("expected a user row");
    }
    expect(row.text).toBe("");
    expect(row.documents).toEqual(["[pdf: report.pdf]"]);
  });
});
