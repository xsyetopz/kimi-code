/**
 * Small, conservative shell lexer for permission hints.
 *
 * It recognizes command boundaries (`|`, `&&`, `||`, `;`) outside quotes and
 * returns each command's first word. It intentionally does not evaluate
 * expansions, substitutions, redirects, heredocs, or shell grammar. Callers
 * must treat `hasError` as "cannot fully analyze"; this is not a sandbox.
 */
export type ParseBashResult =
  | {
      readonly ok: true;
      readonly hasError: boolean;
      readonly commands: string[];
    }
  | { readonly ok: false; readonly reason: "aborted" };

export function parseBash(source: string): ParseBashResult {
  if (source.length > 1_000_000) {
    return { ok: false, reason: "aborted" };
  }
  const commands: string[] = [];
  let word = "";
  let commandHead = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let hasError = false;

  const finishWord = () => {
    if (word.length > 0 && commandHead.length === 0) commandHead = word;
    word = "";
  };
  const finishCommand = () => {
    finishWord();
    if (commandHead.length > 0) commands.push(commandHead);
    commandHead = "";
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      word += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#") {
      finishWord();
      while (index + 1 < source.length && source[index + 1] !== "\n") index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      finishWord();
      continue;
    }
    if (char === "|" || char === ";" || char === "&") {
      finishCommand();
      if (
        (char === "|" && source[index + 1] === "|") ||
        (char === "&" && source[index + 1] === "&")
      ) {
        index += 1;
      }
      continue;
    }
    word += char;
  }
  if (escaped || quote !== undefined) hasError = true;
  finishCommand();
  return { ok: true, hasError, commands };
}
