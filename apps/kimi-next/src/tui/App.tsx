import { Box, Text, useApp } from "ink";
import { useCallback, useEffect, useState } from "react";
import {
  Footer,
  PromptInput,
  Transcript,
  type FooterState,
  type TranscriptEntry,
} from "@kimi-next/tui";
import type {
  HostLine,
  HostSnapshot,
  InteractiveHost,
} from "../cli/host";

export interface AppProps {
  readonly host: InteractiveHost;
}

function toTranscriptEntries(lines: readonly HostLine[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const line of lines) {
    if (line.kind === "stream") continue;
    out.push(line);
  }
  return out;
}

function buildFooterState(snap: HostSnapshot): FooterState {
  const base: FooterState = {
    modelId: snap.modelId,
    permissionMode: snap.permissionMode,
    inputTokens: snap.inputTokens,
    outputTokens: snap.outputTokens,
    cachedInputTokens: snap.cachedInputTokens,
  };
  if (
    snap.effort !== undefined &&
    snap.toggles.showSwarmVisibility &&
    snap.swarmLines.length > 0
  ) {
    return { ...base, effort: snap.effort, swarmLines: snap.swarmLines };
  }
  if (snap.effort !== undefined) {
    return { ...base, effort: snap.effort };
  }
  if (snap.toggles.showSwarmVisibility && snap.swarmLines.length > 0) {
    return { ...base, swarmLines: snap.swarmLines };
  }
  return base;
}

export function App({ host }: AppProps) {
  const { exit } = useApp();
  const [snap, setSnap] = useState<HostSnapshot>(() => host.getSnapshot());

  useEffect(() => host.subscribe(() => setSnap(host.getSnapshot())), [host]);

  const onSubmit = useCallback(
    (text: string) => {
      void host.submit(text);
    },
    [host],
  );

  const onSteer = useCallback(
    (text: string) => {
      host.steer(text);
    },
    [host],
  );

  const onExit = useCallback(() => {
    void host.dispose().then(() => exit());
  }, [exit, host]);

  const prompt =
    snap.permissionPrompt === undefined ? (
      <PromptInput
        busy={snap.busy}
        onSubmit={onSubmit}
        onPermission={(answer) => host.answerPermission(answer)}
        onAbort={() => host.abort()}
        onSteer={onSteer}
        onExit={onExit}
      />
    ) : (
      <PromptInput
        busy={snap.busy}
        permissionPrompt={snap.permissionPrompt}
        onSubmit={onSubmit}
        onPermission={(answer) => host.answerPermission(answer)}
        onAbort={() => host.abort()}
        onSteer={onSteer}
        onExit={onExit}
      />
    );

  return (
    <Box flexDirection="column" height="100%">
      <Box paddingX={1} marginBottom={0}>
        <Text bold color="cyan">
          kimi-next
        </Text>
        <Text dimColor>
          {" "}
          · {snap.sessionId || "…"} · {snap.transport}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <Transcript
          entries={toTranscriptEntries(snap.lines)}
          streamingText={snap.streamingText}
          toggles={snap.toggles}
        />
      </Box>
      <Footer
        state={buildFooterState(snap)}
        toggles={snap.toggles}
        busy={snap.busy}
      />
      {prompt}
      <Box paddingX={1}>
        <Text dimColor>
          Enter send · busy Enter steers · Ctrl+C stop/quit · /help
        </Text>
      </Box>
    </Box>
  );
}
