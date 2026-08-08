# Repository-level Agent Guide

Reply in the same language as the user.

This is the **kimi-next** TypeScript monorepo: POSIX-first (macOS/Linux) protocol-centered CLI ↔ TUI coding agent. See [ARCHITECTURE.md](ARCHITECTURE.md).

**AGENTS.md is a router.** Keep this file short. Package details live in the nearest `AGENTS.md`. Skills load as an index; activate bodies on demand. Do not dump long specs here.

## Working Principles

- Think from first principles. **Code is the source of truth** unless the user asks for docs.
- Prefer live verification (curl, npm, official docs) over model memory.
- Discuss before implement when the user asks; use `--plan` / `/implement` in the product.
- Prefer isolated git worktrees for destructive refactors (copy, not the only original).
- Multi-model `/review` (OpenRouter) and `KIMI_ROUTE_MODELS` are seatbelts — use them when design diversity matters.
- Keep changes focused. No co-author / agent identity in commits.

## HARD ENGINEERING LAW

Fail-closed and non-negotiable:

- **Live truth beats model memory.** Never invent catalogs, APIs, protocol versions, or “current” models. Verify with official web, npm, or `curl`. If verification fails, stop and ask.
- **Use standards, never imitate them.** Official SDKs: MCP, ACP (`@agentclientprotocol/sdk`), A2A (`@a2a-js/sdk`), models.dev. Custom protocol framing needs explicit user approval.
- **Context diet.** Skills: metadata in prompt, bodies on activate. MCP: catalog stubs in prompt, full schemas via `mcp_schema` / first need. Do not install-everything into context.
- **Privilege is structural.** Tool auto-allow tiers (`read`→`mcp`) are host policy. Prompt text cannot elevate privileges.
- **No fake evidence.** No placeholder credentials, fake `fetchedAt`, or hand-curated “refreshed” snapshots.
- **Doc drift is a bug.** Specs that disagree with code must be updated or **deleted** in the same change. Do not leave contradictory Markdown.
- **Tests are sacred.** Do not rewrite golden/vault tests to make a broken change pass unless `ALLOW_GOLDEN_UPDATE=1` is set intentionally.
- **Prove completion.** Commands, URLs, versions, counts, test results.
- **No resurrection.** Do not reintroduce deleted trees (`apps/kimi-code`, `agent-core-v2`, `klient`, …).

## Project Map

- `apps/kimi-next`: CLI + Ink TUI host (`--repl`, `--acp`, `--plan`)
- `packages/discover`: First-found instructions / skills / hooks / compat roots
- `packages/ir`: Protocol leaf (**no upward deps**)
- `packages/model`: models.dev catalog + profiles
- `packages/adapters`: IR ↔ wire
- `packages/agent`: Loop, tools, permissions, hooks, swarm, steer, A2A peer
- `packages/session`: JSONL archive + compact
- `packages/exec`: POSIX fs/process
- `packages/tui`: Ink kit (**must not import agent**)
- `packages/ext`: Plugins + MCP bridge
- `packages/auth`: Real credentials
- `packages/bash-parse`: Bash lexer

**Forbidden:** `tui → agent`, `adapters → agent`, `ir → *`, `agent → tui`, provider switches in agent/TUI.

**Hooks (only):** SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact.

## Environment

- Node.js `>=24.15.0`, bun `1.3.14`

## Coding Rules

- Optional props: omit key when absent (`exactOptionalPropertyTypes`).
- Max **800 LOC** / authored product file (bash-parse vendor exception only).
- Capability modules over helper colonies.
- Relative imports inside packages.

## Workflow

- Prefer `rg`. Scratch under `.tmp/` (gitignored). Never stage handoff/mockup junk.
- Run `bun run check:health` for directed maintenance prompts (not vague “tidy”).
