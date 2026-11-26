/**
 * The apps host's socket (docs/feat/session-apps-host.md): route by `Host`, run
 * the signed-request pipeline, hand every decision to `HostCore` and apply what
 * it decided to the store. Policy lives in the pure modules (AGENTS §7).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APPS_API_VERSION, APPS_HEADERS, APPS_TUNNEL_PING_MS, isAppId } from "@tentacle/protocol";
import { clientIpOf, limiterKeyOf } from "@tentacle/relay/client-ip";
import { createLogLimiter } from "@tentacle/relay/log-limit";
import { type RandomBytes, hostRoute } from "./app-id.ts";
import { BODY_RETRY_MS, BodyBudget, declaredLength } from "./body-budget.ts";
import { HostCore, type Reservation, type Reserved } from "./host-core.ts";
import { APPS_LIMITS, type AppsLimits } from "./limits.ts";
import { type LiveSocket, type SocketData, createLive } from "./live-server.ts";
import type { LiveTunnels } from "./live-tunnels.ts";
import {
  type OperatorFileName,
  type OperatorFileRead,
  createOperatorFiles,
} from "./operator-files.ts";
import {
  COMMON_HEADERS,
  FRAME_PATH,
  REPORT_CONTACT_MAX,
  REPORT_DETAILS_MAX,
  REPORT_REASONS,
  appResponseHeaders,
  createPages,
  framedAppResponseHeaders,
  isFrameRequest,
  visitorView,
} from "./pages.ts";
import { readBody } from "./read-body.ts";
import type { Effect } from "./records.ts";
import { NOTICE_STATUS, type Refused, errorResponse, pageResponse, text } from "./respond.ts";
import { type ControlRoute, ERROR_STATUS, controlRoute } from "./routes.ts";
import {
  NonceGuard,
  type SignedHeaders,
  checkSignedHeaders,
  sha256Hex,
  verifySignedBody,
} from "./signed-request.ts";
import type { Store } from "./store.ts";

/** Loopback: Caddy terminates TLS in front of the host. */
export const DEFAULT_APPS_HOST = "127.0.0.1";
export const DEFAULT_APPS_PORT = 4200;
/** A report form with every field full, urlencoded, fits well inside. */
const MAX_REPORT_BYTES = 64 * 1024;
const ROBOTS = "User-agent: *\nDisallow: /\n";
const HTML_TYPE = /^text\/html(\s*;\s*charset\s*=\s*"?utf-8"?)?$/i;

export interface AppsHostOptions {
  readonly domain: string;
  readonly abuseEmail: string;
  readonly termsUrl: string;
  readonly store: Store;
  readonly readOperatorFile: (name: OperatorFileName) => OperatorFileRead;
  readonly host?: string;
  readonly port?: number;
  readonly limits?: Partial<AppsLimits>;
  readonly now?: () => number;
  readonly random?: RandomBytes;
  readonly onLog?: (line: string) => void;
  /** Read `X-Forwarded-For` from a loopback peer (required behind Caddy). */
  readonly trustProxy?: boolean;
}

export interface RunningAppsHost {
  readonly url: string;
  readonly port: number;
  /** Run one sweep now (a test drives time instead of waiting for a tick). */
  sweep(): Promise<void>;
  /** The core, for a test's assertions about state. */
  readonly core: HostCore;
  /** The connected tunnels of live apps (a test's assertions). */
  readonly tunnels: LiveTunnels;
  /** Stop serving, let writes finish, take a last snapshot. */
  stop(): Promise<void>;
}

/** The operator directory's files, as `operator-files.ts` reads them. */
export function fileReader(dir: string): (name: OperatorFileName) => OperatorFileRead {
  return (name) => {
    try {
      return { kind: "text", text: readFileSync(join(dir, name), "utf8") };
    } catch (error) {
      return (error as { code?: unknown }).code === "ENOENT"
        ? { kind: "absent" }
        : { kind: "error" };
    }
  };
}

const errno = (error: unknown): string => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : "unknown";
};

