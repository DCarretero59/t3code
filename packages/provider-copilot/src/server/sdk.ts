import type {
  CopilotClient,
  GetAuthStatusResponse,
  MCPServerConfig,
  MessageOptions,
  ModelInfo,
  PermissionRequestResult,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";
import { ProviderDriverKind } from "@t3tools/contracts";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { npmShimExecutable, resolveCommandPath } from "@t3tools/shared/shell";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export const COPILOT_DRIVER_KIND = ProviderDriverKind.make("copilot");
export const COPILOT_SDK_REPLAY_PROTOCOL = "copilot-sdk.local";

const CLIENT_STOP_TIMEOUT = Duration.seconds(10);

export class CopilotSdkError extends Schema.TaggedError<CopilotSdkError>()("CopilotSdkError", {
  method: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `GitHub Copilot SDK ${this.method} failed.`;
  }
}

type ReasoningEffort = NonNullable<SessionConfig["reasoningEffort"]>;
type UserInputHandler = NonNullable<SessionConfig["onUserInputRequest"]>;
export type CopilotUserInputRequest = Parameters<UserInputHandler>[0];
export type CopilotUserInputResponse = Awaited<ReturnType<UserInputHandler>>;
/** Models also report "none", which the SDK's `ReasoningEffort` type predates. */
export type CopilotReasoningEffort = ReasoningEffort | "none";

export type CopilotSendAttachment = {
  readonly type: "file";
  readonly path: string;
  readonly displayName: string;
};

export interface CopilotSdkSessionOptions {
  readonly model?: string;
  readonly reasoningEffort?: CopilotReasoningEffort;
  readonly workingDirectory: string;
  readonly mcpServers: Readonly<Record<string, MCPServerConfig>>;
  readonly systemMessage?: string;
  /** Full access hands every permission to the SDK's `approveAll`; otherwise T3 answers them. */
  readonly approveAll: boolean;
}

/** Values the transcript keeps; MCP credentials and the system prompt stay out of it. */
export interface CopilotSdkLoggedSessionOptions {
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly workingDirectory: string;
  readonly mcpServers: ReadonlyArray<string>;
  readonly systemMessage: boolean;
  readonly permissions: "approve-all" | "host";
}

export type CopilotSdkOutboundFrame =
  | { readonly type: "session.create"; readonly options: CopilotSdkLoggedSessionOptions }
  | {
      readonly type: "session.resume";
      readonly sessionId: string;
      readonly options: CopilotSdkLoggedSessionOptions;
    }
  | {
      readonly type: "session.send";
      readonly prompt: string;
      readonly mode?: "immediate";
      readonly attachments?: ReadonlyArray<CopilotSendAttachment>;
    }
  | { readonly type: "session.abort" }
  | { readonly type: "session.setModel"; readonly model: string; readonly reasoningEffort?: string }
  | {
      readonly type: "permission.respond";
      readonly requestId: string;
      readonly result: PermissionRequestResult;
    }
  | {
      readonly type: "user_input.respond";
      readonly requestId: string;
      readonly response: CopilotUserInputResponse | null;
    };

export type CopilotSdkInboundFrame =
  | { readonly type: "call.result"; readonly method: string; readonly sessionId?: string }
  | { readonly type: "call.failed"; readonly method: string; readonly message: string }
  | { readonly type: "session.event"; readonly event: SessionEvent }
  | {
      readonly type: "user_input.request";
      readonly requestId: string;
      readonly request: CopilotUserInputRequest;
    };

export type CopilotSdkFrame =
  | { readonly direction: "outbound"; readonly frame: CopilotSdkOutboundFrame }
  | { readonly direction: "inbound"; readonly frame: CopilotSdkInboundFrame };

export interface CopilotSdkOpenSessionInput {
  readonly operation: "create" | "resume";
  /** Native session to resume; ignored when creating. */
  readonly sessionId?: string;
  readonly options: CopilotSdkSessionOptions;
  readonly onEvent: (event: SessionEvent) => void;
  readonly onUserInputRequest: (input: {
    readonly requestId: string;
    readonly request: CopilotUserInputRequest;
  }) => Promise<CopilotUserInputResponse>;
}

export interface CopilotSdkSendInput {
  readonly prompt: string;
  readonly mode?: "immediate";
  readonly attachments?: ReadonlyArray<CopilotSendAttachment>;
}

export interface CopilotSdkSession {
  readonly sessionId: string;
  readonly send: (input: CopilotSdkSendInput) => Effect.Effect<void, CopilotSdkError>;
  readonly abort: Effect.Effect<void, CopilotSdkError>;
  readonly setModel: (input: {
    readonly model: string;
    readonly reasoningEffort?: CopilotReasoningEffort;
  }) => Effect.Effect<void, CopilotSdkError>;
  readonly respondToPermission: (input: {
    readonly requestId: string;
    readonly result: PermissionRequestResult;
  }) => Effect.Effect<void, CopilotSdkError>;
  /** Releases the in-memory session; its history stays on disk for resume. */
  readonly disconnect: Effect.Effect<void>;
}

export interface CopilotSdkConnection {
  readonly openSession: (
    input: CopilotSdkOpenSessionInput,
  ) => Effect.Effect<CopilotSdkSession, CopilotSdkError>;
}

export interface CopilotSdkConnectInput {
  /** As configured; the runner resolves it on PATH because the SDK spawns an exact file. */
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly threadId?: string;
}

interface CopilotLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}

