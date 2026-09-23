import { Agent } from "@mastra/core/agent";
import type { InputProcessor } from "@mastra/core/processors";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { afterEach, expect, it, vi } from "vitest";
import {
  createMemoryRuntime,
  RESOURCE,
  seedMemory,
  streamParts,
  THREAD,
  textStream,
} from "./helpers/memory-agent.js";

it("retains invocation memory tool identity through public native conversion", async () => {
  const runtime = createMemoryRuntime({ messageTokens: 10000 });
  await seedMemory(runtime);
  const marker = "kitaru-owned-memory-identity";
  const memory = new Proxy(runtime.memory, {
    get(target, key) {
      if (key === "listTools")
        return (...args: Parameters<typeof target.listTools>) =>
          Object.fromEntries(
            Object.entries(target.listTools(...args)).map(([name, tool]) => [
              name,
              { ...tool, id: marker },
            ]),
          );
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const identities: unknown[] = [];
  const executions: string[] = [];
  const initial: InputProcessor = {
    id: "identity-first",
    processInputStep({ tools }) {
      identities.push((tools?.updateWorkingMemory as { id?: string })?.id);
    },
  };
  const final: InputProcessor = {
    id: "identity-last",
    processInputStep({ tools }) {
      const wrapped = Object.fromEntries(
        Object.entries(tools ?? {}).map(([name, tool]) => {
          const native = tool as { execute?: (...args: unknown[]) => unknown };
          return [
            name,
            {
              ...native,
              execute: async (...args: unknown[]) => {
                executions.push(name);
                return native.execute?.(...args);
              },
            },
          ];
        }),
      );
      return { tools: wrapped };
    },
  };
  let calls = 0;
  const agent = new Agent({
    id: "marker-proof",
    name: "Marker proof",
    instructions: "Update memory",
    memory,
    inputProcessors: [initial, final],
    model: new MastraLanguageModelV2Mock({
      doStream: async () =>
        ++calls === 1
          ? streamParts(
              [
                {
                  type: "tool-call",
                  toolCallId: "memory-call",
                  toolName: "updateWorkingMemory",
                  input: JSON.stringify({ memory: { preference: "green" } }),
                },
              ],
              "tool-calls",
            )
          : textStream("done"),
    }),
  });
  const result = await agent.stream("Green please", {
    memory: { thread: THREAD, resource: RESOURCE },
    maxSteps: 3,
  });
  await result.consumeStream();
  await runtime.memory.settled();
  expect(identities).toEqual([marker, marker]);
  expect(executions).toEqual(["updateWorkingMemory"]);
  expect(
    await runtime.memory.getWorkingMemory({
      threadId: THREAD,
      resourceId: RESOURCE,
    }),
  ).toContain("green");
  await runtime.store.close();
});

import {
  createMemoryReplayAgent,
  createProcessLocalMemoryAccess,
  MEMORY_REPLAY_KEY,
} from "../src/memory.js";
import {
  AGENT_ID,
  installTestApi,
  ORIGINAL_SESSION_ID,
  REPLAY_ID,
} from "./helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("records and replays native evolving memory without re-resolving live configuration", async () => {
  const runtime = createMemoryRuntime({ messageTokens: 10000 });
  await seedMemory(runtime);
  let replaying = false;
  const dynamicCalls: string[] = [];
  const requests: unknown[] = [];
  let calls = 0;
  const model = new MastraLanguageModelV2Mock({
    modelId: "actor",
    provider: "fixture",
    doStream: async (args) => {
      requests.push(args);
      return ++calls % 2 === 1
        ? streamParts(
            [
              {
                type: "tool-call",
                toolCallId: `call-${calls}`,
                toolName: "updateWorkingMemory",
                input: JSON.stringify({
                  memory: {
                    preference: replaying ? "replay-green" : "baseline-red",
                  },
                }),
              },
            ],
            "tool-calls",
          )
        : textStream("done");
    },
  });
  const source = vi.fn(() => ({
    settled: () => runtime.memory.settled(),
    domain: runtime.domain,
    configuration: runtime.memory.getMergedThreadConfig(),
    exclusiveAccess: createProcessLocalMemoryAccess(),
  }));
  const baselineApi = installTestApi({
    replaySpec: {
      id: REPLAY_ID,
      baseline_session_id: ORIGINAL_SESSION_ID,
      status: "pending",
      override: { system_prompt: "New instructions" },
      tool_policy: {
        default: { type: "history", scope: "baseline", on_miss: "fail" },
        tools: {},
      },
    },
  });
  const adapter = createMemoryReplayAgent(
    ({ memory }) => ({
      id: "stateful",
      name: "Stateful",
      memory,
      instructions: () => {
        dynamicCalls.push("instructions");
        return "Original instructions";
      },
      model: () => {
        dynamicCalls.push("model");
        return model;
      },
      defaultOptions: () => {
        dynamicCalls.push("defaults");
        return { maxSteps: 3 };
      },
    }),
    {
      agentId: AGENT_ID,
      apiUrl: "https://kitaru.invalid",
      apiKey: "fixture",
      requestedModelId: "fixture/actor",
      sourceMemory: source,
      resolveModel: async (id) =>
        id.includes("observer")
          ? runtime.observer.model
          : id.includes("reflector")
            ? runtime.reflector.model
            : model,
    },
  );
  const baseline = await adapter.stream("Green please", {
    memory: { thread: THREAD, resource: RESOURCE },
    context: [
      { role: "system", content: "Extra context. Original instructions" },
    ],
  });
  await baseline.consumeStream();
  expect(dynamicCalls).toEqual(["instructions", "model", "defaults"]);
  const recorded = baselineApi.calls.find(
    (call) => call.method === "POST" && call.path === "/api/v1/sessions",
  )?.body?.inputs;
  expect(recorded).toHaveProperty(MEMORY_REPLAY_KEY);
  expect(
    baselineApi.calls.filter((call) => call.method === "PATCH").at(-1)?.body
      ?.status,
  ).toBe("completed");
  const baselineNodes = baselineApi.nodeBatches().flat();
  expect(baselineNodes.some((node) => node.name === "memory_mutation")).toBe(
    true,
  );
  expect(
    baselineNodes
      .filter((node) => node.node_type === "llm_call")
      .every((node) => node.inputs),
  ).toBe(true);
  expect(
    baselineNodes.find((node) => node.node_type === "llm_call")?.attributes,
  ).toHaveProperty("prompt_provenance.extraContext.context", [
    { role: "system", content: "Extra context. Original instructions" },
  ]);
  await runtime.memory.updateWorkingMemory({
    threadId: THREAD,
    resourceId: RESOURCE,
    workingMemory: JSON.stringify({ preference: "production-today" }),
  });
  replaying = true;
  source.mockImplementation(() => {
    throw new Error("Production source used during replay");
  });
  vi.stubEnv("KITARU_REPLAY_ID", REPLAY_ID);
  vi.stubEnv("KITARU_TASK_INPUTS", JSON.stringify(recorded));
  const replayApi = baselineApi;
  const replay = await adapter.stream("ignored", {
    memory: { thread: "today", resource: "today" },
  });
  await replay.consumeStream();
  expect(dynamicCalls).toEqual(["instructions", "model", "defaults"]);
  expect(source).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(requests[2])).toContain("historical-blue");
  expect(JSON.stringify(requests[2])).toContain("New instructions");
  expect(
    JSON.stringify(requests[2]).match(/Original instructions/g),
  ).toHaveLength(1);
  expect(JSON.stringify(requests[2])).toContain("Extra context");
  expect(JSON.stringify(requests[3])).toContain("replay-green");
  expect(
    replayApi.calls.filter((call) => call.method === "PATCH").at(-1)?.body
      ?.status,
  ).toBe("completed");
  expect(
    replayApi.calls.some((call) => call.path.endsWith("tool-lookup")),
  ).toBe(false);
  expect(
    await runtime.memory.getWorkingMemory({
      threadId: THREAD,
      resourceId: RESOURCE,
    }),
  ).toContain("production-today");
  await runtime.store.close();
});

