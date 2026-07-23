import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createPriceVerifier } from "./chainlink-verifier.sepolia.mjs";

const TOKEN = "0x7b79995e5f793a07bc00c21412e50ecae098e7f9";
const FEED = "0x694aa1769357215de4fac081bf1f309adc325306";
const FEED_DESCRIPTION = "ETH / USD";
const BLOCK_NUMBER = 11_330_500n;
const BLOCK_HASH = `0x${"ab".repeat(32)}`;
const BLOCK_TIMESTAMP = 1_720_000_000;
const ROUND_ID = 184_467_440_737_095_516_202n;
const ANSWER = 345_678_901_234n;
const STARTED_AT = BLOCK_TIMESTAMP - 15;
const UPDATED_AT = BLOCK_TIMESTAMP - 10;
const E18_PRICE = ANSWER * 10n ** 10n;

const SELECTOR = Object.freeze({
  decimals: "0x313ce567",
  description: "0x7284e416",
  latestRoundData: "0xfeaf968c"
});

const POLICY = Object.freeze({
  token: TOKEN,
  source: "chainlink-data-feeds",
  feedId: FEED,
  feedDecimals: 8,
  feedDescription: FEED_DESCRIPTION,
  maxAgeSeconds: 3_600,
  maxConfidenceBps: 0
});

test("verifies a canonical Sepolia Data Feed round and scales it to 18 decimals", async () => {
  const fixture = await createRpcFixture();
  try {
    const verifier = await verifierFor(fixture.url);
    const verified = await verifier.verify(submission(), context());

    assert.deepEqual(verified, {
      token: TOKEN,
      source: "chainlink-data-feeds",
      feedId: FEED,
      priceUsdE18: E18_PRICE,
      confidenceUsdE18: 0n,
      observedAt: UPDATED_AT,
      sequence: ROUND_ID,
      verifiedBy: `chainlink-data-feed:${FEED}:11155111`
    });
  } finally {
    await fixture.close();
  }
});

test("hash-pins both the canonical header attestation and latestRoundData call", async () => {
  const fixture = await createRpcFixture();
  try {
    const verifier = await verifierFor(fixture.url);
    await verifier.verify(submission(), context());

    const headerCall = fixture.calls.find((call) => call.method === "eth_getBlockByHash");
    assert(headerCall);
    assert.deepEqual(headerCall.params, [BLOCK_HASH, false]);

    const roundCall = fixture.calls.find((call) =>
      call.method === "eth_call" && call.params[0]?.data === SELECTOR.latestRoundData
    );
    assert(roundCall);
    assert.equal(roundCall.params[0].to, FEED);
    assert.deepEqual(roundCall.params[1], {
      blockHash: BLOCK_HASH,
      requireCanonical: true
    });
  } finally {
    await fixture.close();
  }
});

test("returns canonical feed values instead of trusting forged submission fields", async () => {
  const fixture = await createRpcFixture();
  try {
    const verifier = await verifierFor(fixture.url);
    const forged = submission({
      priceUsdE18: 1n,
      confidenceUsdE18: 999n,
      observedAt: UPDATED_AT - 1_000,
      sequence: ROUND_ID + 99n
    });
    const verified = await verifier.verify(forged, context());

    assert.notEqual(verified.priceUsdE18, forged.priceUsdE18);
    assert.notEqual(verified.confidenceUsdE18, forged.confidenceUsdE18);
    assert.notEqual(verified.observedAt, forged.observedAt);
    assert.notEqual(verified.sequence, forged.sequence);
    assert.equal(verified.priceUsdE18, E18_PRICE);
    assert.equal(verified.confidenceUsdE18, 0n);
    assert.equal(verified.observedAt, UPDATED_AT);
    assert.equal(verified.sequence, ROUND_ID);
  } finally {
    await fixture.close();
  }
});

test("rejects a feed round whose timestamp is after the canonical block", async () => {
  const fixture = await createRpcFixture({
    round: {
      startedAt: BLOCK_TIMESTAMP,
      updatedAt: BLOCK_TIMESTAMP + 1
    }
  });
  try {
    const verifier = await verifierFor(fixture.url);
    await assert.rejects(
      verifier.verify(submission(), context()),
      /round timestamp is after canonical block/
    );
  } finally {
    await fixture.close();
  }
});

test("rejects a negative feed answer", async () => {
  const fixture = await createRpcFixture({ round: { answer: -1n } });
  try {
    const verifier = await verifierFor(fixture.url);
    await assert.rejects(
      verifier.verify(submission(), context()),
      /answer is not positive/
    );
  } finally {
    await fixture.close();
  }
});

test("rejects incomplete and internally inconsistent feed rounds", async (t) => {
  await t.test("answeredInRound precedes roundId", async () => {
    const fixture = await createRpcFixture({
      round: { answeredInRound: ROUND_ID - 1n }
    });
    try {
      const verifier = await verifierFor(fixture.url);
      await assert.rejects(
        verifier.verify(submission(), context()),
        /answeredInRound precedes round ID/
      );
    } finally {
      await fixture.close();
    }
  });

  await t.test("updatedAt is zero", async () => {
    const fixture = await createRpcFixture({
      round: { startedAt: 0, updatedAt: 0 }
    });
    try {
      const verifier = await verifierFor(fixture.url);
      await assert.rejects(
        verifier.verify(submission(), context()),
        /round timestamps are invalid/
      );
    } finally {
      await fixture.close();
    }
  });

  await t.test("roundId is zero", async () => {
    const fixture = await createRpcFixture({
      round: { roundId: 0n, answeredInRound: 0n }
    });
    try {
      const verifier = await verifierFor(fixture.url);
      await assert.rejects(
        verifier.verify(submission(), context()),
        /round ID is zero/
      );
    } finally {
      await fixture.close();
    }
  });
});

