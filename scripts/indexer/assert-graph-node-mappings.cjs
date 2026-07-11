#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const endpoint = process.env.INDEXER_LOCAL_ENDPOINT || "http://127.0.0.1:8000/subgraphs/name/robinhood-lb/localnet";
const responseFile = process.env.GRAPH_NODE_E2E_RESPONSE_FILE || "";
const manifestPath = process.env.LOCALNET_MANIFEST_PATH || path.join(root, "deployments/localnet/latest.json");
const attempts = Number(process.env.GRAPH_NODE_E2E_ASSERT_ATTEMPTS || "120");
const sleepMs = Number(process.env.GRAPH_NODE_E2E_ASSERT_SLEEP_MS || "1000");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const factoryId = lower(manifest.contracts && manifest.contracts.lbFactory);
const pairId = lower(manifest.seededPools && manifest.seededPools.wnativeUsdc && manifest.seededPools.wnativeUsdc.pair);

if (!address(factoryId) || !address(pairId)) {
  throw new Error(`Manifest ${manifestPath} is missing the local factory or WNATIVE/USDC pair.`);
}

const query = `query GraphNodeMappingEvidence($factory: ID!, $pair: ID!) {
  _meta { block { number hash } hasIndexingErrors }
  factory(id: $factory) { id pairCount }
  pair(id: $pair) { id totalFeesX totalFeesY protocolFeesX protocolFeesY }
  bins(first: 1000) { id pair { id } totalSupply reserveX reserveY }
  positions(first: 1000) { id pair { id } liquidity }
  swaps(first: 1000) { id pair { id } transactionHash totalFeeX totalFeeY protocolFeeX protocolFeeY }
  liquidityEvents(first: 1000) { id pair { id } type ids amounts transactionHash amountX amountY }
  feeEvents(first: 1000) { id pair { id } type totalFeeX totalFeeY protocolFeeX protocolFeeY }
}`;

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const data = await request();
      console.log(JSON.stringify(assertMappings(data), null, 2));
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
    }
  }

  throw new Error(`Graph Node mapping assertions did not pass: ${lastError && lastError.message}`);
}

async function request() {
  let payload;
  if (responseFile) {
    payload = JSON.parse(fs.readFileSync(responseFile, "utf8"));
  } else {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { factory: factoryId, pair: pairId } }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`GraphQL returned HTTP ${response.status}`);
    payload = await response.json();
  }
  if (payload.errors && payload.errors.length > 0) throw new Error(payload.errors.map((item) => item.message).join("; "));
  if (!payload.data || payload.data._meta?.hasIndexingErrors !== false) throw new Error("GraphQL metadata is missing or reports indexing errors");
  return payload.data;
}

function assertMappings(data) {
  if (!data.factory || BigInt(data.factory.pairCount || "0") < 1n) throw new Error("factory mapping is missing");
  if (!data.pair) throw new Error("pair mapping is missing");
  const forPair = (items) => array(items).filter((item) => lower(item.pair && item.pair.id) === pairId);
  const bins = forPair(data.bins).filter((item) => positive(item.totalSupply));
  const positions = forPair(data.positions).filter((item) => positive(item.liquidity));
  const swaps = forPair(data.swaps);
  const liquidityEvents = forPair(data.liquidityEvents);
  const compositionFees = forPair(data.feeEvents).filter((item) => item.type === "COMPOSITION");

  if (bins.length === 0) throw new Error("bin mapping is missing");
  if (positions.length === 0) throw new Error("position mapping is missing");
  if (swaps.length === 0) throw new Error("swap mapping is missing");
  if (!liquidityEvents.some((item) => item.type === "DEPOSIT") || !liquidityEvents.some((item) => item.type === "WITHDRAW")) {
    throw new Error("deposit/withdraw liquidity mappings are incomplete");
  }
  if (compositionFees.length === 0) throw new Error("composition-fee mapping is missing");

  const expected = sumFees([...swaps, ...compositionFees]);
  for (const [pairField, sumField] of [["totalFeesX", "totalFeeX"], ["totalFeesY", "totalFeeY"], ["protocolFeesX", "protocolFeeX"], ["protocolFeesY", "protocolFeeY"]]) {
    if (BigInt(data.pair[pairField]) !== expected[sumField]) throw new Error(`${pairField} does not equal Swap plus CompositionFees rows`);
  }

  return {
    block: data._meta.block,
    factory: factoryId,
    pair: pairId,
    mappings: {
      bins: bins.length,
      positions: positions.length,
      swaps: swaps.length,
      liquidityEvents: liquidityEvents.length,
      compositionFees: compositionFees.length
    },
    aggregateFees: Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, value.toString()]))
  };
}

function sumFees(events) {
  return events.reduce((sum, event) => {
    for (const field of ["totalFeeX", "totalFeeY", "protocolFeeX", "protocolFeeY"]) sum[field] += BigInt(event[field] || "0");
    return sum;
  }, { totalFeeX: 0n, totalFeeY: 0n, protocolFeeX: 0n, protocolFeeY: 0n });
}

function array(value) { return Array.isArray(value) ? value : []; }
function lower(value) { return String(value || "").toLowerCase(); }
function address(value) { return /^0x[0-9a-f]{40}$/.test(value); }
function positive(value) { try { return BigInt(String(value || "0")) > 0n; } catch (_) { return false; } }
