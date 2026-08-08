import type { ModelProfile } from "@kimi-next/model";

/** Swarm child visibility — WYSIWYG parent footer data. */
export interface SwarmWorkerSpec {
  readonly id: string;
  readonly modelId: string;
  readonly effort?: string;
  readonly profile: ModelProfile;
}

export interface SwarmBatch {
  readonly workers: readonly SwarmWorkerSpec[];
}

export interface SwarmWorkerResult {
  readonly id: string;
  readonly modelId: string;
  readonly effort?: string;
  readonly text: string;
  readonly error?: string;
}

export interface RunSwarmBatchOptions {
  readonly workers: readonly SwarmWorkerSpec[];
  readonly prompt: string;
  readonly runWorker: (
    worker: SwarmWorkerSpec,
    prompt: string,
  ) => Promise<string>;
}

/** Run all workers concurrently while keeping failures isolated per worker. */
export async function runSwarmBatch(
  options: RunSwarmBatchOptions,
): Promise<readonly SwarmWorkerResult[]> {
  const settled = await Promise.allSettled(
    options.workers.map((worker) => options.runWorker(worker, options.prompt)),
  );

  return options.workers.map((worker, index) => {
    const outcome = settled[index];
    const result: {
      id: string;
      modelId: string;
      effort?: string;
      text: string;
      error?: string;
    } = {
      id: worker.id,
      modelId: worker.modelId,
      text: "",
    };
    if (worker.effort !== undefined) {
      result.effort = worker.effort;
    }
    if (outcome?.status === "fulfilled") {
      result.text = outcome.value;
      return result;
    }

    const error = outcome?.reason;
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  });
}

export function formatSwarmVisibility(batch: SwarmBatch): string {
  return batch.workers
    .map((w) => {
      const effort = w.effort ? ` effort=${w.effort}` : "";
      return `${w.id}: model=${w.modelId}${effort}`;
    })
    .join("\n");
}
