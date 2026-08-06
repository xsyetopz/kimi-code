import { describe, expect, it } from "vitest";

import {
  buildRestUrl,
  buildWsUrl,
  normalizeServerOrigin,
} from "../src/api/config";

describe("API config", () => {
  it("normalizes a direct server URL carrying the canonical API prefix", () => {
    expect(normalizeServerOrigin("https://daemon.test/api/v1/?ignored=1#hash")).toBe(
      "https://daemon.test",
    );
  });

  it("builds REST URLs under the canonical API prefix", () => {
    expect(buildRestUrl("http://daemon.test", "sessions/s_1")).toBe(
      "http://daemon.test/api/v1/sessions/s_1",
    );
  });

  it("builds WebSocket URLs under the canonical API prefix", () => {
    expect(buildWsUrl("https://daemon.test", "client_1")).toBe(
      "wss://daemon.test/api/v1/ws?client_id=client_1",
    );
  });
});
