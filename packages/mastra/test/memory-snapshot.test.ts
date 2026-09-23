import { expect, it } from "vitest";
import {
  createContextInput,
  restoreConversationContext,
} from "../src/conversation-context.js";
import {
  createMemoryReplayEnvelope,
  decodeMemoryReplayEnvelope,
  decodeMemoryValue,
  encodeMemoryValue,
} from "../src/memory-snapshot.js";
import {
  createMemoryRuntime,
  FILE_BYTES,
  FILE_URL,
  seedMemory,
  snapshotMemory,
} from "./helpers/memory-agent.js";

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null)
    throw new Error("Missing fixture value");
  return value;
}

async function fixture() {
  const runtime = createMemoryRuntime();
  await seedMemory(runtime);
  return {
    invocationId: "invocation-1",
    rawInput: [
      { role: "user", content: [{ type: "file", data: new URL(FILE_URL) }] },
    ],
    initialSnapshot: {
      ...(await snapshotMemory(runtime, true)),
      threadId: "historical-thread",
      resourceId: "historical-resource",
    },
    configuration: {
      instructions: "Answer",
      model: { provider: "fixture", modelId: "actor" },
      memory: {
        semanticRecall: false,
        workingMemory: { scope: "thread", schema: { type: "object" } },
        observationalMemory: { scope: "thread" },
      },
    },
    requestContext: { locale: "en" },
    files: [{ url: FILE_URL, mediaType: "application/pdf", bytes: FILE_BYTES }],
  };
}

it("round-trips historical memory Dates, undefined fields, URL input and lossless binary", async () => {
  const input = await fixture();
  required(input.initialSnapshot.records[0]).lastBufferedAtTime = new Date(123);
  required(input.initialSnapshot.records[0]).bufferedReflection =
    "pending reflection";
  required(input.initialSnapshot.records[0]).bufferedMessageIds = [
    "historical-message",
  ];
  const envelope = createMemoryReplayEnvelope(input);
  expect(envelope.complete).toBe(true);
  const restored = decodeMemoryReplayEnvelope(
    JSON.parse(JSON.stringify(envelope)),
  );
  expect(restored).toEqual(input);
  expect(restored.initialSnapshot.messages[0]?.createdAt).toBeInstanceOf(Date);
  expect(decodeMemoryValue(encodeMemoryValue(FILE_BYTES))).toEqual(FILE_BYTES);
});

it.each(["version", "hash", "missing", "inflight"])(
  "rejects invalid replay prerequisites: %s",
  async (kind) => {
    const envelope = createMemoryReplayEnvelope(await fixture());
    if (kind === "version") envelope.version = 3 as 2;
    if (kind === "hash") required(envelope.files[0]).sha256 = "0".repeat(64);
    if (kind === "missing") envelope.initialSnapshot = {};
    if (kind === "inflight") {
      const input = await fixture();
      required(input.initialSnapshot.records[0]).isObserving = true;
      Object.assign(envelope, createMemoryReplayEnvelope(input));
    }
    expect(() => decodeMemoryReplayEnvelope(envelope)).toThrow(
      /Unsupported Mastra memory replay/,
    );
  },
);

it.each([
  { apiKey: "private-value" },
  { callback: () => "live" },
  { value: "a".repeat(1_048_576) },
  { value: new Map([["key", "value"]]) },
  { value: Array.from({ length: 10_001 }, () => 1) },
])(
  "marks altered or oversized state incomplete without exposing credentials",
  async (configuration) => {
    const envelope = createMemoryReplayEnvelope({
      ...(await fixture()),
      configuration,
    });
    expect(envelope.complete).toBe(false);
    expect(JSON.stringify(envelope)).not.toContain("private-value");
    expect(() => decodeMemoryReplayEnvelope(envelope)).toThrow();
  },
);

it("rejects reserved codec tags and cyclic objects instead of accepting ambiguous data", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(() => encodeMemoryValue(cycle)).toThrow();
  expect(() =>
    encodeMemoryValue({ $mastra: "date", value: "2026-01-01" }),
  ).toThrow();
});

