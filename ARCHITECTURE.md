# Architecture Report: Minimal Agentic Harness

- Date: 2026-08-07
- Status: Accepted
- Rigor: R3
- Branch: `chore/bun-biome-ts7`

## 1. Task Contract

### Objective

- `OBJ-001` — Reduce the product to a proper agentic harness with a minimal footprint while preserving agent capability.
- `OBJ-002` — CLI (`apps/kimi-code`) and TUI (Ink in `apps/kimi-code`, primitives in `packages/kimi-tui`) are the only product surfaces.
- `OBJ-003` — Enforce ≤800 LOC per source file (no formatting tricks) and acyclic package deps.
- `OBJ-004` — Target ~200K–250K LOC for the harness product line (source, excluding tests/generated).

### Requirements

- `REQ-001` — Keep top-level package directory names; rewrite internals.
- `REQ-002` — Idiomatic ES6+ TypeScript; capability modules over helper colonies.
- `REQ-003` — Strip novelty users of a harness never need (telemetry cloud pipeline, easter eggs, design-system demo chrome, browser UIs).
- `REQ-004` — Function and behaviour over prose; rollbackable git slices.
- `REQ-005` — CI rework deferred until product slices land.

### Constraints

- `CON-001` — Hard max 800 LOC / file.
- `CON-002` — Max ~3–4 parallel workers per wave.
- `CON-003` — Do not thrash lint/format during migration.
- `CON-004` — No cyclic dependencies across packages.

### Explicit exclusions

- `EXC-001` — CI pipeline rewrite (later).
- `EXC-002` — Publishing / release choreography changes.
- `EXC-003` — Rewriting tree-sitter-bash generated parser (vendor exception; keep out of product LOC budget accounting or isolate).

### Definition of done (program)

1. Ink TUI in `apps/kimi-code` backed by `packages/kimi-tui` terminal primitives; no browser hosts.
2. Telemetry cloud/novelty surfaces removed or reduced to a no-op interface.
3. No authored product source file >800 LOC (except documented vendor exceptions).
4. Product-line source LOC in 200K–250K.
5. Dependency graph acyclic under the direction below.
6. Each wave committed as a rollbackable slice.

## 2. Evidence

| ID | Class | Claim | Source | Impact |
|---|---|---|---|---|
| E-001 | FACT | Product source ≈408K LOC (excl. tests) | inventory 2026-08-07 | Must cut ~150–200K |
| E-002 | FACT | 98 files >800 LOC | inventory | Must split or delete |
| E-003 | FACT | Ink owns TUI stdout; pi-tui dual trees remain | `tui-lifecycle.ts`, audit | Dual maintenance |
| E-004 | FACT | Telemetry domain ≈2.1K LOC + call sites | `agent-core-v2/src/app/telemetry` | Novelty strip target |
| E-005 | USER | CLI⇔TUI only; drop web/vis/inspect apps | user directive | Delete browser hosts |
| E-006 | USER | Keep package dir names; change internals | user directive | No new top-level package names |
| E-007 | USER | CI after product | user directive | Do not block on CI |

## 3. Domain and Boundary Model

### Vocabulary

| Term | Definition |
|---|---|
| Harness | Agent runtime + thin CLI/TUI client; no product analytics / novelty chrome |
| Ink host | `apps/kimi-code` TUI that renders via Ink |
| API server | `kimi web` — foreground kap-server (REST + WebSocket); no bundled UI |
| Engine | `packages/agent-core-v2` DI×Scope agent runtime |

### Boundaries and owners

| Boundary | Responsibility | State owned | Contracts |
|---|---|---|---|
| `packages/agent-core-v2` | Agent/session/workspace/app services | Engine state, wire | Service interfaces, wire records |
| `packages/kap-server` | HTTP/WS edge | Live sessions, search | `/api/v1`, transcript ops |
| `packages/node-sdk` | Public harness SDK | Client session façade | SDK types |
| `packages/kimi-tui` | Terminal primitives + optional Ink adapters | None (pure view) | Component props, terminal I/O |
| `apps/kimi-code` | CLI + Ink host + `kimi web` | TUI coordinator state | CLI flags, Ink mount |
| `packages/transcript` | Transcript L1–L4 | None | Contract schemas |
| `packages/protocol` | Shared wire/error types | None | Types only |

### Dependency direction (acyclic)

```mermaid
flowchart TB
  CODE[apps/kimi-code] --> KIT[packages/kimi-tui]
  CODE --> SDK[packages/node-sdk]
  SDK --> KL[packages/klient]
  KL --> CORE[packages/agent-core-v2]
  KAP[packages/kap-server] --> CORE
  KAP --> TR[packages/transcript]
  CORE --> KO[packages/kosong]
  CORE --> KA[packages/kaos]
  CORE --> PROTO[packages/protocol]
  KIT -.->|types only| PROTO
```

