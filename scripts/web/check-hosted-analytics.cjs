#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const args = process.argv.slice(2);
const originIndex = args.indexOf("--origin");
const rawOrigin = originIndex === -1 ? "" : args[originIndex + 1] ?? "";
const manifestIndex = args.indexOf("--manifest");
const manifestPath = manifestIndex === -1 ? "" : args[manifestIndex + 1] ?? "";
const expectedPairIndex = args.indexOf("--expected-pair");
const rawExpectedPair = expectedPairIndex === -1 ? "" : args[expectedPairIndex + 1] ?? "";

async function main() {
  const origin = parseOrigin(rawOrigin);
  const expected = readManifest(manifestPath);
  const expectedPair = rawExpectedPair === "" ? null : parseAddress(rawExpectedPair, "--expected-pair");
  const endpoint = `${origin}/graphql`;
  const bootstrap = await graphql(endpoint, origin, {
    query: `query HostedAnalyticsBinding {
      analyticsHealth { status headBlock headHash headTimestamp }
      poolCatalog(first: 100) {
        nodes {
          pair chainId factoryAddress tokenX tokenY decimalsX decimalsY activeId
          createdAtBlock createdAtBlockHash creationTransactionHash creationLogIndex
          asOfBlock asOfBlockHash
        }
        pageInfo { hasNextPage partial }
        streamCursor
      }
    }`
  });
  const health = bootstrap.data?.analyticsHealth;
  const catalog = bootstrap.data?.poolCatalog;
  if (health === null || typeof health !== "object" || typeof health.status !== "string") {
    throw new Error("Hosted analytics health is missing");
  }
  if (catalog === null || typeof catalog !== "object" || !Array.isArray(catalog.nodes)) {
    throw new Error("Hosted analytics pool catalog is missing");
  }
  if (!["READY", "PARTIAL"].includes(health.status)) {
    throw new Error(`Hosted analytics health is ${health.status}`);
  }
  if (catalog.nodes.length === 0) {
    throw new Error("Hosted analytics has no canonical pool to smoke");
  }
  const pool = expectedPair === null
    ? catalog.nodes.find((candidate) =>
        candidate?.chainId === expected.chainId &&
        String(candidate?.factoryAddress).toLowerCase() === expected.factory.toLowerCase()
      )
    : catalog.nodes.find((candidate) => String(candidate?.pair).toLowerCase() === expectedPair.toLowerCase());
  if (
    pool === null ||
    pool === undefined ||
    typeof pool !== "object" ||
    !isAddress(pool.pair) ||
    !isAddress(pool.tokenX) ||
    !isAddress(pool.tokenY) ||
    pool.chainId !== expected.chainId ||
    String(pool.factoryAddress).toLowerCase() !== expected.factory.toLowerCase() ||
    typeof pool.createdAtBlock !== "string" ||
    !isHash(pool.createdAtBlockHash) ||
    !isHash(pool.creationTransactionHash) ||
    !Number.isSafeInteger(pool.creationLogIndex) ||
    typeof pool.asOfBlock !== "string" ||
    !isHash(pool.asOfBlockHash)
  ) {
    throw new Error("Hosted analytics returned no fully provenanced pool for the sealed deployment");
  }

  const now = Math.floor(Date.now() / 1_000);
  const detail = await graphql(endpoint, origin, {
    query: `query HostedCanonicalPool($pair: ID!, $from: Int!, $to: Int!) {
      poolState(pair: $pair, radius: 2) {
        state {
          pair chainId tokenX tokenY decimalsX decimalsY activeId
          reserveX reserveY marketPriceQuoteE18 asOfBlock asOfBlockHash
        }
        bins { binId reserveX reserveY updatedAtBlock updatedAtBlockHash }
        streamCursor
      }
      pairCandles(
        pair: $pair
        interval: HOUR
        fromTimestamp: $from
        toTimestamp: $to
        first: 100
      ) {
        nodes {
          pair interval startTimestamp endTimestamp
          openUsdE18 highUsdE18 lowUsdE18 closeUsdE18
          finalized revision firstBlockHash lastBlockHash
        }
        pageInfo { hasNextPage partial }
        streamCursor
      }
      trustedPairPrice(baseToken: "${pool.tokenX}", quoteToken: "${pool.tokenY}") {
        baseToken quoteToken quotePerBaseE18 status
        baseSource quoteSource baseAgeSeconds quoteAgeSeconds
        asOfBlock asOfBlockHash
      }
    }`,
    variables: {
      pair: pool.pair,
      from: now - 14 * 24 * 60 * 60,
      to: now + 1
    }
  });
  const state = detail.data?.poolState?.state;
  const candles = detail.data?.pairCandles;
  const trustedPrice = detail.data?.trustedPairPrice;
  if (
    state === null ||
    typeof state !== "object" ||
    String(state.pair).toLowerCase() !== pool.pair.toLowerCase() ||
    state.chainId !== pool.chainId ||
    String(state.tokenX).toLowerCase() !== String(pool.tokenX).toLowerCase() ||
    String(state.tokenY).toLowerCase() !== String(pool.tokenY).toLowerCase() ||
    typeof state.asOfBlock !== "string" ||
    !isHash(state.asOfBlockHash) ||
    !isUnsignedInteger(state.asOfBlock) ||
    !isUnsignedInteger(pool.createdAtBlock) ||
    BigInt(state.asOfBlock) < BigInt(pool.createdAtBlock)
  ) {
    throw new Error("Hosted analytics direct pool state does not match catalog identity");
  }
  if (candles === null || typeof candles !== "object" || !Array.isArray(candles.nodes)) {
    throw new Error("Hosted analytics candle history is missing");
  }
  if (trustedPrice === null || typeof trustedPrice !== "object" || typeof trustedPrice.status !== "string") {
    throw new Error("Hosted analytics trusted pair-price status is missing");
  }
  await verifyCandleStream(origin, pool.pair, candles.streamCursor);
  console.log(`Verified hosted analytics catalog, direct pool state, candle history/live handoff, and trusted pricing at ${endpoint}.`);
}

