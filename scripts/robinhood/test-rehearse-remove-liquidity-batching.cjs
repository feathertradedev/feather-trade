#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");

const { readLiveBinStates } = require("./rehearse-remove-liquidity.cjs");

const pair = "0x1111111111111111111111111111111111111111";
const owner = "0x2222222222222222222222222222222222222222";
const binId = 42n;
const blockNumber = 123_456;
const blockTag = "0x1e240";

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  await withRpcFixture(async (rpcUrl, respond) => {
    respond((payload) => {
      assertRequestPayload(payload);
      return [
        rpcResult(3, abiWords(900n)),
        rpcResult(1, abiWords(100n)),
        rpcResult(2, abiWords(500n, 600n))
      ];
    });
    const [state] = await readStates(rpcUrl);
    assert.deepEqual(state, {
      binId,
      liveBalance: 100n,
      reserveX: 500n,
      reserveY: 600n,
      totalSupply: 900n
    });

    respond((payload) => {
      assertRequestPayload(payload);
      return [rpcResult(1, abiWords(100n)), { id: 2, jsonrpc: "2.0", error: { message: "getBin unavailable" } }, rpcResult(3, abiWords(900n))];
    });
    await assert.rejects(() => readStates(rpcUrl), /fixture RPC batch 42:getBin failed: getBin unavailable/);

    respond((payload) => {
      assertRequestPayload(payload);
      return [rpcResult(1, abiWords(100n)), rpcResult(3, abiWords(900n))];
    });
    await assert.rejects(() => readStates(rpcUrl), /fixture RPC batch 42:getBin failed: missing result/);

    respond((payload) => {
      assertRequestPayload(payload);
      return [rpcResult(1, abiWords(100n)), rpcResult(2, abiWords(500n, 600n)), rpcResult(2, abiWords(700n, 800n))];
    });
    await assert.rejects(() => readStates(rpcUrl), /fixture RPC batch returned duplicate response ID 2/);

    respond((payload) => {
      assertRequestPayload(payload);
      return [rpcResult("1", abiWords(100n)), rpcResult(2, abiWords(500n, 600n)), rpcResult(3, abiWords(900n))];
    });
    await assert.rejects(() => readStates(rpcUrl), /fixture RPC batch returned a malformed response entry/);

    respond((payload) => {
      assertRequestPayload(payload);
      return [rpcResult(1, abiWords(100n)), rpcResult(2, abiWords(500n, 600n)), rpcResult(4, abiWords(900n))];
    });
    await assert.rejects(() => readStates(rpcUrl), /fixture RPC batch returned an unexpected response ID 4/);

    respond((payload) => {
      assertRequestPayload(payload);
      return [rpcResult(1, "0x01"), rpcResult(2, abiWords(500n, 600n)), rpcResult(3, abiWords(900n))];
    });
    await assert.rejects(() => readStates(rpcUrl), /fixture balanceOf bin 42 returned malformed ABI data/);

    respond((payload) => {
      assertRequestPayload(payload);
      return { id: 1, jsonrpc: "2.0", result: abiWords(100n) };
    });
    await assert.rejects(() => readStates(rpcUrl), /fixture RPC endpoint did not return a batch response/);

    const chunkBinIds = [7n, 8n, 9n, 10n];
    const expectedPayload = requestPayloadForBins(chunkBinIds);
    const expectedResponses = responsePayloadForBins(chunkBinIds);
    const expectedChunks = [expectedPayload.slice(0, 10), expectedPayload.slice(10)];
    const responseChunks = [expectedResponses.slice(0, 10), expectedResponses.slice(10)];
    let requestCount = 0;
    respond((payload) => {
      assert.ok(requestCount < expectedChunks.length, "unexpected extra RPC batch request");
      assert.deepEqual(payload, expectedChunks[requestCount]);
      const responses = responseChunks[requestCount];
      requestCount += 1;
      return [responses.at(-1), ...responses.slice(0, -1)];
    });
    const states = await readLiveBinStates({
      rpcUrl,
      pair,
      owner,
      binIds: chunkBinIds,
      blockNumber,
      labelPrefix: "fixture"
    });
    assert.equal(requestCount, 2);
    assert.deepEqual(states, chunkBinIds.map((id) => ({
      binId: id,
      liveBalance: id * 1000n + 1n,
      reserveX: id * 1000n + 2n,
      reserveY: id * 1000n + 3n,
      totalSupply: id * 1000n + 4n
    })));
  });

  console.log("rehearse-remove-liquidity batching fixture tests passed");
}

function readStates(rpcUrl) {
  return readLiveBinStates({ rpcUrl, pair, owner, binIds: [binId], blockNumber, labelPrefix: "fixture" });
}

function assertRequestPayload(payload) {
  assert.deepEqual(payload, requestPayloadForBins([binId]));
}

function requestPayloadForBins(binIds) {
  return binIds.flatMap((id) => [
    "0x00fdd58e" + word(owner) + word(id),
    "0x0abe9688" + word(id),
    "0xbd85b039" + word(id)
  ]).map((data, index) => rpcCall(index + 1, data));
}

function responsePayloadForBins(binIds) {
  return binIds.flatMap((id) => [
    abiWords(id * 1000n + 1n),
    abiWords(id * 1000n + 2n, id * 1000n + 3n),
    abiWords(id * 1000n + 4n)
  ]).map((result, index) => rpcResult(index + 1, result));
}

function rpcCall(id, data) {
  return {
    jsonrpc: "2.0",
    id,
    method: "eth_call",
    params: [{ to: pair, data }, blockTag]
  };
}

function rpcResult(id, result) {
  return { id, jsonrpc: "2.0", result };
}

function abiWords(...values) {
  return `0x${values.map(word).join("")}`;
}

function word(value) {
  const hex = typeof value === "string" ? value.slice(2) : BigInt(value).toString(16);
  return hex.toLowerCase().padStart(64, "0");
}

async function withRpcFixture(test) {
  let responder = null;
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        assert.equal(request.method, "POST");
        assert.equal(request.headers["content-type"], "application/json");
        const result = responder(JSON.parse(body));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await test(`http://127.0.0.1:${server.address().port}`, (nextResponder) => {
      responder = nextResponder;
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
