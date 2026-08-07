/**
 * `kosong/provider` domain — Google GenAI message conversion.
 *
 * Maps Kimi messages and tools into the Gemini generateContent wire shape,
 * including finish-reason normalization and media URL handling.
 */

import { ChatProviderError } from "#/kosong/contract/errors";
import type { Message } from "#/kosong/contract/message";
import { isToolDeclarationOnlyMessage } from "#/kosong/contract/message";
import type { ResponseFormat, ThinkingEffort, ProviderRequestAuth } from "#/kosong/contract/provider";
import type { Tool } from "#/kosong/contract/tool";
import type { GoogleGenAI } from "@google/genai";

import { mergeConsecutiveUserMessages } from "../merge-user-messages";

export interface GoogleGenAIOptions {
  apiKey?: string | undefined;
  model: string;
  baseUrl?: string;
  vertexai?: boolean | undefined;
  project?: string | undefined;
  location?: string | undefined;
  stream?: boolean | undefined;
  thinkingEffort?: ThinkingEffort | undefined;
  defaultHeaders?: Record<string, string>;
  clientFactory?: (auth: ProviderRequestAuth) => GoogleGenAI;
}

export interface GoogleGenAIGenerationKwargs {
  maxOutputTokens?: number;
  temperature?: number;
  topK?: number;
  topP?: number;
  thinkingConfig?: ThinkingConfig;
  [key: string]: unknown;
}

export interface ThinkingConfig {
  includeThoughts?: boolean;
  thinkingBudget?: number;
  thinkingLevel?: string;
}

interface GoogleFunctionDeclaration {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
}

interface GoogleTool {
  functionDeclarations: GoogleFunctionDeclaration[];
}

export function toolToGoogleGenAI(tool: Tool): GoogleTool {
  return {
    functionDeclarations: [
      {
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.parameters,
      },
    ],
  };
}

export function applyResponseFormat(
  config: Record<string, unknown>,
  format: ResponseFormat | undefined,
): void {
  if (format === undefined) return;
  config["responseMimeType"] = "application/json";
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete config["responseSchema"];
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete config["responseJsonSchema"];
  if (format.type === "json_schema") {
    config["responseJsonSchema"] = format.jsonSchema.schema;
  }
}

interface GoogleContent {
  role: string;
  parts: GooglePart[];
}

interface GooglePart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: {
    name: string;
    response: Record<string, string>;
    parts: unknown[];
  };
  thoughtSignature?: string;
  [key: string]: unknown;
}

function toolCallIdToName(
  toolCallId: string,
  toolNameById: Map<string, string>,
): string {
  const name = toolNameById.get(toolCallId);
  if (name !== undefined) return name;
  const withoutEntropy = toolCallId.replace(/_[0-9a-f]{8}$/, "");
  const match = /^(.+)_[^_]+$/.exec(withoutEntropy);
  return match?.[1] ?? withoutEntropy;
}

function convertMediaUrl(
  url: string,
  fallbackMimeType: string,
):
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { fileUri: string; mimeType: string } } {
  if (url.startsWith("data:")) {
    const commaIndex = url.indexOf(",");
    if (commaIndex === -1) {
      return { fileData: { fileUri: url, mimeType: fallbackMimeType } };
    }
    const meta = url.slice(0, commaIndex);
    const data = url.slice(commaIndex + 1);
    const colonIndex = meta.indexOf(":");
    const semiIndex = meta.indexOf(";");
    const mimeType =
      colonIndex !== -1 && semiIndex !== -1
        ? meta.slice(colonIndex + 1, semiIndex)
        : fallbackMimeType;
    return { inlineData: { mimeType, data } };
  }
  let mimeType = fallbackMimeType;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".png")) mimeType = "image/png";
    else if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg"))
      mimeType = "image/jpeg";
    else if (pathname.endsWith(".gif")) mimeType = "image/gif";
    else if (pathname.endsWith(".webp")) mimeType = "image/webp";
    else if (pathname.endsWith(".mp3") || pathname.endsWith(".mpeg"))
      mimeType = "audio/mpeg";
    else if (pathname.endsWith(".wav")) mimeType = "audio/wav";
    else if (pathname.endsWith(".ogg")) mimeType = "audio/ogg";
  } catch {}
  return { fileData: { fileUri: url, mimeType } };
}

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

async function abortPromise(signal: AbortSignal | undefined): Promise<never> {
  if (signal === undefined) {
    return new Promise(() => {});
  }
  if (signal.aborted) {
    throw createAbortError();
  }
  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        reject(createAbortError());
      },
      { once: true },
    );
  });
}

