import type { MessageList } from "@mastra/core/agent/message-list";
import type { JsonValue } from "@zenml-io/kitaru";
import {
  boundedRecorderConversion,
  type RecordingLimits,
  recordedToolPayloadConversion,
} from "@zenml-io/kitaru/adapter";
import { encodeMemoryValue } from "./memory-snapshot.js";

export interface RequestEvidence {
  externalId: string;
  invocationId: string;
  stepNumber: number;
  attemptNumber: number;
  memoryRevision: number | null;
  method: "doStream" | "doGenerate";
  modelId: string;
  provider: string;
  startedAt: string;
  inputs: JsonValue;
  modelSettings: Record<string, JsonValue>;
  provenance: JsonValue;
  complete: boolean;
  reasons: string[];
}

export interface RequestCaptureOptions {
  invocationId: string;
  getMemoryRevision: () => number;
  recordingLimits?: RecordingLimits;
  onFailedAttempt?: (
    evidence: RequestEvidence,
    error: unknown,
  ) => void | Promise<void>;
  onCaptureError?: (error: unknown) => void;
}

export interface RequestStepContext {
  stepNumber: number;
  messageList?: MessageList;
  applicationInstructions?: unknown;
  extraContext?: unknown;
}

interface PublicModel {
  specificationVersion: string;
  modelId: string;
  provider: string;
}

