/**
 * Whether the transcript FOLLOWS the stream (owner B5, 2026-11-15): new content
 * scrolls the list to the end while the person is at the bottom; once they drag
 * up, it stays where they are and a "Jump to latest" pill is offered.
 *
 * Pure and React-free (AGENTS §7): `SessionScreen.tsx` feeds it the list's
 * scroll metrics, content-size and layout changes, and only performs the
 * `scrollToOffset` a step names.
 */

/** How close to the end still counts as "at the bottom" (a finger's slack). */
export const NEAR_BOTTOM_PT = 48;

export interface ScrollMetrics {
  /** `contentOffset.y`. */
  readonly offset: number;
  /** `contentSize.height`. */
  readonly content: number;
  /** `layoutMeasurement.height`. */
  readonly viewport: number;
}

export interface Follow {
  /** New content scrolls the list to the end. */
  readonly following: boolean;
  /** Content arrived while not following (the pill may say so). */
  readonly unseen: boolean;
}

export const initialFollow: Follow = { following: true, unseen: false };

export function nearBottom(m: ScrollMetrics): boolean {
  return m.content - (m.offset + m.viewport) <= NEAR_BOTTOM_PT;
}

/**
 * A scroll event. Only the PERSON (`byPerson`: a drag or its momentum) can stop
 * following: the list's own animated scroll-to-end trails a growing end, and
 * reading that as "scrolled up" would drop a fast stream out of follow.
 * Reaching the bottom — by hand or not — always resumes it.
 */
export function scrolled(state: Follow, m: ScrollMetrics, byPerson: boolean): Follow {
  if (nearBottom(m)) {
    return initialFollow;
  }
  if (byPerson) {
    return state.following ? { following: false, unseen: state.unseen } : state;
  }
  return state;
}

/** The list's size: the NATIVE content height (it includes the container padding) and its viewport. */
export type ListSize = Pick<ScrollMetrics, "content" | "viewport">;

/** One follow step: the next state, and the offset to scroll to (null: stay). */
export interface FollowStep {
  readonly state: Follow;
  readonly scrollTo: number | null;
  /**
   * Whether the scroll is animated. The INITIAL landing of an attach is not
   * (docs/fix/mobile-open-at-end.md, item 1): a long history would otherwise be
   * seen scrolling through the whole transcript. Everything after it is.
   */
  readonly animated: boolean;
}

/**
 * The TRUE end: the native content height minus the viewport, clamped at 0.
 * Not RN's `scrollToEnd`, whose target is the last CELL's end (estimated until
 * measured) and leaves out the container's bottom padding — a constant 16 pt
 * short (docs/fix/mobile-chat-glitches.md, bug 3).
 */
export function endOffset(m: ListSize): number {
  return Math.max(0, m.content - m.viewport);
}

/** The end to scroll to, or null while either size is still unknown (0 before the first layout). */
export function endTarget(m: ListSize): number | null {
  return m.content > 0 && m.viewport > 0 ? endOffset(m) : null;
}

/** The content grew (a delta, a row): scroll to the end, or mark it unseen. */
export function contentGrew(state: Follow, m: ListSize): FollowStep {
  if (state.following) {
    return { state, scrollTo: endTarget(m), animated: true };
  }
  return {
    state: state.unseen ? state : { following: false, unseen: true },
    scrollTo: null,
    animated: true,
  };
}

/**
 * The list's VIEWPORT changed (a header bar, a notice or the composer grew): the
 * end moved with no content change. Following → scroll to the new end; not
 * following → stay, and nothing is "unseen" (no content arrived).
 */
export function viewportChanged(state: Follow, m: ListSize): FollowStep {
  return { state, scrollTo: state.following ? endTarget(m) : null, animated: true };
}

/** The pill's tap: back to the end, following again. */
export function jumped(): Follow {
  return initialFollow;
}

/**
 * The INITIAL landing (docs/fix/mobile-open-at-end.md, item 1): a long history
 * must be at its END before it is ever seen, with no visible scroll and no
 * animation. `contentGrew` cannot do it alone: a `FlatList` renders the first
 * cells only, so its content height (and hence the end) keeps moving as the
 * silent scroll renders more — the landing repeats, each time not animated,
 * until a measurement changes nothing, and the list is hidden until then.
 *
 * Pure and React-free (AGENTS §7): the screen owns the ref, the hide and the
 * scroll.
 */
export interface Landing {
  /** Still landing: the list is laid out (and scrolled) but not yet shown. */
  readonly settling: boolean;
  /** The next scroll is not animated (a re-attach, whose rows are already shown). */
  readonly silent: boolean;
  /** The content height of the previous measurement (0: none yet). */
  readonly last: number;
  /** How many measurements this landing has taken. */
  readonly rounds: number;
  /**
   * The reveal timer fired with NOTHING to land yet (a slow attach), so the empty
   * state was seen: the rows that finally arrive hide again for their landing
   * rather than appearing at the TOP. Never set on a re-attach.
   */
  readonly awaiting: boolean;
}

/** A fresh screen's landing: hidden until the end stops moving. */
export const landingStart: Landing = {
  settling: true,
  silent: true,
  last: 0,
  rounds: 0,
  awaiting: false,
};

/**
 * A RE-ATTACH (a resync, a Retry, a foreground resync): the rows are already
 * shown, so nothing is hidden — but the jump to the end must not be animated
 * either, or the person watches the transcript scroll past again.
 */
export const landingQuiet: Landing = {
  settling: false,
  silent: true,
  last: 0,
  rounds: 0,
  awaiting: false,
};

