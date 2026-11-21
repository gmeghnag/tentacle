/**
 * Flow 36's world (docs/feat/mobile-file-preview-cards.md): the LAPTOP runs one
 * turn on this flow's session that presents four files — the generated 7-page
 * PDF and PNG (workspace files, `run.ts`), a markdown plan and an HTML page —
 * so the phone draws one preview card of each kind.
 */
const calls = [
  ["present", { title: "Q3 Infrastructure Report", id: "report", path: "project/q3-report.pdf" }],
  ["present", { title: "Hero image", id: "hero", path: "project/hero.png" }],
  [
    "present",
    {
      title: "Migration plan",
      id: "plan",
      kind: "markdown",
      content:
        "# Migration plan\n\nMove session logs to the v3 format without downtime.\n\n## Steps\n\n- Freeze writers behind the lock\n- Rewrite segments atomically\n- Verify, then drop the old index\n",
    },
  ],
  [
    "present",
    {
      title: "Deploy dashboard",
      id: "dash",
      kind: "html",
      content:
        '<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{font:16px -apple-system,sans-serif;margin:0;color:#1c1c1e}header{background:#0e7490;color:#fff;padding:18px 20px;font-size:22px;font-weight:600}main{padding:16px 20px}.k{display:flex;gap:12px;margin:8px 0 16px}.k div{flex:1;background:#eef2f5;border-radius:8px;padding:10px}.k b{display:block;font-size:22px}.bar{height:14px;background:#0e7490;border-radius:3px;margin:8px 0}</style></head><body><header>Deploy dashboard</header><main><div class="k"><div><b>42</b>deploys</div><div><b>99.9%</b>success</div></div><p>Last 7 days</p><div class="bar" style="width:80%"></div><div class="bar" style="width:55%"></div><div class="bar" style="width:92%"></div><div class="bar" style="width:40%"></div></main></body></html>',
    },
  ],
];
const prompt = calls.map((c) => `CALL ${c[0]} ${JSON.stringify(c[1])}`).join("\n");
const response = http.get(
  `http://${MAESTRO_HOOKS}/laptop-prompt?session=${PREVIEW_ID}&answer=allow&prompt=${encodeURIComponent(prompt)}`,
);
if (!response.ok) {
  throw new Error(`laptop-prompt failed: ${response.status} ${response.body}`);
}
