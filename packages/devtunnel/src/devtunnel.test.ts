import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import {
  DevTunnelCommandExitError,
  ensureDevTunnel,
  parseDevTunnel,
  parseDevTunnelHostLine,
  parseDevTunnelUser,
} from "./devtunnel.ts";

const encoder = new TextEncoder();

const BANNER = `Welcome to dev tunnels!
CLI version: 1.0.2115+e16833f284

By using the software, you agree to
  - the dev tunnels License Terms: https://aka.ms/devtunnels/tos

`;

// Captured from devtunnel 1.0.2115.
const CREATED_TUNNEL = `{
  "tunnel": {
    "tunnelId": "interesting-hill-05w2zgd.usw3",
    "hostConnections": 0,
    "labels": [],
    "hostRequestHeader": "unchanged",
    "originRequestHeader": "unchanged",
    "accessControl": [{ "type": "Anonymous", "subjects": [], "scopes": ["connect"] }]
  }
}`;

const tunnelWithPorts = (ports: ReadonlyArray<number>) =>
  JSON.stringify({
    tunnel: {
      tunnelId: "interesting-hill-05w2zgd.usw3",
      ports: ports.map((portNumber) => ({ portNumber, protocol: "http" })),
    },
  });

function mockHandle(result: { stdout?: string; stderr?: string; code?: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function layerMockSpawner(
  handler: (args: ReadonlyArray<string>) => { stdout?: string; stderr?: string; code?: number },
) {
  const calls: Array<ReadonlyArray<string>> = [];
  const layer = Layer.merge(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
        calls.push(args);
        return Effect.succeed(mockHandle(handler(args)));
      }),
    ),
    Layer.succeed(HostProcess.Platform, "darwin"),
  );
  return { calls, layer };
}

describe("devtunnel", () => {
  it.effect("parses JSON printed after the license banner", () =>
    Effect.gen(function* () {
      const user = yield* parseDevTunnelUser(
        `${BANNER}{"status":"Logged in","provider":"github","username":"octocat"}`,
      );
      assert.deepEqual(user, { loggedIn: true, provider: "github", username: "octocat" });

      const signedOut = yield* parseDevTunnelUser(`{"status":"Not logged in"}`);
      assert.deepEqual(signedOut, { loggedIn: false, provider: null, username: null });

      const created = yield* parseDevTunnel("create")(`${BANNER}${CREATED_TUNNEL}`);
      assert.deepEqual(created, { tunnelId: "interesting-hill-05w2zgd.usw3", ports: [] });
    }),
  );

  it("finds the web-forwarding URL in current and older host output", () => {
    assert.deepEqual(
      parseDevTunnelHostLine("Connect via browser: https://3n8rj3rj-38123.usw3.devtunnels.ms"),
      { _tag: "url", url: "https://3n8rj3rj-38123.usw3.devtunnels.ms/" },
    );
    assert.deepEqual(
      parseDevTunnelHostLine(
        "Hosting port 8080 at https://abc123.usw2.devtunnels.ms:8080/, https://abc123-8080.usw2.devtunnels.ms/ and inspect it at https://abc123-8080-inspect.usw2.devtunnels.ms/",
      ),
      { _tag: "url", url: "https://abc123-8080.usw2.devtunnels.ms/" },
    );
    assert.isNull(
      parseDevTunnelHostLine(
        "Inspect network activity: https://3n8rj3rj-38123-inspect.usw3.devtunnels.ms",
      ),
    );
    assert.deepEqual(
      parseDevTunnelHostLine("Ready to accept connections for tunnel: interesting-hill.usw3"),
      { _tag: "ready" },
    );
    assert.isNull(parseDevTunnelHostLine("Connection to host tunnel relay restored."));
  });

  it.effect("reuses a stored tunnel and leaves it forwarding only the current port", () => {
    const { calls, layer } = layerMockSpawner((args) =>
      args[0] === "show" ? { stdout: tunnelWithPorts([3773, 3774]) } : { stdout: "{}" },
    );
    return Effect.gen(function* () {
      const ensured = yield* ensureDevTunnel({
        tunnelId: "interesting-hill-05w2zgd.usw3",
        port: 3775,
        description: "T3 Code",
      }).pipe(Effect.provide(layer));
      assert.deepEqual(ensured, { tunnelId: "interesting-hill-05w2zgd.usw3", created: false });
      assert.deepEqual(
        calls.map((args) => args.slice(0, 5)),
        [
          ["show", "interesting-hill-05w2zgd.usw3", "--json"],
          ["port", "delete", "interesting-hill-05w2zgd.usw3", "--port-number", "3773"],
          ["port", "delete", "interesting-hill-05w2zgd.usw3", "--port-number", "3774"],
          ["port", "create", "interesting-hill-05w2zgd.usw3", "--port-number", "3775"],
        ],
      );
      const portCreate = calls[3]!;
      assert.includeMembers([...portCreate], ["--host-header", "--origin-header", "unchanged"]);
    });
  });

  it.effect(
    "creates an anonymous tunnel that keeps Host and Origin when the stored one is gone",
    () => {
      const { calls, layer } = layerMockSpawner((args) => {
        if (args[0] === "show") {
          return { code: 2, stderr: "Tunnel not found in usw3: expired-tunnel" };
        }
        if (args[0] === "create") return { stdout: `${BANNER}${CREATED_TUNNEL}` };
        return { stdout: "{}" };
      });
      return Effect.gen(function* () {
        const ensured = yield* ensureDevTunnel({
          tunnelId: "expired-tunnel.usw3",
          port: 3773,
          description: "T3 Code",
        }).pipe(Effect.provide(layer));
        assert.deepEqual(ensured, { tunnelId: "interesting-hill-05w2zgd.usw3", created: true });
        const create = calls.find((args) => args[0] === "create")!;
        assert.includeMembers(
          [...create],
          ["--allow-anonymous", "--host-header", "--origin-header", "unchanged"],
        );
        assert.deepEqual(calls.at(-1)?.slice(0, 5), [
          "port",
          "create",
          "interesting-hill-05w2zgd.usw3",
          "--port-number",
          "3773",
        ]);
      });
    },
  );

  it.effect("names a signed-out CLI without quoting stderr", () => {
    const { layer } = layerMockSpawner(() => ({
      code: 1,
      stderr: "Login required. Run devtunnel user login for octocat@example.com",
    }));
    return Effect.gen(function* () {
      const error = yield* ensureDevTunnel({ tunnelId: null, port: 3773, description: "T3" }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      assert.instanceOf(error, DevTunnelCommandExitError);
      assert.equal(error.stderrDiagnostic, "not-logged-in");
      assert.notInclude(error.message, "octocat");
    });
  });
});
