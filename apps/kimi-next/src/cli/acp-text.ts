/** Shared ACP prompt extraction for host + tests (no SDK import required). */
export function promptTextForTest(
  content: readonly { type: string; text?: string }[],
): string {
  return content
    .map((block) => (block.type === "text" ? block.text ?? "" : ""))
    .join("");
}
