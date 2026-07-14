import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const server = await createServer({ configFile: resolve(webRoot, "vite.config.ts"), root: webRoot, logLevel: "error", server: { hmr: false, middlewareMode: true } });

try {
  const { parsePoolWorkspaceRoute, poolWorkspaceHref } = await server.ssrLoadModule("/src/pool-workspace-route.ts");
  const pool = "0x4A47586912f0e03d9f3DCAa762fB8B659E52604b";

  assert.deepEqual(parsePoolWorkspaceRoute(`#/pools/${pool}`), { poolId: pool, task: "market", intent: null, source: "canonical" });
  assert.deepEqual(parsePoolWorkspaceRoute(`#/pools/${pool}/swap?returnTo=%23%2Fpools`), { poolId: pool, task: "swap", intent: null, source: "canonical" });
  assert.deepEqual(parsePoolWorkspaceRoute(`#/pools/${pool}/create`), { poolId: pool, task: "create", intent: "add", source: "canonical" });
  assert.deepEqual(parsePoolWorkspaceRoute(`#/pools/${pool}/manage`), { poolId: pool, task: "manage", intent: null, source: "canonical" });
  assert.deepEqual(parsePoolWorkspaceRoute(`#/swap/${pool}`), { poolId: pool, task: "swap", intent: null, source: "legacy" });
  assert.deepEqual(parsePoolWorkspaceRoute(`#/liquidity/add/${pool}`), { poolId: pool, task: "create", intent: "add", source: "legacy" });
  assert.deepEqual(parsePoolWorkspaceRoute(`#/liquidity/partial/${pool}`), { poolId: pool, task: "manage", intent: "partial", source: "legacy" });
  assert.deepEqual(parsePoolWorkspaceRoute(`#/liquidity/full/${pool}`), { poolId: pool, task: "manage", intent: "full", source: "legacy" });
  assert.equal(parsePoolWorkspaceRoute(`#/pools/${pool}/unknown`), null);
  assert.equal(parsePoolWorkspaceRoute("#/pools/%252e%252e/swap"), null);
  assert.equal(poolWorkspaceHref(pool, "create"), `#/pools/${pool}/create`);
  assert.throws(() => poolWorkspaceHref("../escape", "swap"), /Invalid pool route identifier/);

  console.log("Pool workspace route fixture passed: canonical tasks, legacy adapters, and safe pool identity.");
} finally {
  await server.close();
}
