# Contributing to kimi-code

Thanks for taking the time to contribute! This project moves quickly, and thoughtful contributions from the community are what keep it sharp. The guide below walks you through how we work so your PR has the best chance of landing smoothly.

## Before You Start

Kimi Code already has opinions on CLI/TUI behavior, agent workflows, and public APIs. If your change shifts that direction, open an issue first so we can align before you invest time in a PR.

We hold AI-assisted contributions to the same standard as hand-written ones. **You should understand what you submit** — what changed, how it behaves at the edges, and why it fits this codebase. If you cannot explain that, the PR is not ready for review.

We only merge PRs aligned with the roadmap. Drive-by refactors without context are unlikely to land.

**Discuss first** — open an issue before coding. PRs without prior discussion may be closed without review:

- New features or user-visible behavior changes (regardless of size)
- Refactors or other changes larger than ~100 lines
- Public API or compatibility changes
- Bug fixes where the cause or fix approach is still unclear

**Can open a PR directly** — link an existing issue when there is one:

- Clear, reproducible bug fixes with a focused diff
- Typos, documentation-only changes, and small CI/build fixes
- Small changes that clearly match an existing issue or maintainer request

## Project Layout

This is a bun workspaces monorepo. The product is a **CLI / TUI harness only** — see [ARCHITECTURE.md](ARCHITECTURE.md) for the north star. The most relevant entry points are:

- `apps/kimi-code` — CLI / TUI (the only app host)
- `packages/node-sdk` — public TypeScript SDK (`@moonshot-ai/kimi-code-sdk`)
- `packages/agent-core-v2`, `klient`, `kimi-tui`, `kosong`, `kaos`, `oauth`, `transcript` — engine and harness packages
- `docs/` — VitePress bilingual docs site

For the full project map, see [AGENTS.md](AGENTS.md).

## Development Setup

Prerequisites: Node.js >= 24.15.0, bun 1.3.14, Git.

```sh
git clone https://github.com/MoonshotAI/kimi-code.git
cd kimi-code
bun install
```

Useful scripts:

- `bun dev:cli` — run the CLI in dev mode
- `bun test` — run tests (vitest)
- `bun typecheck` — TypeScript check (note: builds packages first)
- `bun lint` — TypeScript check (alias for `bun typecheck`)
- `bun lint:fix` — format and organize imports (Biome, no lint rules)
- `bun format` — format only (Biome)
- `bun build` — build all packages

## Commit Convention

All commits and PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/).

| Type     | Use for                                     | Example                                   |
|----------|---------------------------------------------|-------------------------------------------|
| feat     | A new feature                               | feat(agent-core): add tool dedup          |
| fix      | A bug fix                                   | fix(tui): correct status bar alignment    |
| docs     | Documentation only                          | docs: clarify install instructions        |
| chore    | Tooling / housekeeping                      | chore: bump dependencies                  |
| refactor | Internal refactor without behavior change   | refactor(kosong): extract retry helper    |
| test     | Adding or improving tests                   | test(agent-core): cover skill resolver    |
| ci       | CI / build pipeline changes                 | ci: cache bun install                     |
| build    | Build system / artifact changes             | build(native): add win32-arm64 target     |
| perf     | Performance improvement                     | perf(session): batch event flushes        |
| style    | Formatting only (no logic)                  | style: apply biome format                 |

PR titles are enforced by the `pr-title-checker` workflow — a non-conforming title will block merge.

## Changesets

This repo uses [changesets](https://github.com/changesets/changesets) to manage versioning and releases.

- Every PR that affects release artifacts (code, behavior, public API) **must** include a changeset.
- Docs-only, test-only, or CI-only PRs may skip changesets.
- Generate one with `bun changeset` and follow the prompts (which packages are touched, which bump level).
- For repo-specific conventions on package selection and bump levels, see `.changeset/README.md`. When working in this repo with coding agents, use the `gen-changesets` skill.

## Pull Requests

Use the [PR template](.github/pull_request_template.md) when opening a feature pull request.

PR titles must follow [Conventional Commits](#commit-convention); CI runs `bun lint`, `bun typecheck`, and `bun test` on every PR. Update user-facing docs in `docs/` when behavior changes — use the `gen-docs` skill when working with coding agents.

## Code Style

- TypeScript across the codebase.
- CI gates on `bun typecheck` (strict `tsconfig.base.json`: unused locals/parameters, implicit returns, and related checks).
- Formatting and import organization via Biome (config in `biome.jsonc`); run `bun format` or `bun lint:fix` on demand — not enforced in CI.
- Follow existing local patterns when formatting does not cover a style choice.

## Reporting Security Issues

Found a security issue? Please see [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

By contributing to this repository, you agree that your contributions will be licensed under the [MIT License](LICENSE).
