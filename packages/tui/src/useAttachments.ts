/**
 * The input's IMAGE CHIPS and the upload in flight (docs/feat/attachments-tui.md
 * D8; docs/feat/app-decomposition.md S6). Every DECISION stays where it was and
 * stays pure — `attach-candidates.ts` (is this text a path?), `attach-files.ts`
 * (what is on the disk?), `attach-draft.ts` (what does it do to the draft?) —
 * and this hook is the executor for them: it owns the ONE serialization chain
 * the feature needs ("one decision at a time", so a second paste's `existing`
 * always sees the first one's chips) and runs the upload loop.
 *
 * What does NOT move (Fable H1, frozen identifiers):
 * - the draft STATE (`attach`, `attachRef`, `setAttach`), because the render
 *   reads it for the attach row and the input box's row count, and `submit` /
 *   Backspace edit it outside this feature;
 * - the refs other layers read: `probedTextRef` (the App's `submit`, R2-1),
 *   `uploadCtrlRef` (Esc's `cancelUpload` and the key snapshot's
 *   `uploadInFlight`) and `attachGenRef` (the unmount effect);
 * - the unmount effect itself, which is effect 1 of 22 in `App` and stays at
 *   that index (the original 20; session-hop added `targetFeed`'s subscription
 *   and the idle `hopIfQueued` after it); it aborts the upload and bumps the
 *   generation, and this hook only READS the generation it bumped.
 * They arrive as port fields, the same way S4's `useMouse` takes `selectionRef`
 * and `panelRef`: a ref is passed in, never re-created here.
 */

import { resolve } from "node:path";
import type { AttachmentRef } from "@tentacle/core";
import type { DocumentContent } from "@tentacle/protocol";
import { type MutableRefObject, type RefObject, useCallback, useRef } from "react";
import type { SessionController } from "./app-types.ts";
import { attachmentCandidateText, parseAttachCommand } from "./attach-candidates.ts";
import {
  type AttachDraft,
  type AttachMode,
  NOT_AN_IMAGE_NOTICE,
  NO_IMAGE_SEAM,
  attachErrorText,
  draftRefs,
  looksLikeCommand,
  routeDecision,
  uploadDone,
  uploadProgress,
  withChips,
  withDocuments,
} from "./attach-draft.ts";
import {
  type AttachedDocument,
  type AttachedImage,
  type FileProbe,
  decideAttachment,
} from "./attach-files.ts";
import type { LineEditor } from "./hooks.ts";
import { type DocumentMode, NO_DOCUMENT_SEAM } from "./pdf-attach.ts";

/**
 * What this slice asks of the App's `run` — the fields that carry an attachment
 * prompt. The turn driver's own options are wider, and a wider-parameter
 * function is assignable here, so the App's `runRef` is passed unchanged.
 */
export type AttachRun = (
  text: string,
  opts?: {
    readonly attachments?: readonly AttachmentRef[];
    readonly images?: readonly AttachedImage[];
    /** The PDF chips whose wire blocks `documents` holds (docs/feat/pdf-read.md D6). */
    readonly documents?: readonly DocumentContent[];
    readonly documentChips?: readonly AttachedDocument[];
  },
) => void;

/**
 * The narrow port the attachments execute through: the App's own state, setters
 * and callbacks. A port FIELD is ref-backed or keeps its current identity rule
 * (Fable H2), and the callbacks below destructure the fields and name them in
 * deps — never `host`.
 */
export interface AttachHost {
  readonly field: LineEditor;
  /** The draft as of the last render: an async decision reads what it is NOW. */
  readonly attachRef: MutableRefObject<AttachDraft>;
  readonly setAttach: (next: AttachDraft | ((prev: AttachDraft) => AttachDraft)) => void;
  /** Bumped on unmount: a decision landing after it is dropped. */
  readonly attachGenRef: MutableRefObject<number>;
  /** The text a `convert` already probed — the App's `submit` reads it (R2-1). */
  readonly probedTextRef: MutableRefObject<string | null>;
  /** The upload in flight — Esc aborts it, the key snapshot asks if it is there. */
  readonly uploadCtrlRef: MutableRefObject<AbortController | null>;
  readonly sessionRef: RefObject<SessionController | null>;
  readonly runRef: RefObject<AttachRun | null>;
  /** `level: "warn"` marks a harness line the person should notice (docs/feat/harness-notices.md S2). */
  readonly pushNotice: (text: string, level?: "warn") => void;
  readonly restoreInput: (text: string, why: string) => void;
  readonly fileProbe: FileProbe;
  /** `~` expansion for a pasted path (`undefined` on a host that cannot answer). */
  readonly home: string | undefined;
  /** The LAPTOP's cwd: what a relative `/attach` path means, never the `cwd` prop. */
  readonly localCwd: string;
}

