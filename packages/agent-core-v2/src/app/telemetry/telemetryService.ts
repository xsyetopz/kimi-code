/**
 * `telemetry` domain — harness no-op `ITelemetryService` implementation.
 *
 * Registers a scoped service that satisfies every telemetry call site without
 * recording or transmitting events. Bound at App scope.
 */

import { toDisposable, type IDisposable } from "#/_base/di/lifecycle";
import {
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from "#/_base/di/scope";

import type {
  StrictPropertyCheck,
  TelemetryEventName,
  TelemetryEventPayload,
} from "./events";
import {
  ITelemetryService,
  type ITelemetryAppender,
  type TelemetryContextPatch,
  type TelemetryProperties,
} from "./telemetry";

export class NoopTelemetryService implements ITelemetryService {
  declare readonly _serviceBrand: undefined;

  track(_event: string, _properties?: TelemetryProperties): void {}

  track2<
    K extends TelemetryEventName,
    E extends TelemetryEventPayload<K> = never,
  >(
    _event: K,
    _properties?: StrictPropertyCheck<TelemetryEventPayload<K>, E>,
  ): void {}

  withContext(_patch: TelemetryContextPatch): ITelemetryService {
    return this;
  }

  setContext(_patch: TelemetryContextPatch): void {}

  addAppender(_appender: ITelemetryAppender): IDisposable {
    return toDisposable(() => {});
  }

  removeAppender(_appender: ITelemetryAppender): void {}

  setAppender(_appender: ITelemetryAppender): void {}

  setEnabled(_enabled: boolean): void {}

  async flush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

registerScopedService(
  LifecycleScope.App,
  ITelemetryService,
  NoopTelemetryService,
  ScopeActivation.OnScopeCreated,
  "telemetry",
);
