import type { ModelProtocolProfile } from "@moonshot-ai/kosong";

export type {
  AuthStyle,
  EndpointKind,
  ModelProtocolCapability,
  ModelProtocolProfile,
  ModelProtocolReasoningProfile,
  ModelProtocolRequestConstraints,
  ModelProtocolToolsProfile,
  OpaqueProviderState,
  ProtocolTransportFamily,
  ProviderTransportProfile,
  ReasoningMode,
  ServingEngine,
  ServingProfile,
  ToolProtocolKind,
} from "@moonshot-ai/kosong";

export {
  AuthStyleSchema,
  EndpointKindSchema,
  ModelProtocolCapabilitySchema,
  ModelProtocolProfileSchema,
  ModelProtocolReasoningProfileSchema,
  ModelProtocolRequestConstraintsSchema,
  ModelProtocolToolsProfileSchema,
  OpaqueProviderStateSchema,
  ProtocolTransportFamilySchema,
  ProviderTransportProfileSchema,
  ReasoningModeSchema,
  ServingEngineSchema,
  ServingProfileSchema,
  ToolProtocolKindSchema,
  capabilityToProtocolCapability,
  parseModelProtocolProfile,
  parseOpaqueProviderState,
  parseProviderTransportProfile,
  parseServingProfile,
} from "@moonshot-ai/kosong";

export function profileRequiresAssistantReplay(
  profile: ModelProtocolProfile | undefined,
): boolean {
  return profile?.tools.requiresAssistantReplay === true;
}

export function profileReplayReasoningWithToolCalls(
  profile: ModelProtocolProfile | undefined,
): boolean {
  return profile?.reasoning.replayWithToolCalls === true;
}
