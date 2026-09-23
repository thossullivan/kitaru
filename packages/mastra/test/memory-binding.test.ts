import { expect, it, vi } from "vitest";
import {
  createMemoryCaptureBinding,
  createProcessLocalMemoryAccess,
} from "../src/memory-binding.js";
import {
  createMemoryRuntime,
  RESOURCE,
  seedMemory,
  THREAD,
} from "./helpers/memory-agent.js";

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null)
    throw new Error("Missing fixture value");
  return value;
}

async function fixture(
  invocationId = "invocation-1",
  access = createProcessLocalMemoryAccess(),
) {
  const runtime = createMemoryRuntime();
  await seedMemory(runtime);
  const recordMutation = vi.fn(async (_event: unknown) => {});
  const binding = createMemoryCaptureBinding({
    invocationId,
    domain: runtime.domain,
    threadId: THREAD,
    resourceId: RESOURCE,
    exclusiveAccess: access,
    recordMutation,
  });
  return { runtime, binding, recordMutation };
}

it("captures initial memory under a real lease, records ordered mutations, and releases", async () => {
  const { runtime, binding, recordMutation } = await fixture();
  const initial = await binding.captureInitial(runtime.memory);
  expect(initial?.thread?.id).toBe(THREAD);
  await binding.domain.updateThread({
    id: THREAD,
    metadata: { workingMemory: "new" },
  });
  const record = await binding.domain.getObservationalMemory(THREAD, RESOURCE);
  await binding.domain.setPendingMessageTokens(required(record).id, 12);
  await binding.drain();
  expect(binding.revision).toBe(2);
  expect(recordMutation.mock.calls.map(([event]) => event)).toMatchObject([
    { id: "invocation-1:memory:1", revision: 1, method: "updateThread" },
    {
      id: "invocation-1:memory:2",
      revision: 2,
      method: "setPendingMessageTokens",
    },
  ]);
  expect(binding.incompleteReasons).toEqual([]);
  expect(initial?.thread?.metadata?.workingMemory).not.toBe("new");
  await binding.release();
});

it("rejects shared-thread overlap while allowing independent source threads", async () => {
  const access = createProcessLocalMemoryAccess();
  const one = await fixture("one", access);
  const two = await fixture("two", access);
  await one.binding.captureInitial(one.runtime.memory);
  expect(await two.binding.captureInitial(two.runtime.memory)).toBeUndefined();
  expect(two.binding.incompleteReasons.join()).toMatch(/exclusive/i);
  await one.binding.release();
  await two.binding.release();
});

it("preserves native mutation results despite evidence persistence failure", async () => {
  const { runtime, binding, recordMutation } = await fixture();
  await binding.captureInitial(runtime.memory);
  recordMutation.mockRejectedValue(new Error("sink failed"));
  const result = await binding.domain.updateThread({
    id: THREAD,
    title: "still succeeds",
  });
  expect(result.title).toBe("still succeeds");
  await binding.drain();
  expect(binding.incompleteReasons.join()).toMatch(/persistence/);
  await binding.release();
});

it("marks failed capture or unjoined work incomplete without throwing", async () => {
  const { runtime, binding } = await fixture();
  const record = await runtime.domain.getObservationalMemory(THREAD, RESOURCE);
  await runtime.domain.setObservingFlag(required(record).id, true);
  expect(await binding.captureInitial(runtime.memory)).toBeUndefined();
  expect(binding.incompleteReasons.join()).toMatch(/Unjoined/);
  await binding.release();
});

it("invalidates the first recording when a conflicting invocation cannot get its lease", async () => {
  const access = createProcessLocalMemoryAccess();
  const one = await fixture("one", access);
  const two = await fixture("two", access);
  await one.binding.captureInitial(one.runtime.memory);
  await two.binding.captureInitial(two.runtime.memory);
  expect(one.binding.incompleteReasons.join()).toMatch(/overlapping/);
  await one.binding.release();
  await two.binding.release();
});

