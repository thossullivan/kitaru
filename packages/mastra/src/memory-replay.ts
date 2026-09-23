import { createRequire } from "node:module";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { MemoryConfigInternal } from "@mastra/core/memory";
import {
  createMemoryCaptureBinding,
  createProcessLocalMemoryAccess,
  type MastraMemoryCaptureOptions,
} from "./memory-binding.js";
import {
  decodeMemoryValue,
  encodeMemoryValue,
  type MastraMemorySnapshot,
  validateMemorySnapshot,
} from "./memory-snapshot.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsupported(message: string): never {
  throw new Error(`Unsupported Mastra memory replay: ${message}`);
}

/** Require the dependency pair exercised by the native memory proof. */
export function assertMemoryReplayVersions(): void {
  const require = createRequire(import.meta.url);
  for (const [name, version] of [
    ["@mastra/core", "1.67.0"],
    ["@mastra/memory", "1.30.0"],
  ]) {
    const metadata: unknown = require(`${name}/package.json`);
    if (!record(metadata) || metadata.version !== version)
      unsupported(`requires ${name}@${version}.`);
  }
}

/** Save a model identity, never the provider client or its credentials. */
export function getMemoryModelId(model: unknown): string {
  if (typeof model === "string" && model.length > 0) return model;
  if (
    record(model) &&
    typeof model.modelId === "string" &&
    typeof model.provider === "string"
  )
    return `${model.provider}/${model.modelId}`;
  if (record(model) && typeof model.id === "string") return model.id;
  return unsupported("Memory models require a static model identity.");
}

function checkConfiguration(config: Record<string, unknown>): void {
  const allowed = new Set([
    "readOnly",
    "lastMessages",
    "semanticRecall",
    "workingMemory",
    "observationalMemory",
    "generateTitle",
    "filterIncompleteToolCalls",
  ]);
  for (const key of Object.keys(config))
    if (!allowed.has(key))
      unsupported(`Memory option '${key}' is not supported.`);
  if (config.semanticRecall !== undefined && config.semanticRecall !== false)
    unsupported("Semantic recall requires external state.");
  if (config.generateTitle !== undefined && config.generateTitle !== false)
    unsupported("Automatic title generation is not supported.");
  for (const key of ["workingMemory", "observationalMemory"]) {
    const feature = config[key];
    if (feature === undefined || feature === false) continue;
    if (!record(feature))
      unsupported(`${key} requires explicit thread-scoped configuration.`);
    if (feature.enabled !== false && feature.scope !== "thread")
      unsupported(`${key} must use thread scope.`);
  }
}

/** Convert the supported native schema and OM models to self-contained configuration. */
export function serializeMemoryConfiguration(
  config: MemoryConfigInternal,
): Record<string, unknown> {
  checkConfiguration(config);
  const copy: Record<string, unknown> = { ...config };
  if (config.workingMemory?.schema) {
    const { standardSchemaToJSONSchema, toStandardSchema } = createRequire(
      import.meta.url,
    )("@mastra/core/schema") as typeof import("@mastra/core/schema");
    copy.workingMemory = {
      ...config.workingMemory,
      schema: standardSchemaToJSONSchema(
        toStandardSchema(config.workingMemory.schema),
      ),
    };
  }
  if (record(config.observationalMemory)) {
    const om = { ...config.observationalMemory };
    if (om.model !== undefined) om.model = getMemoryModelId(om.model);
    for (const name of ["observation", "reflection"]) {
      if (record(om[name])) {
        const phase = { ...om[name] };
        if (phase.model !== undefined)
          phase.model = getMemoryModelId(phase.model);
        om[name] = phase;
      }
    }
    copy.observationalMemory = om;
  }
  return decodeMemoryValue(encodeMemoryValue(copy)) as Record<string, unknown>;
}

