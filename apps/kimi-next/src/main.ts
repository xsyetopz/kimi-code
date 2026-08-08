#!/usr/bin/env bun
import { helpText, parseArgs } from "./cli/args";
import { initReplContext, runRepl } from "./cli/repl";
import { runInkTui } from "./tui/run";

async function main(): Promise<void> {
  if (process.platform === "win32") {
    console.error("kimi-next supports macOS and Linux only.");
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(helpText());
    return;
  }

  const ctx = await initReplContext(args);
  if (args.print || args.rpc || args.repl) {
    await runRepl(ctx);
    return;
  }
  await runInkTui(ctx);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
