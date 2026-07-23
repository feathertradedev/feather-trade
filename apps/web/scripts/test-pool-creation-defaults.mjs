import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.ts"),
  logLevel: "error",
  server: { middlewareMode: true }
});

try {
  const { selectPoolCreationTokenDefaults } = await server.ssrLoadModule("/src/pool-creation-defaults.ts");
  const weth = {
    address: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
    tags: ["canonical", "testnet", "wrapped-native"],
    risk: { reviewStatus: "standard" }
  };
  const usdc = {
    address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    tags: ["canonical", "quote", "stablecoin", "testnet"],
    risk: { reviewStatus: "restricted" }
  };

  assert.deepEqual(
    selectPoolCreationTokenDefaults([weth, usdc], [weth.address, usdc.address]),
    { tokenX: weth.address, tokenY: usdc.address },
    "Sepolia must default to WETH as base and USDC as quote even though both are factory quote assets"
  );
  assert.deepEqual(
    selectPoolCreationTokenDefaults([weth, { ...usdc, risk: { reviewStatus: "blocked" } }], [weth.address, usdc.address]),
    { tokenX: null, tokenY: weth.address },
    "blocked tokens must not become wizard defaults"
  );
  assert.deepEqual(
    selectPoolCreationTokenDefaults([usdc, weth], [weth.address, usdc.address]),
    { tokenX: weth.address, tokenY: usdc.address },
    "selection must not depend on registry insertion order"
  );

  console.log("pool creation token default fixtures passed");
} finally {
  await server.close();
}
