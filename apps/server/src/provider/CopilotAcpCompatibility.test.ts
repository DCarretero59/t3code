import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import {
  makeCopilotAdapterV2Driver,
  type CopilotSdkRunner,
  type CopilotSdkOpenSessionInput,
} from "@t3tools/provider-copilot/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { makeTurnInput } from "../orchestration-v2/Adapters/AcpAdapterV2.testkit.ts";
import { COPILOT_SDK_SESSION_PREFIX, withCopilotSdkRouting } from "./CopilotAcpCompatibility.ts";

const driver = ProviderDriverKind.make("acpRegistry");
const instanceId = ProviderInstanceId.make("acpRegistry_copilot");
const threadId = ThreadId.make("compatibility-test");
const modelSelection = {
  instanceId,
  model: "gpt-6-luna",
  options: [
    { id: "reasoning_effort", value: "low" },
    { id: "allow_all", value: "off" },
  ],
};
const openInput: ProviderAdapter.ProviderAdapterV2OpenSessionInput = {
  threadId,
  providerSessionId: ProviderSessionId.make("compatibility-session"),
  modelSelection,
  runtimePolicy: { runtimeMode: "approval-required", interactionMode: "default", cwd: null },
};

function routingProbe(detail: string): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.die("Not used"),
    planSelectionTransition: () => Effect.die("Not used"),
    openSession: () =>
      Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail })),
  };
}

it.effect.each([
  [false, undefined, "ACP"],
  [true, undefined, "SDK"],
  [true, "existing-acp-session", "ACP"],
  [false, "existing-acp-session", "ACP"],
  [true, `${COPILOT_SDK_SESSION_PREFIX}existing-sdk-session`, "SDK"],
] as const)("routes the saved session %j", ([enabled, nativeId, expected]) =>
  Effect.gen(function* () {
    const adapter = withCopilotSdkRouting(
      routingProbe("ACP"),
      enabled ? routingProbe("SDK") : undefined,
    );
    const error = yield* adapter
      .openSession({
        ...openInput,
        ...(nativeId === undefined ? {} : { initialNativeThreadId: nativeId }),
      })
      .pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "ProviderAdapterProtocolError", detail: expected });
  }),
);

it.effect("does not hand an SDK session to ACP when compatibility is disabled", () =>
  Effect.gen(function* () {
    const adapter = withCopilotSdkRouting(routingProbe("ACP"), undefined);
    const error = yield* adapter
      .openSession({
        ...openInput,
        initialNativeThreadId: `${COPILOT_SDK_SESSION_PREFIX}saved`,
      })
      .pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "ProviderAdapterOpenSessionError", driver });
  }),
);

const testLayer = Layer.mergeAll(
  TestProviderHost.layer({ runBackgroundWork: false }).pipe(Layer.provide(NodeServices.layer)),
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
);

