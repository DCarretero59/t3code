import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveCopilotBinary } from "@t3tools/provider-copilot/testing";

it.effect.each([
  [
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\node_modules\\@github\\copilot\\npm-loader.js" %*',
    true,
  ],
  ['"%dp0%\\node_modules\\@github\\copilot\\copilot.exe" %*', false],
  ['"%_prog%" "%dp0%\\node_modules\\other\\cli.js" %*', false],
  ['"%_prog%" "%dp0%\\node_modules\\@github\\copilot\\npm-loader.js" --extra %*', false],
] as const)(
  "resolves npm Copilot shims without executing a shell %j",
  ([command, resolvesLoader]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "copilot-shim-" });
      const shim = path.join(directory, "copilot.cmd");
      const loader = path.join(directory, "node_modules", "@github", "copilot", "npm-loader.js");
      yield* fs.makeDirectory(path.dirname(loader), { recursive: true });
      yield* fs.writeFileString(loader, "");
      yield* fs.writeFileString(shim, `@ECHO off\r\n${command}\r\n`);
      yield* fs.chmod(shim, 0o755);
      const resolved = yield* resolveCopilotBinary(shim, { PATHEXT: ".CMD;.JS" });
      expect(resolved).toBe(resolvesLoader ? loader : shim);
    }).pipe(Effect.provide(NodeServices.layer)),
);
