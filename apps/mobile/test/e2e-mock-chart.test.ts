/**
 * Flow 31's mock-model scenario (docs/feat/model-charts.md T6), through the REAL
 * `OpenAIProvider` stream: `CHART31` makes one `chart` call whose arguments are a
 * spec the phone draws (it re-validates and lays out), and the follow-up round
 * (its tool result last) answers in prose instead of calling again.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { ChatMessage, StreamEvent, ToolCall } from "@tentacle/core";
import { OpenAIProvider } from "../../../packages/providers/src/index.ts";
import { CHART_PROMPT, startMockModel } from "../e2e/mock-model.ts";
import { chartRowView } from "../src/chart-row.ts";
import { lightPalette } from "../src/theme.ts";

const mock = startMockModel();
afterAll(() => mock.stop());
const provider = new OpenAIProvider({ baseURL: mock.baseUrl, model: "mock" });

async function round(messages: ChatMessage[]): Promise<{ text: string; calls: ToolCall[] }> {
  let text = "";
  const calls: ToolCall[] = [];
  for await (const event of provider.stream({ messages }) as AsyncIterable<StreamEvent>) {
    if (event.type === "text") text += event.delta;
    else if (event.type === "tool_call") calls.push(event.toolCall);
  }
  return { text, calls };
}

describe("CHART31 (flow 31)", () => {
  test("one `chart` call whose spec the phone lays out", async () => {
    const { calls } = await round([{ role: "user", content: CHART_PROMPT }]);
    expect(calls.map((c) => c.name)).toEqual(["chart"]);
    const call = calls[0];
    if (call === undefined) throw new Error("no call");
    const view = chartRowView(
      { name: call.name, args: call.arguments, status: "ok" },
      { width: 358, fontScale: 1, locale: "it-IT", palette: lightPalette },
    );
    expect(view?.title).toBe("Ricavi");
  });

  test("the follow-up round answers in prose, no second call", async () => {
    const { text, calls } = await round([
      { role: "user", content: CHART_PROMPT },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "mocked-1", name: "chart", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "mocked-1", content: "Chart shown to the user: Ricavi" },
    ]);
    expect(calls).toEqual([]);
    expect(text.length).toBeGreaterThan(0);
  });
});