it.effect("streams under the ACP identity and resumes the unprefixed SDK session", () =>
  Effect.gen(function* () {
    const opened: Array<CopilotSdkOpenSessionInput> = [];
    const controls: Array<{ readonly mode: string; readonly agent: string | null }> = [];
    const runner: CopilotSdkRunner = {
      connect: () =>
        Effect.succeed({
          openSession: (input) =>
            Effect.sync(() => {
              opened.push(input);
              return {
                sessionId: input.sessionId ?? "native-sdk-session",
                send: () =>
                  Effect.sync(() => {
                    const base = { timestamp: "2026-01-01T00:00:00.000Z", parentId: null };
                    input.onEvent({
                      ...base,
                      id: "start",
                      type: "assistant.turn_start",
                      data: { turnId: "1" },
                    });
                    input.onEvent({
                      ...base,
                      id: "delta",
                      type: "assistant.message_delta",
                      ephemeral: true,
                      data: { messageId: "reply", deltaContent: "SDK reply" },
                    });
                    input.onEvent({
                      ...base,
                      id: "message",
                      type: "assistant.message",
                      data: { messageId: "reply", content: "SDK reply" },
                    });
                    input.onEvent({
                      ...base,
                      id: "idle",
                      type: "session.idle",
                      ephemeral: true,
                      data: {},
                    });
                  }),
                abort: Effect.void,
                setModel: () => Effect.void,
                getControls: Effect.die("Not used"),
                setControls: (selection) =>
                  Effect.sync(() => {
                    controls.push(selection);
                  }),
                respondToPermission: () => Effect.void,
                disconnect: Effect.void,
              };
            }),
        }),
    };
    const sdkDriver = makeCopilotAdapterV2Driver(runner, {
      driverKind: driver,
      nativeThreadIdPrefix: COPILOT_SDK_SESSION_PREFIX,
    });
    const adapter = yield* sdkDriver.create({
      instanceId,
      enabled: true,
      displayName: "Copilot",
      environment: [],
      config: sdkDriver.defaultConfig(),
    });
    const nativeDriver = makeCopilotAdapterV2Driver(runner);
    const nativeAdapter = yield* nativeDriver.create({
      instanceId: ProviderInstanceId.make("copilot"),
      enabled: true,
      displayName: "Copilot",
      environment: [],
      config: nativeDriver.defaultConfig(),
    });
    for (const option of [
      { id: "mode", value: "unknown-mode" },
      { id: "reasoning_effort", value: "invalid" },
    ] as const) {
      const error = yield* adapter
        .openSession({
          ...openInput,
          modelSelection: { ...modelSelection, options: [option] },
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "ProviderAdapterOpenSessionError", driver });
      expect(
        yield* nativeAdapter
          .openSession({
            ...openInput,
            modelSelection: { ...modelSelection, options: [option] },
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "ProviderAdapterOpenSessionError" });
    }
    expect(opened).toHaveLength(0);
    const runtime = yield* adapter.openSession(openInput);
    const terminal = yield* Deferred.make<ProviderAdapter.ProviderAdapterV2Event>();
    const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    yield* runtime.events.pipe(
      Stream.runForEach((event) => {
        events.push(event);
        return event.type === "turn.terminal" ? Deferred.succeed(terminal, event) : Effect.void;
      }),
      Effect.forkChild,
    );
    const providerThread = yield* runtime.ensureThread(openInput);
    expect(providerThread.nativeThreadRef).toEqual({
      driver,
      nativeId: `${COPILOT_SDK_SESSION_PREFIX}native-sdk-session`,
      strength: "strong",
    });
    expect(opened[0]?.options).toMatchObject({
      model: "gpt-6-luna",
      reasoningEffort: "low",
      approveAll: false,
    });
    const turn = makeTurnInput({
      threadId,
      providerThread,
      instanceId,
      runtimePolicy: openInput.runtimePolicy,
      modelSelection: {
        ...modelSelection,
        options: [{ id: "reasoningEffort", value: "low" }],
      },
      now: yield* DateTime.now,
    });
    yield* runtime.startTurn(turn);
    expect(yield* Deferred.await(terminal)).toMatchObject({
      type: "turn.terminal",
      driver,
      status: "completed",
    });
    expect(events.every((event) => event.driver === driver)).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message.updated",
        message: expect.objectContaining({ text: "SDK reply" }),
      }),
    );
    const nativeId = providerThread.nativeThreadRef?.nativeId;
    if (nativeId == null) return yield* Effect.die("Missing native session reference");
    const resumed = yield* adapter.openSession({ ...openInput, initialNativeThreadId: nativeId });
    const restored = yield* resumed.resumeThread({ providerThread });
    expect(restored.id).toBe(providerThread.id);
    expect(opened[1]).toMatchObject({ operation: "resume", sessionId: "native-sdk-session" });
    const restrictedInput = {
      ...openInput,
      runtimePolicy: { ...openInput.runtimePolicy, runtimeMode: "full-access" as const },
      modelSelection: { ...modelSelection, options: [{ id: "allow_all", value: "off" }] },
    };
    const restricted = yield* adapter.openSession(restrictedInput);
    yield* restricted.ensureThread(restrictedInput);
    expect(opened[2]?.options.approveAll).toBe(false);
    for (const [mode, agent] of [
      ["plan", "reviewer"],
      ["autopilot", "reviewer"],
      ["agent", "_t3/empty"],
    ] as const) {
      const selectedInput = {
        ...openInput,
        modelSelection: {
          ...modelSelection,
          options: [
            { id: "mode", value: `https://agentclientprotocol.com/protocol/session-modes#${mode}` },
            { id: "agent", value: agent },
          ],
        },
      };
      const selected = yield* adapter.openSession(selectedInput);
      yield* selected.ensureThread(selectedInput);
      expect(controls.at(-1)).toEqual({
        mode: mode === "agent" ? "interactive" : mode,
        agent: agent === "_t3/empty" ? null : agent,
      });
    }
    const planInput = {
      ...openInput,
      runtimePolicy: { ...openInput.runtimePolicy, interactionMode: "plan" as const },
    };
    const plan = yield* adapter.openSession(planInput);
    yield* plan.ensureThread(planInput);
    expect(controls.at(-1)).toEqual({ mode: "plan", agent: null });
  }).pipe(Effect.provide(testLayer)),
);
