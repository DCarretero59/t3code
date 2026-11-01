import { describe } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { materializeReplayTranscriptWorkspace } from "@t3tools/provider-testing/replayTranscript";
import { CopilotOrchestratorReplayHarness } from "../Adapters/CopilotAdapterV2.testkit.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

describe("GitHub Copilot replay fixtures", () => {
  itRunsReplayFixtures("copilot", (input) =>
    runReplayFixture({
      ...input,
      harness: CopilotOrchestratorReplayHarness,
      materializeWorkspace: (transcript, workspace) =>
        Effect.succeed(materializeReplayTranscriptWorkspace(transcript, workspace)),
    }),
  );
});
