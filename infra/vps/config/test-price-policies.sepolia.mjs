import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const WETH = "0x7b79995e5f793a07bc00c21412e50ecae098e7f9";
const USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
const ETH_USD = "0x694aa1769357215de4fac081bf1f309adc325306";
const USDC_USD = "0xa2f78ab2355fe2f984d808b5cee7fd0a93d5270e";

test("Sepolia Chainlink policies exactly match the deployed and allowlisted WETH/USDC assets", async () => {
  const [policies, manifest, tokenList] = await Promise.all([
    json("infra/vps/config/price-policies.sepolia.json"),
    json("deployments/evm/sepolia/public.json"),
    json("packages/sdk/src/token-lists/sepolia.json")
  ]);
  assert.equal(manifest.environment, "sepolia");
  assert.equal(manifest.chainId, 11_155_111);
  assert.equal(tokenList.environment, "sepolia");
  assert.equal(tokenList.chainId, 11_155_111);
  assert.equal(manifest.tokens.wrappedNative.toLowerCase(), WETH);
  assert.equal(manifest.quoteAssets.extra0.toLowerCase(), USDC);
  assert.equal(tokenList.tokens.find((token) => token.id === "weth")?.address.toLowerCase(), WETH);
  assert.equal(tokenList.tokens.find((token) => token.id === "usdc")?.address.toLowerCase(), USDC);

  assert.deepEqual(policies, [
    {
      token: WETH,
      source: "chainlink-data-feeds",
      feedId: ETH_USD,
      maxAgeSeconds: 7200,
      maxConfidenceBps: 0,
      feedDecimals: 8,
      feedDescription: "ETH / USD"
    },
    {
      token: USDC,
      source: "chainlink-data-feeds",
      feedId: USDC_USD,
      maxAgeSeconds: 90000,
      maxConfidenceBps: 0,
      feedDecimals: 8,
      feedDescription: "USDC / USD"
    }
  ]);
});

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
