import * as readline from "node:readline";

export type RpcCommand =
  | { readonly op: "prompt"; readonly text: string }
  | { readonly op: "compact" }
  | { readonly op: "exit" };

export function parseRpcCommand(raw: string): RpcCommand {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("RPC input must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("RPC command must be an object");
  }
  const command = value as Record<string, unknown>;
  const op = command["op"];
  if (op === "compact" || op === "exit") return { op };
  if (op === "prompt" && typeof command["text"] === "string") {
    return { op, text: command["text"] };
  }
  throw new Error('RPC command must be {"op":"prompt","text":"..."}');
}

export interface RpcLoop {
  readonly prompt: (text: string) => Promise<void>;
  readonly compact: () => Promise<void>;
  readonly emit: (event: unknown) => void;
}

export async function runRpcLoop(loop: RpcLoop): Promise<void> {
  const input = readline.createInterface({ input: process.stdin });
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      const command = parseRpcCommand(line);
      if (command.op === "exit") {
        loop.emit({ type: "exit" });
        break;
      }
      if (command.op === "compact") {
        await loop.compact();
        loop.emit({ type: "compact" });
      } else {
        await loop.prompt(command.text);
        loop.emit({ type: "prompt.complete" });
      }
    } catch (error) {
      loop.emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  input.close();
}
