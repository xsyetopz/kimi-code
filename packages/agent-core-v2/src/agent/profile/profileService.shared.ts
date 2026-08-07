/**
 * `profile` domain — shared profile state keys and warning helpers.
 */

import { defineState } from '#/_base/state/stateRegistry';
import type { InactiveToolPattern } from '#/agent/toolPolicy/toolPattern';

export interface WarningEvent {
  readonly type: 'warning';
  readonly message: string;
  readonly code?: string;
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    warning: WarningEvent;
  }
}

export export export function describeInactiveToolPattern(
  context: string,
  field: string,
  issue: InactiveToolPattern,
): string {
  switch (issue.kind) {
    case 'unknown-tool':
      return `Tool pattern "${issue.pattern}" in ${context} ${field} does not match any registered or built-in tool; it will never activate anything.`;
    case 'wildcard-not-mcp':
      return `Tool pattern "${issue.pattern}" in ${context} ${field} uses wildcards, which only match MCP tools (names starting with "mcp__"); it will never activate anything.`;
    case 'incomplete-mcp-name':
      return `Tool pattern "${issue.pattern}" in ${context} ${field} matches no tool; use "${issue.pattern}__*" to match the whole MCP server.`;
  }
}

export const PLUGIN_SECTIONS_MAX_BYTES = 64 * 1024;

export const profileActiveToolNamesOverlayKey = defineState<readonly string[] | undefined>(
  'profile.activeToolNamesOverlay',
  () => undefined as readonly string[] | undefined,
);
export const profileAgentsMdWarningKey = defineState<string | undefined>(
  'profile.agentsMdWarning',
  () => undefined as string | undefined,
);
export const profileEmittedThinkingEffortWarningsKey = defineState<Set<string>>(
  'profile.emittedThinkingEffortWarnings',
  () => new Set(),
);
export const profileEmittedToolPatternWarningsKey = defineState<Set<string>>(
  'profile.emittedToolPatternWarnings',
  () => new Set(),
);
export const profileEmittedPluginBudgetWarningsKey = defineState<Set<string>>(
  'profile.emittedPluginBudgetWarnings',
  () => new Set(),
);

