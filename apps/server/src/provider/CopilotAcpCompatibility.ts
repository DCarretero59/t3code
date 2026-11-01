import { AcpRegistryDriver } from "@t3tools/provider-acp-registry/server";
import { makeCopilotDriver } from "@t3tools/provider-copilot/server";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export const COPILOT_SDK_SESSION_PREFIX = "copilot-sdk:";

const sdkDriver = makeCopilotDriver({
  driverKind: AcpRegistryDriver.driverKind,
  nativeThreadIdPrefix: COPILOT_SDK_SESSION_PREFIX,
});

export function withCopilotSdkRouting(
  acp: ProviderAdapter.ProviderAdapterV2["Service"],
  sdk: ProviderAdapter.ProviderAdapterV2["Service"] | undefined,
): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    ...(sdk ?? acp),
    openSession: Effect.fn("CopilotAcpCompatibility.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const sdkSession = input.initialNativeThreadId?.startsWith(COPILOT_SDK_SESSION_PREFIX);
      if (sdkSession && sdk === undefined) {
        return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
          driver: acp.driver,
          providerSessionId: input.providerSessionId,
          cause: new Error("Restart with T3CODE_COPILOT_SDK_COMPAT=1 to resume this SDK session."),
        });
      }
      const adapter =
        sdk !== undefined && (input.initialNativeThreadId === undefined || sdkSession) ? sdk : acp;
      return yield* adapter.openSession(input);
    }),
  };
}

export const CopilotAcpCompatibilityDriver = {
  ...AcpRegistryDriver,
  create: Effect.fn("CopilotAcpCompatibilityDriver.create")(function* (
    input: Parameters<typeof AcpRegistryDriver.create>[0],
  ) {
    const acp = yield* AcpRegistryDriver.create(input);
    if (input.config.source !== "registry" || input.config.agentId !== "github-copilot-cli") {
      return acp;
    }
    const enabled = yield* Config.Boolean("T3CODE_COPILOT_SDK_COMPAT").pipe(
      Config.withDefault(false),
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: AcpRegistryDriver.driverKind,
            instanceId: input.instanceId,
            detail: "T3CODE_COPILOT_SDK_COMPAT must be a boolean.",
            cause,
          }),
      ),
    );
    if (enabled && input.config.commandArgs.length > 0) {
      return yield* new ProviderDriverError({
        driver: AcpRegistryDriver.driverKind,
        instanceId: input.instanceId,
        detail: "Remove the ACP command arguments or disable T3CODE_COPILOT_SDK_COMPAT.",
      });
    }
    const sdk = enabled
      ? yield* sdkDriver.create({
          ...input,
          config: {
            ...sdkDriver.defaultConfig(),
            enabled: input.enabled,
            binaryPath: input.config.commandPath || "copilot",
            customModels: input.config.customModels,
          },
        })
      : undefined;
    if (enabled) {
      yield* Effect.logInfo("Copilot SDK compatibility routing enabled", {
        instanceId: input.instanceId,
      });
    }
    return {
      ...(sdk ?? acp),
      ...(acp.auth === undefined ? {} : { auth: acp.auth }),
      ...(acp.acpSessionManagement === undefined
        ? {}
        : { acpSessionManagement: acp.acpSessionManagement }),
      orchestrationAdapter: withCopilotSdkRouting(
        acp.orchestrationAdapter,
        sdk?.orchestrationAdapter,
      ),
    } satisfies ProviderInstance;
  }),
};
