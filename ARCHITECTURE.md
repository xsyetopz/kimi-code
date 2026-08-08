# Architecture Report: kimi-next Protocol-Centered Harness

- Date: 2026-08-08
- Status: Accepted
- Rigor: R3
- Platform: darwin + linux only (Windows excluded)

## North star

**kimi-next** is a personal, POSIX-first CLI ↔ TUI coding agent. **CLI is completed first**; Ink TUI is a presentation surface over the same agent APIs.

| Pillar | Target |
|---|---|
| Product | `apps/kimi-next` binary `kimi-next` |
| Protocol | `packages/ir` — messages, turns, tools, reasoning, events |
| Discovery | `packages/discover` — universal **first-found** instructions/skills/hooks/configs |
| Providers | `packages/model` + `packages/adapters` — never agent/TUI `if (provider)` |
| Context | Session archive (never lossy) + derived active LLM context |
| Hooks | Only SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact |
| Auth | Real credentials only — no stub tokens |
| Platform | macOS + Linux |

## Universal first-found

| Pattern | Behavior |
|---------|----------|
| Instruction files | Walk cwd→parents; pick exactly one from candidate set |
| Skills / hooks / configs | Scan compat roots in order; first name/event wins |

Instruction candidates: `AGENTS.md` → `agents.md` → `CLAUDE.md` → `GEMINI.md` → `AGENT.md` → `.agents.md`.

Compat roots: `.agents/` → `.kimi-next/` → `.pi/` → `.claude/` → `.codex/` → `.goose/`.

## Package topology

```
apps/kimi-next/          CLI + Ink TUI host (readline via --repl)
packages/discover/       First-found instructions, skills, hooks, roots
packages/ir/             Canonical protocol (leaf)
packages/model/          Catalog (models.dev), profiles, validation
packages/adapters/       Transport adapters
packages/agent/          Loop, tools, permissions, hooks ports, swarm, steer
packages/session/        JSONL archive, compact
packages/exec/           POSIX fs/process
packages/tui/            Ink primitives + projection helpers
packages/ext/            Plugins + MCP
packages/auth/           Real multi-provider credentials
packages/bash-parse/     Bash lexer
```

```mermaid
flowchart TB
  app[apps/kimi-next] --> discover[packages/discover]
  app --> tui[packages/tui]
  app --> agent[packages/agent]
  app --> auth[packages/auth]
  agent --> session[packages/session]
  agent --> ir[packages/ir]
  agent --> model[packages/model]
  agent --> adapters[packages/adapters]
  agent --> exec[packages/exec]
  agent --> ext[packages/ext]
  adapters --> ir
  model --> ir
  session --> ir
  ext --> ir
```

**Forbidden:** `tui → agent`, `adapters → agent`, `ir → *`, `agent → tui`, provider-name switches in agent/TUI.

## Dual truth

| Store | Lossy? | Owner |
|---|---|---|
| Session archive (JSONL) | Never | `session` |
| Active LLM context | Yes — derived | `agent` |
| TUI projection | Display only | `tui` + host |

## Context diet

- Skills: index (name/description/parent) in the prompt; bodies load on `/skill` or inline activation (size-capped).
- MCP: catalog stubs + `mcp_list` / `mcp_schema`; full JSON Schemas are not sent every turn.
- `--plan` / `/plan`: tools disabled until `/implement`.
- Per-turn **receipts** record what was loaded (instruction, skills, MCP counts, plan mode).
- **Privilege tiers** (`/privilege read|write|exec|mcp`): auto-allow up to a tier; user prompt text cannot elevate.
- **Task-class model routing** (`KIMI_ROUTE_MODELS`): cheap/plan/review paths can use lighter models.
- **Multi-model review** (`/review`, `KIMI_REVIEW_MODELS` + OpenRouter): concurrent design opinions, not a second agent loop.

## Programs

- **A — CLI complete:** discover, hooks, real auth, models.dev/cache, real glob, mid-turn abort, steering, model/effort swaps.
- **B — Ink TUI:** React+Ink (tura-next style) is the default interactive path over `InteractiveHost`; `--repl` remains as escape hatch.
- **C — Protocol host surfaces:** `kimi-next --acp` serves ACP over stdio through the official ACP SDK; swarm federation can use the official A2A client seam in `packages/agent` without changing the agent loop.

ACP usage: `bun run --cwd apps/kimi-next dev --acp --yolo` starts the stdio agent for an ACP editor. Process stdout is reserved for ACP messages; configure credentials and the model through normal CLI environment/options.

A2A usage: `createA2aPeerRunner([{ id, url }])` in `@kimi-next/agent` discovers each peer's Agent Card through the official `ClientFactory`, then sends a standard message to every peer concurrently. It is an adapter seam for swarm/federation callers, not a replacement agent loop.

## Non-goals

Windows; hooks beyond the five named events. Deleted product lines (`apps/kimi-code`, `agent-core-v2`, `klient`, …) must not be reintroduced.