it("waits for owned native observation before reporting completion and releases its lease", async () => {
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const runtime = createMemoryRuntime({
    messageTokens: 10000,
    observerWait: async () => {
      started();
      await blocked;
    },
  });
  await seedMemory(runtime);
  const api = installTestApi();
  const lease = createProcessLocalMemoryAccess();
  const model = new MastraLanguageModelV2Mock({
    modelId: "actor",
    provider: "fixture",
    doStream: async () => textStream("done"),
  });
  const adapter = createMemoryReplayAgent(
    ({ memory }) => ({
      id: "settled",
      name: "Settled",
      instructions: "Answer",
      model,
      memory,
    }),
    {
      agentId: AGENT_ID,
      apiUrl: "https://kitaru.invalid",
      requestedModelId: "fixture/actor",
      sourceMemory: () => ({
        settled: () => runtime.memory.settled(),
        domain: runtime.domain,
        configuration: runtime.memory.getMergedThreadConfig(),
        exclusiveAccess: lease,
      }),
      resolveModel: () => model,
    },
  );
  try {
    const result = await adapter.stream("Observe this message", {
      memory: { thread: THREAD, resource: RESOURCE },
    });
    const consuming = result.consumeStream();
    await observing;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      api.calls.some(
        (call) => call.method === "PATCH" && call.body?.status === "completed",
      ),
    ).toBe(false);
    release();
    await consuming;
    expect(
      api.calls.filter((call) => call.method === "PATCH").at(-1)?.body?.status,
    ).toBe("completed");
    const releaseLease = await lease.acquire({
      threadId: THREAD,
      resourceId: RESOURCE,
    });
    await releaseLease();
    expect(runtime.observer.calls.length).toBeGreaterThan(0);
    expect(
      api
        .nodeBatches()
        .flat()
        .some(
          (node) =>
            node.name === "memory_mutation" &&
            (node.attributes as Record<string, unknown>).memory_method ===
              "updateBufferedObservations",
        ),
    ).toBe(true);
  } finally {
    release();
    await runtime.memory.settled();
    await runtime.store.close();
  }
});

