import { TextGenerationError } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { isCopilotReasoningEffort, type CopilotSdkRunner } from "./sdk.ts";

export function makeCopilotTextGeneration(
  runner: CopilotSdkRunner,
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
) {
  const run: TextGenerationOperations.Runner = Effect.fn("CopilotTextGeneration.run")(
    function* (request) {
      const completed = yield* Deferred.make<string, TextGenerationError>();
      let output = "";
      const connection = yield* runner.connect({ binaryPath, environment, cwd: request.cwd });
      const effort =
        getModelSelectionStringOptionValue(request.modelSelection, "reasoningEffort") ??
        getModelSelectionStringOptionValue(request.modelSelection, "reasoning_effort");
      const session = yield* connection.openSession({
        operation: "create",
        options: {
          model: request.modelSelection.model,
          ...(isCopilotReasoningEffort(effort) ? { reasoningEffort: effort } : {}),
          workingDirectory: request.cwd,
          mcpServers: {},
          availableTools: [],
          approveAll: false,
          denyPermissions: true,
          enableConfigDiscovery: false,
        },
        onUserInputRequest: () =>
          Promise.reject(new Error("Text generation cannot ask questions.")),
        onEvent: (event) => {
          switch (event.type) {
            case "assistant.message_delta":
              output += event.data.deltaContent;
              break;
            case "assistant.message":
              output = event.data.content;
              break;
            case "session.idle":
              Deferred.doneUnsafe(completed, Effect.succeed(output));
              break;
            case "session.error":
              Deferred.doneUnsafe(
                completed,
                Effect.fail(
                  new TextGenerationError({
                    operation: request.operation,
                    detail: "Copilot text generation failed.",
                    cause: new Error(event.data.message),
                  }),
                ),
              );
              break;
          }
        },
      });
      yield* Effect.addFinalizer(() => session.disconnect);
      yield* session.setControls({ mode: "interactive", agent: null });
      yield* session.send({ prompt: request.prompt });
      const text = yield* Deferred.await(completed);
      return yield* TextGenerationOperations.decodeJsonReply(request, "GitHub Copilot", text);
    },
    (effect, request) =>
      effect.pipe(
        Effect.timeout("3 minutes"),
        Effect.mapError((cause) =>
          Schema.is(TextGenerationError)(cause)
            ? cause
            : new TextGenerationError({
                operation: request.operation,
                detail: "Copilot text generation request failed.",
                cause,
              }),
        ),
        Effect.scoped,
      ),
  );
  return TextGenerationOperations.fromRunner(
    "CopilotTextGeneration",
    TextGenerationOperations.withoutInvestigation("GitHub Copilot", run),
  );
}