/** The SDK boundary the adapter drives; replay fixtures substitute it. */
export interface CopilotSdkRunner {
  readonly connect: (
    input: CopilotSdkConnectInput,
  ) => Effect.Effect<CopilotSdkConnection, CopilotSdkError, Scope.Scope>;
}

export function loggedSessionOptions(
  options: CopilotSdkSessionOptions,
): CopilotSdkLoggedSessionOptions {
  return {
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    workingDirectory: options.workingDirectory,
    mcpServers: Object.keys(options.mcpServers).toSorted(),
    systemMessage: options.systemMessage !== undefined,
    permissions: options.approveAll ? "approve-all" : "host",
  };
}

export function sendFrame(input: CopilotSdkSendInput): CopilotSdkOutboundFrame {
  return {
    type: "session.send",
    prompt: input.prompt,
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.attachments === undefined || input.attachments.length === 0
      ? {}
      : { attachments: input.attachments }),
  };
}

function definedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const loadSdk = Effect.tryPromise({
  try: () => import("@github/copilot-sdk"),
  catch: (cause) => new CopilotSdkError({ method: "import", cause }),
});

/** Stops gracefully, then kills a runtime that does not exit in time. */
const stopClient = (client: CopilotClient) =>
  Effect.tryPromise(() => client.stop()).pipe(
    Effect.timeout(CLIENT_STOP_TIMEOUT),
    Effect.catch(() => Effect.tryPromise(() => client.forceStop())),
    Effect.ignore,
  );

class CopilotBinaryNotFoundError extends Schema.TaggedError<CopilotBinaryNotFoundError>()(
  "CopilotBinaryNotFoundError",
  { binaryPath: Schema.String },
) {
  override get message(): string {
    return `GitHub Copilot CLI '${this.binaryPath}' was not found.`;
  }
}

/** Npm's Windows `.cmd` shims cannot be spawned without a shell, which the SDK never uses. */
export const resolveCopilotBinary = Effect.fn("resolveCopilotBinary")(function* (
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
) {
  const resolved = yield* resolveCommandPath(
    expandHomePath(binaryPath, yield* HostProcess.HomeDirectory),
    {
      env: environment,
    },
  );
  if (resolved === null) return yield* new CopilotBinaryNotFoundError({ binaryPath });
  return npmShimExecutable(resolved) ?? resolved;
});

