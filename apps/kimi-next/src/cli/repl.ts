import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { TransportAdapter } from "@kimi-next/adapters";
import type { Credential } from "@kimi-next/auth";
import { loadCredentials } from "@kimi-next/auth";
import { type ModelProfile, resolveModel } from "@kimi-next/model";
import { DEFAULT_TOGGLES } from "@kimi-next/tui";
import { adapterForTransport } from "./adapters";
import type { CliArgs } from "./args";
import { createInteractiveHost } from "./host";
import { runRpcLoop } from "./rpc";

export interface ReplContext {
  readonly args: CliArgs;
  readonly profile: ModelProfile;
  readonly compactProfile?: ModelProfile;
  readonly adapter: TransportAdapter;
  readonly credentials: readonly Credential[];
  readonly baseUrl: string;
}

function defaultBaseUrl(transport: string): string {
  switch (transport) {
    case "anthropic": return "https://api.anthropic.com/v1";
    case "gemini": return "https://generativelanguage.googleapis.com/v1beta";
    case "openai-responses":
    case "openai-chat":
    default: return "https://api.openai.com/v1";
  }
}

export function createReplContext(args: CliArgs): ReplContext {
  const profile = resolveModel(args.model);
  const base: ReplContext = {
    args, profile, adapter: adapterForTransport(profile.transport), credentials: [],
    baseUrl: args.baseUrl ?? defaultBaseUrl(profile.transport),
  };
  if (args.compactModel) return { ...base, compactProfile: resolveModel(args.compactModel) };
  return base;
}

export async function initReplContext(args: CliArgs): Promise<ReplContext> {
  return { ...createReplContext(args), credentials: await loadCredentials() };
}

export async function runRepl(ctx: ReplContext): Promise<void> {
  const host = createInteractiveHost(ctx);
  if (ctx.args.rpc) {
    await runRpcLoop({
      prompt: (prompt) => host.submit(prompt),
      compact: () => host.submit("/compact"),
      emit: (event) => console.log(JSON.stringify(event)),
    });
    await host.dispose();
    return;
  }
  if (ctx.args.print) {
    if (!ctx.args.prompt) {
      console.error("--print requires a prompt");
      await host.dispose();
      process.exitCode = 2;
      return;
    }
    await host.submit(ctx.args.prompt);
    await host.dispose();
    return;
  }

  console.log("kimi-next interactive session");
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  const unsubscribe = host.subscribe(() => {
    const prompt = host.getSnapshot().permissionPrompt;
    if (prompt) stdout.write(`\nAllow tool ${prompt.toolName}? [y/N/a] `);
  });
  rl.on("SIGINT", () => {
    if (host.getSnapshot().busy) { host.abort(); stdout.write("\nturn stopped\n"); }
    else stdout.write("\nUse /exit to quit.\n");
  });
  try {
    while (true) {
      const line = (await rl.question("> ")).trim();
      if (!line) continue;
      if (line === "/exit" || line === "/quit") break;
      if (host.getSnapshot().permissionPrompt && /^[yna]$/i.test(line)) {
        host.answerPermission(line.toLowerCase() as "y" | "n" | "a");
        continue;
      }
      await host.submit(line);
    }
  } finally {
    unsubscribe();
    rl.close();
    await host.dispose();
  }
}

export { DEFAULT_TOGGLES };
