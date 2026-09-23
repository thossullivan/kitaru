import type { MemoryStorage } from "@mastra/core/storage";
import { type JsonValue, toRecorderJson } from "@zenml-io/kitaru";
import { recordedToolPayloadConversion } from "@zenml-io/kitaru/adapter";
import {
  decodeMemoryValue,
  encodeMemoryValue,
  type MastraMemorySnapshot,
  validateMemorySnapshot,
} from "./memory-snapshot.js";

export interface MastraMemorySelector {
  threadId: string;
  resourceId: string;
}

/** All writers must participate in this application's lease, including other processes. */
export interface MastraExclusiveMemoryAccess {
  acquire(
    selector: MastraMemorySelector,
    onConflict?: () => void,
  ): Promise<() => Promise<void>>;
}

/**
 * A real process-local lease. Use only when every writer runs in this process
 * and shares this instance; distributed writers require a distributed lease.
 */
export function createProcessLocalMemoryAccess(): MastraExclusiveMemoryAccess {
  const activeThreads = new Map<string, (() => void) | undefined>();
  return {
    async acquire({ threadId }, onConflict) {
      if (activeThreads.has(threadId)) {
        activeThreads.get(threadId)?.();
        throw new Error("Exclusive source-thread ownership is unavailable.");
      }
      activeThreads.set(threadId, onConflict);
      let released = false;
      return async () => {
        if (!released) activeThreads.delete(threadId);
        released = true;
      };
    },
  };
}

export interface MastraMemoryMutation {
  id: string;
  invocationId: string;
  revision: number;
  complete: boolean;
  method: string;
  arguments: JsonValue;
  result: JsonValue;
  requestId?: string;
}

export interface MastraMemoryCaptureOptions extends MastraMemorySelector {
  invocationId: string;
  domain: MemoryStorage;
  exclusiveAccess: MastraExclusiveMemoryAccess;
  recordMutation: (event: MastraMemoryMutation) => Promise<void>;
  getRequestId?: () => string | undefined;
  onIncomplete?: (reason: string) => void;
}

export interface MastraMemoryCaptureBinding {
  /** Supply this public domain to the invocation's native Memory storage. */
  domain: MemoryStorage;
  readonly revision: number;
  readonly incompleteReasons: readonly string[];
  captureInitial(memory: {
    settled(): Promise<void>;
  }): Promise<MastraMemorySnapshot | undefined>;
  markIncomplete(reason: string): void;
  drain(): Promise<void>;
  release(): Promise<void>;
}

// The pinned public MemoryStorage mutation inventory. Delegation binds `this` to
// the original domain, so a native method's own helper calls record only once.
const MUTATIONS = new Set<keyof MemoryStorage>([
  "dangerouslyClearAll",
  "prune",
  "saveThread",
  "updateThread",
  "patchThread",
  "deleteThread",
  "saveMessages",
  "updateMessages",
  "deleteMessages",
  "copyThread",
  "cloneThread",
  "updateThreadResourceId",
  "saveResource",
  "updateResource",
  "initializeObservationalMemory",
  "updateActiveObservations",
  "updateBufferedObservations",
  "swapBufferedToActive",
  "createReflectionGeneration",
  "updateBufferedReflection",
  "swapBufferedReflectionToActive",
  "setReflectingFlag",
  "setObservingFlag",
  "setBufferingObservationFlag",
  "setBufferingReflectionFlag",
  "insertObservationalMemoryRecord",
  "clearObservationalMemory",
  "setPendingMessageTokens",
  "updateObservationalMemoryConfig",
]);

