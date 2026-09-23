import { createRequire } from "node:module";
import { Agent, type AgentConfig } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { Mastra } from "@mastra/core/mastra";
import type { MemoryConfigInternal } from "@mastra/core/memory";
import type { InputProcessor } from "@mastra/core/processors";
import { RequestContext } from "@mastra/core/request-context";
import type { MemoryStorage } from "@mastra/core/storage";
import type { Memory } from "@mastra/memory";
import {
  type JsonValue,
  KitaruClient,
  type SessionNodeCreateRequest,
} from "@zenml-io/kitaru";
import {
  type AdapterRunState,
  normalizeRecordingLimits,
  parseModelSettings,
  ROOT_NODE_EXTERNAL_ID,
  resolveReplayContext,
} from "@zenml-io/kitaru/adapter";
import {
  createMemoryCaptureBinding,
  type MastraExclusiveMemoryAccess,
  type MastraMemoryCaptureBinding,
  type MastraMemoryMutation,
} from "./memory-binding.js";
import {
  assertMemoryReplayVersions,
  createIsolatedMemoryReplay,
  getMemoryModelId,
  serializeMemoryConfiguration,
} from "./memory-replay.js";
import {
  createMemoryReplayEnvelope,
  decodeMemoryValue,
  encodeMemoryValue,
  type MastraMemorySnapshot,
  MEMORY_REPLAY_KEY,
  restoreMemoryReplayEnvelope,
} from "./memory-snapshot.js";
import { assertStableToolName } from "./replay-guards.js";
import {
  createRequestCapture,
  type RequestEvidence,
  requestEvidenceAttributes,
} from "./request-capture.js";
import { createCapturedFiles, restoreCapturedFiles } from "./stateful-files.js";
import {
  bindMemoryToolIdentity,
  createStatefulToolProcessors,
} from "./stateful-tools.js";
import { loadSkillsWorkspace } from "./stateful-workspace.js";
import {
  StatefulRecordingError,
  streamWithRecording,
} from "./stream-recording.js";
import type { KitaruAgentOptions, RuntimeStreamOptions } from "./types.js";

interface MastraMemorySource {
  settled(): Promise<void>;
  domain: MemoryStorage;
  configuration: MemoryConfigInternal;
  exclusiveAccess: MastraExclusiveMemoryAccess;
}

export interface MemoryReplayAgentOptions extends KitaruAgentOptions {
  /** Registry context passed to baseline dynamic configuration resolvers. */
  mastra?: Mastra;
  /** Called only for new recordings. All writers must share exclusiveAccess. */
  sourceMemory(): MastraMemorySource | Promise<MastraMemorySource>;
  /** Return only approved replay-relevant JSON context. Credentials are forbidden. */
  captureRequestContext?(context: RequestContext): Record<string, unknown>;
  files?: readonly string[];
  resolveFile?: (
    url: string,
  ) => Promise<{ bytes: Uint8Array; mediaType: string }>;
  skillsDirectory?: string;
  resolveModel: (id: string) => MastraModelConfig | Promise<MastraModelConfig>;
}

export interface MemoryReplayAgentBindings {
  memory: Memory;
  resolveFile(url: string): Promise<{ bytes: Uint8Array; mediaType: string }>;
  workspace?: Awaited<ReturnType<typeof loadSkillsWorkspace>>["workspace"];
}

export type MemoryReplayAgentFactory = (
  bindings: MemoryReplayAgentBindings,
) => AgentConfig | Promise<AgentConfig>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!record(value))
    throw new Error(`Unsupported Mastra memory replay: missing ${label}.`);
  return value;
}
function getSelector(options: RuntimeStreamOptions) {
  const memory = requireRecord(
    options.memory,
    "memory thread/resource selectors",
  );
  const threadId =
    typeof memory.thread === "string"
      ? memory.thread
      : record(memory.thread)
        ? memory.thread.id
        : undefined;
  if (typeof threadId !== "string" || typeof memory.resource !== "string")
    throw new Error(
      "Memory replay requires explicit memory.thread and memory.resource strings.",
    );
  return { threadId, resourceId: memory.resource };
}
function assertSupportedConfiguration(
  config: AgentConfig,
  options: RuntimeStreamOptions,
): void {
  for (const name of [
    "agents",
    "workflows",
    "voice",
    "browser",
    "backgroundTasks",
    "editor",
    "defaultGenerateOptionsLegacy",
    "defaultStreamOptionsLegacy",
    "outputProcessors",
    "errorProcessors",
    "hooks",
  ]) {
    if ((config as unknown as Record<string, unknown>)[name] !== undefined)
      throw new Error(`Unsupported memory replay configuration '${name}'.`);
  }
  for (const name of [
    "inputProcessors",
    "outputProcessors",
    "hooks",
    "toolsets",
    "clientTools",
    "prepareStep",
    "instructions",
    "model",
    "requestContext",
    "abortSignal",
    "onFinish",
    "onError",
    "onAbort",
    "onStepFinish",
  ]) {
    if (options[name] !== undefined)
      throw new Error(`Unsupported serialized memory replay option '${name}'.`);
  }
  for (const name of Object.keys(config.tools ?? {}))
    assertStableToolName(name);
  for (const name of ["experimental_sandbox", "delegation", "backgroundTasks"])
    if (options[name] !== undefined)
      throw new Error(`Unsupported memory replay option ${name}.`);
  if (
    typeof config.tools === "function" ||
    typeof config.inputProcessors === "function" ||
    typeof config.workspace === "function"
  )
    throw new Error(
      "Memory replay requires static tools, processors and supplied workspace bindings.",
    );
  if (
    config.inputProcessors?.some(
      (processor) =>
        !record(processor) ||
        "loadTools" in processor ||
        "createRun" in processor,
    )
  )
    throw new Error(
      "Memory replay processors must use the supplied dependencies and ordinary processor methods.",
    );
}

