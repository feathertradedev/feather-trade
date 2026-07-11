import assert from "node:assert/strict";
import test from "node:test";

import type { Address, Hash, Hex } from "viem";

import {
  simulateAndSendTransaction,
  type ExampleTransactionEstimateRequest,
  type ExampleTransactionRequest
} from "../examples/preflight-transaction.js";

const account = "0x1000000000000000000000000000000000000001" as Address;
const to = "0x2000000000000000000000000000000000000002" as Address;
const data = "0x1234" as Hex;
const hash = `0x${"3".repeat(64)}` as Hash;

test("preflights and sends the exact same immutable transaction request", async () => {
  const calls: string[] = [];
  let estimateRequest: ExampleTransactionEstimateRequest | null = null;
  let simulatedRequest: ExampleTransactionRequest | null = null;
  let sentRequest: ExampleTransactionRequest | null = null;

  const result = await simulateAndSendTransaction(
    account,
    { to, data, value: 7n },
    async (request) => {
      calls.push("estimate");
      estimateRequest = request;
      return 101n;
    },
    async (request) => {
      calls.push("simulate");
      simulatedRequest = request;
    },
    async (request) => {
      calls.push("send");
      sentRequest = request;
      return hash;
    }
  );

  assert.equal(result, hash);
  assert.deepEqual(calls, ["estimate", "simulate", "send"]);
  assert.deepEqual(estimateRequest, { account, to, data, value: 7n });
  assert.equal(Object.isFrozen(estimateRequest), true);
  assert.equal(sentRequest, simulatedRequest);
  assert.deepEqual(sentRequest, { account, to, data, value: 7n, gas: 122n });
  assert.equal(Object.isFrozen(sentRequest), true);
});

test("does not invoke the wallet send when preflight simulation fails", async () => {
  let sendCalled = false;

  await assert.rejects(
    simulateAndSendTransaction(
      account,
      { to, data, value: 0n },
      async () => 100n,
      async () => {
        throw new Error("execution reverted");
      },
      async () => {
        sendCalled = true;
        return hash;
      }
    ),
    /execution reverted/
  );

  assert.equal(sendCalled, false);
});

test("does not simulate or send when gas estimation fails", async () => {
  let simulateCalled = false;
  let sendCalled = false;

  await assert.rejects(
    simulateAndSendTransaction(
      account,
      { to, data, value: 0n },
      async () => {
        throw new Error("estimation reverted");
      },
      async () => {
        simulateCalled = true;
      },
      async () => {
        sendCalled = true;
        return hash;
      }
    ),
    /estimation reverted/
  );

  assert.equal(simulateCalled, false);
  assert.equal(sendCalled, false);
});