/** Capture one native invocation without changing the shared source domain or Agent. */
export function createMemoryCaptureBinding(
  options: MastraMemoryCaptureOptions,
): MastraMemoryCaptureBinding {
  let revision = 0;
  let started = false;
  let capturing = false;
  let readingSnapshot = false;
  let released = false;
  let releaseLease: (() => Promise<void>) | undefined;
  let mutations = Promise.resolve();
  let evidence = Promise.resolve();
  const reasons: string[] = [];
  const methods = new Map<PropertyKey, unknown>();

  function markIncomplete(reason: string): void {
    if (reasons.includes(reason)) return;
    reasons.push(reason);
    try {
      options.onIncomplete?.(reason);
    } catch {
      /* Diagnostics must not affect native calls. */
    }
  }

  const domain = new Proxy(options.domain, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (methods.has(property)) return methods.get(property);
      if (!MUTATIONS.has(property as keyof MemoryStorage)) {
        const bound = value.bind(target);
        methods.set(property, bound);
        return bound;
      }
      const bound = (...args: unknown[]): Promise<unknown> => {
        let encodedArguments: JsonValue = null;
        let complete = true;
        let requestId: string | undefined;
        try {
          encodedArguments = encodeMemoryValue(args);
          requestId = options.getRequestId?.();
        } catch {
          complete = false;
          markIncomplete(
            "Memory mutation arguments or request attribution could not be recorded safely.",
          );
        }
        if (!started || released)
          markIncomplete(
            "Memory mutation occurred outside the owned invocation lifecycle.",
          );
        if (readingSnapshot)
          markIncomplete("Memory mutation overlapped initial snapshot reads.");
        if (property === "dangerouslyClearAll" || property === "prune")
          markIncomplete(
            "Storage-wide mutation is outside the captured thread scope.",
          );
        const duringCapture = capturing;
        const result = mutations.then(async () => {
          let output: unknown;
          try {
            output = await Reflect.apply(value, target, args);
          } catch (error) {
            markIncomplete("Native memory storage mutation failed.");
            throw error;
          }
          // Joined work from a previous turn belongs to the initial snapshot.
          if (duringCapture) return output;
          revision += 1;
          let encodedResult: JsonValue = null;
          try {
            encodedResult = encodeMemoryValue(output);
          } catch {
            complete = false;
            markIncomplete(
              "Memory mutation result could not be recorded safely.",
            );
          }
          let event: MastraMemoryMutation = {
            id: `${options.invocationId}:memory:${revision}`,
            invocationId: options.invocationId,
            revision,
            complete,
            method: String(property),
            arguments: encodedArguments,
            result: encodedResult,
            ...(requestId === undefined ? {} : { requestId }),
          };
          try {
            toRecorderJson(event);
            if (
              recordedToolPayloadConversion(event, "Mastra memory mutation")
                .lossy
            )
              throw new Error("Lossy event");
          } catch {
            markIncomplete(
              "Memory mutation evidence exceeds replay payload bounds or contains credentials.",
            );
            event = {
              ...event,
              complete: false,
              arguments: null,
              result: null,
            };
          }
          evidence = evidence.then(async () => {
            try {
              await options.recordMutation(event);
            } catch {
              markIncomplete("Memory mutation evidence persistence failed.");
            }
          });
          return output;
        });
        mutations = result.then(
          () => {},
          () => {},
        );
        return result;
      };
      methods.set(property, bound);
      return bound;
    },
  });

  async function drain(): Promise<void> {
    // Evidence can grow while a storage operation settles; follow both tails.
    while (true) {
      const currentMutations = mutations;
      await currentMutations;
      const currentEvidence = evidence;
      await currentEvidence;
      if (currentMutations === mutations && currentEvidence === evidence)
        return;
    }
  }

  return {
    domain,
    get revision() {
      return revision;
    },
    get incompleteReasons() {
      return [...reasons];
    },
    markIncomplete,
    async captureInitial(memory) {
      if (started || released) {
        markIncomplete(
          "Initial memory capture may run only once per invocation.",
        );
        return undefined;
      }
      started = true;
      capturing = true;
      try {
        try {
          releaseLease = await options.exclusiveAccess.acquire(options, () =>
            markIncomplete(
              "Exclusive source-thread ownership was invalidated by an overlapping invocation.",
            ),
          );
        } catch {
          markIncomplete("Exclusive source-thread ownership is unavailable.");
          return undefined;
        }
        await memory.settled();
        await mutations;
        readingSnapshot = true;
        const thread = await options.domain.getThreadById({
          threadId: options.threadId,
        });
        const resource = await options.domain.getResourceById({
          resourceId: options.resourceId,
        });
        const { messages } = await options.domain.listMessages({
          threadId: options.threadId,
          perPage: false,
        });
        const records = await options.domain.getObservationalMemoryHistory(
          options.threadId,
          options.resourceId,
        );
        const snapshot = {
          threadId: options.threadId,
          resourceId: options.resourceId,
          thread,
          resource,
          messages,
          records,
        };
        // Copy through the explicit codec: no storage-owned objects or Dates escape.
        const copy = decodeMemoryValue(encodeMemoryValue(snapshot));
        validateMemorySnapshot(copy);
        return reasons.length === 0 ? copy : undefined;
      } catch {
        markIncomplete(
          "Initial memory capture failed: unsupported, altered, or Unjoined observational-memory state.",
        );
        return undefined;
      } finally {
        capturing = false;
        readingSnapshot = false;
      }
    },
    drain,
    async release() {
      if (released) return;
      await drain();
      released = true;
      try {
        await releaseLease?.();
      } catch {
        markIncomplete("Exclusive source-thread lease release failed.");
      }
    },
  };
}
