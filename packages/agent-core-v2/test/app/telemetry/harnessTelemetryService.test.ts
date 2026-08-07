import { describe, expect, it } from "vitest";

import {
  HarnessTelemetryService,
} from "#/app/telemetry/telemetryService";
import type {
  ITelemetryAppender,
  TelemetryProperties,
} from "#/app/telemetry/telemetry";

describe("HarnessTelemetryService", () => {
  it("forwards events to a host appender when enabled", () => {
    const records: { event: string; properties?: TelemetryProperties }[] = [];
    const appender: ITelemetryAppender = {
      track: (event, properties) => {
        records.push({ event, properties });
      },
    };
    const telemetry = new HarnessTelemetryService();
    telemetry.setAppender(appender);
    telemetry.track2("model_switch", { model: "k2" });
    expect(records).toEqual([{ event: "model_switch", properties: { model: "k2" } }]);
  });

  it("drops events when no appender is installed", () => {
    const telemetry = new HarnessTelemetryService();
    expect(() => telemetry.track2("model_switch", { model: "k2" })).not.toThrow();
  });

  it("respects setEnabled(false)", () => {
    const records: string[] = [];
    const telemetry = new HarnessTelemetryService();
    telemetry.setAppender({
      track: (event) => {
        records.push(event);
      },
    });
    telemetry.setEnabled(false);
    telemetry.track("ping");
    expect(records).toEqual([]);
  });

  it("merges withContext properties into forwarded events", () => {
    const records: { event: string; properties?: TelemetryProperties }[] = [];
    const root = new HarnessTelemetryService();
    root.setAppender({
      track: (event, properties) => {
        records.push({ event, properties });
      },
    });
    const scoped = root.withContext({ agent_id: "main" });
    scoped.track("tool_call", { tool: "Read" });
    expect(records).toEqual([
      {
        event: "tool_call",
        properties: { agent_id: "main", tool: "Read" },
      },
    ]);
  });
});
