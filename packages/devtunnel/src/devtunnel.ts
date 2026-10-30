import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** Management commands round-trip to the tunnel service, so allow for a slow region. */
const DEVTUNNEL_COMMAND_TIMEOUT = Duration.seconds(30);
const DEVTUNNEL_HOST_READY_TIMEOUT = Duration.seconds(45);
const DEVTUNNEL_KILL_GRACE = Duration.millis(500);

const devTunnelCommandForPlatform = (platform: NodeJS.Platform): "devtunnel" | "devtunnel.exe" =>
  platform === "win32" ? "devtunnel.exe" : "devtunnel";

const DevTunnelCommandContext = {
  executable: Schema.Literals(["devtunnel", "devtunnel.exe"]),
  subcommand: Schema.Literals(["user", "show", "create", "port", "host"]),
  argumentCount: Schema.Number,
};

type DevTunnelSubcommand = typeof DevTunnelCommandContext.subcommand.Type;

/**
 * Failure kinds we can name without quoting the CLI. Stderr can carry tunnel
 * ids and account names, and these labels are logged.
 */
export const DevTunnelStderrDiagnostic = Schema.Literals([
  "not-logged-in",
  "not-found",
  "conflict",
  "unknown",
]);
export type DevTunnelStderrDiagnostic = typeof DevTunnelStderrDiagnostic.Type;

const STDERR_DIAGNOSTIC_PATTERNS: ReadonlyArray<
  readonly [RegExp, Exclude<DevTunnelStderrDiagnostic, "unknown">]
> = [
  [/not logged in|login required|unauthorized|user login/i, "not-logged-in"],
  [/not found/i, "not-found"],
  [/conflict/i, "conflict"],
];

const stderrDiagnosticOf = (stderr: string): DevTunnelStderrDiagnostic | undefined => {
  if (stderr.trim().length === 0) {
    return undefined;
  }
  return STDERR_DIAGNOSTIC_PATTERNS.find(([pattern]) => pattern.test(stderr))?.[1] ?? "unknown";
};

export class DevTunnelCommandSpawnError extends Schema.TaggedError<DevTunnelCommandSpawnError>()(
  "DevTunnelCommandSpawnError",
  {
    ...DevTunnelCommandContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to spawn devtunnel ${this.subcommand}. Is the devtunnel CLI installed?`;
  }
}

export class DevTunnelCommandOutputError extends Schema.TaggedError<DevTunnelCommandOutputError>()(
  "DevTunnelCommandOutputError",
  {
    ...DevTunnelCommandContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read output from devtunnel ${this.subcommand}.`;
  }
}

export class DevTunnelCommandExitError extends Schema.TaggedError<DevTunnelCommandExitError>()(
  "DevTunnelCommandExitError",
  {
    ...DevTunnelCommandContext,
    exitCode: Schema.Number,
    stderrLength: Schema.Number,
    stderrDiagnostic: Schema.optional(DevTunnelStderrDiagnostic),
  },
) {
  override get message(): string {
    return this.stderrDiagnostic === "not-logged-in"
      ? "devtunnel is not signed in. Run `devtunnel user login -g`."
      : `devtunnel ${this.subcommand} exited with code ${this.exitCode}.`;
  }
}

export class DevTunnelCommandTimeoutError extends Schema.TaggedError<DevTunnelCommandTimeoutError>()(
  "DevTunnelCommandTimeoutError",
  {
    ...DevTunnelCommandContext,
    timeoutMs: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `devtunnel ${this.subcommand} timed out after ${this.timeoutMs}ms.`;
  }
}

