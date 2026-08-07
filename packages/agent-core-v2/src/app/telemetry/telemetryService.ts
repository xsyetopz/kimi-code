/**
 * `telemetry` domain — harness `ITelemetryService` implementation.
 *
 * Default harness installs with no appenders (events are silently dropped).
 * In-process hosts attach a `TelemetryClient` through `setAppender`; events
 * then flow to the host while `telemetry=false` in config keeps the service
 * disabled. Bound at App scope.
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

interface HarnessTelemetryShared {
  enabled: boolean;
  appenders: ITelemetryAppender[];
}

function mergeProperties(
  context: TelemetryProperties,
  properties?: TelemetryProperties,
): TelemetryProperties | undefined {
  if (properties === undefined) {
    return Object.keys(context).length > 0 ? context : undefined;
  }
  return { ...context, ...properties };
}

export class HarnessTelemetryService implements ITelemetryService {
  declare readonly _serviceBrand: undefined;

  private readonly shared: HarnessTelemetryShared;
  private readonly context: TelemetryProperties;

  constructor(
    shared?: HarnessTelemetryShared,
    context: TelemetryProperties = {},
  ) {
    this.shared = shared ?? { enabled: true, appenders: [] };
    this.context = context;
  }

  track(event: string, properties?: TelemetryProperties): void {
    if (!this.shared.enabled || this.shared.appenders.length === 0) return;
    const payload = mergeProperties(this.context, properties);
    for (const appender of this.shared.appenders) {
      appender.track(event, payload);
    }
  }

  track2<
    K extends TelemetryEventName,
    E extends TelemetryEventPayload<K> = never,
  >(
    event: K,
    properties?: StrictPropertyCheck<TelemetryEventPayload<K>, E>,
  ): void {
    this.track(event, properties as TelemetryProperties | undefined);
  }

  withContext(patch: TelemetryContextPatch): ITelemetryService {
    return new HarnessTelemetryService(this.shared, {
      ...this.context,
      ...patch,
    });
  }

  setContext(patch: TelemetryContextPatch): void {
    Object.assign(this.context, patch);
  }

  addAppender(appender: ITelemetryAppender): IDisposable {
    this.shared.appenders.push(appender);
    return toDisposable(() => {
      this.removeAppender(appender);
    });
  }

  removeAppender(appender: ITelemetryAppender): void {
    const index = this.shared.appenders.indexOf(appender);
    if (index >= 0) this.shared.appenders.splice(index, 1);
  }

  setAppender(appender: ITelemetryAppender): void {
    this.shared.appenders.length = 0;
    this.shared.appenders.push(appender);
  }

  setEnabled(enabled: boolean): void {
    this.shared.enabled = enabled;
  }

  async flush(): Promise<void> {
    await Promise.all(
      this.shared.appenders.map(async (appender) => {
        await appender.flush?.();
      }),
    );
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      this.shared.appenders.map(async (appender) => {
        await appender.shutdown?.();
      }),
    );
  }
}

/** @deprecated Use `HarnessTelemetryService`. */
export const NoopTelemetryService = HarnessTelemetryService;

registerScopedService(
  LifecycleScope.App,
  ITelemetryService,
  HarnessTelemetryService,
  ScopeActivation.OnScopeCreated,
  "telemetry",
);
