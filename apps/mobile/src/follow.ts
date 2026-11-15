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
    return { state, scrollTo: endTarget(m) };
  }
  return { state: state.unseen ? state : { following: false, unseen: true }, scrollTo: null };
}

/**
 * The list's VIEWPORT changed (a header bar, a notice or the composer grew): the
 * end moved with no content change. Following → scroll to the new end; not
 * following → stay, and nothing is "unseen" (no content arrived).
 */
export function viewportChanged(state: Follow, m: ListSize): FollowStep {
  return { state, scrollTo: state.following ? endTarget(m) : null };
}

/** The pill's tap: back to the end, following again. */
export function jumped(): Follow {
  return initialFollow;
}

/** The "Jump to latest" pill shows whenever the list is not following. */
export function jumpPill(state: Follow): boolean {
  return !state.following;
}
