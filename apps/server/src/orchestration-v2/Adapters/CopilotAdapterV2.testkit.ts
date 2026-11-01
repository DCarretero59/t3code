import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderInstanceId,
  ProviderReplayEntry,
  type ResolvedProviderInstanceEnvironment,
  type ProviderReplayEntry as ProviderReplayEntryType,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ProviderAdapterDriverCreateError } from "@t3tools/provider-core/server/adapterDriver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  COPILOT_PROVIDER,
  COPILOT_SDK_REPLAY_PROTOCOL,
  CopilotSdkError,
  type CopilotSdkFrame,
  type CopilotSdkInboundFrame,
  type CopilotSdkOpenSessionInput,
  type CopilotSdkOutboundFrame,
  type CopilotSdkRunner,
  type CopilotSdkSession,
  loggedSessionOptions,
  makeCopilotAdapterV2Driver,
  sendFrame,
} from "@t3tools/provider-copilot/testing";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";

const COPILOT_REPLAY_ANY = "<any>";

const CopilotSdkReplayTranscript = Schema.Struct({
  provider: Schema.Literal(COPILOT_PROVIDER),
  protocol: Schema.Literal(COPILOT_SDK_REPLAY_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
type CopilotSdkReplayTranscript = typeof CopilotSdkReplayTranscript.Type;
const decodeCopilotSdkReplayTranscript = Schema.decodeUnknownEffect(CopilotSdkReplayTranscript);

class CopilotReplayTranscriptDecodeError extends Schema.TaggedError<CopilotReplayTranscriptDecodeError>()(
  "CopilotReplayTranscriptDecodeError",
  {
    scenario: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode Copilot SDK replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

class CopilotReplayMismatchError extends Schema.TaggedError<CopilotReplayMismatchError>()(
  "CopilotReplayMismatchError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    label: Schema.optional(Schema.String),
    expected: Schema.Unknown,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Copilot replay frame mismatch at cursor ${this.cursor} (expected ${this.label ?? "<none>"}) in scenario ${this.scenario}.`;
  }
}

class CopilotReplayIncompleteError extends Schema.TaggedError<CopilotReplayIncompleteError>()(
  "CopilotReplayIncompleteError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    remaining: Schema.Number,
    nextLabel: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Copilot replay ended with ${this.remaining} unconsumed entries at cursor ${this.cursor} (next ${this.nextLabel ?? "<none>"}) in scenario ${this.scenario}.`;
  }
}

const CopilotOrchestratorReplayHarnessError = Schema.Union([
  CopilotReplayTranscriptDecodeError,
  ProviderAdapterDriverCreateError,
]);
type CopilotOrchestratorReplayHarnessError = typeof CopilotOrchestratorReplayHarnessError.Type;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function replayValueMatches(expected: unknown, actual: unknown): boolean {
  if (expected === COPILOT_REPLAY_ANY) return true;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((entry, index) => replayValueMatches(entry, actual[index]))
    );
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].every((key) => replayValueMatches(expected[key], actual[key]));
  }
  return Object.is(expected, actual);
}

function copilotFrameLabel(frame: unknown): string | undefined {
  if (!isRecord(frame) || typeof frame.type !== "string") return undefined;
  if (frame.type === "session.event" && isRecord(frame.event)) {
    return typeof frame.event.type === "string" ? `event:${frame.event.type}` : frame.type;
  }
  if (
    (frame.type === "call.result" || frame.type === "call.failed") &&
    typeof frame.method === "string"
  ) {
    return `${frame.type}:${frame.method}`;
  }
  return frame.type;
}

function entryLabel(entry: ProviderReplayEntryType | undefined): string | undefined {
  if (entry === undefined) return undefined;
  return entry.type === "runtime_exit" ? "runtime_exit" : (entry.label ?? entry.type);
}

/** A new prompt opens a turn window; earlier writes must not match across it. */
function startsTurn(entry: ProviderReplayEntryType): boolean {
  return (
    entry.type === "expect_outbound" &&
    isRecord(entry.frame) &&
    entry.frame.type === "session.send" &&
    entry.frame.mode === undefined
  );
}

interface PendingCall {
  readonly method: string;
  readonly done: Deferred.Deferred<{ readonly sessionId?: string }, CopilotSdkError>;
}

/** Adapter fibers can reorder SDK calls; hold matches within the turn until reached, and fail unmatched calls. */
class CopilotReplayController {
  private cursor = 0;
  private failure: unknown = null;
  private readonly consumed = new Set<number>();
  private readonly held: Array<unknown> = [];
  private readonly calls: Array<PendingCall> = [];
  private session: CopilotSdkOpenSessionInput | null = null;
  private readonly transcript: CopilotSdkReplayTranscript;

  constructor(transcript: CopilotSdkReplayTranscript) {
    this.transcript = transcript;
  }

  bindSession(input: CopilotSdkOpenSessionInput): void {
    this.session = input;
  }

  /** Records an SDK call; its result frame settles `done`. */
  call(method: string, frame: CopilotSdkOutboundFrame) {
    const done = Deferred.makeUnsafe<{ readonly sessionId?: string }, CopilotSdkError>();
    this.calls.push({ method, done });
    this.receive(frame);
    if (this.failure !== null) {
      Deferred.doneUnsafe(done, Effect.fail(new CopilotSdkError({ method, cause: this.failure })));
    }
    return Deferred.await(done);
  }

  receive(actual: unknown): void {
    if (this.failure !== null) return;
    const entries = this.transcript.entries;
    let possible = false;
    for (let index = this.cursor; index < entries.length && !possible; index += 1) {
      const entry = entries[index]!;
      const pending = entry.type === "expect_outbound" && !this.consumed.has(index);
      possible = pending && replayValueMatches(entry.frame, actual);
      if (!possible && pending && startsTurn(entry)) break;
    }
    if (!possible) {
      const expected = entries[this.cursor];
      const label = entryLabel(expected);
      this.fail(
        new CopilotReplayMismatchError({
          scenario: this.transcript.scenario,
          cursor: this.cursor,
          ...(label === undefined ? {} : { label }),
          expected: expected ?? null,
          actual,
        }),
      );
      return;
    }
    this.held.push(actual);
    this.advance();
  }

  assertComplete(): void {
    if (this.failure !== null) throw this.failure;
    if (this.cursor !== this.transcript.entries.length || this.held.length > 0) {
      const nextLabel = entryLabel(this.transcript.entries[this.cursor]);
      throw new CopilotReplayIncompleteError({
        scenario: this.transcript.scenario,
        cursor: this.cursor,
        remaining: this.transcript.entries.length - this.cursor,
        ...(nextLabel === undefined ? {} : { nextLabel }),
      });
    }
  }

  private advance(): void {
    let progressed = true;
    while (progressed && this.failure === null) {
      progressed = this.drainInbound();
      for (const [heldIndex, actual] of this.held.entries()) {
        if (this.consumePending(actual)) {
          this.held.splice(heldIndex, 1);
          progressed = true;
          break;
        }
      }
    }
  }

  private consumePending(actual: unknown): boolean {
    const entries = this.transcript.entries;
    for (let index = this.cursor; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.type !== "expect_outbound") return false;
      if (this.consumed.has(index) || !replayValueMatches(entry.frame, actual)) continue;
      this.consumed.add(index);
      while (this.consumed.has(this.cursor)) this.cursor += 1;
      return true;
    }
    return false;
  }

  private drainInbound(): boolean {
    let emitted = false;
    while (this.failure === null) {
      const entry = this.transcript.entries[this.cursor];
      if (entry?.type !== "emit_inbound") return emitted;
      this.cursor += 1;
      emitted = true;
      this.dispatch(entry.frame as CopilotSdkInboundFrame);
      while (this.consumed.has(this.cursor)) this.cursor += 1;
    }
    return emitted;
  }

  private dispatch(frame: CopilotSdkInboundFrame): void {
    switch (frame.type) {
      case "call.result":
      case "call.failed": {
        const index = this.calls.findIndex((call) => call.method === frame.method);
        if (index === -1) {
          this.fail(new Error(`Copilot replay has no pending ${frame.method} call.`));
          return;
        }
        const [call] = this.calls.splice(index, 1);
        Deferred.doneUnsafe(
          call!.done,
          frame.type === "call.result"
            ? Effect.succeed(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId })
            : Effect.fail(
                new CopilotSdkError({ method: frame.method, cause: new Error(frame.message) }),
              ),
        );
        return;
      }
      case "session.event":
        this.session?.onEvent(frame.event);
        return;
      case "user_input.request": {
        const session = this.session;
        if (session === null) return;
        void session
          .onUserInputRequest({ requestId: frame.requestId, request: frame.request })
          .then(
            (response) =>
              this.receive({ type: "user_input.respond", requestId: frame.requestId, response }),
            () =>
              this.receive({
                type: "user_input.respond",
                requestId: frame.requestId,
                response: null,
              }),
          );
        return;
      }
    }
  }

  private fail(cause: unknown): void {
    if (this.failure !== null) return;
    this.failure = cause;
    for (const call of this.calls.splice(0)) {
      Deferred.doneUnsafe(
        call.done,
        Effect.fail(new CopilotSdkError({ method: call.method, cause })),
      );
    }
  }
}

