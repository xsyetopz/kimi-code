# agent-core-v2 Agent Guide

> Agent engine built on the DI Scope architecture.

## Scopes

Four `LifecycleScope` tiers — `App` (0) / `Workspace` (1) / `Session` (2) / `Agent` (3) (`src/_base/di/scope.ts`). The `workspace/` domain owns the Workspace tier: the App-scope `workspaceLifecycle` holds the live handler registry (one handler per workspaceId, create-or-get + join, never closed), and each handler's `sessionLifecycle` owns the session lifecycle (create/resume/fork/close/delete) as its child scopes. Workspace-scope services (`workspaceSkillCatalog` / `workspaceAgentProfileLoader` / `workspaceInstructions` / `workspaceMcp` / `workspaceDirs` / `workspaceFs` / `workspaceFsWatch` / `workspaceProcess` / `workspaceGit` / `workspaceToolPolicy` / `workspaceTrust`) hold the handler-shared resources — loaded once at handler materialization, then refreshed by fs watch — and sessions consume them through session-domain seed contracts with change events. A session created with `CreateSessionOptions.mcpServers` additionally gets ephemeral per-session MCP servers: `workspaceMcp.sessionOverlay` builds a session-owned manager for them (never persisted, invisible to the handler's other sessions, not gated by `workspaceTrust`), the session's `ISessionMcpHandle` seed carries a `session/mcp` `MergedMcpConnectionView` over the shared manager and the overlay (an ephemeral name shadows a workspace server for that session), and `sessionLifecycle` shuts the overlay down when the session handle disposes (backstopped by the lifecycle service's own dispose for teardown paths that bypass the handle wrapper). Agent profiles follow the Contribution / Registry / Catalog extension point instead of a workspace catalog: the `workspaceAgentProfileLoader` domain owns agent-file discovery end to end (parse / roots / SYSTEM.md / explicit runtime files) and its Workspace-scope loaders (`workspace` / `user` / `plugin` / `extra` / `explicit`) register `AgentProfileContribution`s into the App-scope `IAgentProfileRegistry`, tagged with the handler's `workspaceId` (the registry dedups per source id; the App-scope `builtinAgentProfileLoader` contributes the code-defined profiles), and each Session-scope `sessionAgentProfileCatalog` projects the registry into the merged, name-deduped read view directly — its seed carries only the workspace key. `workspaceTrust` records the per-workspace trust marker (persisted under the home, keyed by `encodeWorkDirKey(root)`); while untrusted, `workspaceMcpConfig` skips the project-level MCP config files (`.mcp.json`, `.kimi-code/mcp.json`). The old App-level session-lifecycle facade and `ISessionMcpService` / `ISessionFsService` are gone — compose `sessionIndex` → `workspaceLifecycle.handlerFor` → the handler instead.

## Examples

> The runnable examples have moved to the standalone `kimi-code-mini-bench` package at `../kimi-code-mini-bench`. They are wired to `agent-core-v2` through a bun `link:` dependency and run as a separate Vitest project.

Domain-slice scenarios that used to live in `examples/<name>.example.ts` are now maintained there. Each `*.example.ts` exercises one subset of domains end-to-end, builds its own container, runs its slice's services for real, and stubs collaborators outside the slice. See `../kimi-code-mini-bench/README.md` for how to run them.

## Comment conventions

- **Header only, external role only.** Comments live solely in the top-of-file `/** */` block — never beside functions, methods, or statements. Say what the module exposes and the responsibility it owns; the code is the source of truth for how it works, so do not narrate implementation steps, enumerate every export, or note porting / skeleton status.
- **Identity line first.** Start with `` `<domain>` domain — <one-line role>. `` Keep an existing `(cross-cutting)` label as-is. Write the role as a responsibility ("drives the turn lifecycle"), not a symbol list ("turn driver + context + loop runner").
- **Impl files add collaborators + scope; contract files add the public contract + scope.** For impls, list every imported cross-domain collaborator as a role ("persists records through `records`") — declared dependencies count even if not yet wired in this WIP port; infrastructure imports (`_base/**`) are not collaborators. Read scope from `registerScopedService(LifecycleScope.X, …)`.

### Examples

Impl (`src/session/sessionMetadata/sessionMetadataService.ts`):

```ts
/**
 * `sessionMetadata` domain — `ISessionMetadata` implementation.
 *
 * Persists the session metadata document (`state.json`) through the `storage`
 * access-pattern store (`IAtomicDocumentStore`), rooted at the `metaScope`
 * namespace from `sessionContext`. Loads the existing document on
 * construction (creating it on first run), and logs through `log`. Bound at
 * Session scope.
 */
```

## Persistence

