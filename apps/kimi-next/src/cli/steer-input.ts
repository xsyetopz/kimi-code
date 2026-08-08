import { stdin } from "node:process";
import { SteeringQueue } from "@kimi-next/agent";

export function listenForSteering(
  queue: SteeringQueue,
  abort: AbortController,
): () => void {
  let buffer = "";
  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trim();
      if (text === "/stop") abort.abort();
      else if (text) queue.pushSteer(text);
    }
  };
  stdin.on("data", onData);
  return () => {
    stdin.off("data", onData);
    if (buffer.trim() && buffer.trim() !== "/stop") queue.pushSteer(buffer.trim());
  };
}
