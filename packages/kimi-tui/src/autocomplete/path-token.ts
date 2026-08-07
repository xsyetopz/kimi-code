const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

export function toDisplayPath(value: string): string {
  return value.replace(/\\/gu, "/");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function buildFdPathQuery(query: string): string {
  const normalized = toDisplayPath(query);
  if (!normalized.includes("/")) {
    return normalized;
  }

  const hasTrailingSeparator = normalized.endsWith("/");
  const trimmed = normalized.replace(/^\/+|\/+$/gu, "");
  if (!trimmed) {
    return normalized;
  }

  const separatorPattern = "[\\\\/]";
  const segments = trimmed
    .split("/")
    .filter(Boolean)
    .map((segment) => escapeRegex(segment));
  if (segments.length === 0) {
    return normalized;
  }

  let pattern = segments.join(separatorPattern);
  if (hasTrailingSeparator) {
    pattern += separatorPattern;
  }
  return pattern;
}

export function findLastDelimiter(text: string): number {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (PATH_DELIMITERS.has(text[i] ?? "")) {
      return i;
    }
  }
  return -1;
}

function findUnclosedQuoteStart(text: string): number | null {
  let inQuotes = false;
  let quoteStart = -1;

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '"') {
      inQuotes = !inQuotes;
      if (inQuotes) {
        quoteStart = i;
      }
    }
  }

  return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
  return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

export function extractQuotedPrefix(text: string): string | null {
  const quoteStart = findUnclosedQuoteStart(text);
  if (quoteStart === null) {
    return null;
  }

  if (quoteStart > 0 && text[quoteStart - 1] === "@") {
    if (!isTokenStart(text, quoteStart - 1)) {
      return null;
    }
    return text.slice(quoteStart - 1);
  }

  if (!isTokenStart(text, quoteStart)) {
    return null;
  }

  return text.slice(quoteStart);
}

export function parsePathPrefix(prefix: string): {
  rawPrefix: string;
  isAtPrefix: boolean;
  isQuotedPrefix: boolean;
} {
  if (prefix.startsWith('@"')) {
    return {
      rawPrefix: prefix.slice(2),
      isAtPrefix: true,
      isQuotedPrefix: true,
    };
  }
  if (prefix.startsWith('"')) {
    return {
      rawPrefix: prefix.slice(1),
      isAtPrefix: false,
      isQuotedPrefix: true,
    };
  }
  if (prefix.startsWith("@")) {
    return {
      rawPrefix: prefix.slice(1),
      isAtPrefix: true,
      isQuotedPrefix: false,
    };
  }
  return { rawPrefix: prefix, isAtPrefix: false, isQuotedPrefix: false };
}

export function buildCompletionValue(
  path: string,
  options: {
    isDirectory: boolean;
    isAtPrefix: boolean;
    isQuotedPrefix: boolean;
  },
): string {
  const needsQuotes = options.isQuotedPrefix || path.includes(" ");
  const prefix = options.isAtPrefix ? "@" : "";

  if (!needsQuotes) {
    return `${prefix}${path}`;
  }

  const openQuote = `${prefix}"`;
  const closeQuote = '"';
  return `${openQuote}${path}${closeQuote}`;
}
