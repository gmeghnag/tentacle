/**
 * The Live Activity RENDER spec (docs/feat/mobile-live-activity.md Design 7,
 * slice L9): `ActivityContent → LaViewModel`, as pure data.
 *
 * This module is the SPEC the widget's SwiftUI views follow, and the vectors
 * (`apps/mobile/test/fixtures/la-render-v1.json`) are asserted by BOTH this test
 * and the Swift tests (L10), so the two implementations cannot drift — the same
 * discipline `push-render.ts` uses for the Notification Service Extension
 * (decision 20: logic in pure modules, one spec, two implementations).
 *
 * Rules that are security-relevant, not cosmetic:
 *
 *  - **Approve is only ever offered for an `allow_once` option**, Deny for a
 *    `reject_once`. An activity can never offer a lasting rule (decision 8,
 *    Owner Q6): a lock-screen tap cannot grant what the in-app sheet exists to
 *    make deliberate, so `allow_always` produces NO button.
 *  - **Anything unrenderable is the PLACEHOLDER** — "tentacle — open to see", no
 *    buttons, no content. An unknown `v`, an unknown `kind`, a missing ask: never
 *    a guess, so a hostile relay's junk activity shows nothing and offers nothing
 *    (F6, F22). A throw would be worse than useless: iOS drops the whole update.
 *  - **`title` and the ask's `preview` are PRIVATE** (Owner Q7). The view-model
 *    names which fields are private and the Swift view applies
 *    `.privacySensitive()`, so the policy lives HERE, once.
 *  - **Every string is sanitized and bounded**: it came from a daemon that may be
 *    a pod. `fitActivityContent` already clipped it; this is the second belt, and
 *    the reason a stray ANSI escape can never reach a lock screen.
 *
 * What is NOT here: elapsed time. It is drawn on the phone from `startedAt`
 * (`Text(timerInterval:)`), so a running turn costs no updates at all.
 */
import {
  ACTIVITY_PREVIEW_MAX,
  ACTIVITY_PROJECT_MAX,
  ACTIVITY_TITLE_MAX,
  ACTIVITY_TOOL_MAX,
  type ActivityContent,
  type ActivityKind,
} from "@tentacle/protocol";
import { stripAnsi } from "./ansi.ts";

/** The plaintext's OWN version this build renders; a future one is a placeholder (F22). */
const RENDER_VERSION = 1;

/** What the placeholder says. The same words the Swift view hard-codes from the vectors. */
export const LA_PLACEHOLDER_TEXT = "tentacle — open to see";

/** A button the activity may offer. Only these two actions exist (Owner Q6). */
export interface LaButton {
  readonly action: "approve" | "deny";
  /** The `optionId` the answer will carry (a lock screen tap selects THIS option). */
  readonly optionId: string;
}

/**
 * What a widget view draws. `placeholder: true` means: show `text`, draw no
 * content and NO buttons — the caller must not read the other fields.
 *
 * The absent fields are absent ON PURPOSE: a placeholder must not carry the
 * project or title it could not authenticate, because a view that ignored the
 * flag would then leak them.
 */
export interface LaViewModel {
  readonly placeholder: boolean;
  /** The one line a placeholder shows (absent when `placeholder` is false). */
  readonly text?: string;
  /** The activity's identity: what an action reports back. Absent on a placeholder. */
  readonly slot?: string;
  readonly project?: string;
  readonly phase?: ActivityKind;
  /** The turn's ORIGINAL start, for the on-phone elapsed timer. */
  readonly startedAt?: number;
  readonly tool?: string;
  readonly title?: string;
  /** The ask's command preview, when `phase` is `asking`. */
  readonly preview?: string;
  /** Which of the above are `.privacySensitive()` (hidden while locked). */
  readonly privateFields: readonly (keyof LaViewModel)[];
  readonly buttons: readonly LaButton[];
  /** The turn's error line, when `phase` is `failed`. */
  readonly error?: string;
}

/** The placeholder: no identity, no content, no buttons. Quiet by construction. */
function placeholder(): LaViewModel {
  return { placeholder: true, text: LA_PLACEHOLDER_TEXT, privateFields: [], buttons: [] };
}

/** `text` cleaned for a lock screen: no ANSI, no control characters, bounded. */
function clean(text: unknown, max: number): string | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  const stripped = stripAnsi(text)
    // The wire's `line` rule, applied again: a pod-originated daemon is peer input.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim();
  return stripped.length === 0 ? undefined : stripped.slice(0, max);
}

/** `true` iff `kind` is a phase this build draws. */
function isKnownKind(kind: unknown): kind is ActivityKind {
  return (
    kind === "running" ||
    kind === "asking" ||
    kind === "done" ||
    kind === "failed" ||
    kind === "cancelled"
  );
}

