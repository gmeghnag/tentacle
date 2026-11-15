/**
 * The session's shared auto-accept on ONE client (docs/feat/session-auto-accept.md
 * D4). Pure and React-free (AGENTS §7): `RemoteSession` owns an `AutoAcceptHandle`
 * and exposes its `link`; `permission-ui.ts` / the phone's sheet read the link,
 * and every rule below is tested without a renderer or a socket.
 *
 * What this module is NOT: the DECISION. A requester (`permission-ui.ts`,
 * `permission-sheet.ts`, `relay-policy.ts`) still decides whether an ask may be
 * auto-answered, through `autoApproves`; this only holds the value the session
 * shares, so a daemon can never answer an ask (owner Q1) — it only says what
 * the switch is.
 *
 * Rules:
 * - `set` applies LOCALLY at once, then tells the daemon. OFF must bite on the
 *   device it was pressed on without a round trip, and ON grants the ask
 *   already on screen, exactly as a local Shift+Tab does today.
 * - Every `auto_accept` update is applied in arrival order, OWN ECHOES
 *   INCLUDED: all clients then converge on the daemon's last emitted value
 *   (one emit per change, one total order — P2). A late echo of an older set
 *   cannot flap a client.
 * - A set not yet acknowledged when the link drops is kept as `pendingSet` and
 *   re-sent after re-attach. The re-attach snapshot is adopted only when there
 *   is no `pendingSet`, so a person's OFF made offline is never undone by the
 *   daemon's older ON (AGENTS §7's re-attach rule, narrowed by honesty).
 * - Without a shared link (`shared()` false: an older daemon, or a client
 *   whose trust bit is off) the value is this client's own, in memory, and no
 *   method is ever sent — today's behaviour, unchanged.
 */

/**
 * Where an applied change came from: another client's `auto_accept` update, or
 * the daemon's own snapshot (the open/re-attach that also CONFIRMS sharing).
 * A consumer's "another device flipped it" notice must not fire for a snapshot:
 * an attach is not somebody pressing the switch.
 */
export type AutoAcceptSource = "update" | "snapshot";

/**
 * What a consumer (a TUI, the phone, the routing feed) may do with the session's
 * auto-accept. Nothing here can answer an ask: the requester decides, and its
 * `autoApproves` rule is what stands between this value and a tool call.
 */
export interface AutoAcceptLink {
  /** The value now (the daemon's, or this client's own when not shared). */
  current(): boolean;
  /**
   * Apply a value. Shared: applied locally at once, then sent — a promise of
   * the daemon's answer (a rejection when it did not land). Not shared: sets
   * the local value, sends nothing, returns `undefined`.
   */
  set(on: boolean): Promise<{ on: boolean }> | undefined;
  /**
   * Called on every applied change (from any client, own echoes included) — and
   * ONCE when the daemon first CONFIRMS sharing, even if the value it reports is
   * the one this link already held: a consumer bound before that confirmation
   * (a TUI's routing feed at an attach) must learn the session's value, which an
   * "only on change" notify would never tell it.
   */
  onChange(listener: (on: boolean, source: AutoAcceptSource) => void): () => void;
  /** True iff the daemon behind this session SHARES it (a trusted daemon that said so). */
  shared(): boolean;
  /**
   * Who made the last change, when the daemon named it (display only: untrusted
   * text, so a surface must sanitize it). Absent → nobody named.
   */
  lastBy(): string | undefined;
}

/** The link plus the client's own hooks (never handed to a view). */
export interface AutoAcceptHandle {
  readonly link: AutoAcceptLink;
  /**
   * The daemon's own change (an `auto_accept` update): applied in arrival
   * order, own echoes included, so every client converges on the last value.
   */
  receive(on: boolean, by?: string): void;
  /**
   * The link (re)attached with the daemon's snapshot: adopted unless a set of
   * ours is still unacknowledged (then it is re-sent and wins).
   */
  sync(snapshot: boolean): void;
  /** The link dropped: a set still in flight becomes pending, re-sent by `sync`. */
  dropped(): void;
  /** Back on the link (`recovered`): a pending set goes out again now. */
  recovered(): void;
  /** Who made the last change, when the daemon named it (display only, untrusted text). */
  lastBy(): string | undefined;
}
export interface AutoAcceptHandleOptions {
  /** This daemon shares it (`OpenResult.autoAccept` was present at the open). */
  readonly shared: boolean;
  readonly initial: boolean;
  /** Send the value to the daemon; rejects when it did not land. */
  readonly send: (on: boolean) => Promise<{ on: boolean }>;
}

