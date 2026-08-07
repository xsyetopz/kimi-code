# Repository-level Agent Guide

Reply in the same language as the user.

This is a TypeScript monorepo built for agent-assisted development. Keep the root `AGENTS.md` limited to hot-path rules: the project map, hard constraints, and workflow requirements — things every task needs to know.

## Working Principles

- Think from first principles. Start from real requirements, code facts, and verification results; if the goal is unclear, discuss it with the user first.
- Treat code, not documentation, as the source of truth. Unless the user explicitly says otherwise, do not read ordinary Markdown just to understand the implementation.
- Before making code changes, read the relevant code and the most recent constraints, and follow the nearest `AGENTS.md` in the directory tree.
- Keep changes focused. Do not slip in unrelated refactors along the way.
- When committing, do not add any co-author attribution, and do not reveal the identity of the agent in commit messages, PR descriptions, or any explanatory text.

## Project Map

- `apps/kimi-code`: the CLI / TUI application and the **only** app host. It consumes core capabilities through `@moonshot-ai/kimi-code-sdk` (in-process `klient/memory` on the default path) and must not depend directly on `@moonshot-ai/agent-core-v2`. When writing or modifying its terminal UI, use the `write-tui` skill (`.agents/skills/write-tui/SKILL.md`).
- `packages/agent-core-v2`: the unified agent engine — Agent, Session, profile, skills, tools, plan, permission, background, records, swarm orchestration, the hook/interceptor pipeline, and the DI × Scope service layer. Four `LifecycleScope` tiers — `App` / `Workspace` / `Session` / `Agent`. See `packages/agent-core-v2/AGENTS.md`.
- `packages/kimi-tui`: the terminal UI engine — differential rendering, text editor, markdown, components, inline images, and keyboard input handling. Forked from pi-tui (upstream pi-mono). See `packages/kimi-tui/AGENTS.md`.
- `packages/node-sdk`: the public TypeScript SDK and harness (`@moonshot-ai/kimi-code-sdk`).
- `packages/klient`: the client SDK — contract-driven façade over agent-core-v2 with aggregated `global.*` / `session(id).*` / `agent(id).*` methods, zod validation on every call, and klient-level typed event forwarding. **Default product transport:** `@moonshot-ai/klient/memory` (in-process). See `packages/klient/AGENTS.md`.
- `packages/kosong`: the LLM / provider abstraction layer.
- `packages/kaos`: the execution environment and file/process abstractions.
- `packages/oauth`: Kimi OAuth and managed auth utilities.
- Telemetry: removed from the harness product line.
- `packages/transcript`: the isomorphic transcript rendering data layer — agent-granular L1 store, idempotent L2 operations, `off/turn/block/delta` L3 subscription granularity, framework-free L4 view registry, and turn-cursor pagination. Pure TypeScript (no engine imports) and the sole owner of transcript contract types (`src/contract/`). Consumed by the TUI projection path and engine-side fold/rebuild helpers.
- `packages/tree-sitter-bash`: a pure-TypeScript bash parser (no runtime deps, no wasm) that produces a syntax tree with tree-sitter-bash 0.25.0 named-node type names and UTF-16 code-unit offsets. `parse(source, { timeoutMs, maxNodes })` runs under a deterministic budget (default 50 ms / 50k nodes, plus per-chain recursion depth caps) and returns a discriminated `ParseResult` (`{ ok, rootNode, hasError }` or `{ ok: false, reason: 'aborted' }`) — callers must treat aborted/hasError trees as "cannot analyze" and degrade. Parser only, no safety judgments; consumers (e.g. Bash tool permission matching) live elsewhere. Known deviations from the reference are tracked in the package README's "Known differences" section, pinned by differential fixtures tested against the real `tree-sitter-bash` wasm (dev-only).

**Out of the harness product line** (migration targets for deletion or quarantine, not default-path dependencies): `apps/kimi-web`, `apps/vis`, `apps/kimi-inspect`. **Deleted from the tree:** `packages/kap-server`, `packages/minidb`, `packages/server-e2e` (legacy HTTP server stack; klient hosts the retired wire e2e suites). See [ARCHITECTURE.md](ARCHITECTURE.md) for the north star.

## Environment Requirements

