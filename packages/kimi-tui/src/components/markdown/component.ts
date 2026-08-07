import { isImageLine } from "../../terminal-image.ts";
import type { Component } from "../../tui.ts";
import {
  applyBackgroundToLine,
  visibleWidth,
  wrapTextWithAnsi,
} from "../../utils.ts";
import { markdownParser, trimPartialClosingFences } from "./parser.ts";
import { MarkdownRenderer } from "./renderer.ts";
import type {
  DefaultTextStyle,
  MarkdownOptions,
  MarkdownTheme,
} from "./types.ts";

export type {
  DefaultTextStyle,
  MarkdownOptions,
  MarkdownTheme,
} from "./types.ts";

export class Markdown implements Component {
  private text: string;
  private readonly paddingX: number;
  private readonly paddingY: number;
  private readonly defaultTextStyle?: DefaultTextStyle;
  private readonly theme: MarkdownTheme;
  private readonly options: MarkdownOptions;
  private readonly renderer: MarkdownRenderer;

  private cachedText?: string;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    text: string,
    paddingX: number,
    paddingY: number,
    theme: MarkdownTheme,
    defaultTextStyle?: DefaultTextStyle,
    options?: MarkdownOptions,
  ) {
    this.text = text;
    this.paddingX = paddingX;
    this.paddingY = paddingY;
    this.theme = theme;
    this.defaultTextStyle = defaultTextStyle;
    this.options = options ? { ...options } : {};
    this.renderer = new MarkdownRenderer(
      this.theme,
      this.options,
      this.defaultTextStyle,
    );
  }

  setText(text: string): void {
    this.text = text;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (
      this.cachedLines &&
      this.cachedText === this.text &&
      this.cachedWidth === width
    ) {
      return this.cachedLines;
    }

    const contentWidth = Math.max(1, width - this.paddingX * 2);

    if (!this.text || this.text.trim() === "") {
      const result: string[] = [];
      this.cachedText = this.text;
      this.cachedWidth = width;
      this.cachedLines = result;
      return result;
    }

    const normalizedText = this.text.replace(/\t/gu, "   ");
    const tokens = markdownParser.lexer(normalizedText);
    trimPartialClosingFences(tokens);

    const renderedLines: string[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      const nextToken = tokens[i + 1];
      const tokenLines = this.renderer.renderToken(
        token,
        contentWidth,
        nextToken?.type,
      );
      for (const tokenLine of tokenLines) {
        renderedLines.push(tokenLine);
      }
    }

    const wrappedLines: string[] = [];
    for (const line of renderedLines) {
      if (isImageLine(line)) {
        wrappedLines.push(line);
      } else {
        for (const wrappedLine of wrapTextWithAnsi(line, contentWidth)) {
          wrappedLines.push(wrappedLine);
        }
      }
    }

    const leftMargin = " ".repeat(this.paddingX);
    const rightMargin = " ".repeat(this.paddingX);
    const bgFn = this.defaultTextStyle?.bgColor;
    const contentLines: string[] = [];

    for (const line of wrappedLines) {
      if (isImageLine(line)) {
        contentLines.push(line);
        continue;
      }

      const lineWithMargins = leftMargin + line + rightMargin;

      if (bgFn) {
        contentLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
      } else {
        const visibleLen = visibleWidth(lineWithMargins);
        const paddingNeeded = Math.max(0, width - visibleLen);
        contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
      }
    }

    const emptyLine = " ".repeat(Math.max(0, width));
    const emptyLines: string[] = [];
    for (let i = 0; i < this.paddingY; i++) {
      const line = bgFn
        ? applyBackgroundToLine(emptyLine, width, bgFn)
        : emptyLine;
      emptyLines.push(line);
    }

    const result = emptyLines.concat(contentLines, emptyLines);

    this.cachedText = this.text;
    this.cachedWidth = width;
    this.cachedLines = result;

    return result;
  }
}
