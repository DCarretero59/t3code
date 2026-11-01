import type { PermissionRequest, SessionEvent } from "@github/copilot-sdk";
import {
  type ModelSelection,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ProviderTurnTokenUsage,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@t3tools/provider-core/server/attachmentPrompt";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { t3OrchestrationSystemPrompt } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";

import { CopilotSettings } from "../settings.ts";
import { copilotRuntimeEnvironment } from "./environment.ts";
import { copilotSessionControls, copilotSessionMode } from "./controls.ts";
import {
  type CopilotPromptRequest,
  copilotApprovalPresentation,
  copilotPermissionResult,
  type CopilotApprovalPresentation,
} from "./permissions.ts";
import {
  COPILOT_DRIVER_KIND,
  type CopilotReasoningEffort,
  type CopilotSdkConnection,
  type CopilotSdkRunner,
  type CopilotSdkSession,
  type CopilotSessionControls,
  type CopilotSdkSessionOptions,
  type CopilotSendAttachment,
  type CopilotUserInputRequest,
  type CopilotUserInputResponse,
  makeCopilotSdkRunner,
  isCopilotReasoningEffort,
} from "./sdk.ts";
import { COPILOT_DEFAULT_MODEL, COPILOT_REASONING_EFFORT_OPTION } from "./status.ts";
import { copilotToolTurnItemFields, isCopilotShellTool, isHiddenCopilotTool } from "./tools.ts";

export const COPILOT_PROVIDER = COPILOT_DRIVER_KIND;
const DEFAULT_COPILOT_SETTINGS = Schema.decodeSync(CopilotSettings)({});
const STREAM_FLUSH_MS = 50;
const T3_MCP_SERVER = "t3-code";
const USER_INPUT_QUESTION_ID = "answer";
const SESSION_NOT_FOUND = /session not found/iu;
const USAGE_LIMIT_ERROR_TYPES = new Set(["quota", "rate_limit"]);

const CopilotProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    // Full access swaps the permission handler, which is fixed when the session opens.
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    // Aborting also stops background agents the turn started.
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

interface CopilotAdapterV2Options {
  readonly identity?: CopilotAdapterIdentity;
  readonly instanceId: ProviderInstanceId;
  readonly settings: CopilotSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly runner: CopilotSdkRunner;
}

export interface CopilotAdapterIdentity {
  readonly driverKind: ProviderDriverKind;
  readonly nativeThreadIdPrefix: string;
}

/** T3's thread MCP server, over HTTP; Copilot keeps the session running when it is unreachable. */
export function copilotT3McpServers(session: McpProviderSessionConfig | undefined) {
  return session === undefined
    ? {}
    : {
        [T3_MCP_SERVER]: {
          type: "http" as const,
          url: session.endpoint,
          headers: { Authorization: session.authorizationHeader },
          tools: ["*"],
        },
      };
}

export function copilotProviderFailure(input: {
  readonly errorType: string;
  readonly message: string;
  readonly errorCode?: string | undefined;
  readonly quotaResetAt?: string | null | undefined;
}): OrchestrationV2ProviderFailure {
  const usageLimit = USAGE_LIMIT_ERROR_TYPES.has(input.errorType);
  return makeProviderFailure({
    message: input.message.trim() || "GitHub Copilot reported an error.",
    code: input.errorCode ?? input.errorType,
    class: usageLimit
      ? "usage_limit"
      : input.errorType === "authentication" || input.errorType === "authorization"
        ? "permission_error"
        : "provider_error",
    retryable: usageLimit ? true : null,
    ...(input.errorType === "quota" && input.quotaResetAt ? { resetAt: input.quotaResetAt } : {}),
  });
}

function mentionsSessionNotFound(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const message = Reflect.get(current, "message");
    if (typeof message === "string" && SESSION_NOT_FOUND.test(message)) return true;
    current = Reflect.get(current, "cause");
  }
  return false;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const field = record(value)?.[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  const field = record(value)?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

interface CopilotModelChoice {
  readonly model: string;
  readonly reasoningEffort?: CopilotReasoningEffort;
}

function modelChoice(selection: ModelSelection): CopilotModelChoice {
  const effort =
    getModelSelectionStringOptionValue(selection, COPILOT_REASONING_EFFORT_OPTION) ??
    getModelSelectionStringOptionValue(selection, "reasoning_effort");
  return {
    model: selection.model.trim() || COPILOT_DEFAULT_MODEL,
    ...(isCopilotReasoningEffort(effort) ? { reasoningEffort: effort } : {}),
  };
}

function unsupportedSelectionOption(selection: ModelSelection): string | undefined {
  for (const option of selection.options ?? []) {
    switch (option.id) {
      case COPILOT_REASONING_EFFORT_OPTION:
      case "reasoning_effort":
        if (typeof option.value !== "string" || !isCopilotReasoningEffort(option.value))
          return option.id;
        break;
      case "mode":
        if (typeof option.value !== "string" || copilotSessionMode(option.value) === undefined) {
          return option.id;
        }
        break;
      case "agent":
        if (typeof option.value !== "string") return option.id;
        break;
      case "allow_all":
        if (option.value !== "on" && option.value !== "off") return option.id;
        break;
      default:
        return option.id;
    }
  }
  return undefined;
}

interface StreamItem {
  readonly nativeItemId: string;
  readonly kind: "assistant_message" | "reasoning";
  text: string;
  completed: boolean;
  flushScheduled: boolean;
  readonly startedAt: DateTime.Utc;
}

interface ToolItem {
  readonly nativeItemId: string;
  readonly toolName: string;
  readonly arguments: unknown;
  readonly mcpServerName?: string;
  readonly mcpToolName?: string;
  readonly startedAt: DateTime.Utc;
  output: string;
  completed: boolean;
}

interface ActiveTurn {
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly itemOrdinals: Map<string, number>;
  nextItemOrdinal: number;
  readonly streamItems: Map<string, StreamItem>;
  readonly tools: Map<string, ToolItem>;
  reasoningOrdinal: number;
  interrupted: boolean;
  aborted: boolean;
  sawPrompt: boolean;
  /** Steers Copilot accepted but has not echoed as a user message yet. */
  pendingSteers: number;
  /** Copilot went idle while a steer was pending; that steer runs as a follow-up native turn. */
  idleDeferred: boolean;
  failure: OrchestrationV2ProviderFailure | null;
  tokenUsage: OrchestrationV2ProviderTurnTokenUsage | undefined;
  readonly sendSettled: Deferred.Deferred<void>;
}

interface PendingRequest {
  readonly sdk: CopilotSdkSession;
  readonly nativeRequestId: string;
  readonly kind: "permission" | "user_input";
  readonly presentation?: CopilotApprovalPresentation;
  readonly answer?: Deferred.Deferred<CopilotUserInputResponse | null>;
  readonly choices: ReadonlyArray<string>;
  runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
}

interface BoundSession {
  readonly sdk: CopilotSdkSession;
  providerThread: OrchestrationV2ProviderThread;
  activeTurn: ActiveTurn | null;
  applied: CopilotModelChoice;
  controls: CopilotSessionControls;
  readonly approveAll: boolean;
}

type InboxItem =
  | { readonly type: "event"; readonly owner: object; readonly event: SessionEvent }
  | {
      readonly type: "user_input";
      readonly owner: object;
      readonly requestId: string;
      readonly request: CopilotUserInputRequest;
      readonly answer: Deferred.Deferred<CopilotUserInputResponse | null>;
    };

const makeCopilotAdapterV2 = Effect.fn("makeCopilotAdapterV2")(function* (
  options: CopilotAdapterV2Options,
) {
  const COPILOT_PROVIDER = options.identity?.driverKind ?? COPILOT_DRIVER_KIND;
  const nativeThreadIdPrefix = options.identity?.nativeThreadIdPrefix ?? "";
  const providerRef = (
    nativeId: string,
    strength: "strong" | "weak" = "strong",
  ): OrchestrationV2ProviderRef => ({ driver: COPILOT_PROVIDER, nativeId, strength });
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const host = yield* ProviderHost.ProviderHost;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;

  const protocolError = (detail: string, payload?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: COPILOT_PROVIDER,
      detail,
      ...(payload === undefined ? {} : { payload }),
    });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: COPILOT_PROVIDER,
    getCapabilities: Effect.fn("CopilotAdapter.getCapabilities")(function () {
      return Effect.succeed(CopilotProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("CopilotAdapter.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    openSession: Effect.fn("CopilotAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const unsupported = unsupportedSelectionOption(input.modelSelection);
      if (unsupported !== undefined) {
        return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
          driver: COPILOT_PROVIDER,
          providerSessionId: input.providerSessionId,
          cause: new Error(`Copilot SDK does not support the '${unsupported}' selection.`),
        });
      }
      const scope = yield* Effect.scope;
      const cwd = input.runtimePolicy.cwd ?? host.paths.cwd;
      const mcpSession = yield* mcpSessions.read(input.threadId);
      const permitsFullAccess =
        input.runtimePolicy.runtimeMode === "full-access" &&
        input.runtimePolicy.approvalPolicy === undefined &&
        input.runtimePolicy.sandboxPolicy === undefined;
      const approveAll =
        permitsFullAccess &&
        getModelSelectionStringOptionValue(input.modelSelection, "allow_all") !== "off";
      const connection: CopilotSdkConnection = yield* options.runner
        .connect({
          binaryPath: options.settings.binaryPath || "copilot",
          environment: options.environment,
          cwd,
          threadId: input.threadId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: COPILOT_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        );

      const now = yield* DateTime.now;
      let sessionEntity: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: COPILOT_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: CopilotProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      const inbox = yield* Queue.unbounded<InboxItem>();
      const permit = yield* Semaphore.make(1);
      const pendingRequests = new Map<string, PendingRequest>();
      let bound: BoundSession | null = null;
      let quotaResetAt: string | null = null;
      const systemMessage = [
        buildRuntimeInstructions({ harness: "GitHub Copilot" }),
        t3OrchestrationSystemPrompt(
          mcpSession !== undefined,
          mcpSession?.capabilities?.has("device") === true,
        ),
      ]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join("\n\n");

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);

      const updateProviderSession =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (
          status: OrchestrationV2ProviderSession["status"],
          lastError: string | null = sessionEntity.lastError,
          model: string | null = sessionEntity.model,
        ) {
          const updatedAt = yield* DateTime.now;
          sessionEntity = { ...sessionEntity, status, lastError, model, updatedAt };
          yield* emit({
            type: "provider_session.updated",
            driver: COPILOT_PROVIDER,
            providerSession: sessionEntity,
          });
        });

      const updateProviderThread = Effect.fnUntraced(function* (
        session: BoundSession,
        patch: Partial<OrchestrationV2ProviderThread>,
      ) {
        const updatedAt = yield* DateTime.now;
        session.providerThread = { ...session.providerThread, ...patch, updatedAt };
        yield* emit({
          type: "provider_thread.updated",
          driver: COPILOT_PROVIDER,
          providerThread: session.providerThread,
        });
      });

      const itemOrdinal = (turn: ActiveTurn, nativeItemId: string): number => {
        const existing = turn.itemOrdinals.get(nativeItemId);
        if (existing !== undefined) return existing;
        const ordinal = turn.nextItemOrdinal++;
        turn.itemOrdinals.set(nativeItemId, ordinal);
        return ordinal;
      };

      const baseItemFields = (
        turn: ActiveTurn,
        nativeItemId: string,
        startedAt: DateTime.Utc,
        updatedAt: DateTime.Utc,
      ) => ({
        id: idAllocator.derive.turnItemFromProviderItem({
          driver: COPILOT_PROVIDER,
          nativeItemId,
        }),
        threadId: turn.turnInput.threadId,
        runId: turn.turnInput.runId,
        nodeId: idAllocator.derive.nodeFromProviderItem({
          driver: COPILOT_PROVIDER,
          nativeItemId,
        }),
        providerThreadId: turn.turnInput.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: providerRef(nativeItemId),
        parentItemId: null,
        ordinal: itemOrdinal(turn, nativeItemId),
        startedAt,
        updatedAt,
      });

      const emitItemNode = (
        turn: ActiveTurn,
        nativeItemId: string,
        kind: OrchestrationV2ExecutionNode["kind"],
        status: OrchestrationV2ExecutionNode["status"],
        startedAt: DateTime.Utc,
        completedAt: DateTime.Utc | null,
      ) =>
        emit({
          type: "node.updated",
          driver: COPILOT_PROVIDER,
          node: {
            id: idAllocator.derive.nodeFromProviderItem({
              driver: COPILOT_PROVIDER,
              nativeItemId,
            }),
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            parentNodeId: turn.turnInput.rootNodeId,
            rootNodeId: turn.turnInput.rootNodeId,
            kind,
            status,
            countsForRun: false,
            providerThreadId: turn.turnInput.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: providerRef(nativeItemId),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt,
          },
        });

      const emitStreamItem =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (turn: ActiveTurn, item: StreamItem, streaming: boolean) {
          const emittedAt = yield* DateTime.now;
          const status = streaming ? "running" : "completed";
          const completedAt = streaming ? null : emittedAt;
          const base = baseItemFields(turn, item.nativeItemId, item.startedAt, emittedAt);
          yield* emitItemNode(
            turn,
            item.nativeItemId,
            item.kind,
            status,
            item.startedAt,
            completedAt,
          );
          if (item.kind === "reasoning") {
            yield* emit({
              type: "turn_item.updated",
              driver: COPILOT_PROVIDER,
              turnItem: {
                ...base,
                status,
                title: null,
                completedAt,
                type: "reasoning",
                text: item.text,
                streaming,
              },
            });
            return;
          }
          const messageId = idAllocator.derive.messageFromProviderItem({
            driver: COPILOT_PROVIDER,
            nativeItemId: item.nativeItemId,
          });
          yield* emit({
            type: "turn_item.updated",
            driver: COPILOT_PROVIDER,
            turnItem: {
              ...base,
              status,
              title: null,
              completedAt,
              type: "assistant_message",
              messageId,
              text: item.text,
              streaming,
            },
          });
          yield* emit({
            type: "message.updated",
            driver: COPILOT_PROVIDER,
            message: {
              id: messageId,
              threadId: turn.turnInput.threadId,
              runId: turn.turnInput.runId,
              nodeId: base.nodeId,
              role: "assistant",
              text: item.text,
              attachments: [],
              streaming,
              createdBy: "agent",
              creationSource: "provider",
              createdAt: item.startedAt,
              updatedAt: emittedAt,
            },
          });
        });

      const scheduleStreamFlush =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (turn: ActiveTurn, item: StreamItem) {
          if (item.flushScheduled || item.completed) return;
          item.flushScheduled = true;
          yield* Effect.sleep(Duration.millis(STREAM_FLUSH_MS)).pipe(
            Effect.andThen(
              permit.withPermits(1)(
                Effect.suspend(() => {
                  item.flushScheduled = false;
                  return item.completed ? Effect.void : emitStreamItem(turn, item, true);
                }),
              ),
            ),
            Effect.forkIn(scope),
          );
        });

      const streamItemFor = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        kind: StreamItem["kind"],
        key: string,
      ) {
        const existing = turn.streamItems.get(key);
        if (existing !== undefined) return existing;
        const nativeItemId =
          kind === "assistant_message"
            ? key
            : `${turn.providerTurn.id}:reasoning:${++turn.reasoningOrdinal}`;
        const item: StreamItem = {
          nativeItemId,
          kind,
          text: "",
          completed: false,
          flushScheduled: false,
          startedAt: yield* DateTime.now,
        };
        turn.streamItems.set(key, item);
        itemOrdinal(turn, nativeItemId);
        return item;
      });

      const completeStreamItem = (turn: ActiveTurn, item: StreamItem, text?: string) =>
        Effect.suspend(() => {
          if (item.completed) return Effect.void;
          item.completed = true;
          if (text !== undefined && text.length > 0) item.text = text;
          return item.text.trim().length === 0 ? Effect.void : emitStreamItem(turn, item, false);
        });

      const emitToolItem = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        tool: ToolItem,
        status: "running" | "completed" | "failed" | "interrupted",
        error?: string,
      ) {
        const emittedAt = yield* DateTime.now;
        const completedAt = status === "running" ? null : emittedAt;
        yield* emitItemNode(
          turn,
          tool.nativeItemId,
          "tool_call",
          status,
          tool.startedAt,
          completedAt,
        );
        yield* emit({
          type: "turn_item.updated",
          driver: COPILOT_PROVIDER,
          turnItem: {
            ...baseItemFields(turn, tool.nativeItemId, tool.startedAt, emittedAt),
            status,
            completedAt,
            ...copilotToolTurnItemFields({
              toolName: tool.toolName,
              arguments: tool.arguments,
              ...(tool.mcpServerName === undefined ? {} : { mcpServerName: tool.mcpServerName }),
              ...(tool.mcpToolName === undefined ? {} : { mcpToolName: tool.mcpToolName }),
              ...(tool.output.length === 0 ? {} : { output: tool.output }),
              ...(error === undefined ? {} : { error }),
            }),
          },
        });
      });

      const toolFor = Effect.fnUntraced(function* (turn: ActiveTurn, data: unknown) {
        const toolCallId = stringField(data, "toolCallId");
        if (toolCallId === undefined) return undefined;
        const existing = turn.tools.get(toolCallId);
        if (existing !== undefined) return existing;
        const toolName = stringField(data, "toolName");
        if (toolName === undefined || isHiddenCopilotTool(toolName)) return undefined;
        const mcpServerName = stringField(data, "mcpServerName");
        const mcpToolName = stringField(data, "mcpToolName");
        const tool: ToolItem = {
          nativeItemId: toolCallId,
          toolName,
          arguments: record(data)?.["arguments"],
          ...(mcpServerName === undefined ? {} : { mcpServerName }),
          ...(mcpToolName === undefined ? {} : { mcpToolName }),
          startedAt: yield* DateTime.now,
          output: "",
          completed: false,
        };
        turn.tools.set(toolCallId, tool);
        return tool;
      });

      const appendToolOutput = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        tool: ToolItem,
        chunk: string,
      ) {
        if (chunk.length === 0 || tool.completed) return;
        tool.output += chunk;
        if (!isCopilotShellTool(tool.toolName)) return;
        yield* emit({
          type: "command_output.delta",
          driver: COPILOT_PROVIDER,
          threadId: turn.turnInput.threadId,
          itemId: idAllocator.derive.turnItemFromProviderItem({
            driver: COPILOT_PROVIDER,
            nativeItemId: tool.nativeItemId,
          }),
          chunk,
        });
      });

      const settleRequest = Effect.fnUntraced(function* (
        pending: PendingRequest,
        status: "resolved" | "cancelled",
        resolvedAt: DateTime.Utc,
        details: Pick<OrchestrationV2RuntimeRequest, "decision" | "feedback" | "answers"> = {},
      ) {
        pendingRequests.delete(String(pending.runtimeRequest.id));
        pending.runtimeRequest = {
          ...pending.runtimeRequest,
          status,
          resolvedAt,
          ...details,
        };
        yield* emit({
          type: "runtime_request.updated",
          driver: COPILOT_PROVIDER,
          threadId: pending.node.threadId,
          runtimeRequest: pending.runtimeRequest,
        });
        const nodeStatus = status === "resolved" ? "completed" : "cancelled";
        yield* emit({
          type: "node.updated",
          driver: COPILOT_PROVIDER,
          node: { ...pending.node, status: nodeStatus, completedAt: resolvedAt },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: COPILOT_PROVIDER,
          turnItem: {
            ...pending.turnItem,
            status: nodeStatus,
            completedAt: resolvedAt,
            updatedAt: resolvedAt,
          },
        });
      });

      const cancelPendingRequests = Effect.fnUntraced(function* (resolvedAt: DateTime.Utc) {
        for (const pending of Array.from(pendingRequests.values())) {
          if (pending.answer !== undefined) yield* Deferred.succeed(pending.answer, null);
          yield* settleRequest(pending, "cancelled", resolvedAt);
        }
      });

      const registerRequest = Effect.fnUntraced(function* (
        session: BoundSession,
        request:
          | {
              readonly kind: "permission";
              readonly nativeRequestId: string;
              readonly presentation: CopilotApprovalPresentation;
            }
          | {
              readonly kind: "user_input";
              readonly nativeRequestId: string;
              readonly request: CopilotUserInputRequest;
              readonly answer: Deferred.Deferred<CopilotUserInputResponse | null>;
            },
      ) {
        const turn = session.activeTurn;
        const createdAt = yield* DateTime.now;
        const requestId = yield* idAllocator.allocate.runtimeRequest({
          driver: COPILOT_PROVIDER,
          ...(turn === null ? {} : { providerTurnId: turn.providerTurn.id }),
          nativeRequestId: request.nativeRequestId,
        });
        const nodeId = idAllocator.derive.approvalNode({ requestId });
        const threadId =
          turn?.turnInput.threadId ?? session.providerThread.appThreadId ?? input.threadId;
        const providerTurnId = turn?.providerTurn.id ?? null;
        const isPermission = request.kind === "permission";
        const runtimeRequest: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId,
          nativeRequestRef: providerRef(request.nativeRequestId, isPermission ? "strong" : "weak"),
          kind: isPermission ? request.presentation.requestKind : "user_input",
          status: "pending",
          responseCapability: {
            type: "live",
            providerSessionId: input.providerSessionId,
            ...(isPermission ? { supportsFeedback: true } : {}),
          },
          createdAt,
          resolvedAt: null,
        };
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId,
          runId: turn?.turnInput.runId ?? null,
          parentNodeId: turn?.turnInput.rootNodeId ?? null,
          rootNodeId: turn?.turnInput.rootNodeId ?? nodeId,
          kind: isPermission ? "approval_request" : "user_input_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: session.providerThread.id,
          providerTurnId,
          nativeItemRef: providerRef(request.nativeRequestId, isPermission ? "strong" : "weak"),
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: createdAt,
          completedAt: null,
        };
        const itemBase = {
          id: idAllocator.derive.approvalTurnItem({ requestId }),
          threadId,
          runId: turn?.turnInput.runId ?? null,
          nodeId,
          providerThreadId: session.providerThread.id,
          providerTurnId,
          nativeItemRef: node.nativeItemRef,
          parentItemId: null,
          ordinal: turn === null ? 0 : itemOrdinal(turn, `request:${request.nativeRequestId}`),
          status: "waiting" as const,
          startedAt: createdAt,
          completedAt: null,
          updatedAt: createdAt,
        };
        const choices =
          request.kind === "user_input"
            ? (request.request.choices ?? []).filter((choice: string) => choice.trim().length > 0)
            : [];
        const turnItem: OrchestrationV2TurnItem =
          request.kind === "permission"
            ? {
                ...itemBase,
                title: request.presentation.title,
                type: "approval_request",
                requestId,
                requestKind: request.presentation.requestKind,
                prompt: request.presentation.prompt,
                ...(request.presentation.reason === undefined
                  ? {}
                  : { reason: request.presentation.reason }),
                options: request.presentation.options,
              }
            : {
                ...itemBase,
                title: "Question",
                type: "user_input_request",
                requestId,
                questions: [
                  {
                    id: USER_INPUT_QUESTION_ID,
                    header: "Question",
                    question: request.request.question.trim() || "GitHub Copilot needs input.",
                    options: choices.map((choice: string) => ({
                      label: choice,
                      description: choice,
                      value: choice,
                    })),
                    allowCustomAnswer:
                      request.request.allowFreeform !== false || choices.length === 0,
                  },
                ],
              };
        pendingRequests.set(String(requestId), {
          sdk: session.sdk,
          nativeRequestId: request.nativeRequestId,
          kind: request.kind,
          ...(request.kind === "permission"
            ? { presentation: request.presentation }
            : { answer: request.answer }),
          choices,
          runtimeRequest,
          node,
          turnItem,
        });
        yield* emit({
          type: "runtime_request.updated",
          driver: COPILOT_PROVIDER,
          threadId,
          runtimeRequest,
        });
        yield* emit({ type: "node.updated", driver: COPILOT_PROVIDER, node });
        yield* emit({ type: "turn_item.updated", driver: COPILOT_PROVIDER, turnItem });
      });

      const finalizeTurn = Effect.fnUntraced(function* (session: BoundSession) {
        const turn = session.activeTurn;
        if (turn === null) return;
        session.activeTurn = null;
        const interrupted = turn.interrupted || turn.aborted;
        const completedAt = yield* DateTime.now;
        for (const item of turn.streamItems.values()) yield* completeStreamItem(turn, item);
        for (const tool of turn.tools.values()) {
          if (tool.completed) continue;
          tool.completed = true;
          yield* emitToolItem(turn, tool, interrupted ? "interrupted" : "failed");
        }
        yield* cancelPendingRequests(completedAt);
        const failure = interrupted ? null : turn.failure;
        yield* emit({
          type: "provider_turn.updated",
          driver: COPILOT_PROVIDER,
          threadId: turn.turnInput.threadId,
          providerTurn: {
            ...turn.providerTurn,
            status: interrupted ? "interrupted" : failure !== null ? "failed" : "completed",
            completedAt,
            ...(turn.tokenUsage === undefined ? {} : { tokenUsage: turn.tokenUsage }),
          },
        });
        yield* updateProviderThread(session, { status: "idle" });
        yield* updateProviderSession(
          failure !== null ? "error" : "ready",
          failure?.message ?? null,
        );
        if (failure === null) {
          yield* emit({
            type: "turn.terminal",
            driver: COPILOT_PROVIDER,
            providerThreadId: session.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.turnInput.runOrdinal,
            status: interrupted ? "interrupted" : "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          return;
        }
        const failureItemId = `terminal-failure:${turn.providerTurn.id}`;
        yield* emit({
          type: "turn_item.updated",
          driver: COPILOT_PROVIDER,
          turnItem: {
            ...baseItemFields(turn, failureItemId, completedAt, completedAt),
            status: "failed",
            title: failure.class === "usage_limit" ? "Usage limit reached" : "Provider error",
            completedAt,
            type: "error",
            failure,
          },
        });
        yield* emit({
          type: "turn.terminal",
          driver: COPILOT_PROVIDER,
          providerThreadId: session.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          runOrdinal: turn.turnInput.runOrdinal,
          failureItemOrdinal: itemOrdinal(turn, failureItemId),
          status: "failed",
          failure,
          threadDisposition: "reusable",
        });
      });

      const handleEvent = Effect.fnUntraced(function* (session: BoundSession, event: SessionEvent) {
        const data: unknown = event.data;
        if (event.type === "assistant.usage") {
          const premium = record(
            record(record(data)?.["quotaSnapshots"])?.["premium_interactions"],
          );
          quotaResetAt = stringField(premium, "resetDate") ?? quotaResetAt;
          return;
        }
        if (event.type === "permission.completed") {
          const requestId = stringField(data, "requestId");
          const pending = Array.from(pendingRequests.values()).find(
            (candidate) =>
              candidate.kind === "permission" && candidate.nativeRequestId === requestId,
          );
          // Copilot settled it itself, for example when the turn was stopped.
          if (pending !== undefined)
            yield* settleRequest(pending, "cancelled", yield* DateTime.now);
          return;
        }
        if (event.type === "permission.requested") {
          if (session.approveAll || record(data)?.["resolvedByHook"] === true) return;
          const requestId = stringField(data, "requestId");
          const request = record(data)?.["permissionRequest"] as PermissionRequest | undefined;
          if (requestId === undefined || request === undefined) return;
          const promptRequest = record(data)?.["promptRequest"] as CopilotPromptRequest | undefined;
          if (session.activeTurn === null) {
            // No turn owns it, so nobody could answer; Copilot treats this as a denial.
            yield* session.sdk
              .respondToPermission({ requestId, result: { kind: "user-not-available" } })
              .pipe(Effect.ignore, Effect.forkIn(scope));
            return;
          }
          yield* registerRequest(session, {
            kind: "permission",
            nativeRequestId: requestId,
            presentation: copilotApprovalPresentation(request, promptRequest),
          });
          return;
        }
        const turn = session.activeTurn;
        // Subagent internals stay inside their parent's task tool row for now.
        if (turn === null || event.agentId !== undefined) return;
        switch (event.type) {
          case "assistant.message_delta": {
            const messageId = stringField(data, "messageId");
            const delta = stringField(data, "deltaContent") ?? "";
            if (messageId === undefined || delta.length === 0) return;
            const item = yield* streamItemFor(turn, "assistant_message", messageId);
            item.text += delta;
            yield* scheduleStreamFlush(turn, item);
            return;
          }
          case "assistant.message": {
            const messageId = stringField(data, "messageId");
            if (messageId === undefined) return;
            const content = stringField(data, "content") ?? "";
            const existing = turn.streamItems.get(messageId);
            if (existing === undefined && content.trim().length === 0) return;
            const item = yield* streamItemFor(turn, "assistant_message", messageId);
            yield* completeStreamItem(turn, item, content);
            return;
          }
          case "assistant.reasoning_delta": {
            const reasoningId = stringField(data, "reasoningId");
            const delta = stringField(data, "deltaContent") ?? "";
            if (reasoningId === undefined || delta.length === 0) return;
            const item = yield* streamItemFor(turn, "reasoning", reasoningId);
            item.text += delta;
            yield* scheduleStreamFlush(turn, item);
            return;
          }
          case "assistant.reasoning": {
            const reasoningId = stringField(data, "reasoningId");
            if (reasoningId === undefined) return;
            const content = stringField(data, "content") ?? "";
            const existing = turn.streamItems.get(reasoningId);
            // Encrypted reasoning arrives with empty content; there is nothing to show.
            if (existing === undefined && content.trim().length === 0) return;
            const item = yield* streamItemFor(turn, "reasoning", reasoningId);
            yield* completeStreamItem(turn, item, content);
            return;
          }
          case "tool.execution_start": {
            const tool = yield* toolFor(turn, data);
            if (tool !== undefined) yield* emitToolItem(turn, tool, "running");
            return;
          }
          case "tool.shell_output": {
            const tool = turn.tools.get(stringField(data, "toolCallId") ?? "");
            if (tool !== undefined)
              yield* appendToolOutput(turn, tool, stringField(data, "text") ?? "");
            return;
          }
          case "tool.execution_partial_result": {
            const tool = turn.tools.get(stringField(data, "toolCallId") ?? "");
            // Runtimes before tool.shell_output resend the whole output so far.
            const output = stringField(data, "partialOutput");
            if (tool === undefined || output === undefined) return;
            if (output.startsWith(tool.output)) {
              yield* appendToolOutput(turn, tool, output.slice(tool.output.length));
            }
            return;
          }
          case "tool.execution_complete": {
            const tool = yield* toolFor(turn, data);
            if (tool === undefined || tool.completed) return;
            tool.completed = true;
            const result = record(record(data)?.["result"]);
            const output = stringField(result, "detailedContent") ?? stringField(result, "content");
            if (output !== undefined) tool.output = output;
            const success = record(data)?.["success"] === true;
            const error = stringField(record(record(data)?.["error"]), "message");
            yield* emitToolItem(
              turn,
              tool,
              success ? "completed" : turn.interrupted ? "interrupted" : "failed",
              success ? undefined : error,
            );
            return;
          }
          case "session.usage_info": {
            const usedTokens = numberField(data, "currentTokens");
            const maxTokens = numberField(data, "tokenLimit");
            if (usedTokens === undefined) return;
            turn.tokenUsage = {
              usedTokens: Math.max(0, Math.trunc(usedTokens)),
              ...(maxTokens === undefined || maxTokens <= 0
                ? {}
                : { maxTokens: Math.trunc(maxTokens) }),
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            };
            return;
          }
          case "session.error": {
            turn.failure ??= copilotProviderFailure({
              errorType: stringField(data, "errorType") ?? "unknown",
              message: stringField(data, "message") ?? "",
              errorCode: stringField(data, "errorCode"),
              quotaResetAt,
            });
            return;
          }
          case "user.message": {
            if (!turn.sawPrompt) turn.sawPrompt = true;
            else if (turn.pendingSteers > 0) turn.pendingSteers -= 1;
            return;
          }
          case "abort":
            turn.aborted = true;
            return;
          case "session.idle": {
            if (record(data)?.["aborted"] === true) turn.aborted = true;
            // A steer that reached Copilot after its last model call is queued for a new native
            // turn after this idle; it still belongs to this run.
            if (!turn.interrupted && !turn.aborted && turn.pendingSteers > 0) {
              turn.idleDeferred = true;
              return;
            }
            yield* finalizeTurn(session);
            return;
          }
          default:
            return;
        }
      });

      yield* Stream.fromQueue(inbox).pipe(
        Stream.runForEach((item) =>
          permit.withPermits(1)(
            Effect.suspend(() => {
              const session = bound;
              if (item.type === "user_input") {
                if (session === null || session.sdk !== item.owner || session.activeTurn === null) {
                  return Deferred.succeed(item.answer, null).pipe(Effect.asVoid);
                }
                return registerRequest(session, {
                  kind: "user_input",
                  nativeRequestId: item.requestId,
                  request: item.request,
                  answer: item.answer,
                });
              }
              if (session === null || session.sdk !== item.owner) return Effect.void;
              return handleEvent(session, item.event);
            }),
          ),
        ),
        Effect.forkIn(scope),
      );

      const openNativeSession = Effect.fnUntraced(function* (open: {
        readonly operation: "create" | "resume";
        readonly sessionId?: string;
        readonly modelSelection: ModelSelection;
      }) {
        const choice = modelChoice(open.modelSelection);
        const sessionOptions: CopilotSdkSessionOptions = {
          model: choice.model,
          ...(choice.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: choice.reasoningEffort }),
          workingDirectory: cwd,
          mcpServers: copilotT3McpServers(mcpSession),
          ...(systemMessage.length === 0 ? {} : { systemMessage }),
          approveAll,
        };
        // Events can arrive before the session handle resolves; the owner token binds them to it.
        const owner: { sdk?: CopilotSdkSession } = {};
        const pendingItems: Array<InboxItem> = [];
        const enqueue = (item: InboxItem) => {
          if (owner.sdk === undefined) pendingItems.push(item);
          else Queue.offerUnsafe(inbox, item);
        };
        const context = yield* Effect.context();
        const sdk = yield* connection.openSession({
          operation: open.operation,
          ...(open.sessionId === undefined ? {} : { sessionId: open.sessionId }),
          options: sessionOptions,
          onEvent: (event) => enqueue({ type: "event", owner: owner.sdk ?? owner, event }),
          onUserInputRequest: ({ requestId, request }) => {
            const answer = Deferred.makeUnsafe<CopilotUserInputResponse | null>();
            enqueue({ type: "user_input", owner: owner.sdk ?? owner, requestId, request, answer });
            return Effect.runPromiseWith(context)(Deferred.await(answer)).then((response) => {
              if (response === null) throw new Error("The question was dismissed.");
              return response;
            });
          },
        });
        owner.sdk = sdk;
        yield* Scope.addFinalizer(scope, sdk.disconnect);
        const controls = copilotSessionControls(
          open.modelSelection,
          input.runtimePolicy.interactionMode,
        );
        if (
          options.identity !== undefined ||
          controls.mode !== "interactive" ||
          getModelSelectionStringOptionValue(open.modelSelection, "agent") !== undefined
        ) {
          yield* sdk.setControls(controls);
          if (controls.mode !== "interactive" || controls.agent !== null) {
            yield* sdk.setModel(choice);
          }
        }
        for (const item of pendingItems.splice(0))
          Queue.offerUnsafe(inbox, { ...item, owner: sdk });
        return { sdk, applied: choice, controls };
      });

      const bindThread = Effect.fnUntraced(function* (threadInput: {
        readonly threadId: ThreadId;
        readonly modelSelection: ModelSelection;
        readonly existing?: OrchestrationV2ProviderThread;
        readonly forceNew?: boolean;
      }) {
        if (bound?.activeTurn != null) {
          return yield* protocolError(
            "Cannot switch GitHub Copilot sessions while a turn is active",
          );
        }
        const persistedNativeId = threadInput.forceNew
          ? undefined
          : (threadInput.existing?.nativeThreadRef?.nativeId ?? undefined);
        if (
          persistedNativeId !== undefined &&
          !persistedNativeId.startsWith(nativeThreadIdPrefix)
        ) {
          return yield* protocolError("Cannot resume an ACP session through the Copilot SDK");
        }
        const existingNativeId = persistedNativeId?.slice(nativeThreadIdPrefix.length);
        if (
          bound !== null &&
          existingNativeId !== undefined &&
          bound.sdk.sessionId === existingNativeId
        ) {
          return bound.providerThread;
        }
        if (bound !== null) {
          const previous = bound;
          bound = null;
          yield* previous.sdk.disconnect;
        }
        const resumed =
          existingNativeId === undefined
            ? undefined
            : yield* openNativeSession({
                operation: "resume",
                sessionId: existingNativeId,
                modelSelection: threadInput.modelSelection,
              }).pipe(
                // Copilot saves a session only after its first message; an unused one cannot resume.
                Effect.catchIf(
                  (error) =>
                    threadInput.existing?.lastRunOrdinal == null && mentionsSessionNotFound(error),
                  () => Effect.undefined,
                ),
              );
        const opened =
          resumed ??
          (yield* openNativeSession({
            operation: "create",
            modelSelection: threadInput.modelSelection,
          }));
        const nativeId = `${nativeThreadIdPrefix}${opened.sdk.sessionId}`;
        const createdAt = yield* DateTime.now;
        const existing = threadInput.existing;
        const providerThread: OrchestrationV2ProviderThread =
          existing !== undefined
            ? {
                ...existing,
                providerSessionId: input.providerSessionId,
                nativeThreadRef: providerRef(nativeId),
                ...(nativeId === existing.nativeThreadRef?.nativeId
                  ? {}
                  : { nativeConversationHeadRef: null, contextUsage: null }),
                status: "idle",
                updatedAt: createdAt,
              }
            : {
                id: idAllocator.derive.providerThread({
                  driver: COPILOT_PROVIDER,
                  nativeThreadId: nativeId,
                }),
                driver: COPILOT_PROVIDER,
                providerInstanceId: options.instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: providerRef(nativeId),
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                pendingBackgroundTasks: [],
                createdAt,
                updatedAt: createdAt,
              };
        bound = {
          sdk: opened.sdk,
          providerThread,
          activeTurn: null,
          applied: opened.applied,
          approveAll,
          controls: opened.controls,
        };
        yield* emit({
          type: "provider_thread.updated",
          driver: COPILOT_PROVIDER,
          providerThread,
        });
        return providerThread;
      });

      const applySelection = Effect.fnUntraced(function* (
        session: BoundSession,
        selection: ModelSelection,
        interactionMode: ProviderAdapter.ProviderAdapterV2OpenSessionInput["runtimePolicy"]["interactionMode"],
      ) {
        const unsupported = unsupportedSelectionOption(selection);
        if (unsupported !== undefined) {
          return yield* protocolError(
            `Copilot SDK does not support the '${unsupported}' selection.`,
          );
        }
        if (options.identity !== undefined) {
          if (
            permitsFullAccess &&
            (getModelSelectionStringOptionValue(selection, "allow_all") !== "off") !==
              (getModelSelectionStringOptionValue(input.modelSelection, "allow_all") !== "off")
          ) {
            return yield* protocolError(
              "Start a new thread to change Copilot SDK approval settings.",
            );
          }
        }
        const choice = modelChoice(selection);
        const controls = copilotSessionControls(selection, interactionMode);
        const controlsChanged =
          controls.mode !== session.controls.mode || controls.agent !== session.controls.agent;
        if (controlsChanged) {
          yield* session.sdk.setControls(controls);
          session.controls = controls;
        }
        if (
          !controlsChanged &&
          choice.model === session.applied.model &&
          choice.reasoningEffort === session.applied.reasoningEffort
        ) {
          return;
        }
        yield* session.sdk.setModel(choice);
        session.applied = choice;
        yield* updateProviderSession(sessionEntity.status, sessionEntity.lastError, choice.model);
      });

      const promptPayload = Effect.fnUntraced(function* (
        message: ProviderAdapter.ProviderAdapterV2TurnMessage,
      ) {
        const prompt = yield* providerMessageTextWithAttachmentPaths({
          text: message.text,
          attachments: message.attachments,
          resolveAttachmentPath: host.resolveAttachmentPath,
          resolveExtractedTextPath: host.resolveExtractedTextPath,
        });
        const attachments: Array<CopilotSendAttachment> = message.attachments.flatMap(
          (attachment) => {
            const path = host.resolveAttachmentPath(attachment);
            return path !== null && isProviderNativeImageAttachment(attachment)
              ? [{ type: "file" as const, path, displayName: attachment.name }]
              : [];
          },
        );
        return { prompt, attachments };
      });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: COPILOT_PROVIDER,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return sessionEntity;
        },
        events: Stream.fromQueue(events),
        ensureThread: (threadInput) =>
          bindThread({
            threadId: threadInput.threadId,
            modelSelection: threadInput.modelSelection,
            ...(threadInput.existingProviderThread === undefined
              ? {}
              : { existing: threadInput.existingProviderThread }),
            ...(threadInput.forceNewNativeThread === true ? { forceNew: true } : {}),
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: COPILOT_PROVIDER,
                  threadId: threadInput.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: (threadInput) =>
          bindThread({
            threadId:
              threadInput.threadId ?? threadInput.providerThread.appThreadId ?? input.threadId,
            modelSelection: threadInput.modelSelection ?? input.modelSelection,
            existing: threadInput.providerThread,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver: COPILOT_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: threadInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        startTurn: Effect.fn("CopilotAdapter.startTurn")(
          function* (turnInput) {
            const session = bound;
            if (session === null) {
              return yield* protocolError("GitHub Copilot session has no bound thread");
            }
            if (session.activeTurn !== null) {
              return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                driver: COPILOT_PROVIDER,
                detail: `GitHub Copilot provider thread ${turnInput.providerThread.id} already has an active turn`,
                reason: "previous_turn_active",
              });
            }
            if (
              session.providerThread.nativeThreadRef?.nativeId !==
              turnInput.providerThread.nativeThreadRef?.nativeId
            ) {
              return yield* protocolError("GitHub Copilot turn requested for a different session");
            }
            yield* applySelection(
              session,
              turnInput.modelSelection,
              turnInput.runtimePolicy.interactionMode,
            );
            const payload = yield* promptPayload(turnInput.message);
            const startedAt = yield* DateTime.now;
            const syntheticNativeTurnId = `${session.providerThread.id}:attempt:${turnInput.attemptId}`;
            const providerTurn: OrchestrationV2ProviderTurn = {
              id: idAllocator.derive.providerTurn({
                driver: COPILOT_PROVIDER,
                nativeTurnId: syntheticNativeTurnId,
              }),
              providerThreadId: turnInput.providerThread.id,
              nodeId: turnInput.rootNodeId,
              runAttemptId: turnInput.attemptId,
              nativeTurnRef: providerRef(syntheticNativeTurnId, "weak"),
              ordinal: turnInput.providerTurnOrdinal,
              status: "running",
              startedAt,
              completedAt: null,
            };
            const turn: ActiveTurn = {
              turnInput,
              providerTurn,
              itemOrdinals: new Map(),
              nextItemOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
              streamItems: new Map(),
              tools: new Map(),
              reasoningOrdinal: 0,
              interrupted: false,
              aborted: false,
              sawPrompt: false,
              pendingSteers: 0,
              idleDeferred: false,
              failure: null,
              tokenUsage: undefined,
              sendSettled: yield* Deferred.make<void>(),
            };
            yield* permit.withPermits(1)(
              Effect.gen(function* () {
                session.providerThread = turnInput.providerThread;
                session.activeTurn = turn;
                yield* emit({
                  type: "provider_turn.updated",
                  driver: COPILOT_PROVIDER,
                  threadId: turnInput.threadId,
                  providerTurn,
                });
                yield* updateProviderThread(session, {
                  status: "active",
                  firstRunOrdinal: session.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
                  lastRunOrdinal: turnInput.runOrdinal,
                });
                yield* updateProviderSession("running", null);
              }),
            );
            yield* session.sdk
              .send({
                prompt: payload.prompt,
                ...(payload.attachments.length === 0 ? {} : { attachments: payload.attachments }),
              })
              .pipe(
                Effect.ensuring(Deferred.succeed(turn.sendSettled, undefined)),
                Effect.tapError(() =>
                  Effect.sync(() => {
                    if (session.activeTurn === turn) session.activeTurn = null;
                  }),
                ),
              );
          },
          (effect, turnInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: COPILOT_PROVIDER,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            ),
        ),
        steerTurn: Effect.fn("CopilotAdapter.steerTurn")(
          function* (steerInput) {
            const session = bound;
            const turn = session?.activeTurn ?? null;
            if (
              session === null ||
              turn === null ||
              turn.providerTurn.id !== steerInput.providerTurnId
            ) {
              return yield* protocolError(
                `GitHub Copilot turn ${steerInput.providerTurnId} is not active`,
              );
            }
            const payload = yield* promptPayload(steerInput.message);
            yield* Deferred.await(turn.sendSettled);
            yield* permit.withPermits(1)(
              Effect.suspend(() => {
                if (session.activeTurn !== turn) {
                  return Effect.fail(
                    protocolError(`GitHub Copilot turn ${steerInput.providerTurnId} is not active`),
                  );
                }
                turn.pendingSteers += 1;
                return Effect.void;
              }),
            );
            yield* session.sdk
              .send({
                prompt: payload.prompt,
                mode: "immediate",
                ...(payload.attachments.length === 0 ? {} : { attachments: payload.attachments }),
              })
              .pipe(
                Effect.tapError(() =>
                  permit.withPermits(1)(
                    Effect.gen(function* () {
                      if (session.activeTurn !== turn) return;
                      turn.pendingSteers = Math.max(0, turn.pendingSteers - 1);
                      if (turn.idleDeferred && turn.pendingSteers === 0)
                        yield* finalizeTurn(session);
                    }),
                  ),
                ),
              );
          },
          (effect, steerInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterSteerRunError({
                    driver: COPILOT_PROVIDER,
                    providerThreadId: steerInput.providerThread.id,
                    providerTurnId: steerInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
        ),
        interruptTurn: Effect.fn("CopilotAdapter.interruptTurn")(
          function* (interruptInput) {
            const session = bound;
            const turn = session?.activeTurn ?? null;
            if (session === null || turn === null) {
              if (interruptInput.requestRuntimeRestart === true) return;
              return yield* protocolError(
                `GitHub Copilot turn ${interruptInput.providerTurnId} is not active`,
              );
            }
            if (turn.providerTurn.id !== interruptInput.providerTurnId) {
              return yield* protocolError(
                `GitHub Copilot turn ${interruptInput.providerTurnId} is not active`,
              );
            }
            turn.interrupted = true;
            // An abort that overtakes the prompt can be ignored while the turn runs on.
            yield* Deferred.await(turn.sendSettled);
            if (session.activeTurn !== turn) return;
            yield* session.sdk.abort.pipe(
              Effect.tapError(() =>
                // A runtime that cannot take the abort will not report idle; settle the turn here.
                permit.withPermits(1)(
                  Effect.gen(function* () {
                    if (session.activeTurn !== turn) return;
                    yield* finalizeTurn(session);
                    yield* updateProviderSession("error", "GitHub Copilot stopped responding.");
                    yield* Queue.fail(
                      events,
                      new ProviderAdapter.ProviderAdapterEventStreamError({
                        driver: COPILOT_PROVIDER,
                        providerSessionId: input.providerSessionId,
                      }),
                    );
                  }),
                ),
              ),
            );
          },
          (effect, interruptInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterInterruptError({
                    driver: COPILOT_PROVIDER,
                    providerThreadId: interruptInput.providerThread.id,
                    providerTurnId: interruptInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
        ),
        respondToRuntimeRequest: Effect.fn("CopilotAdapter.respondToRuntimeRequest")(
          function* (requestInput) {
            const result = yield* permit.withPermits(1)(
              Effect.gen(function* () {
                const pending = pendingRequests.get(String(requestInput.requestId));
                if (pending === undefined) {
                  return yield* protocolError(
                    `No pending GitHub Copilot request ${requestInput.requestId}`,
                  );
                }
                const resolvedAt = yield* DateTime.now;
                if (pending.kind === "user_input") {
                  const raw = requestInput.answers?.[USER_INPUT_QUESTION_ID];
                  const answer = Array.isArray(raw)
                    ? raw.find((entry) => typeof entry === "string")
                    : raw;
                  const response =
                    typeof answer === "string"
                      ? { answer, wasFreeform: !pending.choices.includes(answer) }
                      : null;
                  yield* Deferred.succeed(pending.answer!, response);
                  yield* settleRequest(
                    pending,
                    response === null ? "cancelled" : "resolved",
                    resolvedAt,
                    requestInput.answers === undefined ? {} : { answers: requestInput.answers },
                  );
                  return null;
                }
                const permission = copilotPermissionResult(
                  pending.presentation!,
                  requestInput.decision,
                  requestInput.feedback,
                );
                yield* settleRequest(pending, "resolved", resolvedAt, {
                  ...(requestInput.decision === undefined
                    ? {}
                    : { decision: requestInput.decision }),
                  ...(requestInput.feedback === undefined
                    ? {}
                    : { feedback: requestInput.feedback }),
                });
                return {
                  sdk: pending.sdk,
                  response: { requestId: pending.nativeRequestId, result: permission },
                };
              }),
            );
            if (result !== null) yield* result.sdk.respondToPermission(result.response);
          },
          (effect, requestInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                    driver: COPILOT_PROVIDER,
                    requestId: requestInput.requestId,
                    cause,
                  }),
              ),
            ),
        ),
        // Capabilities report no snapshot, rollback, or fork support; these keep the contract total.
        readThreadSnapshot: (snapshotInput) =>
          Effect.succeed({
            providerThread: snapshotInput.providerThread,
            providerTurns: [],
            messages: [],
            runtimeRequests: [],
          }),
        rollbackThread: (rollbackInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver: COPILOT_PROVIDER,
              providerThreadId: rollbackInput.providerThread.id,
              checkpointId: rollbackInput.target.checkpointId,
            }),
          ),
        forkThread: (forkInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterForkThreadError({
              driver: COPILOT_PROVIDER,
              providerThreadId: forkInput.sourceProviderThread.id,
            }),
          ),
      };
      return runtime;
    }),
  });
});

