import {
  readFile as readFileNode,
  readdir,
  writeFile as writeFileNode,
} from "node:fs/promises";

import { assertPosix } from "./platform";

export async function readFile(path: string): Promise<string> {
  assertPosix();
  return readFileNode(path, "utf8");
}

export async function writeFile(path: string, content: string): Promise<void> {
  assertPosix();
  await writeFileNode(path, content, "utf8");
}

export async function editFile(
  path: string,
  search: string,
  replace: string,
): Promise<void> {
  assertPosix();
  const content = await readFileNode(path, "utf8");
  const index = content.indexOf(search);
  if (index < 0) {
    throw new Error(`editFile: search string not found in ${path}`);
  }
  const updated =
    content.slice(0, index) +
    replace +
    content.slice(index + search.length);
  await writeFileNode(path, updated, "utf8");
}

export async function listDir(path: string): Promise<string[]> {
  assertPosix();
  const entries = await readdir(path);
  return [...entries].sort();
}

export { assertPosix };
