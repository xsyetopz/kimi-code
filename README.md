# kimi-next

POSIX-first (macOS / Linux) protocol-centered coding agent CLI ↔ TUI.

Small like [pi](https://github.com/earendil-works/pi), with explicit WYSIWYG control, multi-provider equality via a canonical IR + model profiles, and dual-truth sessions (full archive + derived LLM context).

## Quick start

```bash
bun install
bun run dev -- --help
bun run dev -- --print --yolo "say hi"
```

Requires Node `>=24.15.0` and Bun `1.3.14`. Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.

## Packages

| Package | Role |
|---------|------|
| `apps/kimi-next` | CLI host (`kimi-next`) |
| `packages/ir` | Canonical protocol (leaf) |
| `packages/model` | Profiles + catalog |
| `packages/adapters` | Transport adapters |
| `packages/agent` | Loop, tools, permissions, swarm seam |
| `packages/session` | JSONL archive + structured compact |
| `packages/exec` | POSIX fs/process |
| `packages/tui` | WYSIWYG render helpers |
| `packages/ext` | Skills, plugins, MCP seam |
| `packages/auth` | Credentials / OAuth seam |
| `packages/bash-parse` | Bash parse stub |

See [ARCHITECTURE.md](ARCHITECTURE.md).

## Checks

```bash
bun run check:boundaries
bun run check:loc
bun run test
```

**Platform:** darwin + linux only. Windows is not supported.
