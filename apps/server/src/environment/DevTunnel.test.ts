import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { hostDevTunnelOnce, readDevTunnelState } from "./DevTunnel.ts";

const encoder = new TextEncoder();
const TUNNEL_URL = "https://3n8rj3rj-3773.usw3.devtunnels.ms/";

const handle = (input: {
  readonly stdout?: string;
  readonly all?: ReadonlyArray<string>;
  readonly exitCode?: Effect.Effect<number>;
}) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: (input.exitCode ?? Effect.succeed(0)).pipe(Effect.map(ChildProcessSpawner.ExitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(input.stdout ?? "")),
    stderr: Stream.empty,
    all: Stream.fromIterable((input.all ?? []).map((line) => encoder.encode(`${line}\n`))),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

it.effect("reuses the stored tunnel and publishes its URL only while the host runs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const statePath = path.join(yield* fs.makeTempDirectoryScoped(), "devtunnel.json");
    yield* fs.writeFileString(statePath, JSON.stringify({ tunnelId: "stored.usw3" }));

    const hostExit = yield* Deferred.make<number>();
    const commands: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
      commands.push(args);
      switch (args[0]) {
        case "user":
          return Effect.succeed(handle({ stdout: `{"status":"Logged in"}` }));
        case "show":
          return Effect.succeed(
            handle({
              stdout: JSON.stringify({
                tunnel: { tunnelId: "stored.usw3", ports: [{ portNumber: 3773 }] },
              }),
            }),
          );
        case "host":
          return Effect.succeed(
            handle({
              all: [
                "Hosting port: 3773",
                `Connect via browser: ${TUNNEL_URL}`,
                "Ready to accept connections for tunnel: stored.usw3",
              ],
              exitCode: Deferred.await(hostExit),
            }),
          );
        default:
          return Effect.die(`unexpected devtunnel ${args.join(" ")}`);
      }
    });

    const published = yield* Ref.make<ReadonlyArray<Option.Option<string>>>([]);
    yield* hostDevTunnelOnce({
      statePath,
      port: 3773,
      // The host exits once its URL is published, like a dropped relay connection.
      publish: (url) =>
        Ref.update(published, (all) => [...all, url]).pipe(
          Effect.andThen(Option.isSome(url) ? Deferred.succeed(hostExit, 1) : Effect.void),
        ),
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

    assert.deepEqual(yield* Ref.get(published), [Option.some(TUNNEL_URL), Option.none()]);
    assert.deepEqual(
      commands.map((args) => args[0]),
      ["user", "show", "host"],
    );
    assert.deepEqual(
      yield* readDevTunnelState(statePath),
      Option.some({ tunnelId: "stored.usw3", url: TUNNEL_URL }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
