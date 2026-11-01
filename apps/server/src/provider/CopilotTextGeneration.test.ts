import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import { makeCopilotDriver } from "@t3tools/provider-copilot/server";
import type {
  CopilotSdkOpenSessionInput,
  CopilotSdkRunner,
} from "@t3tools/provider-copilot/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const testLayer = Layer.mergeAll(
  TestProviderHost.layer({ runBackgroundWork: false }).pipe(Layer.provide(NodeServices.layer)),
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
);

it.effect.each([
  ['{"title":"Fix tunnel authentication","needsRefinement":false}', true],
  ["not json", false],
  ["", false],
] as const)("generates titles with an isolated, tool-free Copilot session: %s", ([reply, valid]) =>
  Effect.gen(function* () {
    let opened: CopilotSdkOpenSessionInput | undefined;
    let disconnected = false;
    const runner: CopilotSdkRunner = {
      connect: () =>
        Effect.succeed({
          openSession: (input) =>
            Effect.sync(() => {
              opened = input;
              return {
                sessionId: "title-session",
                send: () =>
                  Effect.sync(() => {
                    const base = { timestamp: "2026-01-01T00:00:00.000Z", parentId: null };
                    input.onEvent({
                      ...base,
                      id: "message",
                      type: "assistant.message",
                      data: { messageId: "title", content: reply },
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
                setControls: () => Effect.void,
                getControls: Effect.succeed({
                  mode: "interactive",
                  agent: null,
                  agents: [{ name: "reviewer", displayName: "Reviewer" }],
                }),
                respondToPermission: () => Effect.void,
                disconnect: Effect.sync(() => {
                  disconnected = true;
                }),
              };
            }),
        }),
    };
    const driver = makeCopilotDriver(undefined, runner);
    const instanceId = ProviderInstanceId.make("copilot");
    const instance = yield* driver.create({
      instanceId,
      enabled: true,
      displayName: undefined,
      environment: [],
      config: driver.defaultConfig(),
    });
    const result = yield* instance.textGeneration
      .generateThreadTitle({
        cwd: ".",
        message: "Fix authentication when connecting through the dev tunnel",
        modelSelection: { instanceId, model: "gpt-6-luna" },
      })
      .pipe(Effect.result);
    if (valid) {
      expect(result).toMatchObject({
        _tag: "Success",
        success: { title: "Fix tunnel authentication" },
      });
    } else {
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "TextGenerationError" } });
    }
    expect(opened?.options).toMatchObject({
      availableTools: [],
      approveAll: false,
      denyPermissions: true,
      enableConfigDiscovery: false,
      mcpServers: {},
    });
    expect(disconnected).toBe(true);
    expect((yield* instance.snapshot.getSnapshot).supportsTextGeneration).toBe(true);
    if (valid) {
      if (!instance.snapshotForCwd) return yield* Effect.die("Missing workspace discovery");
      const workspace = yield* instance.snapshotForCwd(".");
      expect(workspace.optionDescriptors?.find((option) => option.id === "agent")).toMatchObject({
        options: [{ id: "_t3/empty" }, { id: "reviewer" }],
      });
      for (const model of (yield* instance.snapshot.getSnapshot).models) {
        const options = model.capabilities?.optionDescriptors ?? [];
        expect(options.filter((option) => option.id === "mode")).toHaveLength(1);
        expect(options.find((option) => option.id === "agent")).toMatchObject({
          options: [{ id: "_t3/empty" }, { id: "reviewer" }],
        });
      }
    }
  }).pipe(Effect.provide(testLayer)),
);
