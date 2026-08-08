import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { ReplContext } from "./repl";
import { createInteractiveHost } from "./host";
import { promptTextForTest } from "./acp-text";

export async function runAcp(ctx: ReplContext): Promise<void> {
  const host = createInteractiveHost(ctx, { quiet: true });
  const sessions = new Set<string>();
  const app = acp
    .agent({ name: "kimi-next" })
    .onRequest("initialize", () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
    }))
    .onRequest("session/new", () => {
      const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      sessions.add(sessionId);
      return { sessionId };
    })
    .onRequest("session/prompt", async ({ params, signal, client }) => {
      if (!sessions.has(params.sessionId)) {
        throw new Error(`Unknown ACP session: ${params.sessionId}`);
      }
      let sentText = "";
      const unsubscribe = host.subscribe(() => {
        const snapshot = host.getSnapshot();
        const text = snapshot.streamingText;
        const delta = text.startsWith(sentText)
          ? text.slice(sentText.length)
          : text;
        sentText = text;
        if (!delta) return;
        void client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: delta },
          },
        });
      });
      const abort = () => host.abort();
      signal.addEventListener("abort", abort, { once: true });
      try {
        await host.submit(promptTextForTest(params.prompt));
        return { stopReason: "end_turn" };
      } catch (error) {
        if (signal.aborted) return { stopReason: "cancelled" };
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
        unsubscribe();
      }
    })
    .onNotification("session/cancel", ({ params }) => {
      if (sessions.has(params.sessionId)) host.abort();
    });

  const connection = app.connect(
    acp.ndJsonStream(
      Writable.toWeb(process.stdout),
      Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
    ),
  );
  await connection.closed;
  await host.dispose();
}
