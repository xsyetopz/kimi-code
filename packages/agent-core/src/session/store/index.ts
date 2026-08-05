import { createHash } from 'node:crypto';
export function encodeWorkDirKey(workDir: string): string {
  return createHash('sha256').update(workDir).digest('hex').slice(0, 16);
}
