/**
 * `di` domain — tree-wide cascade runtime shared across scope engines.
 *
 * Owns the dependency graph view, serialized request queue, in-flight contagion
 * set, and settle waiters for suspended resolutions. One `CascadeTree` lives at
 * the root and is shared by every `CascadeEngine` in the scope tree.
 */

import type { SyncDescriptor } from "./descriptors";
import {
  PairIndex,
  type DependencyGraph,
  type ScopedToken,
} from "./dependencyGraph";
import type { ServiceIdentifier } from "./instantiation";
import type { CascadeEngine } from "./cascadeEngine";

export type UnitState =
  | "Pending"
  | "Activating"
  | "Active"
  | "Unloading"
  | "Failed";

export type CascadeAction = "provide" | "unprovide" | "update";

/** Eager units activate as soon as their dependencies are satisfied; on-demand units wait for their first resolution (but cascade-torn units always rebuild). */
export type UnitActivation = "eager" | "ondemand";

export interface CascadeChange {
  readonly action: CascadeAction;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly token: ServiceIdentifier<any>;
  readonly descriptor?: SyncDescriptor<unknown>;
  /** Pre-materialized value for a `provide` change (mutually exclusive with `descriptor`). */
  readonly instance?: unknown;
  readonly pinned?: boolean;
  readonly activation?: UnitActivation;
  readonly reason: string;
}

export interface CascadeHistoryEntry {
  readonly seq: number;
  readonly reason: string;
  readonly changes: ReadonlyArray<{ token: string; action: CascadeAction }>;
  readonly affected: readonly string[];
  readonly tornDown: readonly string[];
  readonly rebuilt: readonly string[];
  readonly failed: readonly string[];
  readonly abortWaited: boolean;
  readonly abortTimedOut: boolean;
  readonly durationMs: number;
}

export interface CascadeEngineOptions {
  /**
   * Abort hook (§4.5): invoked at transaction step ② with the contagion set.
   * A returned promise is awaited up to `abortWaitMs` (best-effort), then the
   * cascade proceeds anyway (forced teardown).
   */
  onWillCascade?: (
    affected: readonly ScopedToken[],
    reason: string,
  ) => void | Promise<void>;
  /** Bounded wait for in-flight work to abort (default 5000ms). */
  readonly abortWaitMs?: number;
  /** Suspended-resolution timeout (default 30000ms). */
  readonly resolveTimeoutMs?: number;
  /** History ring capacity (default 200). */
  readonly historyCapacity?: number;
  readonly now?: () => number;
}

/** Container operations one engine drives for its own scope's units. */
export interface CascadeHost {
  /** Registered in this container or an ancestor. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isRegistered(token: ServiceIdentifier<any>): boolean;
  /** The container owning this token in this container's chain, if any. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ownerScopeOf(token: ServiceIdentifier<any>): object | undefined;
  /** Has a live materialized instance in this container. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isMaterialized(token: ServiceIdentifier<any>): boolean;
  /** Create + cache the instance (throws on construction failure). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  materialize(token: ServiceIdentifier<any>): unknown;
  /** Tear the live instance down and reset the entry to its recipe. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  retire(token: ServiceIdentifier<any>): void | Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  applyProvide(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    token: ServiceIdentifier<any>,
    descriptor: SyncDescriptor<unknown>,
    pinned: boolean | undefined,
  ): number;
  /** Register a pre-materialized instance (a new generation). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  applyProvideInstance(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    token: ServiceIdentifier<any>,
    instance: unknown,
    pinned: boolean | undefined,
  ): number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  applyUnprovide(token: ServiceIdentifier<any>): void;
  /** The unit's recipe: the pending descriptor, or the retained one of a live instance. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recipeOf(token: ServiceIdentifier<any>): SyncDescriptor<unknown> | undefined;
  /** Constructor-declared (instance-edge) dependencies of a recipe. */
  dependenciesOf(
    recipe: SyncDescriptor<unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Array<ServiceIdentifier<any>>;
}

/** Structural handle a scoped token's `scope` provides to the engine. */
export interface CascadeScopeHandle {
  readonly cascade: CascadeEngine;
  readonly cascadeDisposed: boolean;
  /** Distance from the tree root (root = 0); parents always sort shallower. */
  readonly cascadeDepth: number;
}

export interface QueuedRequest {
  readonly engine: CascadeEngine;
  readonly change: CascadeChange;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Tree-wide cascade runtime, owned by the root container and shared by every
 * engine of the scope tree: the persistent graph, the serialized request
 * queue, the in-flight contagion set of the running transaction, and the
 * settle waiters for suspended resolutions.
 */
export class CascadeTree {
  readonly graph: DependencyGraph;
  readonly queue: QueuedRequest[] = [];
  /** Every live engine of the tree (engines register at construction). */
  readonly engines = new Set<CascadeEngine>();
  running = false;
  /** The scope orchestrating the running transaction (for label rendering). */
  orchestrator: object | undefined;
  private readonly _inFlight = new PairIndex<true>();
  private _settleWaiters: Array<() => void> = [];
  private readonly _scopeSeq = new Map<object, number>();
  private _nextScopeSeq = 0;

  constructor(graph: DependencyGraph) {
    this.graph = graph;
  }

  inFlightSet(ref: ScopedToken, on: boolean): void {
    if (on) {
      this._inFlight.set(ref.scope, ref.token, true);
    } else {
      this._inFlight.delete(ref.scope, ref.token);
    }
  }

  inFlightHas(ref: ScopedToken): boolean {
    return this._inFlight.get(ref.scope, ref.token) !== undefined;
  }

  inFlightClear(refs: Iterable<ScopedToken>): void {
    for (const ref of refs) {
      this._inFlight.delete(ref.scope, ref.token);
    }
  }

  /** Stable per-scope sequence used to render cross-scope labels (`#n:token`). */
  seqOf(scope: object): number {
    let seq = this._scopeSeq.get(scope);
    if (seq === undefined) {
      seq = this._nextScopeSeq++;
      this._scopeSeq.set(scope, seq);
    }
    return seq;
  }

  addSettleWaiter(waiter: () => void): void {
    this._settleWaiters.push(waiter);
  }

  fireSettleWaiters(): void {
    const waiters = this._settleWaiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }
}
