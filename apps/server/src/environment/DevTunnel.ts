import { ensureDevTunnel, hostDevTunnel, readDevTunnelUser } from "@t3tools/devtunnel";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeOS from "node:os";

import * as ServerConfig from "../config.ts";
import { isLoopbackHost } from "../startupAccess.ts";

export const DEVTUNNEL_STATE_FILE = "devtunnel.json";
const RETRY_DELAY = "30 seconds";

/** The tunnel id outlives the server so its public URL stays stable across restarts. */
export const PersistedDevTunnelState = Schema.Struct({
  tunnelId: Schema.String,
  url: Schema.optional(Schema.String),
});
export type PersistedDevTunnelState = typeof PersistedDevTunnelState.Type;

const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(PersistedDevTunnelState));

export const readDevTunnelState = Effect.fn("DevTunnel.readState")(function* (statePath: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(statePath).pipe(Effect.flatMap(decodeState), Effect.option);
});

class DevTunnelSignedOutError extends Schema.TaggedError<DevTunnelSignedOutError>()(
  "DevTunnelSignedOutError",
  {},
) {
  override get message(): string {
    return "devtunnel is not signed in. Run `devtunnel user login -g` on this machine.";
  }
}

/** Dev servers pair through the Vite origin, which proxies the backend. */
export const devTunnelTargetPort = (
  config: Pick<ServerConfig.ServerConfig["Service"], "devUrl">,
  serverPort: number,
): number => {
  const devUrl = config.devUrl;
  if (devUrl?.protocol === "http:" && isLoopbackHost(devUrl.hostname)) {
    return devUrl.port.length > 0 ? Number.parseInt(devUrl.port, 10) : 80;
  }
  return serverPort;
};

/** One hosting session: reuse or create the tunnel, host it, publish its URL until the host exits. */
export const hostDevTunnelOnce = Effect.fn("DevTunnel.hostOnce")(function* (input: {
  readonly statePath: string;
  readonly port: number;
  readonly publish: (url: Option.Option<string>) => Effect.Effect<void>;
}) {
  const writeState = (state: PersistedDevTunnelState) =>
    writeFileStringAtomically({
      filePath: input.statePath,
      contents: `${JSON.stringify(state)}\n`,
    });
  const user = yield* readDevTunnelUser;
  if (!user.loggedIn) {
    return yield* new DevTunnelSignedOutError();
  }
  const stored = yield* readDevTunnelState(input.statePath);
  const ensured = yield* ensureDevTunnel({
    tunnelId: Option.match(stored, { onNone: () => null, onSome: (state) => state.tunnelId }),
    port: input.port,
    description: `T3 Code on ${NodeOS.hostname()}`,
  });
  // Record a new tunnel before hosting so a failed start never leaks another one.
  yield* writeState({ tunnelId: ensured.tunnelId });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const host = yield* hostDevTunnel({ tunnelId: ensured.tunnelId });
      yield* writeState({ tunnelId: ensured.tunnelId, url: host.url });
      yield* Effect.logInfo("Dev tunnel is publishing this server", {
        url: host.url,
        port: input.port,
        created: ensured.created,
      });
      yield* input.publish(Option.some(host.url));
      const exitCode = yield* host.exitCode;
      yield* Effect.logWarning("devtunnel host exited; reconnecting", { exitCode });
    }),
  ).pipe(Effect.ensuring(input.publish(Option.none())));
});

export class DevTunnel extends Context.Service<
  DevTunnel,
  {
    /** The web-forwarding origin while `devtunnel host` is connected. */
    readonly publicUrl: Effect.Effect<Option.Option<string>>;
    /** Hosts the tunnel for `port` until interrupted, reconnecting after failures. */
    readonly run: (port: number) => Effect.Effect<never>;
  }
>()("t3/environment/DevTunnel") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const statePath = path.join(config.stateDir, DEVTUNNEL_STATE_FILE);
  const publicUrl = yield* Ref.make(Option.none<string>());
  const lastFailure = yield* Ref.make<string | null>(null);

  const publish = (url: Option.Option<string>) =>
    Ref.set(publicUrl, url).pipe(
      Effect.andThen(Option.isSome(url) ? Ref.set(lastFailure, null) : Effect.void),
    );

  // Log each distinct failure once; a signed-out CLI would otherwise warn every retry.
  const reportFailure = (error: { readonly message: string }) =>
    Ref.getAndSet(lastFailure, error.message).pipe(
      Effect.flatMap((previous) =>
        previous === error.message
          ? Effect.void
          : Effect.logWarning("Dev tunnel is unavailable", { reason: error.message }),
      ),
    );

  const run = (port: number): Effect.Effect<never> =>
    hostDevTunnelOnce({ statePath, port, publish }).pipe(
      Effect.catch(reportFailure),
      Effect.andThen(Effect.sleep(RETRY_DELAY)),
      Effect.forever,
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  return DevTunnel.of({ publicUrl: Ref.get(publicUrl), run });
});

export const layer = Layer.effect(DevTunnel, make);
