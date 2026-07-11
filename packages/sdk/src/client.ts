import { createPublicClient, http, type Chain, type PublicClient } from "viem";

export function createDexPublicClient(chain: Chain, rpcUrl?: string): PublicClient {
  const fallbackRpcUrl = chain.rpcUrls.default.http[0];

  return createPublicClient({
    chain,
    transport: http(rpcUrl ?? fallbackRpcUrl)
  });
}
