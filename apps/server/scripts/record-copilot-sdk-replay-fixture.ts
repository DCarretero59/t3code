import { pipe } from "effect/Function";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  ProviderInstanceEnvironment,
  ProviderReplayEntry,
  ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  COPILOT_PROVIDER,
  COPILOT_SDK_REPLAY_PROTOCOL,
  makeCopilotSdkRunner,
} from "@t3tools/provider-copilot/testing";
import {
  checkpointWorkspace,
  makeCheckpointWorkspace,
} from "@t3tools/provider-testing/replayWorkspace";
import { materializeReplayTranscriptWorkspace } from "@t3tools/provider-testing/replayTranscript";
import {
  CopilotOrchestratorReplayHarness,
  copilotRecordingTap,
} from "../src/orchestration-v2/Adapters/CopilotAdapterV2.testkit.ts";
import * as CopilotAdapterV2Testkit from "../src/orchestration-v2/Adapters/CopilotAdapterV2.testkit.ts";
import { provideDeterministicTestRuntime } from "../src/orchestration-v2/testkit/DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "../src/orchestration-v2/testkit/fixtures/index.ts";
import { materializeFixtureInput } from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "../src/orchestration-v2/testkit/ProviderReplayHarness.ts";

// Records real premium requests: run one scenario at a time with the fixture's cheap model.
const CLOCK_TICK = Duration.millis(20);

function readArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const scenario = readArgValue("--scenario");
const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((entry) => entry.name === scenario);
const variant = fixture?.providers.find((provider) => provider.driver === COPILOT_PROVIDER);
if (fixture === undefined || variant === undefined) {
  const names = ORCHESTRATOR_REPLAY_FIXTURES.filter((entry) =>
    entry.providers.some((provider) => provider.driver === COPILOT_PROVIDER),
  ).map((entry) => entry.name);
  throw new Error(`Pass --scenario with a fixture that registers Copilot: ${names.join(", ")}`);
}

const copilotBinary = process.env.T3_COPILOT_BIN ?? "copilot";
// The recording runs under an empty COPILOT_HOME, so it needs an explicit token.
const token =
  process.env.COPILOT_GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";
if (token.length === 0) {
  throw new Error("Set COPILOT_GITHUB_TOKEN, GH_TOKEN or GITHUB_TOKEN to record Copilot fixtures.");
}
const home = process.env.HOME ?? "";

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const ISO_TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu;
const NORMALIZED_EPOCH_MS = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"));

// Events the adapter reads, plus the turn lifecycle that orders them. The rest carry the
// user's skills, system prompt, or account details and do not change adapter behavior.
const KEPT_EVENT_TYPES = new Set([
  "session.start",
  "session.resume",
  "session.error",
  "session.warning",
  "session.idle",
  "session.usage_info",
  "abort",
  "user.message",
  "assistant.turn_start",
  "assistant.turn_end",
  "assistant.message_start",
  "assistant.message",
  "assistant.message_delta",
  "assistant.reasoning",
  "assistant.reasoning_delta",
  "assistant.usage",
  "tool.execution_start",
  "tool.execution_partial_result",
  "tool.shell_output",
  "tool.execution_complete",
]);
const KEPT_EVENT_PREFIXES = ["permission.", "user_input.", "subagent."];
const DROPPED_FIELDS = new Set([
  "apiCallId",
  "providerCallId",
  "serviceRequestId",
  "toolTelemetry",
  "copilotUsage",
  "transformedContent",
  "supportedNativeDocumentMimeTypes",
]);
const OPAQUE_FIELDS = new Set(["reasoningOpaque", "encryptedContent"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keepsEvent(type: unknown): boolean {
  return (
    typeof type === "string" &&
    (KEPT_EVENT_TYPES.has(type) || KEPT_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix)))
  );
}

