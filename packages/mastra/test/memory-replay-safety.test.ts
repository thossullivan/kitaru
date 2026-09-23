import {
  MASTRA_AUTH_TOKEN_KEY,
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  RequestContext,
} from "@mastra/core/request-context";
import { InMemoryStore } from "@mastra/core/storage";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { afterEach, expect, it, vi } from "vitest";
import { createProcessLocalMemoryAccess } from "../src/memory-binding.js";
import {
  createMemoryReplayEnvelope,
  decodeMemoryReplayEnvelope,
  type MastraMemoryReplayInput,
} from "../src/memory-snapshot.js";
import {
  createMemoryReplayAgent,
  type MemoryReplayAgentFactory,
  type MemoryReplayAgentOptions,
} from "../src/stateful-agent.js";
import { textStream } from "./helpers/memory-agent.js";
import { AGENT_ID, installTestApi, REPLAY_ID } from "./helpers.js";

const stores: InMemoryStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function input(): MastraMemoryReplayInput {
  return {
    invocationId: "safety-test",
    rawInput: "hello",
    initialSnapshot: {
      threadId: "thread",
      resourceId: "resource",
      thread: null,
      resource: null,
      messages: [],
      records: [],
    },
    configuration: {
      runOptions: { memory: { thread: "thread", resource: "resource" } },
    },
    requestContext: {},
    files: [],
  };
}

function fixture(
  factory?: MemoryReplayAgentFactory,
  overrides: Partial<MemoryReplayAgentOptions> = {},
) {
  const store = new InMemoryStore();
  stores.push(store);
  const domain = store.stores.memory;
  if (!domain) throw new Error("Missing native memory domain");
  const modelCall = vi.fn(async () => textStream("done"));
  const model = new MastraLanguageModelV2Mock({
    provider: "fixture",
    modelId: "actor",
    doStream: modelCall,
  });
  const lease = createProcessLocalMemoryAccess();
  const acquire = vi.spyOn(lease, "acquire");
  const adapter = createMemoryReplayAgent(
    factory ??
      (({ memory }) => ({
        id: "safety",
        name: "Safety",
        memory,
        model,
        instructions: "Answer",
      })),
    {
      agentId: AGENT_ID,
      apiUrl: "https://kitaru.invalid",
      apiKey: "fixture",
      requestedModelId: "fixture/actor",
      sourceMemory: () => ({
        settled: async () => {},
        domain,
        configuration: { semanticRecall: false },
        exclusiveAccess: lease,
      }),
      resolveModel: () => model,
      ...overrides,
    },
  );
  return { adapter, modelCall, acquire, lease };
}

it.each(["defaultOptions", "runOptions", "memoryConfig"])(
  "excludes transport credentials from %s during capture and decode",
  (key) => {
    const original = input();
    const unsafe = {
      providerOptions: {
        openai: { websocket: { headers: { "x-custom-access": "CREDENTIAL" } } },
      },
    };
    const clean = createMemoryReplayEnvelope(original);
    const envelope = createMemoryReplayEnvelope({
      ...original,
      configuration: { ...original.configuration, [key]: unsafe },
    });
    expect(envelope.complete).toBe(false);
    expect(JSON.stringify(envelope)).not.toContain("CREDENTIAL");
    expect(() =>
      decodeMemoryReplayEnvelope({
        ...clean,
        configuration: { ...original.configuration, [key]: unsafe },
      }),
    ).toThrow(/transport/i);
  },
);

it("rejects native auth tokens during capture and decode", () => {
  const original = input();
  const requestContext = { [MASTRA_AUTH_TOKEN_KEY]: "CREDENTIAL" };
  const clean = createMemoryReplayEnvelope(original);
  const unsafe = createMemoryReplayEnvelope({ ...original, requestContext });
  expect(unsafe.complete).toBe(false);
  expect(JSON.stringify(unsafe)).not.toContain("CREDENTIAL");
  expect(() =>
    decodeMemoryReplayEnvelope({ ...clean, requestContext }),
  ).toThrow(/auth/i);
});

it("rejects default auth-token context capture before recording or execution", async () => {
  const api = installTestApi();
  const { adapter, modelCall } = fixture();
  const requestContext = new RequestContext();
  requestContext.set(MASTRA_AUTH_TOKEN_KEY, "CREDENTIAL");
  await expect(
    adapter.stream("hello", {
      memory: { thread: "thread", resource: "resource" },
      requestContext,
    }),
  ).rejects.toThrow(/auth/i);
  expect(modelCall).not.toHaveBeenCalled();
  expect(api.calls).toEqual([]);
});