test("rejects an RPC endpoint on the wrong chain before accepting feed identity", async () => {
  const fixture = await createRpcFixture({ chainId: 1 });
  try {
    await assert.rejects(
      verifierFor(fixture.url),
      /RPC chain ID 1 does not match Sepolia 11155111/
    );
    assert.equal(
      fixture.calls.some((call) => call.method === "eth_getCode"),
      false,
      "feed identity must not be queried until the RPC chain is accepted"
    );
  } finally {
    await fixture.close();
  }
});

test("rejects a plaintext remote RPC even when insecure loopback tests are enabled", async () => {
  await assert.rejects(
    createPriceVerifier({
      environment: "testnet",
      rpcUrl: "http://rpc.example.test/sepolia",
      allowInsecureRpc: true,
      rpcRetries: 0,
      pricePolicies: [POLICY]
    }),
    /must use HTTPS outside explicit loopback tests/
  );
});

test("authenticates a structurally valid stale round without inventing freshness", async () => {
  const staleUpdatedAt = BLOCK_TIMESTAMP - POLICY.maxAgeSeconds - 1;
  const fixture = await createRpcFixture({
    round: {
      startedAt: staleUpdatedAt - 1,
      updatedAt: staleUpdatedAt
    }
  });
  try {
    const verifier = await verifierFor(fixture.url);
    const verified = await verifier.verify(
      submission({ observedAt: staleUpdatedAt }),
      context()
    );

    assert.equal(verified.observedAt, staleUpdatedAt);
    assert.equal(BLOCK_TIMESTAMP - verified.observedAt, POLICY.maxAgeSeconds + 1);
    assert.equal(verified.priceUsdE18, E18_PRICE);
  } finally {
    await fixture.close();
  }
});

async function verifierFor(rpcUrl) {
  return createPriceVerifier({
    environment: "testnet",
    rpcUrl,
    allowInsecureRpc: true,
    rpcTimeoutMs: 1_000,
    rpcRetries: 0,
    pricePolicies: [POLICY]
  });
}

function submission(overrides = {}) {
  return {
    token: TOKEN,
    source: "chainlink-data-feeds",
    feedId: FEED,
    priceUsdE18: E18_PRICE,
    confidenceUsdE18: 0n,
    observedAt: UPDATED_AT,
    sequence: ROUND_ID,
    signedReport: null,
    ...overrides
  };
}

function context(overrides = {}) {
  return {
    blockNumber: BLOCK_NUMBER,
    blockHash: BLOCK_HASH,
    blockTimestamp: BLOCK_TIMESTAMP,
    ...overrides
  };
}

async function createRpcFixture(options = {}) {
  const calls = [];
  const state = {
    chainId: options.chainId ?? 11_155_111,
    header: {
      number: options.header?.number ?? BLOCK_NUMBER,
      hash: options.header?.hash ?? BLOCK_HASH,
      timestamp: options.header?.timestamp ?? BLOCK_TIMESTAMP
    },
    round: {
      roundId: options.round?.roundId ?? ROUND_ID,
      answer: options.round?.answer ?? ANSWER,
      startedAt: options.round?.startedAt ?? STARTED_AT,
      updatedAt: options.round?.updatedAt ?? UPDATED_AT,
      answeredInRound: options.round?.answeredInRound ?? options.round?.roundId ?? ROUND_ID
    }
  };

  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push({ method: payload.method, params: structuredClone(payload.params) });
    try {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result: rpcResult(payload.method, payload.params, state)
      }));
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        error: { code: -32_603, message: error instanceof Error ? error.message : String(error) }
      }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    calls,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

function rpcResult(method, params, state) {
  if (method === "eth_chainId") return quantity(state.chainId);
  if (method === "eth_getCode") {
    assert.deepEqual(params, [FEED, "latest"]);
    return "0x60016000";
  }
  if (method === "eth_getBlockByHash") {
    return {
      number: quantity(state.header.number),
      hash: state.header.hash,
      timestamp: quantity(state.header.timestamp)
    };
  }
  if (method === "eth_call") {
    assert.equal(params[0].to, FEED);
    if (params[0].data === SELECTOR.decimals) return words(8n);
    if (params[0].data === SELECTOR.description) return abiString(FEED_DESCRIPTION);
    if (params[0].data === SELECTOR.latestRoundData) {
      return words(
        state.round.roundId,
        signedWord(state.round.answer),
        BigInt(state.round.startedAt),
        BigInt(state.round.updatedAt),
        state.round.answeredInRound
      );
    }
    throw new Error(`Unexpected eth_call selector ${params[0].data}`);
  }
  throw new Error(`Unexpected RPC method ${method}`);
}

function words(...values) {
  return `0x${values.map(word).join("")}`;
}

function word(value) {
  const bigint = BigInt(value);
  assert(bigint >= 0n && bigint < 1n << 256n);
  return bigint.toString(16).padStart(64, "0");
}

function signedWord(value) {
  const bigint = BigInt(value);
  assert(bigint >= -(1n << 255n) && bigint < 1n << 255n);
  return bigint < 0n ? (1n << 256n) + bigint : bigint;
}

function abiString(value) {
  const bytes = Buffer.from(value, "utf8");
  const paddedBytes = Math.ceil(bytes.length / 32) * 32;
  return `0x${word(32n)}${word(BigInt(bytes.length))}${bytes.toString("hex").padEnd(paddedBytes * 2, "0")}`;
}

function quantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}
