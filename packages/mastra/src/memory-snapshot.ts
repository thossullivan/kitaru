import { createHash } from "node:crypto";
import type { MastraDBMessage, StorageThreadType } from "@mastra/core/memory";
import type {
  ObservationalMemoryRecord,
  StorageResourceType,
} from "@mastra/core/storage";
import { type JsonValue, toRecorderJson } from "@zenml-io/kitaru";
import {
  MAX_RECORDED_PAYLOAD_CHARS,
  recordedToolPayloadConversion,
} from "@zenml-io/kitaru/adapter";

export const MEMORY_REPLAY_KEY = "mastra_memory_replay";
const CODEC_KEY = "$mastra";

export interface MastraMemorySnapshot {
  threadId: string;
  resourceId: string;
  thread: StorageThreadType | null;
  resource: StorageResourceType | null;
  messages: MastraDBMessage[];
  records: ObservationalMemoryRecord[];
}

export interface MastraRecordedFile {
  url: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface MastraFileManifestEntry {
  [key: string]: JsonValue;
  url: string;
  mediaType: string;
  base64: string;
  length: number;
  sha256: string;
}

export interface MastraMemoryReplayInput {
  invocationId: string;
  rawInput: unknown;
  initialSnapshot: MastraMemorySnapshot;
  /** Materialized options only. Models and schemas need explicit JSON representations. */
  configuration: Record<string, unknown>;
  requestContext: Record<string, unknown>;
  files: MastraRecordedFile[];
}

export interface MastraMemoryReplayEnvelope {
  [key: string]: JsonValue;
  version: 2;
  complete: boolean;
  reasons: string[];
  invocationId: string;
  rawInput: JsonValue;
  initialSnapshot: JsonValue;
  configuration: JsonValue;
  requestContext: JsonValue;
  files: MastraFileManifestEntry[];
}

class MemoryReplayError extends Error {}

function unsupported(reason: string): Error {
  return new MemoryReplayError(`Unsupported Mastra memory replay: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireValue(condition: unknown, reason: string): asserts condition {
  if (!condition) throw unsupported(reason);
}

function checkBudget(value: JsonValue): void {
  try {
    toRecorderJson(value);
  } catch {
    throw unsupported(
      "Memory value exceeds the replay JSON depth/item limits.",
    );
  }
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function binary(bytes: Uint8Array): {
  base64: string;
  length: number;
  sha256: string;
} {
  requireValue(
    bytes.byteLength <= MAX_RECORDED_PAYLOAD_CHARS,
    "Binary content exceeds the replay payload limit.",
  );
  return {
    base64: Buffer.from(bytes).toString("base64"),
    length: bytes.byteLength,
    sha256: hash(bytes),
  };
}

function readBinary(value: Record<string, unknown>): Uint8Array {
  requireValue(
    typeof value.base64 === "string" &&
      typeof value.length === "number" &&
      Number.isSafeInteger(value.length) &&
      value.length >= 0 &&
      typeof value.sha256 === "string",
    "Malformed binary content.",
  );
  const bytes = new Uint8Array(Buffer.from(value.base64, "base64"));
  requireValue(
    Buffer.from(bytes).toString("base64") === value.base64 &&
      bytes.length === value.length &&
      hash(bytes) === value.sha256,
    "Corrupt binary content hash, length, or encoding.",
  );
  return bytes;
}

function validateUrl(value: string): URL {
  const url = new URL(value);
  requireValue(
    !url.username && !url.password,
    "URL credentials are not replayable.",
  );
  const query = recordedToolPayloadConversion(
    Object.fromEntries(url.searchParams),
    "Mastra file URL",
  );
  requireValue(!query.lossy, "URL query credentials are not replayable.");
  return url;
}

/** Encode the few non-JSON values in native memory without losing their types. */
export function encodeMemoryValue(value: unknown): JsonValue {
  let items = 0;
  const active = new Set<object>();
  function visit(current: unknown, depth: number): JsonValue {
    requireValue(
      ++items <= 10_000 && depth < 64,
      "Memory value exceeds the replay depth/item limits.",
    );
    if (current === undefined) return { [CODEC_KEY]: "undefined" };
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "string") {
      requireValue(
        current.length <= MAX_RECORDED_PAYLOAD_CHARS,
        "Memory value exceeds the replay payload limit.",
      );
      return current;
    }
    if (typeof current === "number") {
      requireValue(Number.isFinite(current), "Non-finite memory number.");
      return current;
    }
    requireValue(
      typeof current === "object",
      "Unsupported memory value; functions and live dependencies need explicit representations.",
    );
    if (current instanceof Date) {
      requireValue(Number.isFinite(current.getTime()), "Invalid memory Date.");
      return { [CODEC_KEY]: "date", value: current.toISOString() };
    }
    if (current instanceof URL) {
      validateUrl(current.href);
      return { [CODEC_KEY]: "url", value: current.href };
    }
    if (current instanceof Uint8Array)
      return { [CODEC_KEY]: "bytes", ...binary(current) };
    requireValue(!active.has(current), "Circular memory value.");
    active.add(current);
    try {
      if (Array.isArray(current))
        return current.map((item) => visit(item, depth + 1));
      requireValue(
        Object.getPrototypeOf(current) === Object.prototype ||
          Object.getPrototypeOf(current) === null,
        "Unsupported memory object; use explicit JSON configuration.",
      );
      requireValue(
        !Object.hasOwn(current, CODEC_KEY) &&
          Reflect.ownKeys(current).every((key) => typeof key === "string"),
        "Reserved or symbolic memory key.",
      );
      const result: Record<string, JsonValue> = Object.create(null);
      for (const [key, descriptor] of Object.entries(
        Object.getOwnPropertyDescriptors(current),
      )) {
        requireValue(
          descriptor.enumerable && "value" in descriptor,
          "Accessor or hidden memory properties are unsupported.",
        );
        result[key] = visit(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      active.delete(current);
    }
  }
  const encoded = visit(value, 0);
  const converted = recordedToolPayloadConversion(
    encoded,
    "Mastra memory replay",
  );
  requireValue(
    !converted.lossy,
    "Memory content was altered by credential protection or replay payload bounds.",
  );
  checkBudget(converted.value);
  return converted.value;
}

/** Decode an already bounded value, rejecting ambiguous or damaged codec records. */
export function decodeMemoryValue(value: JsonValue): unknown {
  const converted = recordedToolPayloadConversion(
    value,
    "Mastra memory replay",
  );
  requireValue(
    !converted.lossy,
    "Memory content was altered by credential protection or replay payload bounds.",
  );
  checkBudget(converted.value);
  function visit(current: JsonValue): unknown {
    if (Array.isArray(current)) return current.map(visit);
    if (!isRecord(current)) return current;
    if (Object.hasOwn(current, CODEC_KEY)) {
      const kind = current[CODEC_KEY];
      if (kind === "undefined" && Object.keys(current).length === 1)
        return undefined;
      if (
        (kind === "date" || kind === "url") &&
        Object.keys(current).length === 2 &&
        typeof current.value === "string"
      ) {
        if (kind === "url") return validateUrl(current.value);
        const date = new Date(current.value);
        requireValue(
          Number.isFinite(date.getTime()) &&
            date.toISOString() === current.value,
          "Malformed memory Date.",
        );
        return date;
      }
      if (kind === "bytes" && Object.keys(current).length === 4)
        return readBinary(current);
      throw unsupported("Malformed memory codec tag.");
    }
    return Object.fromEntries(
      Object.entries(current).map(([key, item]) => [
        key,
        visit(item as JsonValue),
      ]),
    );
  }
  return visit(converted.value);
}

/** Validate the complete native state before an isolated store receives any writes. */
export function validateMemorySnapshot(
  value: unknown,
): asserts value is MastraMemorySnapshot {
  requireValue(
    isRecord(value) &&
      typeof value.threadId === "string" &&
      value.threadId.length > 0 &&
      typeof value.resourceId === "string" &&
      value.resourceId.length > 0 &&
      Array.isArray(value.messages) &&
      Array.isArray(value.records),
    "Malformed initial memory snapshot.",
  );
  const dates = (record: Record<string, unknown>) =>
    record.createdAt instanceof Date && record.updatedAt instanceof Date;
  requireValue(
    value.thread === null ||
      (isRecord(value.thread) &&
        value.thread.id === value.threadId &&
        value.thread.resourceId === value.resourceId &&
        dates(value.thread)),
    "Malformed or mismatched thread record.",
  );
  requireValue(
    value.resource === null ||
      (isRecord(value.resource) &&
        value.resource.id === value.resourceId &&
        dates(value.resource)),
    "Malformed or mismatched resource record.",
  );
  requireValue(
    value.thread !== null ||
      (value.messages.length === 0 && value.records.length === 0),
    "Orphaned memory state.",
  );
  const messageIds = new Set<string>();
  for (const message of value.messages) {
    requireValue(
      isRecord(message) &&
        typeof message.id === "string" &&
        !messageIds.has(message.id) &&
        message.threadId === value.threadId &&
        (message.resourceId === undefined ||
          message.resourceId === value.resourceId) &&
        message.createdAt instanceof Date &&
        ["system", "user", "assistant", "tool"].includes(
          String(message.role),
        ) &&
        isRecord(message.content) &&
        message.content.format === 2 &&
        Array.isArray(message.content.parts),
      "Malformed or mismatched stored message.",
    );
    messageIds.add(message.id);
  }
  const recordIds = new Set<string>();
  for (const record of value.records) {
    requireValue(
      isRecord(record) &&
        typeof record.id === "string" &&
        !recordIds.has(record.id) &&
        record.scope === "thread" &&
        record.threadId === value.threadId &&
        record.resourceId === value.resourceId &&
        dates(record) &&
        typeof record.activeObservations === "string" &&
        isRecord(record.config),
      "Malformed or unsupported observational-memory record.",
    );
    recordIds.add(record.id);
    for (const key of [
      "generationCount",
      "totalTokensObserved",
      "observationTokenCount",
      "pendingMessageTokens",
      "lastBufferedAtTokens",
    ])
      requireValue(
        typeof record[key] === "number" &&
          Number.isFinite(record[key]) &&
          record[key] >= 0,
        "Malformed observational-memory counter.",
      );
    for (const key of [
      "isObserving",
      "isReflecting",
      "isBufferingObservation",
      "isBufferingReflection",
    ])
      requireValue(
        record[key] === false,
        "Unjoined observational-memory work or missing work flag.",
      );
    requireValue(
      record.lastBufferedAtTime === null ||
        record.lastBufferedAtTime instanceof Date,
      "Malformed observational-memory buffer cursor.",
    );
    requireValue(
      record.lastObservedAt === undefined ||
        record.lastObservedAt instanceof Date,
      "Malformed observational-memory observation cursor.",
    );
    requireValue(
      record.originType === "initial" || record.originType === "reflection",
      "Malformed observational-memory generation origin.",
    );
    for (const key of [
      "bufferedObservations",
      "bufferedReflection",
      "observedTimezone",
    ])
      requireValue(
        record[key] === undefined || typeof record[key] === "string",
        "Malformed observational-memory text.",
      );
    for (const key of [
      "bufferedObservationTokens",
      "bufferedReflectionTokens",
      "bufferedReflectionInputTokens",
      "reflectedObservationLineCount",
    ])
      requireValue(
        record[key] === undefined ||
          (typeof record[key] === "number" &&
            Number.isFinite(record[key]) &&
            record[key] >= 0),
        "Malformed observational-memory buffer counter.",
      );
    for (const key of ["observedMessageIds", "bufferedMessageIds"])
      requireValue(
        record[key] === undefined ||
          (Array.isArray(record[key]) &&
            record[key].every((id) => typeof id === "string")),
        "Malformed observational-memory message identities.",
      );
    const chunks = record.bufferedObservationChunks;
    requireValue(
      chunks === undefined || Array.isArray(chunks),
      "Malformed observation buffer.",
    );
    if (Array.isArray(chunks))
      for (const chunk of chunks) {
        requireValue(
          isRecord(chunk) &&
            typeof chunk.id === "string" &&
            typeof chunk.cycleId === "string" &&
            typeof chunk.observations === "string" &&
            chunk.createdAt instanceof Date &&
            chunk.lastObservedAt instanceof Date &&
            typeof chunk.tokenCount === "number" &&
            Number.isFinite(chunk.tokenCount) &&
            chunk.tokenCount >= 0 &&
            typeof chunk.messageTokens === "number" &&
            Number.isFinite(chunk.messageTokens) &&
            chunk.messageTokens >= 0 &&
            Array.isArray(chunk.messageIds) &&
            chunk.messageIds.every((id) => typeof id === "string"),
          "Malformed observation buffer chunk.",
        );
      }
  }
}

function validateConfiguration(
  configuration: unknown,
): asserts configuration is Record<string, unknown> {
  requireValue(isRecord(configuration), "Malformed resolved configuration.");
  const memory = configuration.memoryConfig ?? configuration.memory;
  if (!isRecord(memory)) return;
  requireValue(
    memory.semanticRecall === undefined || memory.semanticRecall === false,
    "Semantic recall is outside isolated memory replay scope.",
  );
  for (const key of ["workingMemory", "observationalMemory"]) {
    const feature = memory[key];
    if (isRecord(feature) && feature.enabled !== false)
      requireValue(
        feature.scope === "thread",
        "Only explicitly thread-scoped memory is replayable.",
      );
  }
}

/** Build safe diagnostic evidence even when complete replay prerequisites are unavailable. */
export function createMemoryReplayEnvelope(
  input: MastraMemoryReplayInput,
): MastraMemoryReplayEnvelope {
  const incomplete = (reason: string): MastraMemoryReplayEnvelope => ({
    version: 2,
    complete: false,
    reasons: [reason],
    invocationId: "",
    rawInput: null,
    initialSnapshot: null,
    configuration: null,
    requestContext: null,
    files: [],
  });
  try {
    validateMemorySnapshot(input.initialSnapshot);
    validateConfiguration(input.configuration);
    const envelope: MastraMemoryReplayEnvelope = {
      version: 2,
      complete: true,
      reasons: [],
      invocationId: input.invocationId,
      rawInput: encodeMemoryValue(input.rawInput),
      initialSnapshot: encodeMemoryValue(input.initialSnapshot),
      configuration: encodeMemoryValue(input.configuration),
      requestContext: encodeMemoryValue(input.requestContext),
      files: input.files.map((file) => ({
        url: file.url,
        mediaType: file.mediaType,
        ...binary(file.bytes),
      })),
    };
    // The combined envelope, including encoded bytes and metadata, shares one budget.
    const converted = recordedToolPayloadConversion(
      envelope,
      "Mastra memory replay envelope",
    );
    requireValue(
      !converted.lossy,
      "Envelope exceeds replay limits or contains credentials.",
    );
    decodeMemoryReplayEnvelope(converted.value);
    return converted.value as unknown as MastraMemoryReplayEnvelope;
  } catch (error) {
    return incomplete(
      error instanceof MemoryReplayError
        ? error.message
        : "Memory replay prerequisites could not be captured safely.",
    );
  }
}

export function decodeMemoryReplayEnvelope(
  input: unknown,
): MastraMemoryReplayInput {
  const converted = recordedToolPayloadConversion(
    input,
    "Mastra memory replay envelope",
  );
  requireValue(
    !converted.lossy,
    "Envelope exceeds replay limits or contains credentials.",
  );
  checkBudget(converted.value);
  const value = converted.value;
  requireValue(
    isRecord(value) &&
      value.version === 2 &&
      value.complete === true &&
      Array.isArray(value.reasons) &&
      value.reasons.length === 0 &&
      typeof value.invocationId === "string" &&
      value.invocationId.length > 0 &&
      Array.isArray(value.files),
    "Missing, incomplete, or unknown version of memory replay envelope.",
  );
  for (const key of [
    "rawInput",
    "initialSnapshot",
    "configuration",
    "requestContext",
  ])
    requireValue(
      Object.hasOwn(value, key),
      "Missing memory replay prerequisite.",
    );
  const initialSnapshot = decodeMemoryValue(value.initialSnapshot as JsonValue);
  validateMemorySnapshot(initialSnapshot);
  const configuration = decodeMemoryValue(value.configuration as JsonValue);
  validateConfiguration(configuration);
  const requestContext = decodeMemoryValue(value.requestContext as JsonValue);
  requireValue(isRecord(requestContext), "Malformed recorded request context.");
  const urls = new Set<string>();
  const files = value.files.map((file) => {
    requireValue(
      isRecord(file) &&
        typeof file.url === "string" &&
        !urls.has(file.url) &&
        typeof file.mediaType === "string" &&
        file.mediaType.length > 0,
      "Malformed or duplicate recorded file.",
    );
    validateUrl(file.url);
    urls.add(file.url);
    return {
      url: file.url,
      mediaType: file.mediaType,
      bytes: readBinary(file),
    };
  });
  return {
    invocationId: value.invocationId,
    rawInput: decodeMemoryValue(value.rawInput as JsonValue),
    initialSnapshot,
    configuration,
    requestContext,
    files,
  };
}

/** Return undefined for legacy inputs; a present but invalid v2 envelope always rejects. */
export function restoreMemoryReplayEnvelope(
  input: unknown,
): MastraMemoryReplayInput | undefined {
  if (!isRecord(input) || !Object.hasOwn(input, MEMORY_REPLAY_KEY))
    return undefined;
  return decodeMemoryReplayEnvelope(input[MEMORY_REPLAY_KEY]);
}