function makeReplayRunner(controller: CopilotReplayController): CopilotSdkRunner {
  return {
    connect: () =>
      Effect.succeed({
        openSession: (open) =>
          Effect.gen(function* () {
            controller.bindSession(open);
            const logged = loggedSessionOptions(open.options);
            const method = open.operation === "create" ? "session.create" : "session.resume";
            const result = yield* controller.call(
              method,
              open.operation === "create"
                ? { type: "session.create", options: logged }
                : { type: "session.resume", sessionId: open.sessionId ?? "", options: logged },
            );
            return {
              sessionId: result.sessionId ?? "",
              send: (input) =>
                controller.call("session.send", sendFrame(input)).pipe(Effect.asVoid),
              abort: Effect.suspend(() =>
                controller.call("session.abort", { type: "session.abort" }).pipe(Effect.asVoid),
              ),
              setModel: (model) =>
                controller
                  .call("session.setModel", {
                    type: "session.setModel",
                    model: model.model,
                    ...(model.reasoningEffort === undefined
                      ? {}
                      : { reasoningEffort: model.reasoningEffort }),
                  })
                  .pipe(Effect.asVoid),
              respondToPermission: (response) =>
                controller
                  .call("permission.respond", { type: "permission.respond", ...response })
                  .pipe(Effect.asVoid),
              disconnect: Effect.void,
            } satisfies CopilotSdkSession;
          }),
      }),
  };
}

