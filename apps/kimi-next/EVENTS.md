# JSONL events

With `--jsonl`, kimi-next writes one JSON object per line. The stable
top-level `type` values are `user`, `stream`, `assistant`, `tool_result`,
`swarm`, `error`, `auto-compact`, and `compact.complete`. Event-specific data
is carried in the corresponding `message`, `event`, `turn`, `result`,
`visibility`, or `error` field; consumers should ignore unknown fields.

Interactive hosts also expose a per-turn **harness receipt** on
`InteractiveHost.getSnapshot().receipt` (instruction kind, skill index size,
activated skills, MCP catalog vs full-schema counts, tools exposed, plan mode).
Receipts are seatbelts for humans — not additional JSONL event types yet.
