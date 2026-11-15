/**
 * docs/feat/mobile-notifications.md Design 7 / slice N7: an Open tap's
 * destination comes from the plaintext the APP opened, never from the
 * notification's relay-visible hints.
 */
import { describe, expect, test } from "bun:test";
import type { PushMessage } from "@tentacle/protocol";
import { presentFromHints, shouldPresent } from "../src/foreground-presentation.ts";
import { notificationRoute } from "../src/notification-route.ts";

const opened = (over: { computer?: string; sessionId?: string; title?: string } = {}) => ({
  computer: { id: over.computer ?? "c1" },
  message: {
    sessionId: over.sessionId ?? "s1",
    title: over.title ?? "Fix the failing test",
  },
});

const known = (
  over: {
    has?: (id: string) => boolean;
    title?: string;
    archived?: boolean;
  } = {},
) => ({
  has: over.has ?? (() => true),
  title: () => over.title,
  archived: () => over.archived === true,
});

describe("notificationRoute", () => {
  test("a verified notification opens its session, with the plaintext's title", () => {
    expect(notificationRoute(opened(), known())).toEqual({
      computerId: "c1",
      sessionId: "s1",
      title: "Fix the failing test",
      archived: false,
    });
  });

  test("a notification that does not open lands on the computers list (F5)", () => {
    // Mutation: trust `userInfo.tn` for the route → a hostile relay picks the
    // session the app opens.
    expect(notificationRoute(undefined, known())).toBe("computers");
  });

  test("a computer this phone no longer holds lands on the list (F9)", () => {
    expect(notificationRoute(opened({ computer: "gone" }), known({ has: () => false }))).toBe(
      "computers",
    );
  });

  test("the store's title fills in when the plaintext's is empty; archived rides along", () => {
    expect(
      notificationRoute(opened({ title: "" }), known({ title: "Renamed later", archived: true })),
    ).toEqual({
      computerId: "c1",
      sessionId: "s1",
      title: "Renamed later",
      archived: true,
    });
  });
});

const message = (over: Partial<PushMessage> = {}): PushMessage =>
  ({
    v: 1,
    id: "0123456789abcdef0123456789abcdef",
    at: 1,
    kind: "ask",
    computer: "c1",
    cwd: "/home/me/repo",
    sessionId: "s1",
    title: "t",
    ...over,
  }) as PushMessage;

describe("shouldPresent (the foreground handler)", () => {
  test("foreground on that very session: no banner (the sheet already asks)", () => {
    // Mutation: always present → the person is asked twice for one command, and
    // the second one is a notification they can answer by accident.
    expect(shouldPresent(message(), { kind: "session", computerId: "c1", sessionId: "s1" })).toBe(
      false,
    );
  });

  test("another session, or another screen: show it", () => {
    expect(shouldPresent(message(), { kind: "session", computerId: "c1", sessionId: "s2" })).toBe(
      true,
    );
    expect(shouldPresent(message(), { kind: "session", computerId: "c2", sessionId: "s1" })).toBe(
      true,
    );
    expect(shouldPresent(message(), { kind: "other" })).toBe(true);
  });

  test("an unverifiable notification is always shown (never a silent drop)", () => {
    // It cannot be answered, but the person must see that something arrived
    // (decision 8: "never a silent loss").
    expect(shouldPresent(undefined, { kind: "session", computerId: "c1", sessionId: "s1" })).toBe(
      true,
    );
  });
});

// docs/feat/mobile-notifications.md Design 7: the foreground handler reads only
// the routing HINTS (it cannot decrypt), and shows unless it is on that session.
describe("presentFromHints (the handler's decision)", () => {
  const onSession = { kind: "session" as const, computerId: "c1", sessionId: "s1" };

  test("no hints: shown (never a silent drop)", () => {
    expect(presentFromHints({}, onSession)).toBe(true);
    expect(presentFromHints(null, onSession)).toBe(true);
    expect(presentFromHints({ tn: "not an object" }, onSession)).toBe(true);
  });

  test("on that very session: hidden; another session: shown", () => {
    expect(presentFromHints({ tn: { computerId: "c1", sessionId: "s1" } }, onSession)).toBe(false);
    expect(presentFromHints({ tn: { computerId: "c1", sessionId: "s2" } }, onSession)).toBe(true);
    // A hostile relay's hints can at most HIDE a banner for a session it names:
    // it cannot make the app answer anything (Design 3), and the person still
    // sees the sheet when they open the app.
    expect(presentFromHints({ tn: { computerId: "c1", sessionId: "s1" } }, { kind: "other" })).toBe(
      true,
    );
  });
});
