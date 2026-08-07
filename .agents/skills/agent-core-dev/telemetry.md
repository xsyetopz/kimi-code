# Topic — Telemetry

Telemetry was removed from the harness product line. There is no `ITelemetryService`, event registry, or appender pipeline in `packages/agent-core-v2`.

Do not add telemetry imports, stubs, or emission-only test assertions. When validating behavior, assert on user-visible outcomes (logs, events on `IEventBus`, persisted state, tool results) instead of telemetry records.
