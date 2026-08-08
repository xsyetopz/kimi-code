export interface CliArgs {
  readonly print: boolean;
  readonly jsonl: boolean;
  readonly rpc: boolean;
  /** Escape hatch: classic readline REPL instead of Ink TUI. */
  readonly repl: boolean;
  readonly model: string;
  readonly compactModel?: string;
  readonly prompt?: string;
  readonly permissionMode: "manual" | "yolo";
  readonly baseUrl?: string;
  readonly system?: string;
  readonly showThinking: boolean;
  readonly showRaw: boolean;
  readonly autoCompactChars: number;
  readonly help: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  let print = false;
  let jsonl = false;
  let rpc = false;
  let repl = false;
  let model = "openai/gpt-4.1-mini";
  let compactModel: string | undefined;
  let prompt: string | undefined;
  let permissionMode: "manual" | "yolo" = "manual";
  let baseUrl: string | undefined;
  let system: string | undefined;
  let showThinking = true;
  let showRaw = false;
  let autoCompactChars = 120_000;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--help":
      case "-h":
        help = true;
        break;
      case "--print":
        print = true;
        break;
      case "--jsonl":
        jsonl = true;
        print = true;
        break;
      case "--rpc":
        rpc = true;
        jsonl = true;
        print = true;
        break;
      case "--repl":
        repl = true;
        break;
      case "--model":
        model = argv[++i] ?? model;
        break;
      case "--compact-model":
        compactModel = argv[++i];
        break;
      case "--yolo":
        permissionMode = "yolo";
        break;
      case "--base-url":
        baseUrl = argv[++i];
        break;
      case "--system":
        system = argv[++i];
        break;
      case "--no-thinking":
        showThinking = false;
        break;
      case "--raw":
        showRaw = true;
        break;
      case "--auto-compact-chars": {
        const parsed = Number(argv[++i]);
        if (Number.isFinite(parsed) && parsed >= 0) autoCompactChars = parsed;
        break;
      }
      default:
        if (!arg.startsWith("-")) {
          prompt = prompt ? `${prompt} ${arg}` : arg;
        }
        break;
    }
  }

  const result: {
    print: boolean;
    jsonl: boolean;
    rpc: boolean;
    repl: boolean;
    model: string;
    permissionMode: "manual" | "yolo";
    showThinking: boolean;
    showRaw: boolean;
    autoCompactChars: number;
    help: boolean;
    prompt?: string;
    baseUrl?: string;
    system?: string;
    compactModel?: string;
  } = {
    print,
    jsonl,
    rpc,
    repl,
    model,
    permissionMode,
    showThinking,
    showRaw,
    autoCompactChars,
    help,
  };
  if (prompt !== undefined) {
    result.prompt = prompt;
  }
  if (baseUrl !== undefined) {
    result.baseUrl = baseUrl;
  }
  if (system !== undefined) {
    result.system = system;
  }
  if (compactModel !== undefined) {
    result.compactModel = compactModel;
  }
  return result;
}

export function helpText(): string {
  return `kimi-next — POSIX protocol-centered coding agent

Usage:
  kimi-next [options] [prompt]

Options:
  --print              Headless one-shot (requires prompt)
  --jsonl              Print agent events as JSONL
  --rpc                Read NDJSON commands from stdin
  --repl               Readline REPL escape hatch (default is Ink TUI)
  --model <id>         Model profile id (default: openai/gpt-4.1-mini)
  --compact-model <id> Model for /compact refinement (optional)
  --yolo               Auto-approve tools
  --base-url <url>     Provider API base URL
  --system <text>      System prompt
  --no-thinking        Hide thinking in TUI
  --raw                Show raw assistant preserved state
  --auto-compact-chars <n>  Auto-compact derived context at this size
  -h, --help           Show help

REPL commands:
  /auth                List auth provider status
  /login <provider> [apiKey]  Store API key or start OAuth
  /logout <provider>   Remove stored credentials
  /model <id>          Switch model for the current session
  /effort <level>      Set reasoning effort note for subsequent turns
  /provider            Show current transport and API base URL
  /base-url <url>      Change API base URL
  /export [file]       Export conversation as Markdown
  /usage, /cost        Show token usage
  /diff                Show the latest write/edit tool arguments
  /stop                Abort the current turn

Prompt shortcuts:
  @file or @dir/       Attach file contents or a directory listing
  /skill-name          Activate a known skill inline in the prompt
`;
}