it("keeps baseline output when initial snapshot evidence fails and rejects its incomplete replay", async () => {
  const runtime = createMemoryRuntime({ messageTokens: 10000 });
  await seedMemory(runtime);
  const api = installTestApi();
  vi.spyOn(runtime.domain, "getResourceById").mockRejectedValueOnce(
    new Error("Snapshot read failed"),
  );
  const source = vi.fn(() => ({
    settled: () => runtime.memory.settled(),
    domain: runtime.domain,
    configuration: runtime.memory.getMergedThreadConfig(),
    exclusiveAccess: createProcessLocalMemoryAccess(),
  }));
  const model = new MastraLanguageModelV2Mock({
    modelId: "actor",
    provider: "fixture",
    doStream: async () => textStream("native output"),
  });
  const adapter = createMemoryReplayAgent(
    ({ memory }) => ({
      id: "partial",
      name: "Partial",
      instructions: "Answer",
      memory,
      model,
    }),
    {
      agentId: AGENT_ID,
      apiUrl: "https://kitaru.invalid",
      requestedModelId: "fixture/actor",
      sourceMemory: source,
      resolveModel: () => model,
    },
  );
  const output = await adapter.stream("Hello", {
    memory: { thread: THREAD, resource: RESOURCE },
  });
  await output.consumeStream();
  expect(await output.text).toBe("native output");
  const input = api.calls.find(
    (call) => call.method === "POST" && call.path === "/api/v1/sessions",
  )?.body?.inputs as Record<string, { complete: boolean }>;
  expect(input[MEMORY_REPLAY_KEY]?.complete).toBe(false);
  vi.stubEnv("KITARU_REPLAY_ID", REPLAY_ID);
  vi.stubEnv("KITARU_TASK_INPUTS", JSON.stringify(input));
  await expect(adapter.stream("ignored")).rejects.toThrow(/incomplete/i);
  expect(source).toHaveBeenCalledTimes(1);
  await runtime.store.close();
});

