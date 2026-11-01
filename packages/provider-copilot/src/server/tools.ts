import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";

/** Copilot narrates intent and asks questions through tools that have their own T3 rows. */
const HIDDEN_TOOLS = new Set(["report_intent", "ask_user"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const SHELL_EXIT_SUFFIX = /\n?<shellId: [^>]+ completed with exit code (-?\d+)>\s*$/u;
const PATCH_FILE_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/mu;

export function isHiddenCopilotTool(toolName: string): boolean {
  return HIDDEN_TOOLS.has(toolName);
}

export function isCopilotShellTool(toolName: string): boolean {
  return SHELL_TOOLS.has(toolName);
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

/** Copilot appends the shell's exit status to command output; T3 keeps it as `exitCode`. */
export function parseCopilotShellOutput(output: string): {
  readonly output: string;
  readonly exitCode?: number;
} {
  const match = SHELL_EXIT_SUFFIX.exec(output);
  if (match === null) return { output };
  return { output: output.slice(0, match.index), exitCode: Number(match[1]) };
}

export interface CopilotToolSnapshot {
  readonly toolName: string;
  readonly arguments: unknown;
  readonly mcpServerName?: string;
  readonly mcpToolName?: string;
  /** Full output so far for shells; final result text otherwise. */
  readonly output?: string;
  readonly error?: string;
}

type ToolTurnItemFields =
  | Pick<
      Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
      "type" | "title" | "input" | "output" | "exitCode"
    >
  | Pick<
      Extract<OrchestrationV2TurnItem, { type: "file_change" }>,
      "type" | "title" | "fileName" | "diffStr" | "oldStr" | "newStr"
    >
  | (Pick<
      Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>,
      "type" | "title" | "toolName" | "input" | "output"
    > &
      ReturnType<typeof mcpToolPresentation>);

export function copilotToolTurnItemFields(tool: CopilotToolSnapshot): ToolTurnItemFields {
  const args = tool.arguments;
  if (isCopilotShellTool(tool.toolName)) {
    const parsed = tool.output === undefined ? undefined : parseCopilotShellOutput(tool.output);
    const output = parsed?.output ?? tool.error;
    return {
      type: "command_execution",
      title: tool.toolName,
      input: stringField(args, "command") ?? "",
      ...(output === undefined || output.length === 0 ? {} : { output }),
      ...(parsed?.exitCode === undefined ? {} : { exitCode: parsed.exitCode }),
    };
  }
  if (tool.toolName === "create" || tool.toolName === "edit") {
    const fileName = stringField(args, "path")?.trim();
    if (fileName) {
      const oldStr = tool.toolName === "edit" ? stringField(args, "old_str") : undefined;
      const newStr = stringField(args, tool.toolName === "edit" ? "new_str" : "file_text");
      return {
        type: "file_change",
        title: tool.toolName,
        fileName,
        ...(oldStr === undefined ? {} : { oldStr }),
        ...(newStr === undefined ? {} : { newStr }),
      };
    }
  }
  if (tool.toolName === "apply_patch") {
    const patch = typeof args === "string" ? args : stringField(args, "input");
    const fileName = patch === undefined ? undefined : PATCH_FILE_HEADER.exec(patch)?.[1]?.trim();
    if (patch !== undefined && fileName) {
      return { type: "file_change", title: tool.toolName, fileName, diffStr: patch };
    }
  }
  const toolName =
    tool.mcpServerName !== undefined && tool.mcpToolName !== undefined
      ? `mcp__${tool.mcpServerName}__${tool.mcpToolName}`
      : tool.toolName;
  const output = tool.output ?? tool.error;
  return {
    type: "dynamic_tool",
    title: tool.mcpToolName ?? tool.toolName,
    ...mcpToolPresentation({
      toolName: tool.mcpToolName ?? tool.toolName,
      ...(tool.mcpServerName === undefined ? {} : { serverName: tool.mcpServerName }),
    }),
    toolName,
    input: args ?? {},
    ...(output === undefined ? {} : { output }),
  };
}
