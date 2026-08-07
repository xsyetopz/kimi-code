import {
  buildKimiFileUrl,
  parseKimiFileUrl,
  type ContentPart,
  type PromptHandle,
  type PromptQueueSnapshot,
} from "@moonshot-ai/agent-core-v2";
import type { PromptSubmission } from "../protocol/rest-prompt";

export function projectPromptList(snapshot: PromptQueueSnapshot) {
  return {
    active:
      snapshot.active === undefined
        ? null
        : projectPromptSnapshot(snapshot.active),
    queued: snapshot.pending.map(projectPromptSnapshot),
  };
}

export function projectPromptHandle(handle: PromptHandle) {
  return projectPromptSnapshot(handle);
}

function projectPromptSnapshot(prompt: PromptQueueSnapshot["pending"][number]) {
  const status =
    prompt.state === "running" || prompt.state === "steered"
      ? "running"
      : prompt.state === "blocked"
        ? "blocked"
        : "queued";
  return {
    prompt_id: prompt.id,
    user_message_id: prompt.userMessageId,
    status,
    content: corePartsToProtocol(prompt.message.content),
    created_at: prompt.createdAt,
  };
}

function corePartsToProtocol(
  content: readonly ContentPart[],
): PromptSubmission["content"] {
  const parts: PromptSubmission["content"] = [];
  for (const part of content) {
    if (part.type === "text") parts.push({ type: "text", text: part.text });
    else if (part.type === "image_url") {
      const match = /^data:([^;]+);base64,(.*)$/.exec(part.imageUrl.url);
      parts.push(
        match === null
          ? {
              type: "image",
              source: {
                kind: "url",
                url: part.imageUrl.url,
                id: part.imageUrl.id,
              },
            }
          : {
              type: "image",
              source: {
                kind: "base64",
                media_type: match[1]!,
                data: match[2]!,
              },
            },
      );
    } else if (part.type === "video_url") {
      // An internal `kimi-file://<id>?path=…` reference projects back to the
      // daemon upload it came from — the materialization path never leaks to
      // the client.
      const kimiFile = parseKimiFileUrl(part.videoUrl.url);
      if (kimiFile !== undefined) {
        parts.push({
          type: "video",
          source: { kind: "file", file_id: kimiFile.fileId },
        });
        continue;
      }
      const match = /^data:([^;]+);base64,(.*)$/.exec(part.videoUrl.url);
      parts.push(
        match === null
          ? {
              type: "video",
              source: {
                kind: "url",
                url: part.videoUrl.url,
                id: part.videoUrl.id,
              },
            }
          : {
              type: "video",
              source: {
                kind: "base64",
                media_type: match[1]!,
                data: match[2]!,
              },
            },
      );
    }
  }
  return parts;
}

export function contentToCoreParts(
  content: PromptSubmission["content"],
): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const part of content) {
    if (part.type === "text") parts.push({ type: "text", text: part.text });
    else if (part.type === "image" && part.source.kind === "url")
      parts.push({
        type: "image_url",
        imageUrl: { url: part.source.url, id: part.source.id },
      });
    else if (part.type === "image" && part.source.kind === "base64")
      parts.push({
        type: "image_url",
        imageUrl: {
          url: `data:${part.source.media_type};base64,${part.source.data}`,
        },
      });
    else if (part.type === "video" && part.source.kind === "url")
      parts.push({
        type: "video_url",
        videoUrl: { url: part.source.url, id: part.source.id },
      });
    else if (part.type === "video" && part.source.kind === "base64")
      parts.push({
        type: "video_url",
        videoUrl: {
          url: `data:${part.source.media_type};base64,${part.source.data}`,
        },
      });
  }
  return parts;
}
