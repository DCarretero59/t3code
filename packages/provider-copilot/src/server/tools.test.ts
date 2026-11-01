import { expect, it } from "@effect/vitest";

import { copilotToolTurnItemFields, parseCopilotShellOutput } from "./tools.ts";

it("moves Copilot's shell exit status out of the output", () => {
  expect(parseCopilotShellOutput("hello\n<shellId: 0 completed with exit code 0>")).toEqual({
    output: "hello",
    exitCode: 0,
  });
  expect(parseCopilotShellOutput("boom\n<shellId: 3 completed with exit code 127>")).toEqual({
    output: "boom",
    exitCode: 127,
  });
  expect(parseCopilotShellOutput("still running")).toEqual({ output: "still running" });
});

it("names the first patched file of an apply_patch call", () => {
  const patch = "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** End Patch";
  expect(
    copilotToolTurnItemFields({ toolName: "apply_patch", arguments: { input: patch } }),
  ).toEqual({
    type: "file_change",
    title: "apply_patch",
    fileName: "src/app.ts",
    diffStr: patch,
  });
});

it("gives MCP tools their qualified server name", () => {
  const fields = copilotToolTurnItemFields({
    toolName: "t3-code-schedule_task",
    arguments: { prompt: "x" },
    mcpServerName: "t3-code",
    mcpToolName: "schedule_task",
  });
  expect(fields.type).toBe("dynamic_tool");
  expect(fields.type === "dynamic_tool" ? fields.toolName : null).toBe(
    "mcp__t3-code__schedule_task",
  );
});
