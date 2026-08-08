# kimi-next

POSIX-first (macOS / Linux) protocol-centered coding agent CLI ↔ TUI.

## Quick start

```bash
bun install
bun run dev -- --help
bun run dev -- --print --yolo "say hi"
```

Requires Node `>=24.15.0` and Bun `1.3.14`. Set provider API keys as needed (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, …).

## Packages

| Package | Role |
|---------|------|
| `apps/kimi-next` | CLI + Ink TUI host |
| `packages/discover` | First-found instructions / skills / hooks |
| `packages/ir` | Canonical protocol (leaf) |
| `packages/model` | Profiles + models.dev catalog |
| `packages/adapters` | Transport adapters |
| `packages/agent` | Loop, tools, privileges, swarm, A2A, review panel |
| `packages/session` | JSONL archive + compact |
| `packages/exec` | POSIX fs/process |
| `packages/tui` | Ink primitives |
| `packages/ext` | Plugins + MCP |
| `packages/auth` | Credentials / OAuth |
| `packages/bash-parse` | Bash lexer |

See [ARCHITECTURE.md](ARCHITECTURE.md).

## Checks

```bash
bun run check
bun run check:health
bunx vitest run
```

**Platform:** darwin + linux only.
