/**
 * The escape suite's probe listener (docs/feat/model-artifacts.md T8.1, flow 30).
 *
 * The hostile fixture (`fixtures/escape.html`) aims EVERY probe at one URL —
 * `__PROBE__?p=<name>` — so this server is the only thing that can answer the
 * question the suite asks: did the artifact reach the network? A screen claim ("the
 * viewer says network off") proves nothing; a recorded hit proves an escape, and
 * its absence (with `EXPECT=none`) proves the CP + navigation block held for that
 * open. One probe (the fetch) must arrive after "Allow network", which is what
 * makes the first check non-vacuous (`30-escape-hits.js`).
 *
 * Pure and injectable: a flow test drives it over real HTTP on loopback, and the
 * harness starts it once per run. A probe whose name is empty is recorded as
 * `"unnamed"` — never dropped, or a silent probe would read as "blocked".
 */
export interface ProbeListener {
  /** `http://127.0.0.1:<port>`: what the fixture's `__PROBE__` is replaced with. */
  readonly url: string;
  /** Every probe that arrived, in order, by its `?p=<name>`. */
  readonly hits: () => readonly string[];
  /** A flow ended or restarted: forget what was seen (each open has its own). */
  reset(): void;
  stop(): void;
}

export function startProbeListener(): ProbeListener {
  let seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url);
      // A WebSocket upgrade and an ordinary GET both land here, and both ARE the
      // escape: recording the REQUEST is the whole point (nothing is answered
      // with a WebSocket, so a page cannot use this to talk back).
      seen = [...seen, url.searchParams.get("p") ?? "unnamed"];
      return new Response("probe", { headers: { "content-type": "text/plain" } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    hits: () => seen,
    reset: () => {
      seen = [];
    },
    stop: () => server.stop(true),
  };
}

/**
 * The fixture's bytes with `__PROBE__` replaced by a real listener address. The
 * fixture on disk keeps the placeholder, so the escape suite never embeds a port
 * (one run's 54321 is the next run's something else).
 */
export function escapeFixture(html: string, probeUrl: string): string {
  return html.split("__PROBE__").join(probeUrl);
}
