/**
 * Whether the transcript FOLLOWS the stream (owner B5, 2026-11-15): new content
 * scrolls the list to the end while the person is at the bottom; once they drag
 * up, it stays where they are and a "Jump to latest" pill is offered.
 *
 * Pure and React-free (AGENTS §7): `SessionScreen.tsx` feeds it the list's
 * scroll metrics and content-size changes, and only performs `scrollToEnd`.
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

/** The content grew (a delta, a row): scroll to the end, or mark it unseen. */
export function contentGrew(state: Follow): {
  readonly state: Follow;
  readonly scrollToEnd: boolean;
} {
  if (state.following) {
    return { state, scrollToEnd: true };
  }
  return { state: state.unseen ? state : { following: false, unseen: true }, scrollToEnd: false };
}

/** The pill's tap: back to the end, following again. */
export function jumped(): Follow {
  return initialFollow;
}

/** The "Jump to latest" pill shows whenever the list is not following. */
export function jumpPill(state: Follow): boolean {
  return !state.following;
}
