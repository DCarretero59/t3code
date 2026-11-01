import type { PermissionRequest, PermissionRequestResult } from "@github/copilot-sdk";
import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderRequestKind,
} from "@t3tools/contracts";

/** The prompt-facing request Copilot derives for a permission, when the runtime sends one. */
export type CopilotPromptRequest = Readonly<Record<string, unknown>> & { readonly kind: string };

type SessionApproval = Extract<
  PermissionRequestResult,
  { kind: "approve-for-session" }
>["approval"];

export interface CopilotApprovalPresentation {
  readonly requestKind: ProviderRequestKind;
  readonly title: string;
  readonly prompt: string;
  readonly reason?: string;
  readonly options: ReadonlyArray<ProviderApprovalOption>;
  /** Present only when Copilot can remember this approval for the rest of the session. */
  readonly sessionApproval?: SessionApproval;
}

function stringField(record: Readonly<Record<string, unknown>> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArrayField(record: Readonly<Record<string, unknown>> | undefined, key: string) {
  const value = record?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function commandIdentifiers(
  request: Readonly<Record<string, unknown>>,
  prompt: CopilotPromptRequest | undefined,
): ReadonlyArray<string> {
  const fromPrompt = stringArrayField(prompt, "commandIdentifiers");
  if (fromPrompt.length > 0) return fromPrompt;
  const commands = request["commands"];
  return Array.isArray(commands)
    ? commands.flatMap((command) =>
        typeof command === "object" && command !== null && "identifier" in command
          ? typeof command.identifier === "string"
            ? [command.identifier]
            : []
          : [],
      )
    : [];
}

function sessionApprovalFor(
  request: Readonly<Record<string, unknown>> & { readonly kind: string },
  prompt: CopilotPromptRequest | undefined,
): SessionApproval | undefined {
  const source = prompt ?? request;
  const canOffer = source["canOfferSessionApproval"] === true;
  switch (request.kind) {
    case "shell": {
      const identifiers = commandIdentifiers(request, prompt);
      return canOffer && identifiers.length > 0
        ? { kind: "commands", commandIdentifiers: [...identifiers] }
        : undefined;
    }
    case "write":
      return canOffer ? { kind: "write" } : undefined;
    case "read":
      return { kind: "read" };
    case "mcp": {
      const serverName = stringField(request, "serverName");
      const toolName = stringField(request, "toolName");
      return serverName === undefined
        ? undefined
        : { kind: "mcp", serverName, toolName: toolName ?? null };
    }
    case "custom-tool": {
      const toolName = stringField(request, "toolName");
      return toolName === undefined ? undefined : { kind: "custom-tool", toolName };
    }
    case "memory":
      return { kind: "memory" };
    default:
      return undefined;
  }
}

function requestKind(kind: string): ProviderRequestKind {
  switch (kind) {
    case "shell":
      return "command";
    case "write":
      return "file-change";
    case "read":
      return "file-read";
    default:
      return "permission";
  }
}

function describe(request: Readonly<Record<string, unknown>> & { readonly kind: string }): {
  readonly title: string;
  readonly prompt: string;
} {
  switch (request.kind) {
    case "shell":
      return {
        title: "Run command",
        prompt: stringField(request, "fullCommandText") ?? "Run a shell command",
      };
    case "write":
      return { title: "Edit file", prompt: stringField(request, "fileName") ?? "Write a file" };
    case "read":
      return { title: "Read file", prompt: stringField(request, "path") ?? "Read a file" };
    case "mcp": {
      const server = stringField(request, "serverName") ?? "MCP server";
      const tool = stringField(request, "toolTitle") ?? stringField(request, "toolName") ?? "tool";
      return { title: "Use MCP tool", prompt: `${server}: ${tool}` };
    }
    case "url":
      return { title: "Fetch URL", prompt: stringField(request, "url") ?? "Fetch a URL" };
    case "memory":
      return { title: "Save memory", prompt: stringField(request, "fact") ?? "Store a memory" };
    case "custom-tool":
      return {
        title: "Use tool",
        prompt: stringField(request, "toolName") ?? "Run a custom tool",
      };
    default:
      return { title: "Permission request", prompt: `Copilot requests ${request.kind} access` };
  }
}

export function copilotApprovalPresentation(
  request: PermissionRequest,
  prompt: CopilotPromptRequest | undefined,
): CopilotApprovalPresentation {
  const record = request as unknown as Readonly<Record<string, unknown>> & {
    readonly kind: string;
  };
  const { title, prompt: text } = describe(record);
  const reason = stringField(record, "intention");
  const sessionApproval = sessionApprovalFor(record, prompt);
  return {
    requestKind: requestKind(record.kind),
    title,
    prompt: text,
    ...(reason === undefined || reason === text ? {} : { reason }),
    options: [
      { decision: "accept", label: "Allow once" },
      ...(sessionApproval === undefined
        ? []
        : [{ decision: "acceptForSession" as const, label: "Allow for this session" }]),
      { decision: "decline", label: "Deny" },
    ],
    ...(sessionApproval === undefined ? {} : { sessionApproval }),
  };
}

export function copilotPermissionResult(
  presentation: Pick<CopilotApprovalPresentation, "sessionApproval">,
  decision: ProviderApprovalDecision | undefined,
  feedback: string | undefined,
): PermissionRequestResult {
  switch (decision) {
    case "accept":
    case "acceptAlways":
      return { kind: "approve-once" };
    case "acceptForSession":
      return presentation.sessionApproval === undefined
        ? { kind: "approve-once" }
        : { kind: "approve-for-session", approval: presentation.sessionApproval };
    default: {
      const trimmed = feedback?.trim();
      return trimmed ? { kind: "reject", feedback: trimmed } : { kind: "reject" };
    }
  }
}
