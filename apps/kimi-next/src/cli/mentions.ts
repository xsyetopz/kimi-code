import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { listDir, readFile } from "@kimi-next/exec";

const MAX_FILE_SIZE = 100 * 1024;

export interface MentionAttachment {
  readonly path: string;
  readonly kind: "file" | "dir";
  readonly body: string;
}

function mentionedPathPattern(): RegExp {
  return /(^|[\s([{'"`])@([A-Za-z0-9._/~+-]+\/?)/g;
}

function displayPath(path: string, cwd: string): string {
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

async function expandPath(
  token: string,
  cwd: string,
): Promise<MentionAttachment | undefined> {
  const absolutePath = resolve(cwd, token);
  try {
    const info = await stat(absolutePath);
    const path = displayPath(absolutePath, cwd);
    if (info.isDirectory() || token.endsWith("/")) {
      const names = await listDir(absolutePath);
      return {
        path,
        kind: "dir",
        body: names.join("\n") || "(empty directory)",
      };
    }
    const content = await readFile(absolutePath);
    const body =
      content.length > MAX_FILE_SIZE
        ? `${content.slice(0, MAX_FILE_SIZE)}\n[truncated at 100KB]`
        : content;
    return { path, kind: "file", body };
  } catch {
    return undefined;
  }
}

export async function expandMentions(
  text: string,
  cwd: string,
): Promise<{ text: string; attachments: MentionAttachment[] }> {
  const attachments: MentionAttachment[] = [];
  const matches = [...text.matchAll(mentionedPathPattern())];
  for (const match of matches) {
    const token = match[2];
    if (token === undefined) continue;
    const attachment = await expandPath(token, cwd);
    if (attachment) attachments.push(attachment);
  }

  if (attachments.length === 0) return { text, attachments };
  const blocks = attachments.map(
    (attachment) =>
      `[Attached ${attachment.kind}: ${attachment.path}]\n${attachment.body}`,
  );
  return { text: `${text}\n\n${blocks.join("\n\n")}`, attachments };
}