it("does not return a coherent initial snapshot after overlap during capture", async () => {
  const access = createProcessLocalMemoryAccess();
  const one = await fixture("one", access);
  const two = await fixture("two", access);
  const settled = async () => {
    await two.binding.captureInitial(two.runtime.memory);
  };
  expect(await one.binding.captureInitial({ settled })).toBeUndefined();
  await one.binding.release();
  await two.binding.release();
});

it("serializes overlapping native mutations and preserves original storage errors", async () => {
  const { runtime, binding, recordMutation } = await fixture();
  await binding.captureInitial(runtime.memory);
  let unblock: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const native = runtime.domain.updateThread.bind(runtime.domain);
  const calls: string[] = [];
  const spy = vi
    .spyOn(runtime.domain, "updateThread")
    .mockImplementation(async (args) => {
      calls.push(required(args.title));
      if (args.title === "first") await wait;
      return native(args);
    });
  const first = binding.domain.updateThread({ id: THREAD, title: "first" });
  const second = binding.domain.updateThread({ id: THREAD, title: "second" });
  await Promise.resolve();
  expect(calls).toEqual(["first"]);
  required(unblock)();
  await Promise.all([first, second]);
  await binding.drain();
  expect(calls).toEqual(["first", "second"]);
  expect(recordMutation.mock.calls).toHaveLength(2);
  spy.mockRestore();
  const fault = new Error("native write failed");
  vi.spyOn(runtime.domain, "saveResource").mockRejectedValueOnce(fault);
  await expect(
    binding.domain.saveResource({
      resource: { id: RESOURCE, createdAt: new Date(), updatedAt: new Date() },
    }),
  ).rejects.toBe(fault);
  expect(binding.revision).toBe(2);
  expect(binding.incompleteReasons.join()).toMatch(/Native memory storage/);
  await binding.release();
});

it("records OM flags, buffers, config, activation and working memory with stable request identity", async () => {
  const { runtime, binding, recordMutation } = await fixture();
  await binding.captureInitial(runtime.memory);
  const record = await binding.domain.getObservationalMemory(THREAD, RESOURCE);
  await binding.domain.setBufferingObservationFlag(
    required(record).id,
    true,
    10,
  );
  await binding.domain.updateBufferedObservations({
    id: required(record).id,
    chunk: {
      cycleId: "cycle",
      observations: "buffer",
      tokenCount: 3,
      messageIds: ["historical-message"],
      messageTokens: 20,
      lastObservedAt: new Date(20),
    },
    lastBufferedAtTime: new Date(21),
  });
  await binding.domain.setBufferingObservationFlag(required(record).id, false);
  await binding.domain.updateObservationalMemoryConfig({
    id: required(record).id,
    config: { observation: { messageTokens: 20 } },
  });
  await binding.domain.updateActiveObservations({
    id: required(record).id,
    observations: "changed",
    tokenCount: 3,
    lastObservedAt: new Date(20),
  });
  await binding.domain.updateThread({
    id: THREAD,
    metadata: { workingMemory: "changed" },
  });
  await binding.drain();
  expect(
    recordMutation.mock.calls.map(
      ([event]) => (event as { revision: number }).revision,
    ),
  ).toEqual([1, 2, 3, 4, 5, 6]);
  await binding.release();
});

it("marks credential-altered mutation evidence incomplete but keeps native arguments and results", async () => {
  const { runtime, binding, recordMutation } = await fixture();
  await binding.captureInitial(runtime.memory);
  const result = await binding.domain.updateThread({
    id: THREAD,
    metadata: { apiKey: "private-value" },
  });
  expect(result.metadata?.apiKey).toBe("private-value");
  await binding.drain();
  expect(binding.incompleteReasons.length).toBeGreaterThan(0);
  expect(JSON.stringify(recordMutation.mock.calls)).not.toContain(
    "private-value",
  );
  expect(recordMutation.mock.calls[0]?.[0]).toMatchObject({ complete: false });
  await binding.release();
});
