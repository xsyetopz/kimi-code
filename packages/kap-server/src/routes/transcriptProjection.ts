import { errEnvelope } from "../envelope";
import { ErrorCode } from "../protocol/error-codes";
import type {
  TranscriptAttachment,
  TranscriptItem,
  TurnOrigin,
  TurnState,
} from "@moonshot-ai/transcript";

interface UserMessageEntry {
  turn_id: string;
  ordinal: number;
  state: TurnState;
  origin: TurnOrigin;
  prompt: string;
  attachment_ids?: readonly string[];
  started_at?: string;
}

/**
 * Project the user messages out of one agent's full timeline: every turn with
 * a defined prompt, in timeline order. `resolveAttachment` looks up the
 * referenced entities (live: the store's attachment map; cold: the snapshot's
 * array) so the response carries their metadata alongside the ids.
 */
export function projectUserMessages(
  items: readonly TranscriptItem[],
  resolveAttachment: (id: string) => TranscriptAttachment | undefined,
): { messages: UserMessageEntry[]; attachments: TranscriptAttachment[] } {
  const messages: UserMessageEntry[] = [];
  const attachments = new Map<string, TranscriptAttachment>();
  for (const item of items) {
    if (item.kind !== "turn" || item.prompt === undefined) continue;
    messages.push({
      turn_id: item.turnId,
      ordinal: item.ordinal,
      state: item.state,
      origin: item.origin,
      prompt: item.prompt,
      attachment_ids: item.attachmentIds,
      started_at: item.startedAt,
    });
    for (const id of item.attachmentIds ?? []) {
      const attachment = resolveAttachment(id);
      if (attachment !== undefined) attachments.set(id, attachment);
    }
  }
  return { messages, attachments: [...attachments.values()] };
}

export function sendSessionNotFound(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  sessionId: string,
): void {
  reply.send(
    errEnvelope(
      ErrorCode.SESSION_NOT_FOUND,
      `session not found: ${sessionId}`,
      requestId,
    ),
  );
}

export function sendToolCallNotFound(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  toolCallId: string,
): void {
  reply.send(
    errEnvelope(
      ErrorCode.TOOL_CALL_NOT_FOUND,
      `no ExitPlanMode tool call found for tool_call_id: ${toolCallId}`,
      requestId,
    ),
  );
}