export type CopilotAdapterV2DriverEnv =
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | Path.Path
  | ProviderHost.ProviderHost;

/** `runner` replaces the SDK boundary for replay fixtures and the fixture recorder. */
export function makeCopilotAdapterV2Driver(
  runner?: CopilotSdkRunner,
  identity?: CopilotAdapterIdentity,
): ProviderAdapterDriver<CopilotSettings, CopilotAdapterV2DriverEnv> {
  return {
    driverKind: identity?.driverKind ?? COPILOT_DRIVER_KIND,
    configSchema: CopilotSettings,
    defaultConfig: (): CopilotSettings => DEFAULT_COPILOT_SETTINGS,
    create: Effect.fn("CopilotAdapterV2Driver.create")(
      function* (input: ProviderAdapterDriverCreateInput<CopilotSettings>) {
        const hostEnvironment = yield* HostProcess.Environment;
        return yield* makeCopilotAdapterV2({
          ...(identity === undefined ? {} : { identity }),
          instanceId: input.instanceId,
          settings: { ...input.config, enabled: input.enabled },
          environment: yield* mergeProviderInstanceEnvironment(
            input.environment,
            copilotRuntimeEnvironment(hostEnvironment),
          ),
          runner: runner ?? (yield* makeCopilotSdkRunner()),
        });
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterDriverCreateError({
                driver: identity?.driverKind ?? COPILOT_DRIVER_KIND,
                instanceId: input.instanceId,
                detail: "Failed to create GitHub Copilot adapter.",
                cause,
              }),
          ),
        ),
    ),
  };
}

export const CopilotAdapterV2Driver = makeCopilotAdapterV2Driver();
