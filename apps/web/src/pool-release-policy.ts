import { isAddressEqual, type Address } from "viem";

import sepoliaPolicy from "../../../deployments/evm/sepolia/pool-releases.json";

interface PoolPolicyEnvironment {
  environment: string;
  chainId: number;
}

/**
 * Presentation and selection policy only. It never changes factory state or a
 * transaction builder; it prevents known unsafe release epochs from becoming
 * selectable in the public UI.
 */
export function isDeprecatedPool(
  environment: PoolPolicyEnvironment,
  pair: Address
): boolean {
  if (environment.environment !== sepoliaPolicy.environment || environment.chainId !== sepoliaPolicy.chainId) {
    return false;
  }
  return sepoliaPolicy.epochs.some((epoch) =>
    epoch.status === "deprecated-do-not-fund" &&
    epoch.canonical === false &&
    isAddressEqual(epoch.pair as Address, pair)
  );
}

export function deprecatedPoolAddresses(environment: PoolPolicyEnvironment): Address[] {
  if (environment.environment !== sepoliaPolicy.environment || environment.chainId !== sepoliaPolicy.chainId) {
    return [];
  }
  return sepoliaPolicy.epochs
    .filter((epoch) => epoch.status === "deprecated-do-not-fund" && epoch.canonical === false)
    .map((epoch) => epoch.pair as Address);
}
