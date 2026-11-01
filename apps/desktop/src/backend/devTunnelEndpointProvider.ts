import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";
import type { AdvertisedEndpoint, AdvertisedEndpointProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

// The backend's DevTunnel service writes this to its state directory once `devtunnel host` connects.
export const DEVTUNNEL_STATE_FILE = "devtunnel.json";

const DEVTUNNEL_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "devtunnel",
  label: "Dev tunnel",
  kind: "tunnel",
  isAddon: true,
};

const DevTunnelState = Schema.Struct({
  tunnelId: Schema.String,
  url: Schema.optional(Schema.String),
});
const decodeDevTunnelState = Schema.decodeUnknownEffect(Schema.fromJsonString(DevTunnelState));

export const resolveDevTunnelAdvertisedEndpoints = Effect.fn("resolveDevTunnelAdvertisedEndpoints")(
  function* (
    statePath: string,
  ): Effect.fn.Return<readonly AdvertisedEndpoint[], never, FileSystem.FileSystem> {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(statePath).pipe(
      Effect.flatMap(decodeDevTunnelState),
      Effect.flatMap(({ url }) =>
        url === undefined
          ? Effect.succeed([])
          : Effect.try(() => [
              createAdvertisedEndpoint({
                provider: DEVTUNNEL_ENDPOINT_PROVIDER,
                source: "desktop-addon",
                id: `devtunnel:${url}`,
                label: "Dev tunnel",
                httpBaseUrl: url,
                reachability: "public",
                hostedHttpsCompatibility: "compatible",
                status: "available",
                description: "Reachable from anywhere through a Microsoft dev tunnel.",
              }),
            ]),
      ),
      Effect.orElseSucceed(() => []),
    );
  },
);