/** Construct each streamed invocation with historical configuration and isolated replay memory. */
export function createMemoryReplayAgent(
  factory: MemoryReplayAgentFactory,
  supplied: MemoryReplayAgentOptions,
): Pick<Agent, "stream"> {
  const options = {
    ...supplied,
    recordingLimits: normalizeRecordingLimits(supplied.recordingLimits),
  };
  const client = new KitaruClient({
    apiKey: options.apiKey,
    apiUrl: options.apiUrl,
    timeoutMs: options.timeoutMs,
  });
  async function stream(
    rawInput: unknown,
    callerOptions: RuntimeStreamOptions = {},
  ): Promise<unknown> {
    assertMemoryReplayVersions();
    const { resolveModelConfig } = await import("@mastra/core/llm");
    const { MastraCompositeStore } = await import("@mastra/core/storage");
    const startedAt = new Date().toISOString();
    const invocationId = globalThis.crypto.randomUUID();
    const replay = await resolveReplayContext({
      allowedReplayModels: options.allowedReplayModels,
      callerInput: encodeMemoryValue(rawInput),
      client,
      requestedModelId: options.requestedModelId,
    });
    const historical = restoreMemoryReplayEnvelope(replay.effectiveInput);
    const invocationInput =
      historical?.rawInput ??
      decodeMemoryValue(replay.effectiveRuntimeInput as JsonValue);
    if (Boolean(replay.spec) !== Boolean(historical))
      throw new Error(
        "Memory replay requires a complete version-2 recorded invocation and an active Kitaru replay.",
      );
    if (replay.override?.prompt != null)
      throw new Error(
        "Memory replay supports system_prompt overrides; replacing raw invocation input requires a new recording.",
      );
    const abort = new AbortController();
    let state: AdapterRunState | undefined;
    let requestCapture: ReturnType<typeof createRequestCapture> | undefined;
    const getState = () => {
      if (!state) throw new Error("Memory recorder has not initialized.");
      return state;
    };
    const onIncomplete = (reason: string): void => {
      // Mastra converts tool storage errors into results and otherwise continues.
      // Recording-only incompleteness must preserve ordinary native execution.
      if (reason !== "Native memory storage mutation failed.") return;
      const error = new Error(reason);
      state?.storeFailure(error);
      abort.abort(error);
    };
    const writeNode = async (node: SessionNodeCreateRequest) => {
      const active = getState();
      await active.enqueueStep(async () => {
        await active.client.upsertSessionNodes(active.sessionId, {
          nodes: [node],
        });
      });
    };
    const recordMutation = async (event: MastraMemoryMutation) =>
      writeNode({
        external_id: event.id,
        parent_external_id: ROOT_NODE_EXTERNAL_ID,
        node_type: "span",
        name: "memory_mutation",
        status: event.complete ? "completed" : "failed",
        inputs: event.arguments,
        outputs: event.result,
        attributes: {
          invocation_id: event.invocationId,
          memory_revision: event.revision,
          memory_method: event.method,
          request_id: event.requestId ?? null,
          evidence_complete: event.complete,
        },
      });
    let runtime: {
      memory: Memory;
      binding: MastraMemoryCaptureBinding;
      initialSnapshot: MastraMemorySnapshot | undefined;
      finish(): Promise<void>;
    };
    if (historical) {
      runtime = await createIsolatedMemoryReplay({
        invocationId,
        initialSnapshot: historical.initialSnapshot,
        configuration: requireRecord(
          historical.configuration.memoryConfig,
          "memory configuration",
        ),
        resolveModel: options.resolveModel,
        recordMutation,
        onIncomplete,
        getRequestId: () => requestCapture?.currentRequestId,
      });
    } else {
      const source = await options.sourceMemory();
      const selector = getSelector(callerOptions);
      const binding = createMemoryCaptureBinding({
        invocationId,
        ...selector,
        domain: source.domain,
        exclusiveAccess: source.exclusiveAccess,
        recordMutation,
        onIncomplete,
        getRequestId: () => requestCapture?.currentRequestId,
      });
      const { Memory } = await import("@mastra/memory");
      const memory = new Memory({
        storage: new MastraCompositeStore({
          id: `kitaru-baseline-${invocationId}`,
          domains: { memory: binding.domain },
        }),
        options: source.configuration,
      });
      const initialSnapshot = await binding.captureInitial(source);
      let finished: Promise<void> | undefined;
      runtime = {
        memory,
        binding,
        initialSnapshot,
        finish() {
          finished ??= (async () => {
            try {
              await memory.settled();
              await binding.drain();
            } finally {
              await binding.release();
            }
          })();
          return finished;
        },
      };
    }
    try {
      const files = historical
        ? restoreCapturedFiles(historical.files)
        : await createCapturedFiles(
            options.files ?? [],
            options.resolveFile ??
              (async () => {
                throw new Error("Missing controlled file resolver.");
              }),
          );
      const workspace = options.skillsDirectory
        ? await loadSkillsWorkspace(
            options.skillsDirectory,
            historical?.configuration.workspaceManifest as Parameters<
              typeof loadSkillsWorkspace
            >[1],
          )
        : undefined;
      if (historical?.configuration.workspaceManifest && !workspace)
        throw new Error("Recorded skills workspace is missing.");
      const owned = bindMemoryToolIdentity(runtime.memory);
      const config = await factory({
        memory: owned.memory,
        resolveFile: files.resolveFile,
        workspace: workspace?.workspace,
      });
      if (config.memory !== undefined && config.memory !== owned.memory)
        throw new Error("Agent factory must use its supplied Memory instance.");
      if (
        config.workspace !== undefined &&
        config.workspace !== workspace?.workspace
      )
        throw new Error(
          "Agent factory must use its supplied pinned workspace.",
        );
      const liveContext = callerOptions.requestContext ?? new RequestContext();
      const recordedContext =
        historical?.requestContext ??
        options.captureRequestContext?.(liveContext) ??
        Object.fromEntries(liveContext.entries());
      // Validate before any dynamic resolver can observe an unrecordable value.
      const safeContext = requireRecord(
        decodeMemoryValue(encodeMemoryValue(recordedContext)),
        "request context",
      );
      const requestContext = new RequestContext();
      for (const [key, value] of Object.entries(safeContext))
        requestContext.set(key, value);
      const dynamic = { requestContext, mastra: options.mastra };
      const instructions = historical
        ? historical.configuration.instructions
        : typeof config.instructions === "function"
          ? await config.instructions(dynamic)
          : config.instructions;
      const modelConfiguration = historical
        ? await options.resolveModel(
            replay.replacementModelId ??
              String(historical.configuration.modelId),
          )
        : typeof config.model === "function"
          ? await config.model(dynamic)
          : config.model;
      if (Array.isArray(modelConfiguration))
        throw new Error(
          "Model fallback arrays are outside memory replay support.",
        );
      const nativeModel = await resolveModelConfig(
        modelConfiguration,
        requestContext,
      );
      const resolvedDefaults = historical
        ? historical.configuration.defaultOptions
        : typeof config.defaultOptions === "function"
          ? await config.defaultOptions(dynamic)
          : (config.defaultOptions ?? {});
      const defaults = requireRecord(resolvedDefaults, "default options");
      const { deepMerge } = await import("@mastra/core/utils");
      const callerData = { ...callerOptions };
      delete callerData.requestContext;
      delete callerData.abortSignal;
      for (const callback of ["onFinish", "onError", "onAbort", "onStepFinish"])
        delete callerData[callback];
      const effective = historical
        ? requireRecord(
            historical.configuration.runOptions,
            "invocation options",
          )
        : deepMerge(defaults, callerData);
      assertSupportedConfiguration(config, effective);
      if (record(effective.memory) && effective.memory.options !== undefined)
        throw new Error(
          "Per-call memory.options are unsupported. Set the complete memory configuration in sourceMemory instead.",
        );
      const overrideSettings = parseModelSettings(
        replay.override?.model_params,
      );
      if (overrideSettings)
        effective.modelSettings = {
          ...(record(effective.modelSettings) ? effective.modelSettings : {}),
          ...overrideSettings,
        };
      const applicationInstructions =
        replay.override?.system_prompt ?? instructions;
      const configuration = {
        instructions: applicationInstructions,
        modelId: getMemoryModelId(modelConfiguration),
        defaultOptions: defaults,
        runOptions: effective,
        memoryConfig:
          historical?.configuration.memoryConfig ??
          serializeMemoryConfiguration(runtime.memory.getMergedThreadConfig()),
        ...(workspace ? { workspaceManifest: workspace.manifest } : {}),
      };
      const envelope = createMemoryReplayEnvelope({
        invocationId,
        rawInput: invocationInput,
        initialSnapshot: runtime.initialSnapshot as MastraMemorySnapshot,
        configuration,
        requestContext: safeContext,
        files: files.files,
      });
      if (!envelope.complete && historical)
        throw new Error(envelope.reasons.join(" "));
      const writeAttempt = (evidence: RequestEvidence, error: unknown) =>
        writeNode({
          external_id: evidence.externalId,
          parent_external_id: ROOT_NODE_EXTERNAL_ID,
          node_type: "llm_call",
          name: "model_request",
          status: "failed",
          error: error instanceof Error ? error.name : "Model request failed",
          inputs: evidence.inputs,
          outputs: null,
          model: evidence.modelId,
          model_params: evidence.modelSettings,
          started_at: evidence.startedAt,
          ended_at: new Date().toISOString(),
          attributes: requestEvidenceAttributes(evidence),
        });
      const capture = createRequestCapture({
        invocationId,
        getMemoryRevision: () => runtime.binding.revision,
        onFailedAttempt: writeAttempt,
        onCaptureError: () =>
          runtime.binding.markIncomplete(
            "Actor request evidence was incomplete.",
          ),
      });
      requestCapture = capture;
      const policy = createStatefulToolProcessors({
        tokens: owned.tokens,
        getState,
        abort(reason) {
          state?.storeFailure(reason);
          abort.abort(reason);
        },
        adapter: options,
      });
      const requestProcessor: InputProcessor = {
        id: "kitaru-effective-request",
        async processInputStep(args) {
          capture.beginStep({
            stepNumber: args.stepNumber,
            messageList: args.messageList,
            applicationInstructions,
            extraContext: {
              system: effective.system ?? null,
              context: effective.context ?? [],
            },
          });
          const resolved = await resolveModelConfig(args.model, requestContext);
          return {
            model: capture.instrumentModel(resolved) as typeof args.model,
          };
        },
      };
      const agent = new Agent({
        ...config,
        memory: owned.memory,
        workspace: workspace?.workspace,
        instructions: applicationInstructions as AgentConfig["instructions"],
        model: capture.instrumentModel(nativeModel) as MastraModelConfig,
        defaultOptions: {},
        inputProcessors: [
          policy.first,
          ...((config.inputProcessors as InputProcessor[]) ?? []),
          policy.last,
          requestProcessor,
        ],
      });
      const runtimeOptions: RuntimeStreamOptions = {
        ...effective,
        onFinish: callerOptions.onFinish,
        onError: callerOptions.onError,
        onAbort: callerOptions.onAbort,
        onStepFinish: callerOptions.onStepFinish,
        requestContext,
        abortSignal: callerOptions.abortSignal
          ? AbortSignal.any([callerOptions.abortSignal, abort.signal])
          : abort.signal,
      };
      const version = createRequire(import.meta.url)("../package.json") as {
        version: string;
      };
      return await streamWithRecording({
        adapterVersion: version.version,
        agent: agent as unknown as Parameters<
          typeof streamWithRecording
        >[0]["agent"],
        callerMessages: invocationInput,
        callerOptions: runtimeOptions,
        client,
        options,
        replayInput: replay.effectiveInput,
        replay,
        requestedModelId:
          replay.replacementModelId ?? String(configuration.modelId),
        sessionName: options.sessionName,
        startedAt,
        stateful: {
          input: { [MEMORY_REPLAY_KEY]: envelope },
          initialize(value) {
            state = value;
          },
          takeRequest() {
            const evidence = capture.takeSuccessful();
            if (evidence && !evidence.complete)
              runtime.binding.markIncomplete(
                "Actor request evidence was incomplete.",
              );
            return evidence;
          },
          async finish() {
            await runtime.finish();
            await capture.drain();
            for (const pending of capture.flushUnfinished())
              await writeAttempt(
                pending,
                new Error("Unfinished model attempt"),
              );
            if (runtime.binding.incompleteReasons.length) {
              const message = runtime.binding.incompleteReasons.join(" ");
              if (
                runtime.binding.incompleteReasons.includes(
                  "Native memory storage mutation failed.",
                )
              )
                throw new Error(message);
              throw new StatefulRecordingError(message);
            }
          },
        },
      });
    } catch (error) {
      await runtime.finish();
      throw error;
    }
  }
  return { stream: stream as Agent["stream"] };
}
