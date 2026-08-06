# TUI Migration: pi-tui → React+Ink

## Source → Target Mapping

| Source (pi-tui) | Target (React+Ink) | Notes |
|---|---|---|
| `Component` interface (`render(width)`, `handleInput`, `invalidate`) | `InkRenderable` or React component with `useTerminalDimensions` | Ink's `<Static>` renders once, must handle resize manually |
| `Container.render(width)` → recursive traversal | Root `<Box>` with chilren array | Use Ink's `<Parallax>` for scrollback, `<Box>` for layout |
| Hot-render loop (`requestRender`, `MIN_RENDER_INTERVAL_MS`) | Ink's `<Static>` + React `<PortalAsync>` in render output | No external event loop; rely on React's reconcile cycle |
| In-flight cursor positioning (`CURSOR_MARKER`) | Ink's `<Cursor>` component or manual cursor style | Use `<Box style={{ borderBottomWidth: 1, borderBottomColor: 'red' }}>` |
| Overlay stack (focus capture, z-index simulated) | React conditional rendering + focus state (Z-index via `order` prop) | Overlay `<Box>` positioned absolute modally |
| Kitty image sequences (`\x1b_G i=... r=...`) | `react-kitty-images` or custom `ink-gradient` integration | deps: `react-kitty-images` (but monitor for upstream deprecation) |

## Type Correspondence

| Source Type | Target Type |
|---|---|
| `width: number` → `viewportWidth: number` | Ink hook: `useWindowDimensions()` (returns `{ height, width }`) |
| `lines: string[]` | `lines: FlowNode[]` or `text: string[]` (Ink's `Flattext` renders string lines) |
| `InputListener` (function returning `{consume?, data?}`) | Ink's `<Box inputMode="textInputOrAny" onChangeText={callback}>` + `useInput` hook |
| `Focusable` + `focused: boolean` | Ink's `useInput` with `key` + active state from runtime context |

## Control Flow

**Source flow:**
1. User input → `stdin` → `Terminal.handleInput()` → `TUI.handleInput()`
2. Dispatch to `focusedComponent.handleInput()` or global listeners
3. `requestRender()` → `scheduleRender()` → debounce → `doRender()`
4. `doRender()` calls each child's `render(width)` → builds `previousLines`, `previousRawLines`
5. Differential render: compare raw string refs, reuse processed output for unchanged lines

**Target flow:**
1. React renders `<Commit>` (Ink's root commit) on mount/resize
2. User input → `useتابهر("(Ctrl+C)")` or `useInput` hook → handlers
3. Handlers call `updateState({viewportWidth})` + unwind reducers to drive new render
4. Reconciliation: React diff, static content pulled into `<Static>`
5. Kitty images: React portal → terminal node, `useLayoutEffect` uses `react-kitty-images` or direct CSI sequence injection

## State Synchronization

- **Differential rendering** is NOT ported 1:1. Ink's `<Static>` caches subcomponents by `id`, not raw string refs.
- Instead, move per-frame optimization to **render-ancillary data**: serialize terminal metadata (cursor, scrollback range, overflow hints) to the runtime context; components read metadata instead of recomputing.
- Persisted scrollback `previousRawLines` → `session.transcript` (already owned by packages/transcript). TUI just streams transcript updates via `poll` or WebSocket.

## Known Traps

1. **No runtime loop**: Ink renders on commit, never fires a dedicated "tick" that matches pi-tui's 16ms optimum. Accept slower, provide tunable `RENDER_THROTTLE_MS`.
2. **Editor component**: Need to port `editor-component.ts`'s line-aware editing to `react-textarea-autosize` + inline cancellation keyframes.
3. **Overlay focus**: Ink doesn't have a native z-index/overlay stack; simulate with markup order + explicit focus tracking in the runtime context.
4. **Kitty images**: `react-kitty-images` package may be unmaintained; treat as optional fallback to raw CSI injection.

## Performance Constraints

- Startup latency ≤ 15% of v2 baseline (measure with `node --expose-gc` perf harness)
- Frame budget: 16ms early, relax to 100ms on resize events
- Memory: ≤ 50MB for scrollback history cache (already enforced by transcript max size)

## Platform Mismatches

- **Windows**: pi-tui wraps native console; React+Ink renders into terminal emulator. Test with `winpty` and native PTY.
- **macOS/Unix**: standard PTY; expect parity.
- **Termux**: `react-kitty-images` fallback required, use `CLSAG` or fallback CSI.

## Compatibility Discontinuities

- **Differential line reuse**: `previousRawLines` reference-check removed. Replace with incremental transcript diffing.
- **Escape sequence timings**: pi-tui's debouncing/caching may tighten; adapt `requestRender()` to React's `useEffect` timing.
- **API surface**: `TUI.dispatchInput()` migrates to `Runtime.dispatchInput()` in server; CLI expects same method name.
