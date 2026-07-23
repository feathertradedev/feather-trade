import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pair = "0x00000000000000000000000000000000000000a1";
const otherPair = "0x00000000000000000000000000000000000000a2";
const owner = "0x00000000000000000000000000000000000000b1";
const recipient = "0x00000000000000000000000000000000000000b2";
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.ts"),
  root: webRoot,
  logLevel: "error",
  server: { hmr: false, middlewareMode: true }
});

try {
  const {
    assertCanonicalActivityScope,
    canonicalActivityRows,
    canonicalPositionHistoryRows,
    portfolioPositionRows
  } = await server.ssrLoadModule("/src/pool-workspace-activity.ts");

  const position = {
    owner,
    pair,
    bins: [
      portfolioBin("1", "10", "99"),
      portfolioBin("2", "0", "99")
    ],
    costBasisUsdE18: null,
    currentValueUsdE18: null,
    realizedPnlUsdE18: null,
    unrealizedPnlUsdE18: null,
    status: "PARTIAL",
    missingPriceTokens: [],
    asOfBlock: "99",
    asOfTimestamp: 9_000
  };
  assert.deepEqual(portfolioPositionRows(position, null, pair), []);
  assert.deepEqual(portfolioPositionRows(position, owner.toUpperCase().replace("0X", "0x"), pair), [{
    id: `${owner}:${pair}:1`,
    owner,
    pair,
    binId: "1",
    liquidity: "10",
    updatedAtBlock: "99"
  }]);
  assert.throws(
    () => portfolioPositionRows({ ...position, owner: recipient }, owner, pair),
    /does not match the selected owner and pool/
  );
  assert.throws(
    () => portfolioPositionRows({ ...position, bins: [portfolioBin("1", "bad", "99")] }, owner, pair),
    /invalid position liquidity/
  );

  const rows = [
    event("swap", "SWAP", { amountX: "5" }),
    event("deposit", "DEPOSIT", { owner, amountX: "10", amountY: "20", binIds: ["1", "2"] }),
    event("out", "POSITION_TRANSFER", { from: owner, to: recipient, binIds: ["2"] }),
    event("in", "POSITION_TRANSFER", { from: recipient, to: owner, binIds: ["3"], transactionHash: null })
  ];
  const activity = canonicalActivityRows(rows);
  assert.deepEqual(activity.map((row) => row.type), ["SWAP", "DEPOSIT", "POSITION_TRANSFER", "POSITION_TRANSFER"]);
  assert.equal(activity[1].account, owner);
  assert.equal(activity[3].transactionHash, "");

  const history = canonicalPositionHistoryRows(rows, owner);
  assert.deepEqual(history.map((row) => row.type), ["DEPOSIT", "TRANSFER_OUT", "TRANSFER_IN"]);
  assert.deepEqual(history[0].binIds, ["1", "2"]);
  assert.equal(history[2].transactionHash, "");

  assert.doesNotThrow(() => assertCanonicalActivityScope(rows[1], pair, owner));
  assert.throws(
    () => assertCanonicalActivityScope({ ...rows[1], pair: otherPair }, pair, owner),
    /another pool/
  );
  assert.throws(
    () => assertCanonicalActivityScope({ ...rows[1], owner: recipient }, pair, owner),
    /unrelated to owner/
  );

  console.log("Pool workspace activity fixture passed: wallet claims, canonical activity mapping, owner history, empty state, and scope isolation.");
} finally {
  await server.close();
}

function portfolioBin(binId, liquidity, asOfBlock) {
  return {
    binId,
    liquidity,
    amountX: null,
    amountY: null,
    costBasisUsdE18: null,
    currentValueUsdE18: null,
    realizedPnlUsdE18: null,
    unrealizedPnlUsdE18: null,
    asOfBlock,
    asOfTimestamp: 9_000,
    status: "PARTIAL",
    missingPriceTokens: []
  };
}

function event(id, kind, overrides = {}) {
  return {
    id,
    pair,
    kind,
    owner: null,
    from: null,
    to: null,
    amountX: null,
    amountY: null,
    binIds: [],
    blockNumber: "99",
    blockHash: `0x${"a".repeat(64)}`,
    transactionHash: `0x${"b".repeat(64)}`,
    logIndex: 1,
    sequence: 1,
    timestamp: 9_000,
    revision: 1,
    ...overrides
  };
}