/** What is read of a request's URL. */
interface RequestUrl {
  readonly pathname: string;
  readonly search: string;
  readonly searchParams: { get(name: string): string | null };
}

function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export async function startAppsHost(options: AppsHostOptions): Promise<RunningAppsHost> {
  const domain = options.domain.toLowerCase();
  const now = options.now ?? (() => Date.now());
  const limits: AppsLimits = { ...APPS_LIMITS, ...options.limits };
  const { store } = options;

  const limiter = createLogLimiter({ now });
  const write = options.onLog ?? (() => {});
  const log = (line: string): void => {
    if (limiter.admit(line)) {
      write(line);
    }
  };

  const operator = createOperatorFiles({
    read: options.readOperatorFile,
    now,
    staleMs: limits.operatorStaleMs,
    log,
  });
  const core = new HostCore({
    limits,
    now,
    random: options.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n))),
    operator: () => operator.current(),
  });
  const pages = createPages({
    domain,
    abuseEmail: options.abuseEmail,
    termsUrl: options.termsUrl,
  });
  const nonces = new NonceGuard({
    max: limits.maxTrackedNonces,
    skewMs: limits.skewMs,
    reservePerApp: limits.reservedNoncesPerApp,
  });
  const budget = new BodyBudget({
    maxBytes: limits.maxInFlightBodyBytes,
    maxPerIp: limits.maxUploadsPerIp,
  });

  // ── the store, one writer per id ──────────────────────────────────────────

  /** The tail of each id's writes: they reach the disk in the order decided. */
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(id: string, task: () => Promise<T>): Promise<T> => {
    const result = (queues.get(id) ?? Promise.resolve()).then(task);
    const tail = result
      .catch(() => {})
      .then(() => {
        if (queues.get(id) === tail) {
          queues.delete(id);
        }
      });
    queues.set(id, tail);
    return result;
  };

  const runEffect = (effect: Effect): Promise<void> =>
    effect.type === "writeRecord"
      ? store.writeRecord(effect.record)
      : effect.type === "removeContent"
        ? store.removeContent(effect.id, effect.sha256)
        : store.removeRecord(effect.id);

  /** Run effects in order (inside an id's turn). `false`: at least one failed. */
  const runEffects = async (effects: readonly Effect[]): Promise<boolean> => {
    let all = true;
    for (const effect of effects) {
      try {
        await runEffect(effect);
      } catch (error) {
        all = false;
        log(`store-error ${effect.type} ${errno(error)}`);
      }
    }
    return all;
  };

  /** Queue each id's effects, synchronously, before anything else is decided. */
  const apply = async (effects: readonly Effect[]): Promise<boolean> => {
    const byId = new Map<string, Effect[]>();
    for (const effect of effects) {
      byId.set(effect.id, [...(byId.get(effect.id) ?? []), effect]);
    }
    const done = await Promise.all([...byId].map(([id, own]) => serial(id, () => runEffects(own))));
    return done.every(Boolean);
  };

  let snapshotAt = now();
  const saveSnapshot = (): Promise<void> => {
    snapshotAt = now();
    return serial("leases", async () => {
      try {
        await store.writeSnapshot(core.snapshot());
      } catch (error) {
        log(`snapshot-failed ${errno(error)}`);
      }
    });
  };

  /** Nothing signed before this instant is accepted: the nonce cache starts empty. */
  let startedAt = Number.POSITIVE_INFINITY;
  const live = createLive({
    domain,
    limits,
    now,
    core,
    pages,
    nonces,
    startedAt: () => startedAt,
    log,
  });

  const sweepOnce = async (): Promise<void> => {
    live.keepConnected();
    const swept = core.sweep();
    for (const id of swept.expired) {
      log(`expire ${id}`);
    }
    for (const { id, reason } of swept.takenDown) {
      log(`takedown ${id} ${reason}`);
    }
    live.sweep();
    await apply(swept.effects);
    nonces.prune(now());
    try {
      await store.pruneReports(now() - limits.reportRetentionMs);
    } catch (error) {
      log(`store-error pruneReports ${errno(error)}`);
    }
    if (now() - snapshotAt >= limits.snapshotMs) {
      await saveSnapshot();
    }
    for (const line of limiter.flush()) {
      write(line);
    }
  };
  let sweeping: Promise<void> = Promise.resolve();
  let pendingSweeps = 0;
  const sweep = (): Promise<void> => {
    pendingSweeps += 1;
    const result = sweeping.then(sweepOnce).finally(() => {
      pendingSweeps -= 1;
    });
    sweeping = result.catch((error) => log(`sweep-failed ${errno(error)}`));
    return result;
  };

  // ── the API ───────────────────────────────────────────────────────────────

  const freeBytes = async (): Promise<number> => {
    try {
      return await store.freeBytes();
    } catch (error) {
      // Unknown free space is no free space.
      log(`store-error freeBytes ${errno(error)}`);
      return 0;
    }
  };

  /** Write a reserved publication, then commit it. A live app has no bytes. */
  const publishBytes = (
    reservation: Reservation,
    bytes: Uint8Array | undefined,
    done: { status: number; line: string },
  ): Promise<Response | Refused> => {
    const { record } = reservation;
    return serial(record.id, async () => {
      try {
        if (bytes !== undefined) {
          await store.writeContent(record.id, record.sha256, bytes);
        }
        await store.writeRecord(record);
      } catch (error) {
        log(`store-error publish ${errno(error)}`);
        await runEffects(core.release(reservation));
        return errno(error) === "ENOSPC"
          ? { error: "storage_full" as const, message: "the host's disk is full" }
          : { error: "internal" as const, message: "the host could not store the app" };
      }
      const committed = core.commit(reservation);
      await runEffects(committed.effects);
      if (!committed.ok) {
        return committed;
      }
      log(done.line);
      return Response.json(
        { ...committed.lease, url: `https://${record.id}.${domain}/` },
        { status: done.status, headers: COMMON_HEADERS },
      );
    });
  };

  /**
   * Read at most `max` body bytes, holding their share of the budget until `use`
   * is done with them. The ONLY way a body is read; `tooLong` is the answer to a
   * longer one.
   */
  const withBody = async <T>(
    req: Request,
    ip: string,
    max: number,
    tooLong: Refused,
    use: (body: Uint8Array) => Promise<T>,
  ): Promise<T | Refused> => {
    const declared = declaredLength(req.headers);
    if (declared !== "unknown" && declared > max) {
      return tooLong;
    }
    const share = budget.admit(limiterKeyOf(ip), declared === "unknown" ? max : declared);
    if (!share.ok) {
      return share;
    }
    try {
      const read = await readBody(req.body, max, limits.uploadTimeoutMs);
      if (read.ok) {
        return await use(read.body);
      }
      if (read.why === "too_long") {
        return tooLong;
      }
      return read.why === "timeout"
        ? {
            error: "busy",
            message: "the body took too long to arrive",
            retryAfterMs: BODY_RETRY_MS,
          }
        : { error: "bad_request", message: "the body could not be read" };
    } finally {
      share.release();
    }
  };

  type ApiRoute = Extract<
    ControlRoute,
    { kind: "create" | "create_live" | "update" | "renew" | "delete" }
  >;

  /** Cheap checks before crypto, crypto before any state. */
  const handleApi = async (
    route: ApiRoute,
    req: Request,
    url: RequestUrl,
    ip: string,
  ): Promise<Response | Refused> => {
    const publishing = route.kind === "create" || route.kind === "update";
    const renewal =
      route.kind === "renew"
        ? { key: req.headers.get(APPS_HEADERS.key) ?? "", id: route.id }
        : undefined;
    const early =
      (publishing || route.kind === "create_live" ? core.refusalIfKilled() : undefined) ??
      refusalOf(core.admitApi(limiterKeyOf(ip), renewal));
    if (early !== undefined) {
      return early;
    }
    if (url.search !== "" || req.url.includes("?")) {
      return { error: "bad_request", message: "the API takes no query" };
    }
    const shape = checkSignedHeaders(req.headers, {
      now: now(),
      startedAt,
      skewMs: limits.skewMs,
    });
    if (!shape.ok) {
      return shape;
    }
    const tooLong: Refused = publishing
      ? { error: "too_large", message: `an app may be at most ${limits.maxAppBytes} bytes` }
      : { error: "bad_request", message: "this call takes no body" };
    return withBody(req, ip, publishing ? limits.maxAppBytes : 0, tooLong, (body) =>
      handleSigned(route, req, url.pathname, ip, shape.request, body),
    );
  };

  /** A signed request whose body has arrived. */
  const handleSigned = async (
    route: ApiRoute,
    req: Request,
    path: string,
    ip: string,
    request: SignedHeaders,
    body: Uint8Array,
  ): Promise<Response | Refused> => {
    const { key } = request;
    const renewing =
      route.kind === "renew" && core.renewable({ key, id: route.id }) ? route.id : undefined;
    const verified = await verifySignedBody(request, {
      method: req.method,
      path,
      domain,
      body,
      nonces,
      now: now(),
      ...(renewing === undefined ? {} : { reserveFor: renewing }),
    });
    if (!verified.ok) {
      return verified;
    }
    const admitted = core.admitSigned(key, renewing !== undefined);
    if (!admitted.ok) {
      if (admitted.error === "blocked") {
        log(`blocked-key ${key.slice(0, 8)}`);
      }
      return admitted;
    }
    if (route.kind === "create_live") {
      const reserved = core.reserveCreateLive({ key, ip: limiterKeyOf(ip) });
      if (!reserved.ok) {
        return reserved;
      }
      const { reservation } = reserved;
      return publishBytes(reservation, undefined, {
        status: 201,
        line: `publish-live ${reservation.record.id} key ${key.slice(0, 8)} ip ${ip}`,
      });
    }
    if (route.kind === "create" || route.kind === "update") {
      if (!HTML_TYPE.test((req.headers.get("content-type") ?? "").trim())) {
        return { error: "unsupported_media", message: "send text/html in UTF-8" };
      }
      if (body.length === 0 || utf8(body) === undefined) {
        return { error: "malformed", message: "the app must be non-empty valid UTF-8" };
      }
      const publication = {
        key,
        sha256: await sha256Hex(body),
        bytes: body.length,
        freeBytes: await freeBytes(),
      };
      const revive = route.kind === "update" && core.record(route.id)?.state !== "live";
      const reserved: Reserved =
        route.kind === "create"
          ? core.reserveCreate({ ...publication, ip: limiterKeyOf(ip) })
          : core.reserveUpdate({ ...publication, id: route.id });
      if (!reserved.ok) {
        return reserved;
      }
      const { reservation } = reserved;
      const verb = route.kind === "create" ? "publish" : revive ? "revive" : "update";
      return publishBytes(reservation, body, {
        status: route.kind === "create" ? 201 : 200,
        line: `${verb} ${reservation.record.id} key ${key.slice(0, 8)} ip ${ip} bytes ${body.length}`,
      });
    }
    if (route.kind === "renew") {
      const renewed = core.renew({ key, id: route.id });
      return renewed.ok
        ? Response.json(
            { ...renewed.lease, url: `https://${route.id}.${domain}/` },
            { headers: COMMON_HEADERS },
          )
        : renewed;
    }
    const deleted = core.delete({ key, id: route.id });
    if (!deleted.ok) {
      return deleted;
    }
    live.tunnels.end(route.id, "deleted");
    if (!(await apply(deleted.effects))) {
      return { error: "internal", message: "the host could not finish; retry" };
    }
    log(`delete ${route.id}`);
    return new Response(null, { status: 204, headers: COMMON_HEADERS });
  };

  const handleReport = async (req: Request, ip: string): Promise<Response> => {
    const type = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/x-www-form-urlencoded") {
      return pageResponse(pages.reportRefused(), 415);
    }
    const answer = await withBody(
      req,
      ip,
      MAX_REPORT_BYTES,
      { error: "too_large", message: "the report is too long" },
      (body) => fileReport(body, ip),
    );
    if (answer instanceof Response) {
      return answer;
    }
    log(`refused ${answer.error} ip ${ip}`);
    return pageResponse(pages.reportRefused(), ERROR_STATUS[answer.error]);
  };

  const fileReport = async (body: Uint8Array, ip: string): Promise<Response> => {
    const fields = new URLSearchParams(utf8(body) ?? "");
    const field = (name: string): string => (fields.get(name) ?? "").replaceAll("\r\n", "\n");
    const app = field("app").trim().toLowerCase();
    const reason = field("reason");
    const details = field("details");
    const contact = field("contact");
    if (!isAppId(app)) {
      return pageResponse(pages.notice("unknown"), 404);
    }
    if (
      !(REPORT_REASONS as readonly string[]).includes(reason) ||
      details.length > REPORT_DETAILS_MAX ||
      contact.length > REPORT_CONTACT_MAX
    ) {
      return pageResponse(pages.reportRefused(), 400);
    }
    const admitted = core.admitReport(limiterKeyOf(ip), app);
    if (!admitted.ok) {
      log(`refused ${admitted.error} ip ${ip}`);
      return admitted.error === "not_found"
        ? pageResponse(pages.notice("unknown"), 404)
        : pageResponse(pages.reportRefused(), ERROR_STATUS[admitted.error]);
    }
    try {
      await store.appendReport({ at: now(), ip, app, reason, details, contact });
    } catch (error) {
      log(`store-error report ${errno(error)}`);
      return pageResponse(pages.reportRefused(), 503);
    }
    log(`report ${app} ${reason} ip ${ip}`);
    return new Response(null, {
      status: 303,
      headers: { ...COMMON_HEADERS, Location: "/report/thanks" },
    });
  };

  const answered = (answer: Response | Refused, ip: string): Response => {
    if (answer instanceof Response) {
      return answer;
    }
    log(`refused ${answer.error} ip ${ip}`);
    return errorResponse(answer);
  };

  const handleControl = async (
    req: Request,
    url: RequestUrl,
    ip: string,
    server: Parameters<typeof live.upgrade>[4],
  ): Promise<Response | undefined> => {
    const route = controlRoute(req.method, url.pathname);
    switch (route.kind) {
      case "health":
        // No counters: a public endpoint says nothing about its size.
        return Response.json({ ok: true, v: APPS_API_VERSION }, { headers: COMMON_HEADERS });
      case "info":
        return pageResponse(pages.info());
      case "report_form":
        return pageResponse(pages.report(url.searchParams.get("app") ?? undefined));
      case "thanks":
        return pageResponse(pages.thanks());
      case "robots":
        return text(ROBOTS);
      case "report":
        return handleReport(req, ip);
      case "method_not_allowed":
        return text("method not allowed", 405, { Allow: route.allow });
      case "not_found":
        return text("not found", 404);
      case "tunnel": {
        const answer = await live.upgrade(route.id, req, url, ip, server);
        return answer === undefined ? undefined : answered(answer, ip);
      }
      default:
        return answered(await handleApi(route, req, url, ip), ip);
    }
  };

  const handleApp = async (req: Request, url: RequestUrl, id: string): Promise<Response> => {
    if (url.pathname !== "/" && url.pathname !== "/robots.txt" && url.pathname !== FRAME_PATH) {
      return text("not found", 404);
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return text("method not allowed", 405, { Allow: "GET, HEAD" });
    }
    if (url.pathname === "/robots.txt") {
      return text(ROBOTS);
    }
    const view = core.view(id);
    if (view.kind !== "app") {
      // A live app never comes here (`fetch` sends it to the tunnel).
      const kind = view.kind === "live" ? "unknown" : view.kind;
      return pageResponse(pages.notice(kind), NOTICE_STATUS[kind]);
    }
    // The framed copy, behind the warning dialog: only for the wrapper's own
    // iframe. Top level, another origin or no Fetch Metadata: nothing.
    const framed = url.pathname === FRAME_PATH;
    if (framed && !isFrameRequest(req.headers)) {
      return text("not found", 404, { Vary: appResponseHeaders().Vary ?? "" });
    }
    if (!framed && visitorView(req.headers) === "warning") {
      const warning = pages.warning(id);
      return new Response(warning.body, {
        headers: { ...warning.headers, Vary: appResponseHeaders().Vary ?? "" },
      });
    }
    if (req.method === "GET") {
      core.countServed(id, view.bytes);
    }
    const content = await store.content(view.id, view.sha256);
    if (content === undefined) {
      log("store-error content ENOENT");
      return pageResponse(pages.notice("offline"), NOTICE_STATUS.offline);
    }
    return new Response(content, {
      headers: framed ? framedAppResponseHeaders() : appResponseHeaders(),
    });
  };

  // ── start ─────────────────────────────────────────────────────────────────

  const loaded = await store.load();
  for (const problem of loaded.problems) {
    log(`load ${problem}`);
  }
  const restored = core.restore(loaded);
  for (const id of restored.expired) {
    log(`expire ${id}`);
  }
  await apply(restored.effects);
  await saveSnapshot();
  startedAt = now();

  const server = Bun.serve<SocketData>({
    hostname: options.host ?? DEFAULT_APPS_HOST,
    port: options.port ?? DEFAULT_APPS_PORT,
    maxRequestBodySize: limits.maxAppBytes,
    development: false,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const route = hostRoute(req.headers.get("host"), domain);
      if (route.kind === "unknown") {
        return text("not found", 404);
      }
      if (route.kind === "app" && core.record(route.id)?.kind !== "live") {
        return handleApp(req, url, route.id);
      }
      const peer = (srv as unknown as PeerAddressable).requestIP(req)?.address ?? "";
      const ip = clientIpOf({
        peer,
        forwardedFor: req.headers.get("x-forwarded-for"),
        trustProxy: options.trustProxy === true,
      });
      return route.kind === "app"
        ? live.visit(route.id, req, url, ip, srv)
        : handleControl(req, url, ip, srv);
    },
    websocket: {
      ...live.socketOptions,
      open(ws) {
        live.websocket.open(ws as unknown as LiveSocket);
      },
      message(ws, message) {
        live.websocket.message(ws as unknown as LiveSocket, message);
      },
      drain(ws) {
        live.websocket.drain(ws as unknown as LiveSocket);
      },
      close(ws, code, reason) {
        live.websocket.close(ws as unknown as LiveSocket, code, reason);
      },
    },
    error(error) {
      log(`request-failed ${errno(error)}`);
      return text("internal error", 500);
    },
  });

  const pinger = setInterval(() => live.tunnels.ping(), APPS_TUNNEL_PING_MS);

  const timer = setInterval(() => {
    // A sweep slower than its period is not queued behind itself.
    if (pendingSweeps === 0) {
      void sweep().catch(() => {});
    }
  }, limits.sweepMs);

  let stopped: Promise<void> | undefined;
  return {
    url: `http://${options.host ?? DEFAULT_APPS_HOST}:${server.port}`,
    port: server.port ?? 0,
    core,
    tunnels: live.tunnels,
    sweep,
    stop() {
      stopped ??= (async () => {
        clearInterval(timer);
        clearInterval(pinger);
        live.tunnels.closeAll();
        server.stop(true);
        await sweeping;
        await Promise.all([...queues.values()]);
        await saveSnapshot();
      })();
      return stopped;
    },
  };
}

interface PeerAddressable {
  requestIP(req: Request): { address: string } | null;
}

function refusalOf(gate: { ok: true } | ({ ok: false } & Refused)): Refused | undefined {
  return gate.ok ? undefined : gate;
}
