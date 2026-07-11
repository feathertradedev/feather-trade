import { localnetChain, robinhoodChain, robinhoodTestnetChain } from "@robinhood-lb/sdk/chains";
import { createConfig, http } from "wagmi";

import { publicReleaseEnvironment, registries } from "./config";

export const wagmiConfig =
  publicReleaseEnvironment === "robinhoodTestnet"
    ? createConfig({
        chains: [robinhoodTestnetChain],
        connectors: [],
        transports: {
          [robinhoodTestnetChain.id]: http(registries.robinhoodTestnet.endpoints.rpcUrl)
        }
      })
    : publicReleaseEnvironment === "robinhood"
      ? createConfig({
          chains: [robinhoodChain],
          connectors: [],
          transports: {
            [robinhoodChain.id]: http(registries.robinhood.endpoints.rpcUrl)
          }
        })
      : createConfig({
          chains: [localnetChain, robinhoodTestnetChain, robinhoodChain],
          connectors: [],
          transports: {
            [localnetChain.id]: http(registries.localnet.endpoints.rpcUrl),
            [robinhoodTestnetChain.id]: http(registries.robinhoodTestnet.endpoints.rpcUrl),
            [robinhoodChain.id]: http(registries.robinhood.endpoints.rpcUrl)
          }
        });