// Normalize both directions consistently so echoed ids and paths still match on replay.
function normalizeEntries(input: {
  readonly entries: ReadonlyArray<ProviderReplayEntry>;
  readonly workspace: string;
  readonly copilotHome: string;
}): ReadonlyArray<ProviderReplayEntry> {
  const uuids = new Map<string, string>();
  const reasoningIds = new Map<string, string>();
  let timeAnchorMs: number | undefined;
  const shiftTime = (ms: number): number => {
    timeAnchorMs ??= ms;
    return NORMALIZED_EPOCH_MS + (ms - timeAnchorMs);
  };
  const realWorkspace = new RegExp(`(?:/private)?${escapeRegExp(input.workspace)}`, "gu");
  const normalizeString = (value: string): string =>
    value
      .replace(realWorkspace, "<workspace>")
      .replaceAll(input.copilotHome, "<copilot-home>")
      .replaceAll(home.length > 1 ? home : "\0", "~")
      .replace(ISO_TIMESTAMP_PATTERN, (iso) =>
        pipe(
          DateTime.makeUnsafe(iso),
          DateTime.toEpochMillis,
          shiftTime,
          DateTime.makeUnsafe,
          DateTime.formatIso,
        ),
      )
      .replace(UUID_PATTERN, (uuid) => {
        const existing = uuids.get(uuid.toLowerCase());
        if (existing !== undefined) return existing;
        const next = `00000000-0000-4000-8000-${String(uuids.size + 1).padStart(12, "0")}`;
        uuids.set(uuid.toLowerCase(), next);
        return next;
      });
  const normalizeValue = (value: unknown): unknown => {
    if (typeof value === "string") return normalizeString(value);
    if (Array.isArray(value)) return value.map(normalizeValue);
    if (!isRecord(value)) return value;
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]): Array<[string, unknown]> => {
        if (DROPPED_FIELDS.has(key)) return [];
        if (OPAQUE_FIELDS.has(key)) return [[key, "<redacted>"]];
        if (key === "reasoningId" && typeof entry === "string") {
          const existing = reasoningIds.get(entry);
          const next = existing ?? `reasoning-${reasoningIds.size + 1}`;
          reasoningIds.set(entry, next);
          return [[key, next]];
        }
        if (key === "quotaSnapshots" && isRecord(entry)) {
          const premium = entry.premium_interactions;
          return isRecord(premium) && typeof premium.resetDate === "string"
            ? [[key, { premium_interactions: { resetDate: normalizeString(premium.resetDate) } }]]
            : [];
        }
        return [[key, normalizeValue(entry)]];
      }),
    );
  };
  return input.entries.flatMap((entry): Array<ProviderReplayEntry> => {
    if (entry.type === "runtime_exit") return [entry];
    const frame = entry.frame;
    if (isRecord(frame) && frame.type === "session.event") {
      const event = frame.event;
      if (!isRecord(event) || !keepsEvent(event.type)) return [];
    }
    return [{ ...entry, frame: normalizeValue(frame) }];
  });
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function encodeTranscriptNdjson(transcript: ProviderReplayTranscript): string {
  const { entries, ...metadata } = transcript;
  return [
    encodeJson({ type: "transcript_start", ...metadata }),
    ...entries.map((entry) => encodeJson(entry)),
    "",
  ].join("\n");
}

function recordedCopilotVersion(entries: ReadonlyArray<ProviderReplayEntry>): string {
  for (const entry of entries) {
    if (entry.type !== "emit_inbound" || !isRecord(entry.frame)) continue;
    const event = entry.frame.event;
    if (!isRecord(event) || event.type !== "session.start" || !isRecord(event.data)) continue;
    if (typeof event.data.copilotVersion === "string") return event.data.copilotVersion;
  }
  return "unknown";
}

// Follow wall time for live timers while retaining replay's TestClock steps.
const followWallClock = Effect.gen(function* () {
  while (true) {
    yield* TestClock.withLive(Effect.sleep(CLOCK_TICK));
    yield* TestClock.adjust(CLOCK_TICK);
  }
});

