# Modernization Campaign Goal

## Objective

Modernize the Kimi Code TUI renderer and provider registry infrastructure while preserving kimi-web and vis functionality, verify all changes with concrete tests, and remove only officially vetted legacy code paths.

## Completion Standard

Goal is complete when ALL these hold:
1. TUI uses React+Ink renderer with coverage parity proof (>95% measured by runtime checks across all interactive paths)
2. kimi-web and vis maintain current browser ownership and functionality
3. Provider-auth integrations use official boundaries (OpenAI Codex, GitHub Copilot, OpenCode Zen + Kimi wiring)
4. All legacy/unnecessary v1 footprints removed via approval
5. All tests pass and antipatterns cleared

## Success Metrics

- TUI renderer parity: New renderer passes all existing TUI tests + runtime verification probe covers ≥95% of interactive paths
- No duplicates: For each retained feature, there is a single responsible renderer (React/Ink vs browser)
- Performance: Startup latency within 15% of current v2 baseline (measured by perf harness)
- Compatibility: No breaking changes to kimi-web, vis, or SDKs beyond vetted removals

## Hard Rules

- Do NOT remove code without documented approval (commit message, review, or documented decision)
- Do NOT gate breaking changes behind experimental flags without user consent
- Breaking changes → `major` bump → changeset + user confirmation
- Deprecations → `minor` bump → separate deprecation branch with migration path

## Anti-Patterns to Eliminate

- Dual-tracking: Same feature implemented in multiple renderers (resolve to single source)
- Orphaned calls: Functions or modules introduced but never called
- Unsynchronized flags: Runtime features gated by flags missing in Config
