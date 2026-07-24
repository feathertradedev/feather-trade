import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { loadMarketActivityConfig } from "../src/config.js";

const SEPOLIA_WETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

test("loads a validated generic Sepolia manifest through the Sepolia registry", () => {
  const manifestPath = fixturePath("deployments/evm/sepolia/public.json");
  const config = loadMarketActivityConfig({
    MARKET_ACTIVITY_RPC_URL: "https://ethereum-sepolia-rpc.publicnode.com",
    MARKET_ACTIVITY_PRIVATE_KEY: `0x${"01".repeat(32)}`,
    MARKET_ACTIVITY_MANIFEST_PATH: manifestPath,
    MARKET_ACTIVITY_POOL: "0x79EFAC7c0e75fa1aC41dbef2A864659A9097E440",
    MARKET_ACTIVITY_WETH: SEPOLIA_WETH,
    MARKET_ACTIVITY_USDC: SEPOLIA_USDC,
    MARKET_ACTIVITY_BIN_STEP: "20"
  });

  assert.equal(config.environment, "testnet");
  assert.equal(config.registry.environment, "sepolia");
  assert.equal(config.registry.chainId, 11_155_111);
  assert.equal(config.pool.binStep, 20);
  assert.equal(config.weth.address, SEPOLIA_WETH);
  assert.equal(config.usdc.address, SEPOLIA_USDC);
});

function fixturePath(relativePath: string): string {
  const candidates = [
    resolve(process.cwd(), relativePath),
    resolve(process.cwd(), "../../", relativePath)
  ];
  const found = candidates.find(existsSync);
  if (found === undefined) throw new Error(`Unable to find fixture ${relativePath}`);
  return found;
}
