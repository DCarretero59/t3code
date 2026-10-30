import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
  PROVIDER_THREAD_RESUME_FIRST_PROMPT,
  PROVIDER_THREAD_RESUME_SECOND_PROMPT,
} from "../shared.ts";

const FIRST_FINAL = "provider thread resume fixture first turn complete";
const SECOND_FINAL = "provider thread resume fixture second turn complete";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

export function assertCopilotProviderThreadResumeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const opens = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" &&
    (field(entry.frame, "type") === "session.create" ||
      field(entry.frame, "type") === "session.resume")
      ? [entry.frame]
      : [],
  );
  const created = transcript.entries.find(
    (entry) =>
      entry.type === "emit_inbound" &&
      field(entry.frame, "type") === "call.result" &&
      field(entry.frame, "method") === "session.create",
  );
  const sessionId =
    created?.type === "emit_inbound" ? field(created.frame, "sessionId") : undefined;
  assert.deepEqual(
    opens.map((frame) => [field(frame, "type"), field(frame, "sessionId")]),
    [
      ["session.create", undefined],
      ["session.resume", sessionId],
    ],
    "the idle release must retire the first runtime and resume its session",
  );

  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [
    PROVIDER_THREAD_RESUME_FIRST_PROMPT,
    PROVIDER_THREAD_RESUME_SECOND_PROMPT,
  ]);
  assert.lengthOf(projection.providerThreads, 1, "resume must keep one provider thread");
  assert.equal(projection.providerThreads[0]?.nativeThreadRef?.nativeId, sessionId);
  const answers = projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" ? [item.text] : [],
  );
  assert.lengthOf(answers, 2);
  assert.include(answers[1], FIRST_FINAL, "the resumed session must remember the first answer");
  assert.include(answers[1], SECOND_FINAL);
}
