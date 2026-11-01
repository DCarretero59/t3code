import type { PermissionRequest } from "@github/copilot-sdk";
import { expect, it } from "@effect/vitest";

import { copilotApprovalPresentation, copilotPermissionResult } from "./permissions.ts";

const shell = (canOfferSessionApproval: boolean) =>
  ({
    kind: "shell",
    toolCallId: "call-1",
    fullCommandText: "npm test",
    intention: "Run the tests",
    commands: [{ identifier: "npm test", readOnly: false }],
    possiblePaths: [],
    possibleUrls: [],
    hasWriteFileRedirection: false,
    canOfferSessionApproval,
  }) as unknown as PermissionRequest;

it("offers a session approval only when Copilot can remember it", () => {
  const remembered = copilotApprovalPresentation(shell(true), undefined);
  expect(remembered.options.map((option) => option.decision)).toEqual([
    "accept",
    "acceptForSession",
    "decline",
  ]);
  expect(copilotPermissionResult(remembered, "acceptForSession", undefined)).toEqual({
    kind: "approve-for-session",
    approval: { kind: "commands", commandIdentifiers: ["npm test"] },
  });

  const once = copilotApprovalPresentation(shell(false), undefined);
  expect(once.options.map((option) => option.decision)).toEqual(["accept", "decline"]);
  expect(copilotPermissionResult(once, "acceptForSession", undefined)).toEqual({
    kind: "approve-once",
  });
});

it("prefers the runtime's prompt request when deciding what a session approval covers", () => {
  const presentation = copilotApprovalPresentation(shell(false), {
    kind: "commands",
    canOfferSessionApproval: true,
    commandIdentifiers: ["npm"],
  });
  expect(presentation.sessionApproval).toEqual({ kind: "commands", commandIdentifiers: ["npm"] });
});

it.each([
  ["decline", " not now ", { kind: "reject", feedback: "not now" }],
  ["decline", undefined, { kind: "reject" }],
  ["cancel", undefined, { kind: "reject" }],
  [undefined, undefined, { kind: "reject" }],
] as const)("answers %s as a rejection Copilot honors", (decision, feedback, expected) => {
  expect(
    copilotPermissionResult(
      copilotApprovalPresentation(shell(true), undefined),
      decision,
      feedback,
    ),
  ).toEqual(expected);
});