export async function restoreMemoryConfiguration(
  configuration: Record<string, unknown>,
  resolveModel: (id: string) => Promise<MastraModelConfig> | MastraModelConfig,
): Promise<MemoryConfigInternal> {
  const copy = decodeMemoryValue(encodeMemoryValue(configuration));
  if (!record(copy)) return unsupported("Missing native memory configuration.");
  checkConfiguration(copy);
  if (record(copy.observationalMemory)) {
    const om = copy.observationalMemory;
    if (om.model !== undefined) {
      if (typeof om.model !== "string")
        unsupported("Invalid observer model identity.");
      om.model = await resolveModel(om.model);
    }
    for (const name of ["observation", "reflection"]) {
      const phase = om[name];
      if (record(phase) && phase.model !== undefined) {
        if (typeof phase.model !== "string")
          unsupported("Invalid memory model identity.");
        phase.model = await resolveModel(phase.model);
      }
    }
  }
  return copy as MemoryConfigInternal;
}

export interface IsolatedMemoryReplayOptions {
  invocationId: string;
  initialSnapshot: MastraMemorySnapshot;
  configuration: Record<string, unknown>;
  resolveModel: (id: string) => Promise<MastraModelConfig> | MastraModelConfig;
  recordMutation: MastraMemoryCaptureOptions["recordMutation"];
  getRequestId?: MastraMemoryCaptureOptions["getRequestId"];
  onIncomplete?: MastraMemoryCaptureOptions["onIncomplete"];
}

/** Restore historical state into a fresh store; no production store is accepted. */
export async function createIsolatedMemoryReplay(
  options: IsolatedMemoryReplayOptions,
) {
  assertMemoryReplayVersions();
  validateMemorySnapshot(options.initialSnapshot);
  const snapshot = decodeMemoryValue(
    encodeMemoryValue(options.initialSnapshot),
  ) as MastraMemorySnapshot;
  const configuration = await restoreMemoryConfiguration(
    options.configuration,
    options.resolveModel,
  );
  const { Memory } = await import("@mastra/memory");
  const { InMemoryStore, MastraCompositeStore } = await import(
    "@mastra/core/storage"
  );
  const store = new InMemoryStore();
  const domain = store.stores.memory;
  if (!domain) return unsupported("Native in-memory storage is unavailable.");
  try {
    if (snapshot.thread)
      await domain.saveThread({ thread: structuredClone(snapshot.thread) });
    if (snapshot.resource)
      await domain.saveResource({ resource: snapshot.resource });
    if (snapshot.messages.length)
      await domain.saveMessages({ messages: snapshot.messages });
    // Saving messages updates thread metadata, including updatedAt.
    if (snapshot.thread)
      await domain.saveThread({ thread: structuredClone(snapshot.thread) });
    for (const value of snapshot.records)
      await domain.insertObservationalMemoryRecord(value);
    const binding = createMemoryCaptureBinding({
      invocationId: options.invocationId,
      threadId: snapshot.threadId,
      resourceId: snapshot.resourceId,
      domain,
      exclusiveAccess: createProcessLocalMemoryAccess(),
      recordMutation: options.recordMutation,
      getRequestId: options.getRequestId,
      onIncomplete: options.onIncomplete,
    });
    const storage = new MastraCompositeStore({
      id: `kitaru-replay-${options.invocationId}`,
      domains: { memory: binding.domain },
    });
    const memory = new Memory({ storage, options: configuration });
    const initialSnapshot = await binding.captureInitial(memory);
    if (!initialSnapshot) {
      await binding.release();
      return unsupported(
        "Restored memory did not produce a coherent initial snapshot.",
      );
    }
    let finished: Promise<void> | undefined;
    return {
      memory,
      binding,
      initialSnapshot,
      finish(): Promise<void> {
        finished ??= (async () => {
          try {
            await memory.settled();
            await binding.drain();
          } finally {
            await binding.release();
            await store.close();
          }
        })();
        return finished;
      },
    };
  } catch (error) {
    await store.close();
    throw error;
  }
}
