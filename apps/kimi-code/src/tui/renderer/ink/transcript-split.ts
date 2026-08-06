import type { TranscriptEntry } from "../../types";
import type { TerminalViewState } from "./terminal-view-state";

export interface InkTranscriptSplit {
  readonly staticEntries: readonly TranscriptEntry[];
  readonly liveEntries: readonly TranscriptEntry[];
}

function isTranscriptFullyFrozen(view: TerminalViewState): boolean {
  if (view.app.isCompacting || view.app.isReplaying) return false;
  if (view.app.streamingPhase !== "idle") return false;
  if (view.activity.mode !== "idle" && view.activity.mode !== "session") {
    return false;
  }
  if (view.livePane.mode !== "idle") return false;
  return true;
}

function resolveLiveTranscriptStartIndex(
  transcript: readonly TranscriptEntry[],
): number {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (entry?.kind === "user") {
      return index + 1;
    }
  }
  return 0;
}

/**
 * Split transcript rows for Ink's `<Static>` layer. Frozen history is appended
 * once into scrollback; the current turn tail stays in the dynamic frame so
 * streaming updates do not rewrite earlier output.
 */
export function splitInkTranscript(view: TerminalViewState): InkTranscriptSplit {
  const transcript = view.transcript;
  if (transcript.length === 0) {
    return { staticEntries: [], liveEntries: [] };
  }

  // Ctrl-O expand mutates older tool rows; keep them in the dynamic frame.
  if (view.toolOutputExpanded) {
    return { staticEntries: [], liveEntries: transcript };
  }

  if (isTranscriptFullyFrozen(view)) {
    return { staticEntries: transcript, liveEntries: [] };
  }

  const staticCount = resolveLiveTranscriptStartIndex(transcript);
  return {
    staticEntries: transcript.slice(0, staticCount),
    liveEntries: transcript.slice(staticCount),
  };
}
