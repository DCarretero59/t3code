import type { ModelInfo } from "@github/copilot-sdk";
import type {
  ModelCapabilities,
  ServerProviderAuth,
  ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
  buildServerProvider,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import type { CopilotSettings } from "../settings.ts";
import { COPILOT_DRIVER_KIND, type CopilotRuntimeProbe, type CopilotSdkError } from "./sdk.ts";

/** Copilot's own routing model; a real model id, so "Default" never needs a sentinel. */
export const COPILOT_DEFAULT_MODEL = "auto";
export const COPILOT_REASONING_EFFORT_OPTION = "reasoningEffort";
const COPILOT_SUPPORTED_RUNTIME_MODES = ["approval-required", "full-access"] as const;
const SIGN_IN_HINT =
  "Run `copilot login`, or add COPILOT_GITHUB_TOKEN to this provider's environment variables.";
const PROBE_TIMEOUT = Duration.seconds(30);

const COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  showInteractionModeToggle: false,
  supportedRuntimeModes: COPILOT_SUPPORTED_RUNTIME_MODES,
} as const;

const REASONING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

function copilotModelCapabilities(
  model: Pick<ModelInfo, "supportedReasoningEfforts" | "defaultReasoningEffort">,
): ModelCapabilities {
  // The SDK's ReasoningEffort type omits "none", which models still report.
  const efforts: ReadonlyArray<string> = model.supportedReasoningEfforts ?? [];
  if (efforts.length === 0) return EMPTY_CAPABILITIES;
  const defaultEffort = efforts.includes(model.defaultReasoningEffort ?? "")
    ? model.defaultReasoningEffort
    : undefined;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: COPILOT_REASONING_EFFORT_OPTION,
        label: "Reasoning",
        type: "select",
        ...(defaultEffort === undefined ? {} : { currentValue: defaultEffort }),
        options: efforts.map((effort) => ({
          id: effort,
          label: REASONING_EFFORT_LABELS[effort] ?? effort,
          ...(effort === defaultEffort ? { isDefault: true } : {}),
        })),
      },
    ],
  });
}

const AUTO_MODEL: ServerProviderModel = {
  slug: COPILOT_DEFAULT_MODEL,
  name: "Auto",
  isCustom: false,
  isDefault: true,
  capabilities: EMPTY_CAPABILITIES,
};

function copilotModels(
  settings: CopilotSettings,
  listed: ReadonlyArray<ModelInfo> | null,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>([COPILOT_DEFAULT_MODEL]);
  const models = (listed ?? []).flatMap((model): ServerProviderModel[] => {
    if (seen.has(model.id) || model.policy?.state === "disabled") return [];
    seen.add(model.id);
    return [
      {
        slug: model.id,
        name: model.name.trim() || model.id,
        isCustom: false,
        capabilities: copilotModelCapabilities(model),
      },
    ];
  });
  return providerModelsFromSettings([AUTO_MODEL, ...models], settings.customModels, null);
}

function copilotAuth(probe: CopilotRuntimeProbe["auth"]): ServerProviderAuth {
  if (!probe.isAuthenticated) return { status: "unauthenticated" };
  const label = probe.login?.trim();
  return {
    status: "authenticated",
    ...(probe.authType === undefined ? {} : { type: probe.authType }),
    ...(label ? { label } : {}),
  };
}

const snapshot = (
  settings: CopilotSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  listed: ReadonlyArray<ModelInfo> | null,
): ServerProviderDraft => ({
  ...buildServerProvider({
    driver: COPILOT_DRIVER_KIND,
    presentation: COPILOT_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: copilotModels(settings, listed),
    probe,
  }),
  supportsTextGeneration: false,
});

export const buildInitialCopilotProviderSnapshot = (
  settings: CopilotSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    snapshot(
      settings,
      DateTime.formatIso(now),
      {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking GitHub Copilot CLI availability..."
          : "GitHub Copilot is disabled in T3 Code settings.",
      },
      null,
    ),
  );

/** Maps a finished probe; `null` means the runtime could not start or answer. */
export function copilotProbeSnapshot(input: {
  readonly settings: CopilotSettings;
  readonly checkedAt: string;
  readonly installed: boolean;
  readonly probe: CopilotRuntimeProbe | null;
}): ServerProviderDraft {
  const { settings, checkedAt, probe } = input;
  if (!settings.enabled) {
    return snapshot(
      settings,
      checkedAt,
      {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in T3 Code settings.",
      },
      null,
    );
  }
  if (!input.installed) {
    return snapshot(
      settings,
      checkedAt,
      {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "The GitHub Copilot CLI (`copilot`) is not installed or not on PATH.",
      },
      null,
    );
  }
  if (probe === null) {
    return snapshot(
      settings,
      checkedAt,
      {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "The GitHub Copilot CLI is installed but its SDK server failed to start.",
      },
      null,
    );
  }
  const auth = copilotAuth(probe.auth);
  const result: Omit<ProviderProbeResult, "installed" | "version" | "auth"> =
    auth.status === "unauthenticated"
      ? { status: "error", message: `Not signed in to GitHub Copilot. ${SIGN_IN_HINT}` }
      : probe.models === null
        ? {
            status: "warning",
            message: "GitHub Copilot is signed in but its model list could not be read.",
          }
        : { status: "ready" };
  return snapshot(
    settings,
    checkedAt,
    { installed: true, version: probe.version, auth, ...result },
    probe.models,
  );
}

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  settings: CopilotSettings,
  resolveCommand: Effect.Effect<string | null>,
  probe: (command: string) => Effect.Effect<CopilotRuntimeProbe, CopilotSdkError>,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return copilotProbeSnapshot({ settings, checkedAt, installed: false, probe: null });
  }
  const command = yield* resolveCommand;
  if (command === null) {
    return copilotProbeSnapshot({ settings, checkedAt, installed: false, probe: null });
  }
  const outcome = yield* probe(command).pipe(Effect.timeoutOption(PROBE_TIMEOUT), Effect.result);
  return copilotProbeSnapshot({
    settings,
    checkedAt,
    installed: true,
    probe: Result.isSuccess(outcome) ? Option.getOrNull(outcome.success) : null,
  });
});
