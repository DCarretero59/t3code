import { expect, it } from "@effect/vitest";

import { copilotRuntimeEnvironment } from "./environment.ts";

it("drops inherited Copilot credentials in any case and keeps the rest", () => {
  const source = {
    PATH: "/bin",
    GH_TOKEN: "inherited",
    github_token: "inherited",
    Copilot_GitHub_Token: "inherited",
    GITHUB_COPILOT_API_TOKEN: "inherited",
    COPILOT_HOME: "/copilot",
  };
  expect(copilotRuntimeEnvironment(source)).toEqual({ PATH: "/bin", COPILOT_HOME: "/copilot" });
  expect(source.GH_TOKEN).toBe("inherited");
});