it.each([MASTRA_THREAD_ID_KEY, MASTRA_RESOURCE_ID_KEY])(
  "rejects a mismatched %s before acquiring the source lease",
  async (key) => {
    const api = installTestApi();
    const { adapter, modelCall, acquire } = fixture();
    const requestContext = new RequestContext();
    requestContext.set(key, "other");
    await expect(
      adapter.stream("hello", {
        memory: { thread: "thread", resource: "resource" },
        requestContext,
      }),
    ).rejects.toThrow(/selector/i);
    expect(acquire).not.toHaveBeenCalled();
    expect(modelCall).not.toHaveBeenCalled();
    expect(api.calls).toEqual([]);
  },
);

it("does not let selective context capture bypass middleware memory selectors", async () => {
  const api = installTestApi();
  const { adapter, acquire } = fixture(undefined, {
    captureRequestContext: () => ({ locale: "en" }),
  });
  const requestContext = new RequestContext();
  requestContext.set(MASTRA_THREAD_ID_KEY, "authorized-thread");
  await expect(
    adapter.stream("hello", {
      memory: { thread: "thread", resource: "resource" },
      requestContext,
    }),
  ).rejects.toThrow(/selector/i);
  expect(acquire).not.toHaveBeenCalled();
  expect(api.calls).toEqual([]);
});

it("allows selective capture to exclude live authentication tokens", async () => {
  const api = installTestApi();
  const { adapter } = fixture(undefined, {
    captureRequestContext: () => ({ locale: "en" }),
  });
  const requestContext = new RequestContext();
  requestContext.set(MASTRA_AUTH_TOKEN_KEY, "CREDENTIAL");
  const result = await adapter.stream("hello", {
    memory: { thread: "thread", resource: "resource" },
    requestContext,
  });
  await result.consumeStream();
  expect(JSON.stringify(api.calls)).not.toContain("CREDENTIAL");
  expect(
    api.calls.filter((call) => call.method === "PATCH").at(-1)?.body?.status,
  ).toBe("completed");
});

it("records and replays matching middleware and invocation memory selectors", async () => {
  const api = installTestApi();
  const { adapter, modelCall, acquire } = fixture();
  const requestContext = new RequestContext();
  requestContext.set(MASTRA_THREAD_ID_KEY, "thread");
  requestContext.set(MASTRA_RESOURCE_ID_KEY, "resource");
  const baseline = await adapter.stream("hello", {
    memory: { thread: "thread", resource: "resource" },
    requestContext,
  });
  await baseline.consumeStream();
  const recorded = api.calls.find((call) => call.path === "/api/v1/sessions")
    ?.body?.inputs;
  expect(recorded).toHaveProperty("mastra_memory_replay.complete", true);
  vi.stubEnv("KITARU_REPLAY_ID", REPLAY_ID);
  vi.stubEnv("KITARU_TASK_INPUTS", JSON.stringify(recorded));
  const replay = await adapter.stream("ignored", {
    memory: { thread: "live-thread", resource: "live-resource" },
  });
  await replay.consumeStream();
  expect(modelCall).toHaveBeenCalledTimes(2);
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(
    api.calls
      .filter((call) => call.method === "PATCH")
      .map((call) => call.body?.status),
  ).toEqual(["completed", "completed"]);
});

it.each([MASTRA_THREAD_ID_KEY, MASTRA_RESOURCE_ID_KEY, MASTRA_AUTH_TOKEN_KEY])(
  "rejects late processor writes to %s",
  async (key) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const api = installTestApi();
    const modelCall = vi.fn(async () => textStream("done"));
    const { adapter } = fixture(({ memory }) => ({
      id: "processor-mutation",
      name: "Processor mutation",
      memory,
      model: new MastraLanguageModelV2Mock({ doStream: modelCall }),
      instructions: "Answer",
      inputProcessors: [
        {
          id: "context-mutation",
          processInput({ requestContext, messages }) {
            if (!requestContext) throw new Error("Missing request context");
            requestContext.setRaw(key, "FORBIDDEN");
            return messages;
          },
        },
      ],
    }));
    await expect(
      adapter.stream("hello", {
        memory: { thread: "thread", resource: "resource" },
      }),
    ).rejects.toThrow(/processor/i);
    expect(modelCall).not.toHaveBeenCalled();
    expect(JSON.stringify(api.calls)).not.toContain("FORBIDDEN");
    expect(
      api.calls.filter((call) => call.method === "PATCH").at(-1)?.body?.status,
    ).toBe("failed");
  },
);

