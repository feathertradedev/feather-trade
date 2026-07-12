import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const server = await createServer({ configFile: resolve(webRoot, "vite.config.ts"), logLevel: "error", server: { middlewareMode: true } });

try {
  const { fullExitBatchPolicy } = await server.ssrLoadModule("/src/full-exit-policy.ts");
  const localnet = fullExitBatchPolicy("localnet");
  const testnet = fullExitBatchPolicy("robinhoodTestnet");
  const mainnet = fullExitBatchPolicy("robinhood");
  assert(localnet.maxCandidateBins > testnet.maxCandidateBins);
  assert(testnet.maxCandidateBins > mainnet.maxCandidateBins);
  assert(localnet.maxBlockGasBps > testnet.maxBlockGasBps);
  assert(testnet.maxBlockGasBps > mainnet.maxBlockGasBps);
  assert.throws(() => fullExitBatchPolicy("unsupported"), /not configured/);
  for (const policy of [localnet, testnet, mainnet]) {
    assert(policy.maxCalldataBytes > 0);
    assert(policy.maxProbeCount >= policy.maxCandidateBins);
    assert(policy.maxBlockGasBps > 0n && policy.maxBlockGasBps <= 5_000n);
  }
  console.log("full-exit environment policy fixtures passed");
} finally {
  await server.close();
}
