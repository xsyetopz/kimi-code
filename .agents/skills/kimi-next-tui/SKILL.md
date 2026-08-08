---
name: kimi-next-tui
description: Use when changing the kimi-next Ink TUI in apps/kimi-next/src/tui or packages/tui — transcript, footer, prompt, tool cards.
---

# kimi-next TUI

Ink UI lives in:

- `apps/kimi-next/src/tui/` — host App over `InteractiveHost`
- `packages/tui/` — Footer, Transcript, ToolCard, PromptInput (must not import agent)

Prefer dense transcript + tool cards + footer model/effort/usage. Readline is `--repl` only.
