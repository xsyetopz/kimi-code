# Contributing to kimi-next

Personal fork / heavily modified harness. See [ARCHITECTURE.md](ARCHITECTURE.md) and [AGENTS.md](AGENTS.md).

## Layout

- `apps/kimi-next` — CLI (+ Ink TUI later)
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
