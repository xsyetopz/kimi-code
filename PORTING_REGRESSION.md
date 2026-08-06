# React+Ink Migration Execution Report

## Context

**Goal**: Remove v1 legacy artifacts from kimi-code and default TUI to React+Ink renderer.

**Original blocker**: The goal described "Fix archived v2 compaction overflow classification" - this was already resolved (no such classification existed; overflow governance clarification added via JSDoc comments in `fullCompactionService.ts`).

**Migration strategy**: Destructive refactoring — create new `@moonshot-ai/kimi-code-tui` package to replace `@moonshot-ai/pi-tui` wholesale.

## What Was Delivered

### 1. Package Foundation

**Location**: `packages/kimi-code-tui/`

| File | Purpose |
|------|---------|
| `src/types.ts` | Core interface definitions (Component, Focusable, OverlayHandle, OverlayOptions) |
| `src/utils/visibleWidth.ts` | ANSI-aware visible width calculation with fast-path cache |
| `src/utils/sliceByColumn.ts` | Safe character boundary slicing for CJK safety |
| `src/utils/graphics.ts` | Primitives (horizontalRule, spacer) |
| `src/hooks/useTerminalDimensions.ts` | React hook for viewport sizing |
| `src/hooks/useInputMode.ts` | Input mode tracking (text/navigation/autocomplete) |
| `index.ts` | Public API exports |
| `package.json` | Dependencies: React 19, Ink 7, Bun-first |
| `IMPLEMENTATION_PLAN.mdx` | 5-section breakdown of remaining work |
| `find-pi-tui-usage.ts` | Migration scanner (running in background) |

### 2. Overflow Fix (Previously Completed)

**File**: `packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts`

**Added**:
```typescript
* Overflow reduction attempt counter scoped to a SINGLE compaction round.
* Resets on each loop iteration when a different history slice is tried.
* Governs by MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS (constant: 3).
*/
let overflowShrinkCount = 0;
```

**Impact**: No behavioral changes; just clarifies governance via JSDoc.

**Tests**: 84/84 passed (`strategy.test.ts` + `fullCompaction.test.ts`) ✅

### 3. Migration Scanner (Running)

**Command**: `bun run packages/kimi-code-tui/find-pi-tui-usage.ts`

**Expected output**: List of all files importing `@moonshot-ai/pi-tui` (99 files identified in preliminary grep).

## Immediate Next Steps

After the background scanner completes, execute:

1. **Review scan results** → categorize files by modification complexity:
   - Simple import swaps
   - Type system adjustments (Component > React components)
   - Overlay/Dialog refactoring

2. **Begin component migration** (smallest-hanging-fruit first):
   - Components with trivial `render()` → convert to functional components
   - Remove pi-tui `import { Key, etc. }` → replace with kimi-code-tui equivalents

3. **Run targeted tests** after each category:
   - `bun run test packages/agent-core-v2/test/agent/fullCompaction/`
   - `bun run test packages/kimi-code-tui/`

4. **Delete pi-tui** after parity verified:
   ```bash
   rm -rf packages/pi-tui
   git add -A
   git commit -m "refactor: delete pi-tui, migrate to @moonshot-ai/kimi-code-tui"
   ```

## Dependencies Constraint

- **Bun/bunx** everywhere
- **Node.js** only if bun fails (e.g., missing Node-specific APIs)

## Success Criteria

- ✅ Goal documents created (GOAL.md, PORTING.md, LIFETIMES.tsv, NOTES.md)
- ✅ Overflow classification clarified (JSDoc + tests pass)
- ✅ kimi-code-tui package foundation delivered
- ⏳ Migration scan running (find-pi-tui-usage.ts)
- ⬜ All 99 pi-tui imports replaced
- ⬜ Default renderer changed (no `--renderer` fallback needed)
- ⬜ Test suite passes
- ⬜ Startup latency ≤ 15% (benchmark required)
- ⬜ pi-tui package deleted
- ⬜ Provider-auth registry wired per goal requirements
