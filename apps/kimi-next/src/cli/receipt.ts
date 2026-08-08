/** Per-turn harness receipt — what the model was allowed to see. */
export interface HarnessReceipt {
  readonly instructionKind?: string;
  readonly skillIndexCount: number;
  readonly activatedSkills: readonly string[];
  readonly mcpCatalogCount: number;
  readonly mcpFullSchemaCount: number;
  readonly toolsExposed: number;
  readonly planMode: boolean;
  readonly permissionMode: string;
}

export function formatReceipt(receipt: HarnessReceipt): string {
  const parts = [
    `skills_index=${receipt.skillIndexCount}`,
    `activated=${receipt.activatedSkills.join(",") || "-"}`,
    `mcp_catalog=${receipt.mcpCatalogCount}`,
    `mcp_schemas=${receipt.mcpFullSchemaCount}`,
    `tools=${receipt.toolsExposed}`,
    `plan=${receipt.planMode ? "on" : "off"}`,
    `perm=${receipt.permissionMode}`,
  ];
  if (receipt.instructionKind) {
    parts.unshift(`instruction=${receipt.instructionKind}`);
  }
  return `receipt: ${parts.join(" ")}`;
}