/** The attachments' decisions, as `App` calls them. */
export interface AttachLayer {
  /** What the CURRENT session takes: its own answer, or the no-seam reason. */
  attachMode(): AttachMode;
  /** What the CURRENT session takes as a PDF (`documentsInput`, docs/feat/pdf-read.md D6). */
  documentMode(): DocumentMode;
  /** Put a refused prompt's chips back (decision 15). */
  restoreChips(chips: readonly AttachedImage[] | undefined): void;
  /** Put a refused prompt's PDF chips back (the same rule, docs/feat/pdf-read.md D6). */
  restoreDocuments(documents: readonly AttachedDocument[] | undefined): void;
  /** A pasted/dropped text: prose inserts, attachment paths become chips, a refusal is said. */
  routeAttach(text: string): void;
  /** `/attach <path…>`, the explicit form (every failure a refusal). */
  attachCommand(raw: string): void;
  /** An unbracketed drop + Enter: paths become chips and NOTHING is sent (decision 5). */
  convertToChips(text: string): void;
  /** Upload the draft's chips through the session's own seam, then run the prompt. */
  sendWithImages(
    text: string,
    chips: readonly AttachedImage[],
    documents?: readonly AttachedDocument[],
  ): void;
}

export function useAttachments(host: AttachHost): AttachLayer {
  // Destructured so the callbacks' deps name FIELDS, never the port (Fable H2).
  const {
    field,
    attachRef,
    setAttach,
    attachGenRef,
    probedTextRef,
    uploadCtrlRef,
    sessionRef,
    runRef,
    pushNotice,
    restoreInput,
    fileProbe,
    home,
    localCwd,
  } = host;

  // One decision at a time: a promise chain, so a second paste's `existing` (and
  // its duplicate/cap count) always sees the previous one's chips.
  const attachChainRef = useRef<Promise<void>>(Promise.resolve());

  /** What the CURRENT session takes: its own answer (a session that takes none says so). */
  const attachMode = useCallback(
    (): AttachMode => sessionRef.current?.imageInput() ?? NO_IMAGE_SEAM,
    [sessionRef],
  );
  /**
   * What the CURRENT session takes as a PDF (docs/feat/pdf-read.md D6): its own
   * answer, exactly as `attachMode` reads the image one.
   */
  const documentMode = useCallback(
    (): DocumentMode => sessionRef.current?.documentsInput() ?? NO_DOCUMENT_SEAM,
    [sessionRef],
  );
  /**
   * Put a refused prompt's chips back (docs/feat/attachments-tui.md D8): the
   * bytes are still in them, so Enter uploads them again. Appended, never
   * replacing what the user attached meanwhile.
   */
  const restoreChips = useCallback(
    (chips: readonly AttachedImage[] | undefined) => {
      if (chips === undefined || chips.length === 0) {
        return;
      }
      setAttach((draft) => ({ ...withChips(draft, chips).draft, upload: null }));
    },
    [setAttach],
  );
  /** The same for a refused prompt's PDF chips (docs/feat/pdf-read.md D6). */
  const restoreDocuments = useCallback(
    (documents: readonly AttachedDocument[] | undefined) => {
      if (documents === undefined || documents.length === 0) {
        return;
      }
      setAttach((draft) => ({ ...withDocuments(draft, documents).draft, upload: null }));
    },
    [setAttach],
  );
  /** Say each notice as its own row (never joined: one refusal per line). */
  const showNotices = useCallback(
    (notices: readonly string[]) => {
      for (const notice of notices) {
        pushNotice(notice);
      }
    },
    [pushNotice],
  );
  /**
   * Decide what a pasted/dropped text is and act: prose is inserted as it always
   * was, image paths become chips, a refusal is SAID. One decision at a time
   * (a promise chain, so `existing` sees the previous paste's chips), and a
   * result that lands after an unmount is dropped.
   */
  const routeAttach = useCallback(
    (text: string): void => {
      // A `/command` is always text: `/compact` alone is a legal path candidate
      // to `tokenizePaths`, and a paste must never stat one.
      const candidate = looksLikeCommand(text)
        ? ({ kind: "text" } as const)
        : attachmentCandidateText(text, home !== undefined ? { home } : {});
      if (candidate.kind === "text") {
        field.insert(text); // prose never touches the disk
        return;
      }
      const gen = attachGenRef.current;
      attachChainRef.current = attachChainRef.current.then(async () => {
        const decision = await decideAttachment(fileProbe, candidate, {
          existing: draftRefs(attachRef.current),
          existingDocuments: attachRef.current.documents.length,
        });
        if (gen !== attachGenRef.current) {
          return; // unmounted while the disk was read
        }
        // The paste's own text comes back when the decision is `text` (a missing
        // path, a directory, a source file): the 3a rule is that the WHOLE paste
        // stays text, and dropping it silently would lose what was pasted
        // (review round 1, finding 1).
        const routed = routeDecision(
          attachRef.current,
          decision,
          attachMode(),
          text,
          documentMode(),
        );
        setAttach(routed.draft);
        if (routed.insert !== undefined) {
          field.insert(routed.insert);
        }
        showNotices(routed.notices);
      });
    },
    [
      attachGenRef,
      attachMode,
      attachRef,
      documentMode,
      field,
      fileProbe,
      home,
      setAttach,
      showNotices,
    ],
  );
  /**
   * `/attach <path…>`: the explicit form (every failure a refusal). A relative
   * path resolves against the LAPTOP's cwd, never the `cwd` prop (P15).
   */
  const attachCommand = useCallback(
    (raw: string): void => {
      const parsed = parseAttachCommand(raw, home !== undefined ? { home } : {});
      if (parsed === null) {
        pushNotice("_Usage: `/attach <path>` (a path may be dragged into the terminal)_");
        return;
      }
      const paths = parsed.paths.map((path) => resolve(localCwd, path));
      const gen = attachGenRef.current;
      attachChainRef.current = attachChainRef.current.then(async () => {
        const decision = await decideAttachment(
          fileProbe,
          { kind: "paths", paths },
          {
            existing: draftRefs(attachRef.current),
            existingDocuments: attachRef.current.documents.length,
            explicit: true,
          },
        );
        if (gen !== attachGenRef.current) {
          return;
        }
        const routed = routeDecision(attachRef.current, decision, attachMode(), "", documentMode());
        setAttach(routed.draft);
        if (routed.insert !== undefined) {
          field.insert(routed.insert);
        }
        showNotices(routed.notices);
      });
    },
    [
      attachGenRef,
      attachMode,
      attachRef,
      documentMode,
      field,
      fileProbe,
      home,
      localCwd,
      pushNotice,
      setAttach,
      showNotices,
    ],
  );
  /** An unbracketed drop + Enter: the paths become chips and NOTHING is sent (decision 5). */
  const convertToChips = useCallback(
    (text: string): void => {
      const candidate = attachmentCandidateText(text, home !== undefined ? { home } : {});
      if (candidate.kind !== "paths") {
        return;
      }
      const gen = attachGenRef.current;
      attachChainRef.current = attachChainRef.current.then(async () => {
        const decision = await decideAttachment(fileProbe, candidate, {
          existing: draftRefs(attachRef.current),
          existingDocuments: attachRef.current.documents.length,
        });
        if (gen !== attachGenRef.current) {
          return;
        }
        const routed = routeDecision(attachRef.current, decision, attachMode(), "", documentMode());
        setAttach(routed.draft);
        showNotices(routed.notices);
        // A typed drag whose bytes are NOT an image: the text goes back and says
        // why, instead of a cleared field that sent nothing (review round 1,
        // finding 1).
        if (decision.kind === "text") {
          // Recorded BEFORE the restore: the next Enter on this same text is a
          // message, not another probe (round 2, R2-1).
          probedTextRef.current = text;
          restoreInput(text, NOT_AN_IMAGE_NOTICE);
          return;
        }
        // Said only when something WAS attached: a refusal already spoke.
        if (routed.draft.chips.length > attachRef.current.chips.length) {
          pushNotice(
            `_attached ${routed.draft.chips.length} image${routed.draft.chips.length === 1 ? "" : "s"} — type your message and press Enter_`,
          );
        }
      });
    },
    [
      attachGenRef,
      attachMode,
      attachRef,
      documentMode,
      fileProbe,
      home,
      probedTextRef,
      pushNotice,
      restoreInput,
      setAttach,
      showNotices,
    ],
  );
  /**
   * Send the prompt with the draft's attachments: every image goes through the
   * SESSION's own `attachImage`, every PDF through its `attachDocument` (ONE at
   * a time, progress on the same row), then the prompt names the refs and the
   * wire blocks. A failure restores the text, keeps the chips and says why —
   * Enter retries, and the store's put is idempotent.
   *
   * The document seam is the SESSION's on purpose (docs/feat/pdf-read.md D6):
   * only it knows whether this daemon takes an upload (`ref`, the daemon
   * extracts) or needs this laptop's own extraction (`text`, a pod — no PDF
   * bytes into it, AGENTS §7). This hook never decides that, and never sends
   * bytes itself.
   */
  const sendWithImages = useCallback(
    (
      text: string,
      chips: readonly AttachedImage[],
      documents: readonly AttachedDocument[] = [],
    ): void => {
      const session = sessionRef.current;
      if (session === null) {
        restoreInput(text, "_images are off: this session does not take images_");
        return;
      }
      // Every controller has the seam (docs/feat/remove-in-process.md): a session
      // that does not take images answers `imageInput()` with `{kind:"off"}`,
      // which is why no chips of one ever get here.
      const seam = session.attachImage;
      const documentSeam = session.attachDocument;
      const gen = attachGenRef.current;
      const controller = new AbortController();
      uploadCtrlRef.current = controller;
      // ONE row for everything in flight: the images first, then the PDFs, so
      // `index`/`count` still mean something to a reader (`2/3`).
      const count = chips.length + documents.length;
      const upload = async (): Promise<void> => {
        const refs: AttachmentRef[] = [];
        for (const [index, chip] of chips.entries()) {
          const name =
            chip.ref.name !== undefined && chip.ref.name !== "" ? chip.ref.name : chip.ref.mimeType;
          setAttach((draft) => uploadProgress(draft, index, count, name, 0, chip.ref.size));
          refs.push(
            await seam.call(
              session,
              chip.bytes,
              {
                mimeType: chip.ref.mimeType,
                ...(chip.ref.name !== undefined ? { name: chip.ref.name } : {}),
              },
              {
                signal: controller.signal,
                onProgress: (sent, size) =>
                  setAttach((draft) => uploadProgress(draft, index, count, name, sent, size)),
              },
            ),
          );
        }
        const blocks: DocumentContent[] = [];
        for (const [offset, document] of documents.entries()) {
          const index = chips.length + offset;
          setAttach((draft) =>
            uploadProgress(draft, index, count, document.name, 0, document.size),
          );
          blocks.push(
            await documentSeam.call(
              session,
              document.bytes,
              { name: document.name },
              {
                signal: controller.signal,
                // An extraction reports no bytes: one jump to 100% when done.
                onProgress: (sent, size) =>
                  setAttach((draft) =>
                    uploadProgress(draft, index, count, document.name, sent, size),
                  ),
              },
            ),
          );
        }
        if (gen !== attachGenRef.current) {
          return;
        }
        // The upload is over: Esc must go back to stopping the TURN, not abort a
        // finished controller (review round 1, finding 3).
        if (uploadCtrlRef.current === controller) {
          uploadCtrlRef.current = null;
        }
        setAttach((draft) => uploadDone({ ...draft, chips: [], documents: [] }));
        await runRef.current?.(text, {
          attachments: refs,
          images: chips,
          documents: blocks,
          documentChips: documents,
        });
      };
      upload().catch((error: unknown) => {
        if (gen !== attachGenRef.current) {
          return;
        }
        if (uploadCtrlRef.current === controller) {
          uploadCtrlRef.current = null;
        }
        // The chips stay (bytes included): Enter uploads them again.
        setAttach((draft) => uploadDone(draft));
        restoreInput(text, attachErrorText(error));
      });
    },
    [attachGenRef, restoreInput, runRef, sessionRef, setAttach, uploadCtrlRef],
  );

  return {
    attachMode,
    documentMode,
    restoreChips,
    restoreDocuments,
    routeAttach,
    attachCommand,
    convertToChips,
    sendWithImages,
  };
}
