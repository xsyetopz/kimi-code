# Repository-level Agent Guide

Reply in the same language as the user.

This is the **kimi-next** TypeScript monorepo: POSIX-first (macOS/Linux) protocol-centered CLI ↔ TUI coding agent. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Working Principles

- Think from first principles. Code is the source of truth unless the user asks for docs.
- Follow the nearest `AGENTS.md` / discover instruction rules.
- Keep changes focused. No co-author / agent identity in commits.

## Project Map

- `apps/kimi-next`: CLI + Ink TUI host. Binary `kimi-next` (default Ink; `--repl` escape hatch).
- `packages/discover`: Universal **first-found** discovery (instructions, skills, hooks, compat roots).
- `packages/ir`: Canonical protocol leaf. **No upward deps.**
- `packages/model`: Model profiles + models.dev catalog.
- `packages/adapters`: Transport adapters (IR ↔ wire).
- `packages/agent`: Loop, tools, permissions, hook ports, swarm, steering.
- `packages/session`: JSONL archive + structured compact.
- `packages/exec`: POSIX fs/process.
- `packages/tui`: Ink primitives + projection helpers. **Must not import agent.**
- `packages/ext`: Plugins + MCP.
- `packages/auth`: Real credentials / OAuth (no stubs).
- `packages/bash-parse`: Bash lexer.

**Platform:** darwin + linux only.

**Forbidden:** `tui → agent`, `adapters → agent`, `ir → *`, `agent → tui`, provider switches in agent/TUI.

**Hooks (only):** SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact.

## Environment

- Node.js `>=24.15.0`, bun `1.3.14`

## Coding Rules

- Optional props: omit key when absent (`exactOptionalPropertyTypes`).
- Max **800 LOC** / authored product file (bash-parse vendor exception only).
- Capability modules over helper colonies.
- Relative imports inside packages (Bun workspace-safe).

## Workflow

- Prefer `rg`. Scratch under `.tmp/` (gitignored). Never stage handoff/mockup junk.