it("keeps the version-1 recalled conversation contract", () => {
  const messages = [{ role: "user", content: "hello" }];
  expect(
    restoreConversationContext(createContextInput(messages, messages)),
  ).toEqual(messages);
});

it("round-trips complete buffered chunks and every historical OM generation", async () => {
  const input = await fixture();
  required(input.initialSnapshot.records[0]).bufferedObservationChunks = [
    {
      id: "chunk-1",
      cycleId: "cycle-1",
      observations: "buffered",
      tokenCount: 3,
      messageIds: ["historical-message"],
      messageTokens: 7,
      lastObservedAt: new Date(100),
      createdAt: new Date(110),
      extractedValues: { next: "wait" },
    },
  ];
  input.initialSnapshot.records.push({
    ...required(input.initialSnapshot.records[0]),
    id: "older-generation",
    generationCount: 1,
    originType: "reflection",
  });
  expect(decodeMemoryReplayEnvelope(createMemoryReplayEnvelope(input))).toEqual(
    input,
  );
});

it("round-trips an empty initial conversation", async () => {
  const input = await fixture();
  input.initialSnapshot = {
    threadId: "new",
    resourceId: "new-resource",
    thread: null,
    resource: null,
    messages: [],
    records: [],
  };
  expect(
    decodeMemoryReplayEnvelope(createMemoryReplayEnvelope(input))
      .initialSnapshot,
  ).toEqual(input.initialSnapshot);
});

it("counts aggregate envelope items, depth, and binary expansion against the shared budget", async () => {
  const input = await fixture();
  expect(
    createMemoryReplayEnvelope({
      ...input,
      configuration: { values: Array.from({ length: 6000 }, () => 1) },
      requestContext: { values: Array.from({ length: 6000 }, () => 1) },
    }).complete,
  ).toBe(false);
  const deep = Array.from({ length: 65 }).reduce<unknown>(
    (value) => ({ value }),
    null,
  );
  expect(() => encodeMemoryValue(deep)).toThrow(/depth/);
  const withFile = await fixture();
  required(withFile.files[0]).bytes = new Uint8Array(800_000);
  expect(createMemoryReplayEnvelope(withFile).complete).toBe(false);
});

it.each(["resourceScope", "semanticRecall", "buffer", "ids", "date", "url"])(
  "rejects malformed or out-of-scope state: %s",
  async (kind) => {
    const input = await fixture();
    if (kind === "resourceScope")
      required(input.initialSnapshot.records[0]).scope = "resource";
    if (kind === "semanticRecall")
      input.configuration.memory.semanticRecall = true;
    if (kind === "buffer")
      required(input.initialSnapshot.records[0]).bufferedObservationChunks = [
        {} as never,
      ];
    if (kind === "ids")
      required(input.initialSnapshot.messages[0]).threadId = "different-thread";
    if (kind === "date")
      required(input.initialSnapshot.messages[0]).createdAt = new Date(
        Number.NaN,
      );
    if (kind === "url")
      required(required(input.rawInput[0]).content[0]).data = new URL(
        "https://files.invalid/file?apiKey=private-value",
      );
    const envelope = createMemoryReplayEnvelope(input);
    expect(envelope.complete).toBe(false);
    expect(JSON.stringify(envelope)).not.toContain("private-value");
  },
);

it("rejects changed file lengths, noncanonical base64, and malformed date tags", async () => {
  const input = await fixture();
  for (const patch of [{ length: 100 }, { base64: "???" }]) {
    const envelope = createMemoryReplayEnvelope(input);
    Object.assign(required(envelope.files[0]), patch);
    expect(() => decodeMemoryReplayEnvelope(envelope)).toThrow(/binary/);
  }
  expect(() =>
    decodeMemoryValue({ $mastra: "date", value: "2026-01-01" }),
  ).toThrow(/Date/);
});