Forbidden: `kimi-tui → agent-core-v2`, `agent-core-v2 → kimi-tui`, `kap-server → apps/*`.

## 4. Quality-Attribute Scenarios

| ID | Scenario | Measure | Priority |
|---|---|---|---|
| QA-001 | Open TUI, send prompt, see tool/swarm cards | Ink-only path; no pi-tui stdout | P0 |
| QA-002 | `kimi web` serves REST + WS API | No bundled browser UI | P0 |
| QA-003 | Build graph has no package cycles | `madge` / import check | P0 |
| QA-004 | Any new/edited product file ≤800 LOC | LOC gate (later CI) | P0 |
| QA-005 | Harness runs with telemetry disabled/absent | No cloud appenders; no network side effects | P1 |
| QA-006 | Product-line LOC ≤250K | Inventory script | P1 |

## 5. Candidates

### A — Do-less baseline

Keep dual Vue/React/pi-tui and browser apps. Liabilities: fails OBJ-002/003/004. **Rejected.**

### B — New UI package

Violates `REQ-001`. **Rejected.**

### C — CLI⇔TUI harness with API-only `kimi web` (**selected**)

- `packages/kimi-tui` — terminal primitives + Ink adapters
- `apps/kimi-code` — CLI, Ink TUI, foreground kap-server via `kimi web`
- Deleted: `apps/kimi-web`, `apps/vis`, `apps/kimi-inspect`

## 6. Source-topology ownership map (target)

| Path | Owner | Reason | Visibility | Lifecycle | Dependencies | Why separate |
|---|---|---|---|---|---|---|
| `packages/kimi-tui/src/ink/*` | TUI kit | Ink host adapters | public | TUI runtime | react, ink | Capability: Ink host |
| `packages/kimi-tui/src/terminal/*` | TUI kit | Low-level TTY primitives | public | TUI runtime | node tty | Capability: terminal I/O |
| `apps/kimi-code/src/tui/*` | CLI host | Coordinator, controllers | app-private | process | kimi-tui, sdk | Host wiring only |
| `apps/kimi-code/src/cli/sub/web/*` | CLI host | Foreground API server | app-private | process | kap-server | API-only edge |
| `packages/agent-core-v2/src/app/telemetry/*` | Engine | **No-op / delete cloud** | internal | process | none | Shrink to interface stub |
| `packages/kap-server/src/*` | Server | Edge transport | public HTTP | server | core, transcript | Edge boundary |

## 7. Migration sequence (waves)

| Wave | Slice | Rollback |
|---|---|---|
| 0 | This architecture commit | revert commit |
| 1 | Strip novelty: telemetry → no-op; delete easter eggs / tips chrome | revert commits |
| 2 | Scaffold `kimi-tui` `ink/` + terminal exports | revert commits |
| 3 | Split >800 LOC hot-path files | revert per file slice |
| 4 | **Delete web/vis/inspect apps; API-only `kimi web`** | revert |
| 5 | Delete dead pi-tui transcript dual path in kimi-code | revert |
| 6 | LOC budget pass + cycle check; then CI | — |

## 8. Novelty strip policy

**Remove / no-op**

- Cloud telemetry transport, event catalogs used only for product analytics, privacy upload pipeline
- TUI easter eggs (`dance`), rotating influencer tips
- Browser UIs (`kimi-web`, `vis`, `kimi-inspect`), bundled `dist-web` assets, TUI `/web` slash command, `kimi vis`
- Marketplace/CDN novelty not required for harness operation (evaluate per-call-site; keep real plugin install)

**Keep**

- Permission modes, tools, swarm, goals, MCP, skills, transcript, search, OAuth login (auth is functional)
- `kimi web` as foreground kap-server (REST + WebSocket)
- Experimental flags mechanism (thin)

## 9. File size policy

- Soft split trigger: 600 LOC. Hard fail: >800 LOC authored product source.
- Vendor exception list (must stay named): `packages/tree-sitter-bash/src/parser.ts` (generated grammar).
- Prefer capability splits (render / state / parse), never `helpers.ts` / `utils2.ts` colonies.

## 10. Verification (per wave)

- Focused vitest/bun tests for touched packages only (no full-repo lint thrash).
- LOC inventory script after each major wave.
- Import-boundary check: kimi-code ↛ agent-core-v2 (except temporary debt tracked for deletion).
- Architecture audit after topology waves (exclude generated `dist*` from tree or untrack them).

## 11. Rejected alternatives & evolution triggers

- Shared React kit across web/vis/TUI → rejected (`OBJ-002`).
- New UI package name → rejected (`REQ-001`).
- Keep full telemetry → rejected (`OBJ-001`).

Evolution triggers: LOC >250K again; new second UI framework; cycle detected; file >800 LOC introduced.

## 12. Rollback boundary

Every wave is one or more conventional commits on `chore/bun-biome-ts7`. No history rewrite. Wave N+1 does not start until Wave N compiles for its package filter.