/**
 * Approve / Deny for the options an ask OFFERS. Deliberately narrow:
 *
 *  - `allow_once` → Approve (the narrowest approval there is);
 *  - `reject_once` → Deny;
 *  - `allow_always` / `reject_always` → NO button. A lasting rule needs the
 *    in-app sheet, where the person sees the full request (decision 8). The
 *    activity still says `asking`, so the person knows to open the app.
 *
 * A later option of the same kind never adds a second button: one Approve and
 * one Deny are the whole grammar of a lock screen.
 */
function buttonsOf(
  options: readonly { readonly optionId: string; readonly kind: string }[],
): LaButton[] {
  const buttons: LaButton[] = [];
  for (const option of options) {
    if (option.kind === "allow_once" && !buttons.some((b) => b.action === "approve")) {
      buttons.push({ action: "approve", optionId: option.optionId });
    }
    if (option.kind === "reject_once" && !buttons.some((b) => b.action === "deny")) {
      buttons.push({
        action: "deny",
        optionId: option.kind === "reject_once" ? option.optionId : "",
      });
    }
  }
  return buttons;
}

/**
 * The view-model for one content-state's plaintext. TOTAL: every malformed input
 * (a non-object, a missing field, an unknown version or kind) returns the
 * placeholder, never a throw — an exception here would make iOS drop the update
 * and leave the PREVIOUS state on the screen, which is exactly what a hostile
 * relay wants.
 */
export function renderActivity(content: unknown): LaViewModel {
  if (typeof content !== "object" || content === null) {
    return placeholder();
  }
  const value = content as Partial<ActivityContent>;
  // The version gate FIRST: a newer daemon's plaintext is not this build's to
  // interpret, and guessing could draw its fields with this build's meaning (F22).
  if (value.v !== RENDER_VERSION || !isKnownKind(value.kind)) {
    return placeholder();
  }
  const slot = typeof value.slot === "string" ? value.slot : undefined;
  const project = clean(value.project, ACTIVITY_PROJECT_MAX);
  const startedAt =
    typeof value.startedAt === "number" && Number.isFinite(value.startedAt)
      ? value.startedAt
      : undefined;
  // Identity is what an action reports and what the elapsed timer needs: without
  // it the view is not actionable, so it is a placeholder rather than half a view.
  if (slot === undefined || project === undefined || startedAt === undefined) {
    return placeholder();
  }

  const phase = value.kind;
  const title = clean(value.title, ACTIVITY_TITLE_MAX);
  const tool = clean(value.tool, ACTIVITY_TOOL_MAX);
  const error = phase === "failed" ? clean(value.error, ACTIVITY_PREVIEW_MAX) : undefined;
  const privateFields: (keyof LaViewModel)[] = [];
  if (title !== undefined) {
    privateFields.push("title");
  }

  if (phase === "asking") {
    const ask = value.ask;
    // An `asking` with no usable ask is a placeholder: the buttons must come from
    // the SAME plaintext as the request they answer, or an activity could offer a
    // decision the content never described (F6).
    if (
      ask === undefined ||
      typeof ask.requestId !== "string" ||
      !Array.isArray(ask.options) ||
      ask.options.length === 0
    ) {
      return placeholder();
    }
    const preview = clean(ask.preview, ACTIVITY_PREVIEW_MAX);
    if (preview !== undefined) {
      // The command being asked about is the most sensitive line on the screen.
      privateFields.push("preview");
    }
    // While an ask is waiting, the tool the person must judge is the ASK's own
    // (`ask.tool`: what is asking), not `tool` (the turn's last finished call).
    // Showing the stale one would name the wrong thing next to Approve.
    const askTool = clean(ask.tool, ACTIVITY_TOOL_MAX);
    return {
      placeholder: false,
      slot,
      project,
      phase,
      startedAt,
      ...(askTool === undefined ? {} : { tool: askTool }),
      ...(title === undefined ? {} : { title }),
      ...(preview === undefined ? {} : { preview }),
      privateFields,
      buttons: buttonsOf(ask.options),
    };
  }

  return {
    placeholder: false,
    slot,
    project,
    phase,
    startedAt,
    ...(tool === undefined ? {} : { tool }),
    ...(title === undefined ? {} : { title }),
    ...(error === undefined ? {} : { error }),
    privateFields,
    buttons: [],
  };
}

/** The Swift type's name, which the push-to-start `attributes-type` must equal (Design 6). */
export const LA_ATTRIBUTES_TYPE = "TentacleActivityAttributes";