it.each([MASTRA_THREAD_ID_KEY, MASTRA_RESOURCE_ID_KEY, MASTRA_AUTH_TOKEN_KEY])(
  "rejects dynamic resolver mutations of %s before native execution",
  async (key) => {
    const api = installTestApi();
    const { adapter, modelCall } = fixture(({ memory }) => ({
      id: "mutation",
      name: "Mutation",
      memory,
      model: new MastraLanguageModelV2Mock({
        doStream: async () => textStream("done"),
      }),
      instructions: ({ requestContext }) => {
        requestContext.set(key, "other");
        return "Answer";
      },
    }));
    await expect(
      adapter.stream("hello", {
        memory: { thread: "thread", resource: "resource" },
      }),
    ).rejects.toThrow(/selector|auth/i);
    expect(modelCall).not.toHaveBeenCalled();
    expect(api.calls).toEqual([]);
  },
);

it("never uploads provider transport credentials in session inputs", async () => {
  const api = installTestApi();
  const { adapter } = fixture();
  const result = await adapter.stream("hello", {
    memory: { thread: "thread", resource: "resource" },
    providerOptions: {
      openai: { websocket: { headers: { "x-custom-access": "CREDENTIAL" } } },
    },
  });
  await result.consumeStream();
  const session = api.calls.find((call) => call.path === "/api/v1/sessions");
  expect(session?.body?.inputs).toHaveProperty(
    "mastra_memory_replay.complete",
    false,
  );
  expect(JSON.stringify(api.calls)).not.toContain("CREDENTIAL");
});

it("rejects late auth-token additions by default-option resolvers", async () => {
  const api = installTestApi();
  const { adapter } = fixture(({ memory }) => ({
    id: "defaults",
    name: "Defaults",
    memory,
    instructions: "Answer",
    model: new MastraLanguageModelV2Mock({}),
    defaultOptions: ({ requestContext }) => {
      requestContext.setRaw(MASTRA_AUTH_TOKEN_KEY, "CREDENTIAL");
      return {};
    },
  }));
  await expect(
    adapter.stream("hello", {
      memory: { thread: "thread", resource: "resource" },
    }),
  ).rejects.toThrow(/auth/i);
  expect(api.calls).toEqual([]);
});

it("marks nested abort signals as unsupported transport configuration", () => {
  const original = input();
  const configuration = { nested: [{ abortSignal: "transport-state" }] };
  expect(
    createMemoryReplayEnvelope({ ...original, configuration }).complete,
  ).toBe(false);
  expect(() =>
    decodeMemoryReplayEnvelope({
      ...createMemoryReplayEnvelope(original),
      configuration,
    }),
  ).toThrow(/transport/i);
});

it("rejects replay envelopes with selectors inconsistent with the snapshot", () => {
  const envelope = createMemoryReplayEnvelope(input());
  expect(() =>
    decodeMemoryReplayEnvelope({
      ...envelope,
      requestContext: { [MASTRA_THREAD_ID_KEY]: "other" },
    }),
  ).toThrow(/selector/i);
  expect(() =>
    decodeMemoryReplayEnvelope({
      ...envelope,
      configuration: {
        runOptions: { memory: { thread: "other", resource: "resource" } },
      },
    }),
  ).toThrow(/selector/i);
});

it("preserves setup errors when settling memory also rejects", async () => {
  const original = new Error("Original setup error");
  const cleanup = new Error("Memory cleanup error");
  const onRecordingError = vi.fn();
  const { adapter, lease } = fixture(
    ({ memory }) => {
      vi.spyOn(memory, "settled").mockRejectedValue(cleanup);
      throw original;
    },
    { onRecordingError },
  );
  await expect(
    adapter.stream("hello", {
      memory: { thread: "thread", resource: "resource" },
    }),
  ).rejects.toBe(original);
  await vi.waitFor(() =>
    expect(onRecordingError).toHaveBeenCalledWith(
      expect.objectContaining({ error: cleanup, stage: "complete" }),
    ),
  );
  const release = await lease.acquire({
    threadId: "thread",
    resourceId: "resource",
  });
  await release();
});

it("preserves native stream errors when cleanup and diagnostics reject", async () => {
  installTestApi();
  const original = new Error("Native stream failed");
  const cleanup = new Error("Cleanup failed");
  const onRecordingError = vi.fn(async () => {
    throw new Error("Diagnostic failed");
  });
  vi.spyOn(Agent.prototype, "stream").mockRejectedValue(original);
  const { adapter } = fixture(
    ({ memory }) => {
      vi.spyOn(memory, "settled").mockRejectedValue(cleanup);
      return {
        id: "failure",
        name: "Failure",
        memory,
        instructions: "Answer",
        model: new MastraLanguageModelV2Mock({}),
      };
    },
    { onRecordingError },
  );
  await expect(
    adapter.stream("hello", {
      memory: { thread: "thread", resource: "resource" },
    }),
  ).rejects.toBe(original);
  await vi.waitFor(() =>
    expect(onRecordingError).toHaveBeenCalledWith(
      expect.objectContaining({ error: cleanup, stage: "complete" }),
    ),
  );
});

import { Agent } from "@mastra/core/agent";
