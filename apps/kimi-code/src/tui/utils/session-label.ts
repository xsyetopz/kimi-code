/** Session-picker labels for current and imported session metadata. */

const IMPORTED_BADGE = "[imported]";
const IMPORTED_FLAG_KEY = "imported_from_kimi_cli";

export interface SessionLabelInput {
  readonly title: string;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export function isImportedSession(
  metadata: Readonly<Record<string, unknown>> | undefined,
): boolean {
  return metadata?.[IMPORTED_FLAG_KEY] === true;
}

export function formatSessionLabel(input: SessionLabelInput): string {
  const prefix = isImportedSession(input.metadata) ? `${IMPORTED_BADGE} ` : "";
  return `${prefix}${input.title}`;
}
