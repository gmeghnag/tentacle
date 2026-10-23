/**
 * The spike's one screen: runs `runSpike` on mount and renders its status, the
 * streamed text and the last error. A dumb renderer (AGENTS §7); the flow is
 * in src/spike.ts. The URL/token come from the build environment.
 */
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { runSpike } from "./src/spike.ts";

const URL = process.env.EXPO_PUBLIC_TENTACLE_URL ?? "ws://127.0.0.1:4001";
const TOKEN = process.env.EXPO_PUBLIC_TENTACLE_TOKEN;
const PROMPT = process.env.EXPO_PUBLIC_TENTACLE_PROMPT ?? "hello";

export default function App() {
  const [status, setStatus] = useState("starting");
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const log = (line: string) => {
      console.log(`[spike] ${line}`);
      setStatus(line);
    };
    runSpike({
      url: URL,
      ...(TOKEN ? { token: TOKEN } : {}),
      prompt: PROMPT,
      WebSocket,
      log,
      onText: (delta) => setText((prev) => prev + delta),
    }).catch((caught: unknown) => {
      const message =
        caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
      console.log(`[spike] FAILED ${message}`);
      setError(message);
    });
  }, []);

  return (
    <View style={{ paddingTop: 80, paddingHorizontal: 16 }}>
      <Text>{`url: ${URL}`}</Text>
      <Text>{`status: ${status}`}</Text>
      <Text>{`reply: ${text}`}</Text>
      <Text>{`error: ${error}`}</Text>
    </View>
  );
}
