import type { DisplayBlock } from "../../../../reverse-rpc/types";

export function summarizeDisplayBlock(
  block: DisplayBlock,
): string | undefined {
  switch (block.type) {
    case "brief":
      return block.text;
    case "shell":
      return `${block.command}${block.cwd === undefined ? "" : ` · ${block.cwd}`}`;
    case "file_op":
      return `${block.operation} ${block.path}`;
    case "file_content":
      return `write ${block.path}`;
    case "diff":
      return `edit ${block.path}`;
    case "url_fetch":
      return `${block.method ?? "GET"} ${block.url}`;
    case "search":
      return `search ${block.query}${block.scope === undefined ? "" : ` · ${block.scope}`}`;
    case "invocation":
      return `${block.kind} ${block.name}`;
    case "todo":
      return `${block.items.length} todo item${block.items.length === 1 ? "" : "s"}`;
    case "background_task":
      return `${block.kind} ${block.description}`;
    default:
      return;
  }
}