- **Node.js**: `>=24.15.0` (from `apps/kimi-code/package.json` `engines`; `.nvmrc` is `24.15.0`, used by nvm / fnm / mise to pick the minimum recommended version).
- **bun**: `1.3.14` (from the root `package.json` `packageManager`).
- `bun install` will fail when the Node version is not satisfied, because `.npmrc` sets `engine-strict=true`.

## General Coding Rules

- For optional object properties, pass `undefined` directly instead of using conditional spread.
  - YES: `{ user }`
  - NO: `{ ...(user ? { user } : undefined) }`
- Optional object properties do not need to additionally allow `undefined` in the type.
  - YES: `interface Options { user?: User }`
  - NO: `interface Options { user?: User | undefined }`
- Internal methods with only a single parameter should not be turned into options objects just for stylistic uniformity.
- Except for a package's `index.ts`, other `index.ts` files should prefer `export * from './module';`.
- The `Agent` class in `packages/agent-core-v2/src/agent` must be usable on its own. The constructor must not force the caller to create a `Session` instance, nor require an `agentId` or `session`. It may accept an optional `sessionId` as a request-config hint — for example mapped to the provider's `prompt_cache_key` — but the instance must not hold `sessionId`, and must not depend on the Session lifecycle, metadata, or parent/child relationship logic.
- Do not add too many new test files. Prefer adding tests to the existing test file of the corresponding component or module.
- When a test fails because of a user modification, default to fixing the test first; do not change the implementation to satisfy an old test unless the implementation truly has a bug.
- Do not sacrifice code quality for external compatibility unless the user explicitly asks for it. Breaking changes go through changesets and a `major` bump, gated by the rule below.

## Experimental Features

- Gate a not-yet-public feature behind an experimental flag. Add the flag to the registry at `packages/agent-core-v2/src/flags/registry.ts`, then check it with `flags.enabled('my-feature')`. Flags are env-driven and default off: `KIMI_CODE_EXPERIMENTAL_<NAME>` toggles one, `KIMI_CODE_EXPERIMENTAL_FLAG` enables all. Release by flipping the entry's `default` to `true`.

## Where to Update Instructions

- Hard rules that affect almost every task: update the root `AGENTS.md`.
- Rules that only affect a specific directory: update the nearest sub-directory `AGENTS.md`.
- Keep instruction updates focused and supported by code facts.

## Workflow Requirements

- Prefer `rg` / `rg --files` when reading code.
- When designing changes, follow existing boundaries and local patterns first.
- In public text and test data, replace real internal identifiers with neutral placeholders such as `example.com`, `example.test`, and `YOUR_API_KEY`. Before opening a PR, ask a read-only agent to audit the diff for context-specific internal identifiers.
- When creating a PR, the PR title must follow Conventional Commit style, e.g. `chore: remove legacy format commands`.
- When an AI agent opens or updates a PR, fill in `.github/pull_request_template.md` — link the related issue or explain the problem, then describe what changed. Do not leave placeholder text or submit a generic summary of the diff.
- Do not submit vague AI-generated PR text. The human author must understand the change well enough to explain the code, edge cases, and why the approach fits this repository.
- After finishing a task and before submitting a PR, you must run the `gen-changesets` skill (see `.agents/skills/gen-changesets/SKILL.md`) and generate a changeset under `.changeset/` according to its rules.
- When generating a changeset, **never** decide on a `major` bump on your own. When you judge a change to meet the major criteria (breaking changes, incompatible user configuration, renamed or removed commands/arguments, changed behavior semantics, etc.), you must stop and explain it to the user and ask for confirmation. **Only write `major` after the user has explicitly agreed.** Otherwise default to `minor` (and fall back to `patch` if `minor` is unclear). See the "Hard rule: confirm with the user before writing `major`" section in `.agents/skills/gen-changesets/SKILL.md` for details.
- Prefer importing via `import ... from '#/...'`, which serves the same purpose as `import ... from '@/...'`.
- Do not commit throwaway scratch or exploratory files. Never stage:
  - Agent working notes or handoff/summary documents (e.g. `HANDOVER-*.md`, `HANDOFF-*.md`, `handoff.md`).
  - Throwaway UI/UX prototypes or design mockups (e.g. `*-designs.html`, `*-mockup.html`, `*-demo(s).html`) at the repo root or under a `design/` folder. The only tracked `.html` files should be Vite `index.html` entrypoints.
  Before committing or opening a PR, run `git status` and `git diff --staged --stat` and remove anything matching these patterns. Put scratch work under `.tmp/` (gitignored) instead of the repo root or the source tree.
