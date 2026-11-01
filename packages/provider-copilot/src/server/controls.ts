import type {
  ModelSelection,
  ProviderInteractionMode,
  ProviderOptionDescriptor,
  ServerProvider,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import type { CopilotSessionControls, CopilotSessionMode } from "./sdk.ts";

const ACP_MODE_PREFIX = "https://agentclientprotocol.com/protocol/session-modes#";
const MODES = [
  { id: `${ACP_MODE_PREFIX}agent`, label: "Agent" },
  { id: `${ACP_MODE_PREFIX}plan`, label: "Plan" },
  { id: `${ACP_MODE_PREFIX}autopilot`, label: "Autopilot" },
] as const;

export function copilotSessionMode(value: string): CopilotSessionMode | undefined {
  switch (value.startsWith(ACP_MODE_PREFIX) ? value.slice(ACP_MODE_PREFIX.length) : value) {
    case "agent":
    case "interactive":
      return "interactive";
    case "plan":
      return "plan";
    case "autopilot":
      return "autopilot";
    default:
      return undefined;
  }
}

export function copilotSessionControls(
  selection: ModelSelection,
  interactionMode: ProviderInteractionMode,
): CopilotSessionControls {
  const mode = getModelSelectionStringOptionValue(selection, "mode");
  const agent = getModelSelectionStringOptionValue(selection, "agent");
  return {
    mode:
      interactionMode === "plan"
        ? "plan"
        : mode === undefined
          ? "interactive"
          : (copilotSessionMode(mode) ?? "interactive"),
    agent: agent === undefined || agent === "" || agent === "_t3/empty" ? null : agent,
  };
}

export function copilotControlDescriptors(
  agents: ReadonlyArray<{ readonly name: string; readonly displayName: string }>,
): ReadonlyArray<ProviderOptionDescriptor> {
  return [
    { id: "mode", label: "Mode", type: "select", currentValue: MODES[0].id, options: [...MODES] },
    ...(agents.length === 0
      ? []
      : [
          {
            id: "agent",
            label: "Agent",
            type: "select" as const,
            currentValue: "_t3/empty",
            options: [
              { id: "_t3/empty", label: "Copilot" },
              ...agents.map((agent) => ({
                id: agent.name,
                label: agent.displayName || agent.name,
              })),
            ],
          },
        ]),
  ];
}

export function withCopilotControls(
  provider: ServerProvider,
  controls: ReadonlyArray<ProviderOptionDescriptor>,
): ServerProvider {
  return {
    ...provider,
    models: provider.models.map((model) => ({
      ...model,
      capabilities: {
        ...model.capabilities,
        optionDescriptors: [
          ...controls,
          ...(model.capabilities?.optionDescriptors ?? []).filter(
            (descriptor) => descriptor.id !== "mode" && descriptor.id !== "agent",
          ),
        ],
      },
    })),
  };
}
