export type PermissionMode = "manual" | "yolo";

export type PermissionDecision = "allow" | "deny";

export interface PermissionRequest {
  readonly toolName: string;
  readonly arguments: string;
  readonly mode: PermissionMode;
}

export interface PermissionGate {
  ask(request: PermissionRequest): Promise<PermissionDecision>;
}

/** Always-allow gate for yolo / tests. */
export function createYoloPermissionGate(): PermissionGate {
  return {
    async ask() {
      return "allow";
    },
  };
}

/** Manual gate: deny unless callback allows. */
export function createManualPermissionGate(
  askUser: (request: PermissionRequest) => Promise<PermissionDecision>,
): PermissionGate {
  return {
    async ask(request) {
      if (request.mode === "yolo") return "allow";
      return askUser(request);
    },
  };
}
