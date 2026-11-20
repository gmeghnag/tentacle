/**
 * Flow 35's world (docs/feat/mobile-gallery-polish.md): the LAPTOP runs one turn
 * on this flow's session that draws the six chart kinds the gallery tiles must
 * hold (scatter, pie, doughnut, stacked area, bar, a 180-point line) and presents
 * one HTML page — the owner's 2026-11-20 screenshot, as a fixture. Built here (not
 * in the yaml) because seven `CALL` lines of JSON do not survive yaml quoting.
 */
const months = ["gen", "feb", "mar", "apr", "mag", "giu"];
const stress = [];
const stressLabels = [];
for (let i = 0; i < 180; i++) {
  stressLabels.push(`p${i}`);
  stress.push(Math.round(50 + 40 * Math.sin(i / 9) + ((i * 37) % 11)));
}
const calls = [
  [
    "chart",
    {
      type: "scatter",
      title: "Peso vs altezza",
      datasets: [
        {
          label: "A",
          data: [
            { x: 160, y: 55 },
            { x: 170, y: 68 },
            { x: 180, y: 80 },
            { x: 175, y: 72 },
            { x: 165, y: 60 },
          ],
        },
        {
          label: "B",
          data: [
            { x: 158, y: 50 },
            { x: 168, y: 62 },
            { x: 178, y: 75 },
          ],
        },
      ],
    },
  ],
  [
    "chart",
    {
      type: "pie",
      title: "Quote di mercato",
      labels: ["Alpha", "Beta", "Gamma", "Delta"],
      datasets: [{ label: "Quota", data: [40, 30, 20, 10] }],
    },
  ],
  [
    "chart",
    {
      type: "doughnut",
      title: "Budget",
      labels: ["Infra", "Persone", "Marketing", "Altro", "Viaggi"],
      datasets: [{ label: "EUR", data: [50, 30, 10, 6, 4] }],
    },
  ],
  [
    "chart",
    {
      type: "area",
      stacked: true,
      title: "Traffico per canale",
      labels: months,
      datasets: [
        { label: "Web", data: [10, 12, 14, 13, 16, 18] },
        { label: "App", data: [5, 6, 8, 9, 11, 12] },
        { label: "API", data: [2, 3, 3, 4, 5, 6] },
      ],
    },
  ],
  [
    "chart",
    {
      type: "bar",
      title: "Ricavi per regione",
      labels: ["Nord", "Centro", "Sud", "Isole"],
      datasets: [
        { label: "2026", data: [120, 90, 70, 40] },
        { label: "2025", data: [100, 85, 60, 38] },
      ],
    },
  ],
  [
    "chart",
    {
      type: "line",
      title: "Stress 180 punti",
      labels: stressLabels,
      datasets: [{ label: "S", data: stress }],
    },
  ],
  [
    "present",
    {
      title: "Report page",
      kind: "html",
      id: "report",
      content: "<!doctype html><html><body><h1>Report</h1><p>Q3</p></body></html>",
    },
  ],
];
const prompt = calls.map((c) => `CALL ${c[0]} ${JSON.stringify(c[1])}`).join("\n");
const response = http.get(
  `http://${MAESTRO_HOOKS}/laptop-prompt?session=${GALLERY_ID}&answer=allow&prompt=${encodeURIComponent(prompt)}`,
);
if (!response.ok) {
  throw new Error(`laptop-prompt failed: ${response.status} ${response.body}`);
}
