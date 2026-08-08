# Extensions

The MCP bridge uses the official `@modelcontextprotocol/client` v2 SDK for
stdio connections. LLM-facing tool definitions are **catalog stubs** by default;
full JSON Schemas load on demand via `mcp_schema` (or when `deferSchemas: false`).

Protocol surfaces elsewhere in the monorepo:

- ACP editor bridge: `apps/kimi-next` `--acp` via `@agentclientprotocol/sdk`
- A2A peer runner: `packages/agent` `createA2aPeerRunner` via `@a2a-js/sdk`

Skills loading is owned by `@kimi-next/discover` (first-found, hierarchical,
bodies on activate). This package re-exports that API; do not add a second loader.
