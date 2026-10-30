import { TextGenerationError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";

import { CopilotSettings } from "../settings.ts";
import { CopilotAdapterV2Driver, type CopilotAdapterV2DriverEnv } from "./adapter.ts";
import { copilotRuntimeEnvironment } from "./environment.ts";
import { COPILOT_DRIVER_KIND, probeCopilotRuntime, resolveCopilotBinary } from "./sdk.ts";
import { buildInitialCopilotProviderSnapshot, checkCopilotProviderStatus } from "./status.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);
// No installer-ownership resolver covers Copilot's install channels yet, so updates stay manual.
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: COPILOT_DRIVER_KIND,
  packageName: null,
});

// See `supportsTextGeneration` in status.ts.
const unsupportedTextGeneration: ProviderTextGeneration = (() => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "GitHub Copilot does not provide application text generation in T3 Code yet.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
  };
})();

export type CopilotDriverEnv = CopilotAdapterV2DriverEnv;

export const CopilotDriver: ProviderDriver<CopilotSettings, CopilotDriverEnv> = {
  driverKind: COPILOT_DRIVER_KIND,
  metadata: {
    displayName: "GitHub Copilot",
    supportsMultipleInstances: true,
  },
  configSchema: CopilotSettings,
  defaultConfig: (): CopilotSettings => decodeCopilotSettings({}),
  create: Effect.fn("CopilotDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const host = yield* ProviderHost.ProviderHost;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processEnv = yield* mergeProviderInstanceEnvironment(
      environment,
      copilotRuntimeEnvironment(yield* HostProcess.Environment),
    );
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: COPILOT_DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: COPILOT_DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies CopilotSettings;
    const binaryPath = effectiveConfig.binaryPath || "copilot";
    const checkProvider = checkCopilotProviderStatus(
      effectiveConfig,
      resolveCopilotBinary(binaryPath, processEnv).pipe(
        Effect.option,
        Effect.map(Option.getOrNull),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
      (command) => probeCopilotRuntime({ command, environment: processEnv, cwd: host.paths.cwd }),
    ).pipe(Effect.map(stampIdentity));

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CopilotSettings>>({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialCopilotProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: COPILOT_DRIVER_KIND,
            instanceId,
            detail: "Failed to build the GitHub Copilot provider snapshot.",
            cause,
          }),
      ),
    );

    const orchestrationAdapter = yield* CopilotAdapterV2Driver.create({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: COPILOT_DRIVER_KIND,
            instanceId,
            detail: "Failed to build the GitHub Copilot orchestration adapter.",
            cause,
          }),
      ),
    );

    return {
      instanceId,
      driverKind: COPILOT_DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      orchestrationAdapter,
      textGeneration: unsupportedTextGeneration,
    } satisfies ProviderInstance;
  }),
};
