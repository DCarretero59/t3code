import { expect, it } from "@effect/vitest";

import * as Schema from "effect/Schema";

import { CopilotSettings } from "../settings.ts";
import { copilotProbeSnapshot } from "./status.ts";

const settings = { ...Schema.decodeSync(CopilotSettings)({}), enabled: true };

it("reports a signed-out runtime as an error with a sign-in hint", () => {
  const snapshot = copilotProbeSnapshot({
    settings,
    checkedAt: "2026-01-01T00:00:00.000Z",
    installed: true,
    probe: { version: "1.0.69", auth: { isAuthenticated: false }, models: null },
  });
  expect(snapshot.status).toBe("error");
  expect(snapshot.auth).toEqual({ status: "unauthenticated" });
  expect(snapshot.message).toContain("copilot login");
});

it("lists Auto first and keeps each model's own reasoning efforts", () => {
  const snapshot = copilotProbeSnapshot({
    settings,
    checkedAt: "2026-01-01T00:00:00.000Z",
    installed: true,
    probe: {
      version: "1.0.69",
      auth: { isAuthenticated: true, authType: "user", login: "octocat" },
      models: [
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          capabilities: {
            supports: { vision: true, reasoningEffort: true },
            limits: { max_context_window_tokens: 1 },
          },
          supportedReasoningEfforts: ["low", "medium"],
          defaultReasoningEffort: "medium",
        },
        {
          id: "blocked",
          name: "Blocked",
          capabilities: {
            supports: { vision: false, reasoningEffort: false },
            limits: { max_context_window_tokens: 1 },
          },
          policy: { state: "disabled", terms: "" },
        },
      ],
    },
  });
  expect(snapshot.status).toBe("ready");
  expect(snapshot.auth).toEqual({ status: "authenticated", type: "user", label: "octocat" });
  expect(snapshot.models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
    ["auto", true],
    ["gpt-5.6-luna", false],
  ]);
  const effort = snapshot.models[1]?.capabilities?.optionDescriptors?.[0];
  expect(effort?.type === "select" ? effort.options.map((option) => option.id) : []).toEqual([
    "low",
    "medium",
  ]);
});
