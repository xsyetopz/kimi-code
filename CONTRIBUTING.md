# Contributing to kimi-next

See [ARCHITECTURE.md](ARCHITECTURE.md) and [AGENTS.md](AGENTS.md).

## Layout

- `apps/kimi-next` — CLI + Ink TUI (`--repl`, `--acp`, `--plan`)
- `packages/discover` — first-found instructions/skills/hooks
- `packages/{ir,model,adapters,agent,session,exec,tui,ext,auth,bash-parse}`

## Setup

Node >= 24.15.0, bun 1.3.14.

```sh
bun install
bun run check
bunx vitest run
bun run --cwd apps/kimi-next start -- --help
```

## Commits

Conventional Commits. No co-author / agent attribution.

Do not reintroduce deleted product lines (`apps/kimi-code`, `agent-core-v2`, `klient`, etc.).