const record = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outputPath = readArgValue("--out") ?? (yield* path.fromFileUrl(variant.transcriptFile));
  const fixtureInput = fixture.buildInput();
  const workspace = yield* Effect.promise(() =>
    makeCheckpointWorkspace(`copilot-sdk-record-${fixture.name}`, fixtureInput.workspaceFiles),
  );
  // An empty Copilot home keeps the user's instructions, skills and MCP servers out of the fixture.
  const copilotHome = yield* fs.makeTempDirectory({ prefix: "t3-copilot-record-home-" });
  yield* Effect.addFinalizer(() =>
    Effect.all([
      fs.remove(workspace, { recursive: true, force: true }),
      fs.remove(copilotHome, { recursive: true, force: true }),
    ]).pipe(Effect.ignore),
  );
  const environment: ProviderInstanceEnvironment = [
    { name: "COPILOT_HOME", value: copilotHome, sensitive: false },
    { name: "COPILOT_GITHUB_TOKEN", value: token, sensitive: true },
  ];

  const entries: Array<ProviderReplayEntry> = [];
  const runner = yield* makeCopilotSdkRunner(copilotRecordingTap(entries));
  const placeholder: ProviderReplayTranscript = {
    provider: COPILOT_PROVIDER,
    protocol: COPILOT_SDK_REPLAY_PROTOCOL,
    version: "unknown",
    scenario: fixture.name,
    entries: [],
  };
  const materializeInput = materializeFixtureInput({
    scenario: fixture.name,
    fixtureInput,
    driver: variant.driver,
    modelSelection: variant.modelSelection,
  }).pipe(Effect.provide(IdAllocator.layer));
  const continuationOptions =
    variant.runContinuationWorker === true ? { runContinuationWorker: true } : {};

  yield* Effect.gen(function* () {
    yield* followWallClock.pipe(Effect.forkScoped);
    const materialized = yield* materializeInput;
    yield* runOrchestratorV2ProviderReplayScenario(
      {
        name: `${fixture.name}/copilot:record`,
        transcript: placeholder,
        commands: materialized.commands,
        steps: materialized.steps,
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: workspace },
      },
      {
        driver: COPILOT_PROVIDER,
        decodeTranscript: Effect.succeed,
        makeProviderAdapterRegistryLayer: () =>
          CopilotAdapterV2Testkit.layer({
            runner: {
              connect: (input) => runner.connect({ ...input, binaryPath: copilotBinary }),
            },
            environment,
          }),
      },
      continuationOptions,
    );
  }).pipe(Effect.scoped, provideDeterministicTestRuntime);

  const copilotVersion = recordedCopilotVersion(entries);
  const transcript = {
    ...placeholder,
    version: copilotVersion,
    metadata: {
      generatedBy: "live-copilot-sdk-recorder",
      copilotVersion,
      model: variant.modelSelection.model,
    },
    entries: normalizeEntries({ entries, workspace, copilotHome }),
  } satisfies ProviderReplayTranscript;

  // Assert on normalized replay; the live projection has raw paths. Failed assertions preserve the fixture.
  yield* Effect.gen(function* () {
    const replayWorkspace = yield* checkpointWorkspace(fixture.name, fixtureInput.workspaceFiles);
    const materialized = yield* materializeInput;
    const replayResult = yield* runOrchestratorV2ProviderReplayScenario(
      {
        name: `${fixture.name}/copilot:verify`,
        transcript: yield* CopilotOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptWorkspace(transcript, replayWorkspace),
        ),
        commands: materialized.commands,
        steps: materialized.steps,
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: replayWorkspace },
      },
      CopilotOrchestratorReplayHarness,
      continuationOptions,
    );
    variant.assertOutput(replayResult, transcript);
  }).pipe(
    Effect.scoped,
    provideDeterministicTestRuntime,
    Effect.tapError(() =>
      fs
        .writeFileString(`${outputPath}.failed`, encodeTranscriptNdjson(transcript))
        .pipe(Effect.ignore),
    ),
  );

  yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });
  yield* fs.writeFileString(outputPath, encodeTranscriptNdjson(transcript));
  yield* Console.log(
    `Wrote ${transcript.entries.length} Copilot SDK replay entries to ${outputPath}`,
  );
});

await Effect.runPromise(record.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
