import { Marked, type Token, Tokenizer, type Tokens } from "marked";

const STRICT_STRIKETHROUGH_REGEX =
  /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/u;

class StrictStrikethroughTokenizer extends Tokenizer {
  override del(src: string): Tokens.Del | undefined {
    const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
    if (!match) {
      return;
    }

    const text = match[2]!;
    return {
      type: "del",
      raw: match[0],
      text,
      tokens: this.lexer.inlineTokens(text),
    };
  }
}

export function trimPartialClosingFences(tokens: readonly Token[]): void {
  const token = tokens.at(-1);
  if (token?.type === "list") {
    trimPartialClosingFences(token.items.at(-1)?.tokens ?? []);
    return;
  }
  if (token?.type === "blockquote") {
    trimPartialClosingFences(token.tokens ?? []);
    return;
  }
  if (token?.type !== "code") {
    return;
  }

  const marker = /^(`{3,}|~{3,})/u.exec(token.raw)?.[1];
  const lastLine = token.raw.split("\n").pop();
  if (
    !(marker && lastLine) ||
    lastLine.length >= marker.length ||
    lastLine !== marker[0]?.repeat(lastLine.length)
  ) {
    return;
  }

  token.text = token.text.slice(0, -lastLine.length).replace(/\n$/u, "");
}

const markdownParser = new Marked();
markdownParser.setOptions({
  tokenizer: new StrictStrikethroughTokenizer(),
});

export { markdownParser };
