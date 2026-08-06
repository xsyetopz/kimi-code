# Implementation Notes

## Testing Strategy

- **Unit**: Port pi-tui's component tests to React `jest` fixtures. Use `@testing-library/react` to verify render outputs match expected string lines.
- **E2E**: Run kimi-code CLI against recorded sessions; assert TUI output equals baseline (pixel match conceptually — actual string compare across sanitizer variations).
- **Regression**: Keep `packages/pi-tui/` alive as stub until full parity proven; run both renderers side-by-side on sample transcripts to assert feature equivalence.
- **Performance**: Use `node --expose-gc`, `0x` probes, `perf` to measure startup + response time delta vs baseline.

## Platform Variance

- **macOS**: Primary test matrix. PTY + kitty images + hardware cursor work as expected.
- **Linux**: Test with `xterm-256color` + Kitty, Alacritty, iTerm2.
- **Windows**: Run in Git Bash with `winpty`; test w/o `-p` flag to fail early on native Windows console not-full PTY support.
- **Termux**: Use `fauxtty` (requires PTY emulation) or fallback to Ink's fallback rendering.

## Expected Timeline

- **Week 1**: Fix archived v2 compaction overflow classification (baseline data)
- **Week 2-3**: Implement React+Ink TUI renderer core, port editor + overlay components
- **Week 4**: Parity verification (all interactive paths covered, tests green)
- **Week 5**: Wire provider-auth registry using official boundaries
- **Week 6**: Remove vetted legacy v1 footprints after user approval
- **Week 7**: Final CI scrub + release notes

## Rollback Plan

- Keep `packages/pi-tui/` at its pre-migration commit (`7859b0af`) in a buggy-branch until parity is final.
- If migration regressions detected, cut a revert branch, monitor CI, and follow `/skill:kf-ci-green`.

## Dependencies and Compatibility

- **React**: version latest (`18.x` for server-side, or `19.x` if line length constraints permit)
- **Ink**: latest 5.x (stable, preserves server-side rendering)
- **react-kitty-images**: monitor upstream; treat as optional (fallback to CSI)
- **agent-core-v2**: must NOT depend on React/Ink. TUI uses `@moonshot-ai/klient` over `@moonshot-ai/kap-server`.

## De facto ownership redistribution

- **kimi-web**: continues to own browser rendering (Vue 3 + Vite)
- **vis**: continues to own browser-based debugging (React + Vite)
- **TUI**: new React+Ink renderer in `packages/ink-renderer/` or under `apps/kimi-code/src/renderer/`
- **API layer**: `packages/kap-server` unchanged; exposes REST + WebSocket; no change to wire protocol
- **transcript**: unchanged; `packages/transcript` drives both renderers

## Post-migration cleanup triggers

- **Remove**: `packages/pi-tui/` after all TUI commands tested + parity verified
- **Keep**: `packages/ink-renderer` (or `packages/ink-tui`) as reusable component library
- **Deprecate**: Legacy v1 stubs in `packages/agent-core` after feature parity achieved (tracked in changelog as minor bump)
