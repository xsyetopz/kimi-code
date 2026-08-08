import { describe, expect, it } from "vitest";
import {
  listModels,
  ModelNotFoundError,
  ModelValidationError,
  resolveModel,
  validateRequest,
} from "../src/index";

describe("catalog", () => {
  it("lists known models", () => {
    const models = listModels();
    expect(models.length).toBeGreaterThanOrEqual(3);
    expect(models.map((m) => m.id)).toContain("openai/gpt-4.1-mini");
    expect(models.map((m) => m.id)).toContain(
      "anthropic/claude-sonnet-4-20250514",
    );
    expect(models.map((m) => m.id)).toContain("moonshotai/kimi-k2");
  });

  it("resolves a model by id", () => {
    const profile = resolveModel("openai/gpt-4.1-mini");
    expect(profile.transport).toBe("openai-chat");
    expect(profile.wireModel).toBe("gpt-4.1-mini");
    expect(profile.capabilities.input.images).toBe(true);
  });

  it("resolves hand-tuned transport overrides from snapshot", () => {
    expect(resolveModel("openai/gpt-4.1").transport).toBe("openai-responses");
    expect(resolveModel("google/gemini-2.5-flash").transport).toBe("gemini");
    expect(resolveModel("anthropic/claude-sonnet-4-20250514").transport).toBe(
      "anthropic",
    );
    expect(resolveModel("moonshotai/kimi-k2").transport).toBe("openai-chat");
  });

  it("throws for unknown model", () => {
    expect(() => resolveModel("unknown/model")).toThrow(ModelNotFoundError);
  });
});

describe("validateRequest", () => {
  it("accepts supported features", () => {
    const profile = resolveModel("openai/gpt-4.1-mini");
    expect(() =>
      validateRequest({
        profile,
        tools: true,
        vision: true,
        params: { temperature: 0.7 },
      }),
    ).not.toThrow();
  });

  it("rejects vision on models without image input", () => {
    const profile = resolveModel("moonshotai/kimi-k2");
    expect(() =>
      validateRequest({ profile, vision: true }),
    ).toThrow(ModelValidationError);
    try {
      validateRequest({ profile, vision: true });
    } catch (error) {
      expect(error).toBeInstanceOf(ModelValidationError);
      expect((error as ModelValidationError).code).toBe("UNSUPPORTED_VISION");
    }
  });

  it("rejects unsupported reasoning mode", () => {
    const profile = resolveModel("openai/gpt-4.1-mini");
    expect(() =>
      validateRequest({ profile, reasoning: "exposed" }),
    ).toThrow(ModelValidationError);
  });

  it("rejects unsupported parameters", () => {
    const profile = resolveModel("moonshotai/kimi-k2");
    expect(() =>
      validateRequest({
        profile,
        params: { stopSequences: ["END"] },
      }),
    ).toThrow(ModelValidationError);
  });
});