export function layer(input: {
  readonly runner: CopilotSdkRunner;
  readonly environment?: ResolvedProviderInstanceEnvironment;
}) {
  const driver = makeCopilotAdapterV2Driver(input.runner);
  return ProviderAdapterRegistry.layerFromAdaptersEffect(
    driver
      .create({
        instanceId: ProviderInstanceId.make(COPILOT_PROVIDER),
        environment: input.environment ?? [],
        displayName: undefined,
        enabled: true,
        config: { ...driver.defaultConfig(), binaryPath: "copilot" },
      })
      .pipe(Effect.map((adapter) => [adapter])),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
        NodeServices.layer,
        IdAllocator.layer,
      ),
    ),
  );
}

export const CopilotOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  CopilotSdkReplayTranscript,
  CopilotOrchestratorReplayHarnessError
> = {
  driver: COPILOT_PROVIDER,
  decodeTranscript: (transcript: ProviderReplayTranscript) =>
    decodeCopilotSdkReplayTranscript(transcript).pipe(
      Effect.mapError(
        (cause) => new CopilotReplayTranscriptDecodeError({ scenario: transcript.scenario, cause }),
      ),
    ),
  makeProviderAdapterRegistryLayer: (transcript) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const controller = new CopilotReplayController(transcript);
        yield* Effect.addFinalizer(() => Effect.sync(() => controller.assertComplete()));
        return layer({ runner: makeReplayRunner(controller) });
      }),
    ),
};

/** Wraps the live SDK runner so every SDK call, result and event lands in `entries`. */
export function copilotRecordingTap(
  entries: Array<ProviderReplayEntryType>,
): (frame: CopilotSdkFrame) => void {
  return ({ direction, frame }) => {
    const label = copilotFrameLabel(frame);
    entries.push({
      type: direction === "outbound" ? "expect_outbound" : "emit_inbound",
      ...(label === undefined ? {} : { label }),
      frame,
    });
  };
}
