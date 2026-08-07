import { safeGetString, safeSetString, STORAGE_KEYS } from "../../../lib/storage";
import type { PermissionMode } from "../../../types";

export const ACTIVE_WORKSPACE_KEY = STORAGE_KEYS.activeWorkspace;
export const PLAN_MODE_STORAGE_KEY = STORAGE_KEYS.planMode;
export const SWARM_MODE_STORAGE_KEY = STORAGE_KEYS.swarmMode;
export const GOAL_MODE_STORAGE_KEY = STORAGE_KEYS.goalMode;
export const HIDDEN_WORKSPACES_KEY = STORAGE_KEYS.hiddenWorkspaces;

export function loadPermissionFromStorage(): PermissionMode {
  try {
    const v = safeGetString(STORAGE_KEYS.permission);
    if (v === "auto" || v === "yolo" || v === "manual") return v;
  } catch {
    // localStorage not available (e.g. jsdom without config)
  }
  return "manual";
}

export function loadModeMapFromStorage(key: string): Record<string, boolean> {
  const raw = safeGetString(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const out: Record<string, boolean> = {};
    for (const [id, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (value === true) out[id] = true;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadActiveWorkspaceFromStorage(): string | null {
  try {
    return safeGetString(ACTIVE_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

export function loadHiddenWorkspacesFromStorage(): string[] {
  try {
    const v = safeGetString(HIDDEN_WORKSPACES_KEY);
    if (!v) return [];
    const parsed = JSON.parse(v);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export function savePermissionToStorage(mode: PermissionMode): void {
  try {
    safeSetString(STORAGE_KEYS.permission, mode);
  } catch {
    // ignore
  }
}

function saveModeMapToStorage(key: string, map: Record<string, boolean>): void {
  try {
    const out: Record<string, true> = {};
    for (const [id, value] of Object.entries(map)) {
      if (value) out[id] = true;
    }
    safeSetString(key, JSON.stringify(out));
  } catch {
    // ignore
  }
}

export function savePlanModeToStorage(
  planModeBySession: Record<string, boolean>,
): void {
  saveModeMapToStorage(PLAN_MODE_STORAGE_KEY, planModeBySession);
}

export function saveSwarmModeToStorage(
  swarmModeBySession: Record<string, boolean>,
): void {
  saveModeMapToStorage(SWARM_MODE_STORAGE_KEY, swarmModeBySession);
}

export function saveGoalModeToStorage(
  goalModeBySession: Record<string, boolean>,
): void {
  saveModeMapToStorage(GOAL_MODE_STORAGE_KEY, goalModeBySession);
}

export function saveHiddenWorkspacesToStorage(roots: string[]): void {
  try {
    safeSetString(HIDDEN_WORKSPACES_KEY, JSON.stringify(roots));
  } catch {
    // ignore
  }
}

export function saveActiveWorkspaceToStorage(id: string): void {
  try {
    safeSetString(ACTIVE_WORKSPACE_KEY, id);
  } catch {
    // ignore
  }
}

/** Shorten a $HOME-prefixed absolute path to `~/…` for dim display. */
export function shortenHome(path: string, home: string | null): string {
  if (home && path.startsWith(home)) {
    const rest = path.slice(home.length);
    return rest ? `~${rest}` : "~";
  }
  const m = path.match(/^\/(?:Users|home)\/[^/]+(\/.*)?$/);
  if (m) return `~${m[1] ?? ""}`;
  return path;
}