export class DevTunnelOutputParseError extends Schema.TaggedError<DevTunnelOutputParseError>()(
  "DevTunnelOutputParseError",
  {
    subcommand: DevTunnelCommandContext.subcommand,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode devtunnel ${this.subcommand} JSON.`;
  }
}

export class DevTunnelHostExitedError extends Schema.TaggedError<DevTunnelHostExitedError>()(
  "DevTunnelHostExitedError",
  { exitCode: Schema.Number },
) {
  override get message(): string {
    return `devtunnel host exited with code ${this.exitCode} before it was ready.`;
  }
}

export class DevTunnelHostTimeoutError extends Schema.TaggedError<DevTunnelHostTimeoutError>()(
  "DevTunnelHostTimeoutError",
  { timeoutMs: Schema.Number },
) {
  override get message(): string {
    return `devtunnel host did not report a public URL within ${this.timeoutMs}ms.`;
  }
}

export type DevTunnelCommandError =
  | DevTunnelCommandSpawnError
  | DevTunnelCommandOutputError
  | DevTunnelCommandExitError
  | DevTunnelCommandTimeoutError;

export type DevTunnelError =
  | DevTunnelCommandError
  | DevTunnelOutputParseError
  | DevTunnelHostExitedError
  | DevTunnelHostTimeoutError;

const collectText = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const runDevTunnelCommand = Effect.fn("devtunnel.runDevTunnelCommand")(function* (
  args: readonly [DevTunnelSubcommand, ...string[]],
): Effect.fn.Return<string, DevTunnelCommandError, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const executable = devTunnelCommandForPlatform(yield* HostProcess.Platform);
  const commandContext = {
    executable,
    subcommand: args[0],
    argumentCount: args.length,
  };
  return yield* Effect.gen(function* () {
    const child = yield* spawner
      .spawn(ChildProcess.make(executable, [...args], { forceKillAfter: DEVTUNNEL_KILL_GRACE }))
      .pipe(
        Effect.mapError((cause) => new DevTunnelCommandSpawnError({ ...commandContext, cause })),
        // A non-directory entry on PATH makes node throw ENOTDIR synchronously, as a defect.
        Effect.catchDefect((cause) =>
          Effect.fail(new DevTunnelCommandSpawnError({ ...commandContext, cause })),
        ),
      );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectText(child.stdout),
        collectText(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.mapError((cause) => new DevTunnelCommandOutputError({ ...commandContext, cause })),
    );
    if (exitCode !== 0) {
      const stderrDiagnostic = stderrDiagnosticOf(stderr);
      return yield* new DevTunnelCommandExitError({
        ...commandContext,
        exitCode,
        stderrLength: stderr.length,
        ...(stderrDiagnostic !== undefined ? { stderrDiagnostic } : {}),
      });
    }
    return stdout;
  }).pipe(
    Effect.scoped,
    Effect.timeout(DEVTUNNEL_COMMAND_TIMEOUT),
    Effect.catchTags({
      TimeoutError: (cause) =>
        Effect.fail(
          new DevTunnelCommandTimeoutError({
            ...commandContext,
            timeoutMs: Duration.toMillis(DEVTUNNEL_COMMAND_TIMEOUT),
            cause,
          }),
        ),
    }),
  );
});

/** The CLI can print its first-run license banner on stdout ahead of the JSON document. */
function extractDevTunnelJson(stdout: string): string {
  const start = stdout.search(/^\{/m);
  return start === -1 ? stdout : stdout.slice(start);
}

const decodeCommandJson =
  <S extends Schema.Top>(subcommand: DevTunnelSubcommand, schema: S) =>
  (stdout: string) =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(extractDevTunnelJson(stdout)).pipe(
      Effect.mapError((cause) => new DevTunnelOutputParseError({ subcommand, cause })),
    );

const DevTunnelUserJson = Schema.Struct({
  status: Schema.String,
  provider: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String),
});

export interface DevTunnelUser {
  readonly loggedIn: boolean;
  readonly provider: string | null;
  readonly username: string | null;
}

export const parseDevTunnelUser = (stdout: string) =>
  decodeCommandJson(
    "user",
    DevTunnelUserJson,
  )(stdout).pipe(
    Effect.map((user): DevTunnelUser => ({
      loggedIn: user.status.toLowerCase() === "logged in",
      provider: user.provider ?? null,
      username: user.username ?? null,
    })),
  );

export const readDevTunnelUser = runDevTunnelCommand(["user", "show", "--json"]).pipe(
  Effect.flatMap(parseDevTunnelUser),
);

const DevTunnelJson = Schema.Struct({
  tunnel: Schema.Struct({
    tunnelId: Schema.String,
    ports: Schema.optional(Schema.Array(Schema.Struct({ portNumber: Schema.Number }))),
  }),
});

export interface DevTunnelSummary {
  readonly tunnelId: string;
  readonly ports: ReadonlyArray<number>;
}

export const parseDevTunnel = (subcommand: "show" | "create") => (stdout: string) =>
  decodeCommandJson(
    subcommand,
    DevTunnelJson,
  )(stdout).pipe(
    Effect.map(({ tunnel }): DevTunnelSummary => ({
      tunnelId: tunnel.tunnelId,
      ports: (tunnel.ports ?? []).map((port) => port.portNumber),
    })),
  );

/** `null` when the tunnel no longer exists, for example after 30 days without a host. */
const showDevTunnel = (tunnelId: string) =>
  runDevTunnelCommand(["show", tunnelId, "--json"]).pipe(
    Effect.flatMap(parseDevTunnel("show")),
    Effect.catchTags({
      DevTunnelCommandExitError: (error) =>
        error.stderrDiagnostic === "not-found" ? Effect.succeed(null) : Effect.fail(error),
    }),
  );

// Rewriting would make a cross-site request look same-origin to the server's browser-origin check.
const PRESERVE_FORWARDED_HEADERS = ["--host-header", "unchanged", "--origin-header", "unchanged"];

const createDevTunnel = (description: string) =>
  runDevTunnelCommand([
    "create",
    // The environment authenticates every request itself, like any other route.
    "--allow-anonymous",
    ...PRESERVE_FORWARDED_HEADERS,
    "--description",
    description,
    "--json",
  ]).pipe(Effect.flatMap(parseDevTunnel("create")));

export interface EnsuredDevTunnel {
  readonly tunnelId: string;
  readonly created: boolean;
}

/**
 * Reuses the stored tunnel so its public URL survives restarts, and leaves it
 * forwarding exactly `port`.
 */
export const ensureDevTunnel = Effect.fn("devtunnel.ensureDevTunnel")(function* (input: {
  readonly tunnelId: string | null;
  readonly port: number;
  readonly description: string;
}): Effect.fn.Return<
  EnsuredDevTunnel,
  DevTunnelCommandError | DevTunnelOutputParseError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const existing = input.tunnelId === null ? null : yield* showDevTunnel(input.tunnelId);
  const tunnel = existing ?? (yield* createDevTunnel(input.description));
  for (const stalePort of tunnel.ports.filter((port) => port !== input.port)) {
    yield* runDevTunnelCommand([
      "port",
      "delete",
      tunnel.tunnelId,
      "--port-number",
      String(stalePort),
    ]);
  }
  if (!tunnel.ports.includes(input.port)) {
    yield* runDevTunnelCommand([
      "port",
      "create",
      tunnel.tunnelId,
      "--port-number",
      String(input.port),
      "--protocol",
      "http",
      ...PRESERVE_FORWARDED_HEADERS,
      "--json",
    ]);
  }
  return { tunnelId: tunnel.tunnelId, created: existing === null };
});

export type DevTunnelHostOutput =
  | { readonly _tag: "url"; readonly url: string }
  | { readonly _tag: "ready" };

const WEB_FORWARDING_LABEL = /^[a-z0-9]+-\d+$/i;

/**
 * Current CLIs print `Connect via browser: https://<id>-<port>.<region>.devtunnels.ms`;
 * older ones list `Hosting port <port> at <urls>`. Both also name an `-inspect` URL.
 */
export function parseDevTunnelHostLine(line: string): DevTunnelHostOutput | null {
  if (/^ready to accept connections\b/i.test(line.trim())) {
    return { _tag: "ready" };
  }
  for (const match of line.matchAll(/https:\/\/[^\s,]+/g)) {
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    const [label, ...rest] = url.hostname.split(".");
    if (
      label !== undefined &&
      WEB_FORWARDING_LABEL.test(label) &&
      url.hostname.endsWith(".devtunnels.ms") &&
      rest.length >= 2 &&
      url.port === ""
    ) {
      return { _tag: "url", url: `${url.origin}/` };
    }
  }
  return null;
}

export interface DevTunnelHost {
  /** Web-forwarding origin with a trailing slash. */
  readonly url: string;
  /** Resolves when the host process exits. */
  readonly exitCode: Effect.Effect<number, DevTunnelCommandOutputError>;
}

/** Hosts the tunnel until the surrounding scope closes. */
export const hostDevTunnel = Effect.fn("devtunnel.hostDevTunnel")(function* (input: {
  readonly tunnelId: string;
}): Effect.fn.Return<
  DevTunnelHost,
  DevTunnelCommandSpawnError | DevTunnelHostExitedError | DevTunnelHostTimeoutError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const executable = devTunnelCommandForPlatform(yield* HostProcess.Platform);
  const commandContext = { executable, subcommand: "host" as const, argumentCount: 2 };
  const child = yield* spawner
    .spawn(
      ChildProcess.make(executable, ["host", input.tunnelId], {
        forceKillAfter: DEVTUNNEL_KILL_GRACE,
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    .pipe(
      Effect.mapError((cause) => new DevTunnelCommandSpawnError({ ...commandContext, cause })),
      Effect.catchDefect((cause) =>
        Effect.fail(new DevTunnelCommandSpawnError({ ...commandContext, cause })),
      ),
    );
  const exitCode = child.exitCode.pipe(
    Effect.map(Number),
    Effect.mapError((cause) => new DevTunnelCommandOutputError({ ...commandContext, cause })),
  );

  const url = yield* Deferred.make<string>();
  const ready = yield* Deferred.make<void>();
  // Keep draining after readiness so a full pipe never stalls the host.
  yield* child.all.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => {
      const output = parseDevTunnelHostLine(line);
      if (output?._tag === "url") return Deferred.succeed(url, output.url);
      if (output?._tag === "ready") return Deferred.succeed(ready, undefined);
      return Effect.void;
    }),
    Effect.ignore,
    Effect.forkScoped,
  );

  const publicUrl = yield* Effect.raceFirst(
    Deferred.await(ready).pipe(Effect.andThen(Deferred.await(url))),
    exitCode.pipe(
      Effect.orElseSucceed(() => -1),
      Effect.flatMap((code) => Effect.fail(new DevTunnelHostExitedError({ exitCode: code }))),
    ),
  ).pipe(
    Effect.timeoutOrElse({
      duration: DEVTUNNEL_HOST_READY_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new DevTunnelHostTimeoutError({
            timeoutMs: Duration.toMillis(DEVTUNNEL_HOST_READY_TIMEOUT),
          }),
        ),
    }),
  );
  return { url: publicUrl, exitCode };
});
