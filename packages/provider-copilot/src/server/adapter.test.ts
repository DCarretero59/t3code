import { expect, it } from "@effect/vitest";

import { copilotProviderFailure, copilotT3McpServers } from "./adapter.ts";

it.each([
  [
    "quota",
    "2026-11-01T00:00:00Z",
    { class: "usage_limit", retryable: true, resetAt: "2026-11-01T00:00:00.000Z" },
  ],
  ["rate_limit", "2026-11-01T00:00:00Z", { class: "usage_limit", retryable: true }],
  ["authentication", null, { class: "permission_error", retryable: null }],
  ["query", null, { class: "provider_error", retryable: null }],
] as const)("classifies %s errors", (errorType, quotaResetAt, expected) => {
  const failure = copilotProviderFailure({ errorType, message: "Copilot failed", quotaResetAt });
  expect({
    class: failure.class,
    retryable: failure.retryable,
    ...(failure.resetAt == null ? {} : { resetAt: failure.resetAt }),
  }).toEqual(expected);
});

it("sends the thread's MCP credentials only in the T3 server's headers", () => {
  expect(copilotT3McpServers(undefined)).toEqual({});
  expect(
    copilotT3McpServers({
      environmentId: "env" as never,
      threadId: "thread" as never,
      providerSessionId: "session",
      providerInstanceId: "copilot" as never,
      endpoint: "http://127.0.0.1:3773/mcp/thread",
      authorizationHeader: "Bearer secret",
      browserToolsAvailable: false,
    }),
  ).toEqual({
    "t3-code": {
      type: "http",
      url: "http://127.0.0.1:3773/mcp/thread",
      headers: { Authorization: "Bearer secret" },
      tools: ["*"],
    },
  });
});