export function createAutoAcceptHandle(options: AutoAcceptHandleOptions): AutoAcceptHandle {
  let value = options.initial;
  let by: string | undefined;
  /** A set of ours the daemon has not acknowledged (a drop, or a send in flight). */
  let pendingSet: boolean | undefined;
  let inFlight = false;
  /** The daemon said it shares this session (`OpenResult.autoAccept` arrived). */
  let confirmed = false;
  const listeners = new Set<(on: boolean, source: AutoAcceptSource) => void>();

  /**
   * Apply a value. `force`: notify even when the value did not move — used for
   * the ONE confirmation (see `sync`), which is an event of its own.
   */
  const apply = (on: boolean, source: AutoAcceptSource, label?: string, force = false): void => {
    const changed = value !== on;
    value = on;
    if (label !== undefined) by = label;
    if (!changed && !force) {
      return;
    }
    for (const listener of [...listeners]) listener(on, source);
  };

  const sendNow = (on: boolean): Promise<{ on: boolean }> => {
    pendingSet = on;
    inFlight = true;
    const done = (): void => {
      if (pendingSet === on) pendingSet = undefined;
      inFlight = false;
    };
    return options.send(on).then(
      (result) => {
        done();
        return result;
      },
      (error: unknown) => {
        // Unacknowledged: kept, so a re-attach re-sends it rather than
        // adopting the daemon's older value.
        if (pendingSet === on) inFlight = false;
        throw error;
      },
    );
  };

  const link: AutoAcceptLink = {
    current: () => value,
    // Trusted AND confirmed: the bit says this client MAY share, and only the
    // daemon's own snapshot (`OpenResult.autoAccept`, present ⇔ it shares) says
    // it DOES. An older daemon — or one that never answered — leaves this false,
    // so the session keeps a local-only value, exactly as before the feature.
    shared: () => options.shared && confirmed,
    lastBy: () => by,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(on) {
      // Locally at once: OFF bites here, ON grants what is on screen.
      apply(on, "update");
      if (!(options.shared && confirmed)) {
        // Not confirmed yet (the session's first open is still in flight): the
        // person's flip must not be undone by the snapshot that open returns.
        // Kept as pending, so `sync` sends it instead of adopting the older
        // value — the same rule as a set lost to a drop.
        pendingSet = on;
        return undefined;
      }
      return sendNow(on);
    },
  };

  return {
    link,
    lastBy: () => by,
    receive(on, label) {
      apply(on, "update", label);
      if (pendingSet === on) pendingSet = undefined;
    },
    sync(snapshot) {
      // The FIRST snapshot is also the confirmation: a consumer already bound to
      // this link learns the session's value from it even when it matches the
      // local one (`apply`'s `force`), which is the whole "an OFF session binds
      // OFF" rule (session-auto-accept.md Review round 1, HIGH 1). A re-attach
      // of a link that was already confirmed is not one, so it stays silent when
      // nothing moved.
      const confirming = !confirmed;
      confirmed = true;
      if (pendingSet !== undefined) {
        // Ours is not acknowledged: it wins over the daemon's older value, and
        // goes out again (a drop lost the frame, not the person's decision).
        if (!inFlight) void sendNow(pendingSet).catch(() => {});
        return;
      }
      apply(snapshot, "snapshot", undefined, confirming);
    },
    dropped() {
      // A send still in flight is unacknowledged from here on.
      if (inFlight) inFlight = false;
    },
    recovered() {
      // The person's decision outlives the socket: whatever the drop left
      // unacknowledged is re-sent once the link is back (before the re-attach's
      // snapshot, which `sync` then declines to adopt).
      if (pendingSet !== undefined && !inFlight) {
        void sendNow(pendingSet).catch(() => {});
      }
    },
  };
}

/** A link that never shares: this client's own value (a pod, an older daemon). */
export function createLocalAutoAccept(initial = false): AutoAcceptLink {
  return createAutoAcceptHandle({
    shared: false,
    initial,
    send: () => Promise.reject(new Error("auto-accept is not shared by this daemon")),
  }).link;
}