function messageToGoogleGenAI(message: Message): GoogleContent {
  if (message.role === "tool") {
    throw new ChatProviderError(
      "Tool messages must be converted via messagesToGoogleGenAIContents.",
    );
  }

  const role = message.role === "assistant" ? "model" : message.role;
  const parts: GooglePart[] = [];

  for (const part of message.content) {
    switch (part.type) {
      case "text":
        parts.push({ text: part.text });
        break;
      case "think": {
        const thoughtPart: GooglePart = { text: part.think, thought: true };
        if (part.encrypted !== undefined && part.encrypted.length > 0) {
          thoughtPart.thoughtSignature = part.encrypted;
        }
        parts.push(thoughtPart);
        break;
      }
      case "image_url":
        parts.push(convertMediaUrl(part.imageUrl.url, "image/jpeg"));
        break;
      case "audio_url":
        parts.push(convertMediaUrl(part.audioUrl.url, "audio/mpeg"));
        break;
      case "video_url":
        parts.push(convertMediaUrl(part.videoUrl.url, "video/mp4"));
        break;
    }
  }

  for (const toolCall of message.toolCalls) {
    let args: Record<string, unknown> = {};
    if (toolCall.arguments) {
      try {
        const parsed: unknown = JSON.parse(toolCall.arguments);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          args = parsed as Record<string, unknown>;
        } else {
          throw new ChatProviderError(
            "Tool call arguments must be a JSON object.",
          );
        }
      } catch (error) {
        if (error instanceof ChatProviderError) throw error;
        throw new ChatProviderError("Tool call arguments must be valid JSON.");
      }
    }

    const functionCallPart: GooglePart = {
      functionCall: {
        name: toolCall.name,
        args,
      },
    };

    if (toolCall.extras && "thought_signature_b64" in toolCall.extras) {
      functionCallPart["thoughtSignature"] = toolCall.extras[
        "thought_signature_b64"
      ] as string;
    }

    parts.push(functionCallPart);
  }

  return { role, parts };
}

function toolMessageToFunctionResponseParts(
  message: Message,
  toolNameById: Map<string, string>,
): GooglePart[] {
  if (message.role !== "tool") {
    throw new ChatProviderError("Expected a tool message.");
  }
  if (message.toolCallId === undefined) {
    throw new ChatProviderError("Tool response is missing `toolCallId`.");
  }

  let textOutput = "";
  const mediaParts: GooglePart[] = [];
  for (const part of message.content) {
    switch (part.type) {
      case "text":
        if (part.text) textOutput += part.text;
        break;
      case "image_url":
        mediaParts.push(convertMediaUrl(part.imageUrl.url, "image/jpeg"));
        break;
      case "audio_url":
        mediaParts.push(convertMediaUrl(part.audioUrl.url, "audio/mpeg"));
        break;
      case "video_url":
        mediaParts.push(convertMediaUrl(part.videoUrl.url, "video/mp4"));
        break;
      case "think":
        break;
    }
  }

  const functionResponsePart: GooglePart = {
    functionResponse: {
      name: toolCallIdToName(message.toolCallId, toolNameById),
      response: { output: textOutput },
      parts: [],
    },
  };

  return [functionResponsePart, ...mediaParts];
}

export function messagesToGoogleGenAIContents(
  messages: Message[],
): GoogleContent[] {
  const contents: GoogleContent[] = [];
  const toolNameById = new Map<string, string>();

  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (message === undefined) break;

    if (isToolDeclarationOnlyMessage(message)) {
      i += 1;
      continue;
    }

    if (message.role === "system") {
      const text = message.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      if (text.length > 0) {
        contents.push({
          role: "user",
          parts: [{ text: `<system>${text}</system>` }],
        });
      }
      i += 1;
      continue;
    }

    if (message.role === "assistant" && message.toolCalls.length > 0) {
      contents.push(messageToGoogleGenAI(message));
      const expectedToolCallIds: string[] = [];
      for (const toolCall of message.toolCalls) {
        toolNameById.set(toolCall.id, toolCall.name);
        expectedToolCallIds.push(toolCall.id);
      }

      let j = i + 1;
      const toolMessages: Message[] = [];
      while (j < messages.length) {
        const toolMsg = messages[j];
        if (toolMsg === undefined || toolMsg.role !== "tool") break;
        toolMessages.push(toolMsg);
        j += 1;
      }

      if (toolMessages.length > 0) {
        const toolMsgById = new Map<string, Message>();
        const seenToolCallIds = new Set<string>();
        for (const toolMsg of toolMessages) {
          if (toolMsg.toolCallId === undefined) {
            throw new ChatProviderError(
              "Tool response is missing `toolCallId`.",
            );
          }
          if (seenToolCallIds.has(toolMsg.toolCallId)) {
            throw new ChatProviderError(
              `Duplicate tool response for id: ${toolMsg.toolCallId}`,
            );
          }
          seenToolCallIds.add(toolMsg.toolCallId);
          toolMsgById.set(toolMsg.toolCallId, toolMsg);
        }

        const sortedToolMessages: Message[] = [];
        for (const expectedId of expectedToolCallIds) {
          const msg = toolMsgById.get(expectedId);
          if (msg === undefined) {
            throw new ChatProviderError(
              `Missing tool responses for ids: ${expectedId}`,
            );
          }
          sortedToolMessages.push(msg);
          toolMsgById.delete(expectedId);
        }
        if (toolMsgById.size > 0) {
          throw new ChatProviderError(
            `Unexpected tool responses for ids: ${JSON.stringify([...toolMsgById.keys()])}`,
          );
        }

        const parts: GooglePart[] = [];
        for (const toolMsg of sortedToolMessages) {
          parts.push(
            ...toolMessageToFunctionResponseParts(toolMsg, toolNameById),
          );
        }
        contents.push({ role: "user", parts });
        i = j;
        continue;
      }

      i += 1;
      continue;
    }

    if (message.role === "tool") {
      const parts: GooglePart[] = toolMessageToFunctionResponseParts(
        message,
        toolNameById,
      );
      contents.push({ role: "user", parts });
      i += 1;
      continue;
    }

    contents.push(messageToGoogleGenAI(message));
    i += 1;
  }

  return mergeConsecutiveUserMessages(contents, {
    isUser: (content) => content.role === "user",
    isToolResultOnly: (content) =>
      content.parts.length > 0 &&
      content.parts.every((part) => part.functionResponse !== undefined),
    merge: (last, next) => ({ ...last, parts: [...last.parts, ...next.parts] }),
  });
}
