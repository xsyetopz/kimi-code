import type { BadgeTone } from "../components/Badge.tsx";

/** Minimal turn state union mirrored from @moonshot-ai/transcript. */
export type TurnState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** Duck-typed turn row accepted by list adapters (no runtime transcript import). */
export interface TranscriptTurnLike {
  readonly kind: "turn";
  readonly turnId: string;
  readonly ordinal: number;
  readonly state: TurnState;
  readonly origin: { readonly kind: string };
  readonly prompt?: string;
}

/** Duck-typed agent state slice for turn list projection. */
export interface AgentStateLike {
  readonly items: readonly TranscriptTurnLike[];
}

/** Lightweight row model for transcript turn lists in React hosts. */
export interface TurnListItem {
  turnId: string;
  ordinal: number;
  state: TurnState;
  originKind: string;
  promptPreview: string;
}

const TURN_STATE_TONE: Record<TurnState, BadgeTone> = {
  queued: "neutral",
  running: "accent",
  completed: "success",
  failed: "error",
  cancelled: "warning",
};

/** Map a transcript turn state to a shared Badge tone. */
export function turnStateBadgeTone(state: TurnState): BadgeTone {
  return TURN_STATE_TONE[state];
}

function previewPrompt(prompt: string | undefined, max = 120): string {
  if (!prompt) return "";
  const trimmed = prompt.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/** Project a transcript-like state into compact turn rows for list UIs. */
export function listTurnsFromState(state: AgentStateLike): TurnListItem[] {
  const rows: TurnListItem[] = [];
  for (const item of state.items) {
    if (item.kind !== "turn") continue;
    rows.push({
      turnId: item.turnId,
      ordinal: item.ordinal,
      state: item.state,
      originKind: item.origin.kind,
      promptPreview: previewPrompt(item.prompt),
    });
  }
  return rows;
}