/** Spawns the user's `copilot` over stdio; the SDK's bundled runtime is never used. */
const startClient = Effect.fn("CopilotSdk.startClient")(function* (input: CopilotLaunch) {
  const sdk = yield* loadSdk;
  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const client = new sdk.CopilotClient({
          connection: sdk.RuntimeConnection.forStdio({
            path: input.command,
            args: [...input.args],
            env: definedEnvironment(input.environment),
          }),
          workingDirectory: input.cwd,
          clientInfo: { applicationName: "t3-code", integrationName: "provider-copilot" },
        });
        try {
          await client.start();
        } catch (cause) {
          await client.forceStop().catch(() => undefined);
          throw cause;
        }
        return client;
      },
      catch: (cause) => new CopilotSdkError({ method: "client.start", cause }),
    }),
    stopClient,
  );
});

export const makeCopilotSdkRunner = Effect.fn("makeCopilotSdkRunner")(function* (
  tap?: (frame: CopilotSdkFrame) => void,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outbound = (frame: CopilotSdkOutboundFrame) => tap?.({ direction: "outbound", frame });
  const inbound = (frame: CopilotSdkInboundFrame) => tap?.({ direction: "inbound", frame });
  const call = <A>(method: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: async () => {
        try {
          const value = await run();
          inbound({ type: "call.result", method });
          return value;
        } catch (cause) {
          inbound({ type: "call.failed", method, message: errorMessage(cause) });
          throw cause;
        }
      },
      catch: (cause) => new CopilotSdkError({ method, cause }),
    });

  return {
    connect: Effect.fn("CopilotSdkRunner.connect")(function* (input) {
      const sdk = yield* loadSdk;
      const command = yield* resolveCopilotBinary(input.binaryPath, input.environment).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError((cause) => new CopilotSdkError({ method: "client.resolve", cause })),
      );
      const agentScope = yield* AgentScope;
      const launch = yield* agentScope.wrap({
        command,
        args: [],
        name: "copilot",
        threadId: input.threadId,
        env: input.environment,
      });
      // Finalizers run in reverse: reap detached tool processes after the runtime stops.
      if (launch.unit !== undefined)
        yield* Effect.addFinalizer(() => agentScope.stop(launch.unit!));
      const client = yield* startClient({
        command: launch.command,
        args: launch.args,
        environment: input.environment,
        cwd: input.cwd,
      });
      return {
        openSession: Effect.fn("CopilotSdkRunner.openSession")(function* (open) {
          const logged = loggedSessionOptions(open.options);
          outbound(
            open.operation === "create"
              ? { type: "session.create", options: logged }
              : { type: "session.resume", sessionId: open.sessionId ?? "", options: logged },
          );
          let userInputOrdinal = 0;
          const config = {
            ...(open.options.model === undefined ? {} : { model: open.options.model }),
            ...(open.options.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: open.options.reasoningEffort as ReasoningEffort }),
            workingDirectory: open.options.workingDirectory,
            streaming: true,
            mcpServers: { ...open.options.mcpServers },
            ...(open.options.systemMessage === undefined
              ? {}
              : {
                  systemMessage: { mode: "append" as const, content: open.options.systemMessage },
                }),
            // "no-result" leaves the request pending for the pending-permission RPC, which keeps
            // Copilot's own request ids and completion events.
            onPermissionRequest: open.options.approveAll
              ? sdk.approveAll
              : () => ({ kind: "no-result" as const }),
            onUserInputRequest: (request: CopilotUserInputRequest) => {
              userInputOrdinal += 1;
              const requestId = `user-input-${userInputOrdinal}`;
              inbound({ type: "user_input.request", requestId, request });
              return open.onUserInputRequest({ requestId, request }).then(
                (response) => {
                  outbound({ type: "user_input.respond", requestId, response });
                  return response;
                },
                (cause: unknown) => {
                  outbound({ type: "user_input.respond", requestId, response: null });
                  throw cause;
                },
              );
            },
            onEvent: (event: SessionEvent) => {
              inbound({ type: "session.event", event });
              open.onEvent(event);
            },
          } satisfies SessionConfig;
          const method = open.operation === "create" ? "session.create" : "session.resume";
          const session = yield* Effect.tryPromise({
            try: async () => {
              try {
                const opened =
                  open.operation === "create"
                    ? await client.createSession(config)
                    : await client.resumeSession(open.sessionId ?? "", config);
                inbound({ type: "call.result", method, sessionId: opened.sessionId });
                return opened;
              } catch (cause) {
                inbound({ type: "call.failed", method, message: errorMessage(cause) });
                throw cause;
              }
            },
            catch: (cause) => new CopilotSdkError({ method, cause }),
          });
          return {
            sessionId: session.sessionId,
            send: (sendInput) => {
              outbound(sendFrame(sendInput));
              const message: MessageOptions = {
                prompt: sendInput.prompt,
                ...(sendInput.mode === undefined ? {} : { mode: sendInput.mode }),
                ...(sendInput.attachments === undefined || sendInput.attachments.length === 0
                  ? {}
                  : {
                      attachments: sendInput.attachments.map((attachment) => ({ ...attachment })),
                    }),
              };
              return call("session.send", () => session.send(message)).pipe(Effect.asVoid);
            },
            abort: Effect.suspend(() => {
              outbound({ type: "session.abort" });
              return call("session.abort", () => session.abort());
            }),
            setModel: (model) => {
              outbound({
                type: "session.setModel",
                model: model.model,
                ...(model.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: model.reasoningEffort }),
              });
              return call("session.setModel", () =>
                session.setModel(
                  model.model,
                  model.reasoningEffort === undefined
                    ? undefined
                    : { reasoningEffort: model.reasoningEffort as ReasoningEffort },
                ),
              );
            },
            respondToPermission: (response) => {
              outbound({
                type: "permission.respond",
                requestId: response.requestId,
                result: response.result,
              });
              return call("permission.respond", () =>
                session.rpc.permissions.handlePendingPermissionRequest({
                  requestId: response.requestId,
                  // "no-result" never reaches the runtime; the handler path filters it the same way.
                  result: response.result as Exclude<
                    PermissionRequestResult,
                    { kind: "no-result" }
                  >,
                }),
              ).pipe(Effect.asVoid);
            },
            // Older runtimes lack session.detach; client.stop still ends the process.
            disconnect: Effect.tryPromise(() => session.disconnect()).pipe(Effect.ignore),
          } satisfies CopilotSdkSession;
        }),
      } satisfies CopilotSdkConnection;
    }),
  } satisfies CopilotSdkRunner;
});

export interface CopilotRuntimeProbe {
  readonly version: string;
  readonly auth: GetAuthStatusResponse;
  readonly models: ReadonlyArray<ModelInfo> | null;
}

/** Status probe: starts the runtime without opening a session, so no MCP servers or hooks run. */
export const probeCopilotRuntime = Effect.fn("probeCopilotRuntime")(function* (input: {
  readonly command: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}) {
  const client = yield* startClient({ ...input, args: [] });
  const status = yield* Effect.tryPromise({
    try: () => client.getStatus(),
    catch: (cause) => new CopilotSdkError({ method: "status.get", cause }),
  });
  const auth = yield* Effect.tryPromise({
    try: () => client.getAuthStatus(),
    catch: (cause) => new CopilotSdkError({ method: "auth.getStatus", cause }),
  });
  const models = auth.isAuthenticated
    ? yield* Effect.tryPromise(() => client.listModels()).pipe(Effect.orElseSucceed(() => null))
    : null;
  return { version: status.version, auth, models } satisfies CopilotRuntimeProbe;
}, Effect.scoped);
