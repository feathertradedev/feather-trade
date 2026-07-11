import type { Address, Hash, Hex } from "viem";

export interface ExampleBuiltTransaction {
  to: Address;
  data: Hex;
  value: bigint;
}

export interface ExampleTransactionEstimateRequest extends ExampleBuiltTransaction {
  account: Address;
}

export interface ExampleTransactionRequest extends ExampleTransactionEstimateRequest {
  gas: bigint;
}

const GAS_HEADROOM_BPS = 2_000n;
const BPS_DENOMINATOR = 10_000n;

/**
 * Estimates gas with the unmodified transaction, adds 20% headroom, and reuses one
 * immutable prepared request for the pre-submit eth_call and wallet send. A failed
 * estimate or simulation rejects before the send callback is invoked.
 */
export async function simulateAndSendTransaction(
  account: Address,
  transaction: ExampleBuiltTransaction,
  estimateGas: (request: ExampleTransactionEstimateRequest) => Promise<bigint>,
  simulate: (request: ExampleTransactionRequest) => Promise<unknown>,
  send: (request: ExampleTransactionRequest) => Promise<Hash>
): Promise<Hash> {
  const estimateRequest = Object.freeze({
    account,
    to: transaction.to,
    data: transaction.data,
    value: transaction.value
  });
  const estimatedGas = await estimateGas(estimateRequest);
  const gasHeadroom = (estimatedGas * GAS_HEADROOM_BPS + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
  const request = Object.freeze({ ...estimateRequest, gas: estimatedGas + gasHeadroom });

  await simulate(request);
  return send(request);
}
