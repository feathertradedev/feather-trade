import { getAddress, isAddress, zeroAddress } from "viem";

export const DISABLED_LEGACY_ROUTING_CONSTRUCTOR_ARGS = [
  "routerFactoryV1",
  "routerFactoryV2_1",
  "routerLegacyFactoryV2",
  "routerLegacyRouterV2"
] as const;

export function assertLegacyRoutingDisabled(constructorArgs: Record<string, unknown>): void {
  for (const key of DISABLED_LEGACY_ROUTING_CONSTRUCTOR_ARGS) {
    const value = constructorArgs[key];
    if (typeof value !== "string" || !isAddress(value)) {
      throw new Error(`Expected constructorArgs.${key} to be an address`);
    }

    if (getAddress(value) !== zeroAddress) {
      throw new Error(`Expected constructorArgs.${key} to be the zero address for V2.2-only routing`);
    }
  }
}