/** Nothing pending: the ordinary follow rules apply. */
export const landingDone: Landing = {
  settling: false,
  silent: false,
  last: 0,
  rounds: 0,
  awaiting: false,
};

/**
 * The reveal timer fired with nothing to land yet (a slow attach): the empty
 * state was seen, so the list is SHOWN now — and the rows that finally arrive
 * hide it again for their own silent landing (`awaiting`).
 */
export const landingAwaiting: Landing = {
  settling: false,
  silent: true,
  last: 0,
  rounds: 0,
  awaiting: true,
};

/**
 * How many measurements a landing may take before the list is shown anyway: a
 * content height that never repeats (a streaming turn, a thumbnail landing)
 * must never leave the transcript invisible.
 */
export const LANDING_ROUNDS = 12;

/**
 * One measurement while a landing is pending: the next landing state and the
 * (never animated) scroll to the end, or `step: null` when there is nothing to
 * land (already done, sizes unknown, or the person is reading further up —
 * a foreground resync must never yank them to the end).
 *
 * `hasRows` is whether there is anything TO land (Review round 2, HIGH): while an
 * OPENING landing has no rows yet, the measurement is the empty list's, and a
 * content container with `flexGrow: 1` reports about the VIEWPORT — so it must
 * not count as a landing round. Counting it made a slow attach look settled
 * (`landingReveal` then found `content > 0`) and the history that finally arrived
 * went through `contentGrew` ANIMATED: a visible scroll through the whole
 * transcript, the owner's original complaint. A re-attach's rows are already up,
 * so it never passes `false`.
 */
export function landingStep(
  state: Landing,
  m: ListSize,
  following: boolean,
  hasRows: boolean,
): { readonly state: Landing; readonly step: FollowStep | null } {
  if (!state.settling && !state.silent) {
    return { state, step: null };
  }
  if (!following) {
    // Scrolled up and reading: show the list as it is and stay where they are.
    return { state: landingDone, step: null };
  }
  if (m.content <= 0 || m.viewport <= 0) {
    return { state, step: null }; // nothing measured yet: nothing to land
  }
  if (!hasRows) {
    // The empty state's measurement: there is no end to land at yet, and it must
    // not be mistaken for one (its height is the viewport's, not a transcript's).
    return { state, step: null };
  }
  const rounds = state.rounds + 1;
  const next: Landing = {
    settling:
      (state.settling || state.awaiting) && m.content !== state.last && rounds < LANDING_ROUNDS,
    silent: false,
    last: m.content,
    rounds,
    awaiting: false,
  };
  return {
    state: next,
    step: { state: initialFollow, scrollTo: endOffset(m), animated: false },
  };
}

/**
 * How long a hidden landing waits after its last scroll before it is REVEALED
 * (Review round 1, HIGH 1). `settling` used to end only on a REPEATED content
 * height, and React Native fires `onContentSizeChange`/`onLayout` only when a
 * size CHANGES — so on a short session (one to three distinct heights) the
 * repeat never arrives and the transcript stayed at `opacity: 0` for ever. The
 * screen re-arms this timer on every landing scroll, so the list is shown once
 * the measurements have gone quiet — a signal that DOES arrive.
 */
export const LANDING_REVEAL_MS = 120;

/**
 * The timer's step: the measurements have gone quiet for `LANDING_REVEAL_MS`, so
 * the list is SHOWN (whatever is still unknown is not worth an invisible
 * transcript) and its final landing — silent, so it is not seen moving — is
 * performed at the sizes known NOW. Nothing is pending → nothing happens.
 *
 * The person reading further up is never yanked: not following → reveal in
 * place, no scroll (`landingDone`, like `landingStep`'s own early exit).
 *
 * `hasRows` decides "nothing to land YET" (Review round 2, HIGH): a slow attach
 * leaves the empty list on screen, and `flexGrow: 1` gives it about the viewport's
 * height — a `content > 0` test saw that as a landed transcript, revealed as
 * settled, and the history that then arrived was scrolled in ANIMATED. Only the
 * rows (or a status that is no longer `opening`) can say whether a landing has
 * anything to land.
 */
export function landingReveal(
  state: Landing,
  m: ListSize,
  following: boolean,
  hasRows: boolean,
): { readonly state: Landing; readonly step: FollowStep | null } {
  if (!state.settling) {
    return { state, step: null };
  }
  if (!following) {
    return { state: landingDone, step: null };
  }
  if (m.content <= 0 || m.viewport <= 0 || !hasRows) {
    // Nothing to land yet (a screen still being laid out, or an attach slower
    // than the timer): show the empty state, and hide again when the rows arrive.
    return { state: landingAwaiting, step: null };
  }
  return {
    state: landingDone,
    step: { state: initialFollow, scrollTo: endOffset(m), animated: false },
  };
}

/**
 * The landing to arm for a RE-ATTACH: a pull, a Retry, a Reopen, and a
 * FOREGROUND RETURN (Review round 1, MEDIUM 3 — its resync lands through the
 * same path). Following → the jump to the end is silent but nothing is hidden;
 * reading further up → nothing lands at all.
 */
export function reattachLanding(following: boolean): Landing {
  return following ? landingQuiet : landingDone;
}

/**
 * "Show in chat" (docs/feat/mobile-chrome.md S9): the list scrolled to an older
 * row for the person, so it stops following — the next delta must not pull it
 * back to the end; the pill takes them there.
 */
export function shown(): Follow {
  return { following: false, unseen: false };
}

/** The "Jump to latest" pill shows whenever the list is not following. */
export function jumpPill(state: Follow): boolean {
  return !state.following;
}
