/**
 * GitHub Copilot internals the server's replay tests and fixture recorder drive directly.
 *
 * @module provider-copilot/testing
 */
export { COPILOT_PROVIDER, makeCopilotAdapterV2Driver } from "./server/adapter.ts";
export {
  COPILOT_SDK_REPLAY_PROTOCOL,
  CopilotSdkError,
  loggedSessionOptions,
  makeCopilotSdkRunner,
  resolveCopilotBinary,
  sendFrame,
  type CopilotSdkConnection,
  type CopilotSdkFrame,
  type CopilotSdkInboundFrame,
  type CopilotSdkOpenSessionInput,
  type CopilotSdkOutboundFrame,
  type CopilotSdkRunner,
  type CopilotSdkSession,
} from "./server/sdk.ts";
