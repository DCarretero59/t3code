import * as Cache from "effect/Cache";
import * as Equal from "effect/Equal";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
  type ProviderWorkspaceSnapshot,
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

import { CopilotSettings } from "../settings.ts";
import {
  makeCopilotAdapterV2Driver,
  type CopilotAdapterIdentity,
  type CopilotAdapterV2DriverEnv,
} from "./adapter.ts";
import { copilotRuntimeEnvironment } from "./environment.ts";
import {
  COPILOT_DRIVER_KIND,
  makeCopilotSdkRunner,
  probeCopilotRuntime,
  resolveCopilotBinary,
  type CopilotSdkRunner,
} from "./sdk.ts";
import { buildInitialCopilotProviderSnapshot, checkCopilotProviderStatus } from "./status.ts";
import { copilotControlDescriptors, withCopilotControls } from "./controls.ts";
import { makeCopilotTextGeneration } from "./textGeneration.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);
// No installer-ownership resolver covers Copilot's install channels yet, so updates stay manual.
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: COPILOT_DRIVER_KIND,
  packageName: null,
});

export type CopilotDriverEnv = CopilotAdapterV2DriverEnv;

export const makeCopilotDriver = (
  identity?: CopilotAdapterIdentity,
  sdkRunner?: CopilotSdkRunner,
): ProviderDriver<CopilotSettings, CopilotDriverEnv> => ({
  driverKind: identity?.driverKind ?? COPILOT_DRIVER_KIND,
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
      driverKind: identity?.driverKind ?? COPILOT_DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: identity?.driverKind ?? COPILOT_DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies CopilotSettings;
    const binaryPath = effectiveConfig.binaryPath || "copilot";
    const runner = sdkRunner ?? (yield* makeCopilotSdkRunner());
    const activeControls = yield* Ref.make({
      controls: copilotControlDescriptors([]),
      workspace: false,
    });
    const controlChanges = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);
    const updateControls = Effect.fn("CopilotDriver.updateControls")(function* (
      controls: ReturnType<typeof copilotControlDescriptors>,
      workspace = false,
    ) {
      const changed = yield* Ref.modify(activeControls, (current) => {
        if (!workspace && current.workspace) return [false, current];
        return [
          !Equal.equals(current.controls, controls),
          { controls, workspace: workspace || current.workspace },
        ];
      });
      if (changed) yield* PubSub.publish(controlChanges, undefined);
    });
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

    const workspaceControls = yield* Cache.make({
      capacity: 16,
      timeToLive: "30 seconds",
      lookup: Effect.fn("CopilotDriver.discoverWorkspaceControls")(function* (cwd: string) {
        const connection = yield* runner.connect({ binaryPath, environment: processEnv, cwd });
        const session = yield* connection.openSession({
          operation: "create",
          options: {
            workingDirectory: cwd,
            mcpServers: {},
            availableTools: [],
            approveAll: false,
            denyPermissions: true,
          },
          onEvent: () => {},
          onUserInputRequest: () => Promise.reject(new Error("Discovery cannot ask questions.")),
        });
        yield* Effect.addFinalizer(() => session.disconnect);
        return copilotControlDescriptors((yield* session.getControls).agents);
      }, Effect.scoped),
    });
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CopilotSettings>>({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialCopilotProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider,
      enrichSnapshot: ({ snapshot: provider }) =>
        provider.status === "ready"
          ? Cache.get(workspaceControls, host.paths.cwd).pipe(
              Effect.flatMap((controls) => updateControls(controls)),
              Effect.catchTags({
                CopilotSdkError: (cause) =>
                  Effect.logWarning("Copilot workspace agent discovery failed", {
                    instanceId,
                    cause,
                  }),
              }),
            )
          : Effect.void,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: identity?.driverKind ?? COPILOT_DRIVER_KIND,
            instanceId,
            detail: "Failed to build the GitHub Copilot provider snapshot.",
            cause,
          }),
      ),
    );
    const getSnapshot = Effect.all([snapshot.getSnapshot, Ref.get(activeControls)]).pipe(
      Effect.map(([provider, { controls }]) => withCopilotControls(provider, controls)),
    );
    const snapshotForCwd = Effect.fn("CopilotDriver.snapshotForCwd")(function* (cwd: string) {
      const provider = yield* snapshot.getSnapshot;
      if (!enabled || provider.auth.status === "unauthenticated" || provider.status === "error") {
        return provider;
      }
      const controls = yield* Cache.get(workspaceControls, cwd).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: identity?.driverKind ?? COPILOT_DRIVER_KIND,
              instanceId,
              detail: "Failed to discover Copilot modes and agents.",
              cause,
            }),
        ),
      );
      yield* updateControls(controls, true);
      return {
        ...withCopilotControls(provider, controls),
        optionDescriptors: controls,
      } satisfies ProviderWorkspaceSnapshot;
    });
    const orchestrationAdapter = yield* makeCopilotAdapterV2Driver(runner, identity)
      .create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: identity?.driverKind ?? COPILOT_DRIVER_KIND,
              instanceId,
              detail: "Failed to build the GitHub Copilot orchestration adapter.",
              cause,
            }),
        ),
      );

    return {
      instanceId,
      driverKind: identity?.driverKind ?? COPILOT_DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot: {
        ...snapshot,
        getSnapshot,
        refresh: snapshot.refresh.pipe(
          Effect.flatMap((provider) =>
            Ref.get(activeControls).pipe(
              Effect.map(({ controls }) => withCopilotControls(provider, controls)),
            ),
          ),
        ),
        streamChanges: Stream.merge(
          snapshot.streamChanges.pipe(
            Stream.mapEffect((provider) =>
              Ref.get(activeControls).pipe(
                Effect.map(({ controls }) => withCopilotControls(provider, controls)),
              ),
            ),
          ),
          Stream.fromPubSub(controlChanges).pipe(Stream.mapEffect(() => getSnapshot)),
        ),
      },
      snapshotForCwd,
      invalidateCaches: Cache.invalidateAll(workspaceControls),
      orchestrationAdapter,
      textGeneration: makeCopilotTextGeneration(runner, binaryPath, processEnv),
    } satisfies ProviderInstance;
  }),
});

export const CopilotDriver = makeCopilotDriver();