const SETTINGS = [
  "maxOutputTokens",
  "temperature",
  "topP",
  "topK",
  "presencePenalty",
  "frequencyPenalty",
  "stopSequences",
  "seed",
  "responseFormat",
  "reasoning",
  "providerOptions",
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** Capture the final provider arguments without consuming or replacing its output stream. */
export function createRequestCapture(options: RequestCaptureOptions) {
  let currentRequestId: string | undefined;
  let context: {
    stepNumber: number;
    provenance: JsonValue;
    reasons: string[];
  } = {
    stepNumber: 0,
    provenance: null,
    reasons: ["Step provenance was not supplied."],
  };
  const attempts = new Map<number, number>();
  const unfinished = new Map<
    string,
    { evidence: RequestEvidence; returned: boolean }
  >();
  const proxies = new WeakMap<object, object>();
  const writes = new Set<Promise<void>>();

  function report(error: unknown): void {
    try {
      options.onCaptureError?.(error);
    } catch {
      /* Diagnostics cannot change native execution. */
    }
  }

  function convert(
    value: unknown,
    label: string,
    reasons: string[],
  ): JsonValue {
    try {
      const encoded = encodeMemoryValue(value);
      // Provider options can contain custom transport headers whose keys are
      // not recognizable credential names. Do not persist that transport bag.
      function containsTransport(current: JsonValue): boolean {
        if (current === null || typeof current !== "object") return false;
        if (Array.isArray(current)) return current.some(containsTransport);
        return Object.entries(current).some(
          ([key, item]) =>
            /^(headers|abortsignal)$/i.test(key) || containsTransport(item),
        );
      }
      if (containsTransport(encoded)) {
        reasons.push(`${label} contains transport metadata.`);
        return null;
      }
      if (options.recordingLimits === undefined) return encoded;
      const converted = boundedRecorderConversion(
        encoded,
        label,
        options.recordingLimits,
      );
      if (converted.lossy)
        reasons.push(
          `${label} exceeded recording limits or required redaction.`,
        );
      return converted.value;
    } catch (error) {
      reasons.push(`${label} could not be recorded losslessly.`);
      report(error);
      return null;
    }
  }

  function beginStep(step: RequestStepContext): void {
    const reasons: string[] = [];
    let provenance: JsonValue = null;
    try {
      const list = step.messageList;
      const sources = list?.makeMessageSourceChecker();
      provenance = convert(
        {
          applicationInstructions: step.applicationInstructions,
          extraContext: step.extraContext,
          systemMessages: list?.serializeForSpan().systemMessages ?? [],
          messages:
            list?.get.all.db().map((message) => ({
              id: message.id,
              source: sources?.getSource(message) ?? null,
              role: message.role,
              content: message.content,
            })) ?? [],
        },
        "Prompt provenance",
        reasons,
      );
    } catch (error) {
      reasons.push("Prompt provenance could not be read.");
      report(error);
    }
    context = { stepNumber: step.stepNumber, provenance, reasons };
  }

  function capture(
    model: PublicModel,
    method: RequestEvidence["method"],
    args: unknown,
  ): RequestEvidence {
    const reasons = [...context.reasons];
    const attemptNumber = (attempts.get(context.stepNumber) ?? 0) + 1;
    attempts.set(context.stepNumber, attemptNumber);
    let memoryRevision: number | null = null;
    try {
      memoryRevision = options.getMemoryRevision();
    } catch (error) {
      reasons.push("Memory revision could not be read.");
      report(error);
    }
    const request = asRecord(args);
    let inputs: JsonValue = null;
    const modelSettings: Record<string, JsonValue> = {};
    try {
      inputs = convert(
        {
          prompt: request.prompt,
          tools: request.tools,
          toolChoice: request.toolChoice,
        },
        "Effective model request",
        reasons,
      );
      for (const key of SETTINGS) {
        if (request[key] !== undefined)
          modelSettings[key] = convert(
            request[key],
            `Model setting ${key}`,
            reasons,
          );
      }
    } catch (error) {
      reasons.push("Effective model arguments could not be read.");
      report(error);
    }
    const combined = recordedToolPayloadConversion(
      { inputs, modelSettings, provenance: context.provenance },
      "Effective request evidence",
    );
    if (combined.lossy) {
      reasons.push("Combined request evidence exceeded recording limits.");
      inputs = null;
    }
    return {
      externalId: globalThis.crypto.randomUUID(),
      invocationId: options.invocationId,
      stepNumber: context.stepNumber,
      attemptNumber,
      memoryRevision,
      method,
      modelId: model.modelId,
      provider: model.provider,
      startedAt: new Date().toISOString(),
      inputs,
      modelSettings: combined.lossy ? {} : modelSettings,
      provenance: combined.lossy ? null : context.provenance,
      complete: reasons.length === 0,
      reasons,
    };
  }

  function instrumentModel<T extends PublicModel>(model: T): T {
    if (!["v2", "v3", "v4"].includes(model.specificationVersion))
      throw new TypeError("Request capture requires a v2, v3, or v4 model");
    const existing = proxies.get(model);
    if (existing) return existing as T;
    const proxy = new Proxy(model, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (
          (key === "doStream" || key === "doGenerate") &&
          typeof value === "function"
        ) {
          return async (...args: unknown[]) => {
            const evidence = capture(target, key, args[0]);
            currentRequestId = evidence.externalId;
            const attempt = { evidence, returned: false };
            unfinished.set(evidence.externalId, attempt);
            try {
              const result = await Reflect.apply(value, target, args);
              attempt.returned = true;
              return result;
            } catch (error) {
              unfinished.delete(evidence.externalId);
              // Queue the sink separately: retries and provider failures retain native behavior.
              const write = Promise.resolve()
                .then(() => options.onFailedAttempt?.(evidence, error))
                .catch(report);
              writes.add(write);
              void write.finally(() => writes.delete(write));
              throw error;
            }
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    proxies.set(model, proxy);
    proxies.set(proxy, proxy);
    return proxy;
  }

  function takeSuccessful(stepNumber?: number): RequestEvidence | undefined {
    for (const [id, attempt] of unfinished) {
      if (
        attempt.returned &&
        (stepNumber === undefined || attempt.evidence.stepNumber === stepNumber)
      ) {
        unfinished.delete(id);
        return attempt.evidence;
      }
    }
    return undefined;
  }

  /** Retain requests whose step never completed, including aborts and abandoned output streams. */
  function flushUnfinished(): RequestEvidence[] {
    const evidence = [...unfinished.values()].map(
      (attempt) => attempt.evidence,
    );
    unfinished.clear();
    return evidence;
  }

  async function drain(): Promise<void> {
    while (writes.size > 0) await Promise.all(writes);
  }

  return {
    beginStep,
    instrumentModel,
    takeSuccessful,
    flushUnfinished,
    drain,
    get currentRequestId() {
      return currentRequestId;
    },
  };
}

/** Attributes shared by normal step completion and failed or unfinished attempt records. */
export function requestEvidenceAttributes(
  evidence: RequestEvidence,
): Record<string, JsonValue> {
  return {
    invocation_id: evidence.invocationId,
    step_number: evidence.stepNumber,
    attempt_number: evidence.attemptNumber,
    memory_revision: evidence.memoryRevision,
    request_method: evidence.method,
    request_complete: evidence.complete,
    request_incomplete_reasons: evidence.reasons,
    prompt_provenance: evidence.provenance,
  };
}