Business domains **do not implement persistence themselves** — they depend on a Service that owns the access pattern. Business code expresses *what* to store or fetch, never *how*.

- Append-log → `IAppendLogStore`
- Atomic document → `IAtomicDocumentStore`
- Blob → `IBlobStore`
- Domain-specific query → a dedicated Store (e.g. `ISessionIndex`)

Business code must not `import 'node:fs'`, write SQL, hand-roll append-logs / atomic writes, or hold file handles. Generic Stores are named by **access pattern** (`IAppendLogStore`, `IAtomicDocumentStore`); only domain-unique Stores are named after the domain (`ISessionIndex`). See `.agents/skills/agent-core-dev/persistence.md` for the full layering rules and decision tree.

## Conversation undo

`context.undo` is the only persisted undo fact. `contextMemory/conversationTime.ts` owns the conversation clock (`isUndoAnchor` — the single tick predicate used by `computeUndoCut`, the checkpoint reducers, and the transcript reducer) and the checkpoint protocol. A wire Model whose state must follow conversation undo (todo, plan, task-notification delivery, …) **MUST** be defined with `defineCheckpointedModel` — never hand-roll the push/clear/restore reducers — which also registers it into `CHECKPOINTED_MODELS` for the undo pipeline's pre-cut depth check. World-time state (turn counters, task registries, revision counters) must stay outside checkpointed Models.

## Docs

Per-domain references live in `docs/`.

- [`docs/di.md`](docs/di.md) — Read **before adding any business capability**: a scenario-driven walkthrough of the DI × Scope black box, from "add a global service" through dependency injection, scope selection, disposal, delayed/eager instantiation, `invokeFunction`, `createInstance`, child scopes, and cycles — introducing each concept only as the scenario needs it.
- [`docs/service-design.md`](docs/service-design.md) — Read **before designing a new Service**: first-principles rules for choosing a scope, splitting a domain Multi-Scope, picking a calling style (direct call vs event vs veto event vs hook), and directing dependencies — the design companion to `docs/di.md`.
- [`docs/flag.md`](docs/flag.md) — Read **before gating behavior behind a feature flag**: declaring a flag in its owning domain and registering it at import time via `registerFlagDefinition`, checking `IFlagService.enabled(id)`, wiring the `[experimental]` config section, or deciding whether a flag is App-scope vs. per-session.
- [`docs/errors.md`](docs/errors.md) — Read **before raising errors from a domain**: defining a co-located `XxxError`, registering a code in `ErrorCodes`/`ERROR_INFO`, translating external errors (provider/HTTP, fs, MCP) at the boundary, or (de)serializing errors across RPC/SDK with `toErrorPayload`/`fromErrorPayload`.
- [`docs/di-testing.md`](docs/di-testing.md) — Read **before writing or touching any DI/Scope test**: picking the right harness (`InstantiationService` vs `TestInstantiationService` vs `createScopedTestHost`), declaring deps with `@IService`, stubbing collaborators, and teardown via `DisposableStore`.
- [`docs/config-manifest.toml`](docs/config-manifest.toml) — Generated list of every registered config section, in the on-disk `config.toml` shape (owner, scope, defaults, env bindings, schema fields). Do not edit by hand; regenerate with `bun run gen:config-manifest` after adding or removing a `registerConfigSection` call — `test/app/config/configManifest.test.ts` enforces freshness.
- [`docs/wire-manifest.d.ts`](docs/wire-manifest.d.ts) — Generated declaration file listing every registered wire record type as a payload interface (model, persist policy, `toEvent`, cross-reducers in the doc comment; payload fields in real TS type syntax), plus a `WirePayloadMap`. Do not edit by hand; regenerate with `bun run gen:wire-manifest` after adding or removing a `defineOp` call — `test/wire/wireManifest.test.ts` enforces freshness and checks the file parses.
- [`docs/state-manifest.d.ts`](docs/state-manifest.d.ts) — Generated declaration file listing every state key registered into `IAppStateService` / `IWorkspaceStateService` / `ISessionStateService` / `IAgentStateService`, as `AppStateSnapshot` / `WorkspaceStateSnapshot` / `SessionStateSnapshot` / `AgentStateSnapshot` interfaces (keys grouped by defining file), plus the `AppStateKey` / `WorkspaceStateKey` / `SessionStateKey` / `AgentStateKey` unions. Self-contained: every value type is expanded fully inline with each named type marked by a `/* TypeName — source/file.ts */` comment (recursion stops with a `recursive` marker) — no imports, no helper declarations. Do not edit by hand; regenerate with `bun run gen:state-manifest` after adding or removing a `states.register(...)` call — `test/state/stateManifest.test.ts` enforces freshness and checks the file parses.