async function graphql(endpoint, origin, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "origin": origin
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`Hosted analytics returned HTTP ${response.status}`);
  if (response.headers.get("access-control-allow-origin") !== origin) {
    throw new Error("Hosted analytics CORS does not match the deployed app origin");
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new Error("Hosted analytics did not return JSON");
  }
  const payload = await response.json();
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Hosted analytics returned an invalid GraphQL envelope");
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error("Hosted analytics GraphQL query failed");
  }
  return payload;
}

async function verifyCandleStream(origin, pair, cursor) {
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw new Error("Hosted analytics candle stream cursor is missing");
  }
  const url = new URL("/events/candles", origin);
  url.searchParams.set("pair", pair);
  url.searchParams.set("interval", "HOUR");
  url.searchParams.set("after", cursor);
  const controller = new AbortController();
  // The analytics service guarantees a heartbeat every 15 seconds. Allow one
  // complete heartbeat interval through reverse-proxy buffering, then require
  // an actual SSE frame so this checks more than response headers.
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(url, {
      headers: {
        "accept": "text/event-stream",
        "origin": origin
      },
      redirect: "error",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Hosted analytics candle stream returned HTTP ${response.status}`);
    if (response.headers.get("access-control-allow-origin") !== origin) {
      throw new Error("Hosted analytics candle stream CORS does not match the deployed app origin");
    }
    if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream")) {
      throw new Error("Hosted analytics candle stream did not return an event stream");
    }
    if (response.body === null) {
      throw new Error("Hosted analytics candle stream returned no body");
    }
    const reader = response.body.getReader();
    const first = await reader.read();
    const frame = first.done ? "" : new TextDecoder().decode(first.value);
    if (!/^event: (?:heartbeat|candle|reset)$/m.test(frame)) {
      throw new Error("Hosted analytics candle stream returned no recognized SSE frame");
    }
    await reader.cancel();
  } finally {
    clearTimeout(timeout);
  }
}

function isAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function parseOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("--origin must be an HTTPS origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

function readManifest(path) {
  if (path === "") throw new Error("--manifest is required");
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    !Number.isSafeInteger(manifest.chainId) ||
    manifest.chainId <= 0 ||
    manifest.contracts === null ||
    typeof manifest.contracts !== "object"
  ) {
    throw new Error("Sealed deployment manifest is invalid");
  }
  return {
    chainId: manifest.chainId,
    factory: parseAddress(manifest.contracts.lbFactory, "manifest factory")
  };
}

function parseAddress(value, label) {
  if (!isAddress(value)) throw new Error(`${label} is not a canonical EVM address`);
  return value.toLowerCase();
}

function isHash(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isUnsignedInteger(value) {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Hosted analytics verification failed");
  process.exitCode = 1;
});