it("rebuilds observation/reflection on the replay trajectory with an overridden actor model", async () => {
  const runtime = createMemoryRuntime({ messageTokens: 600 });
  await seedMemory(runtime);
  const api = installTestApi({
    replaySpec: {
      id: REPLAY_ID,
      baseline_session_id: ORIGINAL_SESSION_ID,
      status: "pending",
      override: { model: "fixture/replacement" },
      tool_policy: { default: { type: "passthrough" }, tools: {} },
    },
  });
  const requests: unknown[] = [];
  let calls = 0;
  const replacement = new MastraLanguageModelV2Mock({
    modelId: "replacement",
    provider: "fixture",
    doStream: async (args) => {
      requests.push(args);
      calls++;
      return calls === 1
        ? streamParts(
            [
              {
                type: "tool-call",
                toolCallId: "change-memory",
                toolName: "updateWorkingMemory",
                input: JSON.stringify({
                  memory: { preference: "replay-green" },
                }),
              },
            ],
            "tool-calls",
          )
        : calls === 2
          ? streamParts(
              [
                {
                  type: "tool-call",
                  toolCallId: "evidence",
                  toolName: "readEvidence",
                  input: "{}",
                },
              ],
              "tool-calls",
            )
          : textStream("evolved");
    },
  });
  const original = new MastraLanguageModelV2Mock({
    modelId: "actor",
    provider: "fixture",
    doStream: async () => textStream("original"),
  });
  const { createTool } = await import("@mastra/core/tools");
  const { z } = await import("zod/v4");
  const adapter = createMemoryReplayAgent(
    ({ memory }) => ({
      id: "evolving",
      name: "Evolving",
      instructions: "Use evidence",
      model: original,
      memory,
      defaultOptions: { maxSteps: 5 },
      tools: {
        readEvidence: createTool({
          id: "readEvidence",
          description: "Read conversation evidence",
          inputSchema: z.object({}),
          execute: async () => {
            await memory.settled();
            return {
              evidence: "The replay user now prefers green. ".repeat(400),
            };
          },
        }),
      },
    }),
    {
      agentId: AGENT_ID,
      apiUrl: "https://kitaru.invalid",
      requestedModelId: "fixture/actor",
      allowedReplayModels: ["fixture/replacement"],
      sourceMemory: () => ({
        settled: () => runtime.memory.settled(),
        domain: runtime.domain,
        configuration: runtime.memory.getMergedThreadConfig(),
        exclusiveAccess: createProcessLocalMemoryAccess(),
      }),
      resolveModel: async (id) =>
        id.includes("observer")
          ? runtime.observer.model
          : id.includes("reflector")
            ? runtime.reflector.model
            : id === "fixture/replacement"
              ? replacement
              : original,
    },
  );
  const baseline = await adapter.stream("Baseline turn", {
    memory: { thread: THREAD, resource: RESOURCE },
  });
  await baseline.consumeStream();
  const input = api.calls.find(
    (call) => call.method === "POST" && call.path === "/api/v1/sessions",
  )?.body?.inputs;
  vi.stubEnv("KITARU_REPLAY_ID", REPLAY_ID);
  vi.stubEnv("KITARU_TASK_INPUTS", JSON.stringify(input));
  const nativeStream = Agent.prototype.stream;
  let nativeResult: unknown;
  vi.spyOn(Agent.prototype, "stream").mockImplementation(async function (
    this: Agent,
    ...args
  ) {
    nativeResult = await Reflect.apply(nativeStream, this, args);
    return nativeResult as Awaited<ReturnType<Agent["stream"]>>;
  });
  const output = await adapter.stream("ignored");
  expect(output).toBe(nativeResult);
  await output.consumeStream();
  expect(await output.text).toBe("evolved");
  expect(requests).toHaveLength(3);
  expect(runtime.observer.calls.length).toBeGreaterThan(0);
  expect(runtime.reflector.calls.length).toBeGreaterThan(0);
  expect(JSON.stringify(requests[2])).toContain("REFLECTED_REPLAY");
  const resultNodes = api.nodeBatches(api.sessionIds[1]).flat();
  expect(
    resultNodes
      .filter((node) => node.node_type === "llm_call")
      .every((node) => node.model === "replacement"),
  ).toBe(true);
  expect(
    resultNodes.some(
      (node) =>
        node.name === "memory_mutation" &&
        (node.attributes as Record<string, unknown>).memory_method ===
          "createReflectionGeneration",
    ),
  ).toBe(true);
  expect(
    api.calls.filter((call) => call.method === "PATCH").at(-1)?.body?.status,
  ).toBe("completed");
  expect(
    await runtime.memory.getWorkingMemory({
      threadId: THREAD,
      resourceId: RESOURCE,
    }),
  ).toContain("historical-blue");
  await runtime.store.close();
});

