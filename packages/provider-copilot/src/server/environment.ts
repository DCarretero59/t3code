/**
 * Copilot signs in with the first of these it finds, ahead of `copilot login`. An inherited value
 * would let every instance silently share one account and its premium requests.
 */
const AMBIENT_CREDENTIAL_VARIABLES = new Set([
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_COPILOT_API_TOKEN",
  "COPILOT_API_URL",
  "COPILOT_SDK_AUTH_TOKEN",
]);

/** The host environment without inherited Copilot credentials; instance variables are merged after. */
export function copilotRuntimeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => !AMBIENT_CREDENTIAL_VARIABLES.has(key.toUpperCase()),
    ),
  );
}