it("releases the source lease on setup failure and cancellation", async () => {
  const runtime = createMemoryRuntime({ messageTokens: 10000 });
  await seedMemory(runtime);
  const api = installTestApi();
  const lease = createProcessLocalMemoryAccess();
  const model = new MastraLanguageModelV2Mock({
    modelId: "actor",
    provider: "fixture",
    doStream: async () => textStream("unused"),
  });
  let failSetup = true;
  const adapter = createMemoryReplayAgent(
    ({ memory }) => {
      if (failSetup) throw new Error("Factory failed");
      return {
        id: "cancelled",
        name: "Cancelled",
        instructions: "Answer",
        model,
        memory,
      };
    },
    {
      agentId: AGENT_ID,
      apiUrl: "https://kitaru.invalid",
      requestedModelId: "fixture/actor",
      sourceMemory: () => ({
        settled: () => runtime.memory.settled(),
        domain: runtime.domain,
        configuration: runtime.memory.getMergedThreadConfig(),
        exclusiveAccess: lease,
      }),
      resolveModel: () => model,
    },
  );
  await expect(
    adapter.stream("Hello", { memory: { thread: THREAD, resource: RESOURCE } }),
  ).rejects.toThrow("Factory failed");
  const firstRelease = await lease.acquire({
    threadId: THREAD,
    resourceId: RESOURCE,
  });
  await firstRelease();
  failSetup = false;
  const abort = new AbortController();
  abort.abort(new Error("Cancelled"));
  const output = await adapter.stream("Hello", {
    memory: { thread: THREAD, resource: RESOURCE },
    abortSignal: abort.signal,
  });
  await output.consumeStream();
  await vi.waitFor(() =>
    expect(
      api.calls.filter((call) => call.method === "PATCH").at(-1)?.body?.status,
    ).toBe("failed"),
  );
  const release = await lease.acquire({
    threadId: THREAD,
    resourceId: RESOURCE,
  });
  await release();
  await runtime.store.close();
});

it("stops later actor and tool work after native memory storage fails", async () => {
  const runtime = createMemoryRuntime({ messageTokens: 10000 });
  await seedMemory(runtime);
  const api = installTestApi();
  const lease = createProcessLocalMemoryAccess();
  const { createTool } = await import("@mastra/core/tools");
  const { z } = await import("zod/v4");
  const external = vi.fn(async () => "side effect");
  let actorCalls = 0;
  const patchThread = runtime.domain.patchThread.bind(runtime.domain);
  vi.spyOn(runtime.domain, "patchThread").mockImplementation(
    async (...args) => {
      if (actorCalls > 0) throw new Error("Native memory write failed");
      return patchThread(...args);
    },
  );
  const model = new MastraLanguageModelV2Mock({
    modelId: "actor",
    provider: "fixture",
    doStream: async () =>
      ++actorCalls === 1
        ? streamParts(
            [
              {
                type: "tool-call",
                toolName: "updateWorkingMemory",
                toolCallId: "memory-failure",
                input: JSON.stringify({ memory: { preference: "green" } }),
              },
              {
                type: "tool-call",
                toolName: "external",
                toolCallId: "later-tool",
                input: "{}",
              },
            ],
            "tool-calls",
          )
        : textStream("incorrect continuation"),
  });
  const adapter = createMemoryReplayAgent(
    ({ memory }) => ({
      id: "write-failure",
      name: "Write failure",
      instructions: "Update memory",
      model,
      memory,
      defaultOptions: { maxSteps: 3, toolCallConcurrency: 1 },
      tools: {
        external: createTool({
          id: "external",
          description: "A side effect",
          inputSchema: z.object({}),
          execute: external,
        }),
      },
    }),
    {
      agentId: AGENT_ID,
      apiUrl: "https://kitaru.invalid",
      requestedModelId: "fixture/actor",
      sourceMemory: () => ({
        settled: () => runtime.memory.settled(),
        domain: runtime.domain,
        configuration: runtime.memory.getMergedThreadConfig(),
        exclusiveAccess: lease,
      }),
      resolveModel: () => model,
    },
  );
  try {
    const output = await adapter.stream("Remember green", {
      memory: { thread: THREAD, resource: RESOURCE },
    });
    await output.consumeStream();
    await vi.waitFor(() =>
      expect(
        api.calls.filter((call) => call.method === "PATCH").at(-1)?.body
          ?.status,
      ).toBe("failed"),
    );
    expect(actorCalls).toBe(1);
    expect(external).not.toHaveBeenCalled();
    const release = await lease.acquire({
      threadId: THREAD,
      resourceId: RESOURCE,
    });
    await release();
  } finally {
    await runtime.memory.settled();
    await runtime.store.close();
  }
});
