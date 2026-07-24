import { readFile } from "node:fs/promises";

const TRANSFER_BATCH_TOPIC = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";
const GET_NUMBER_OF_PAIRS_SELECTOR = "0x4e937c3a";
const GET_PAIR_AT_INDEX_SELECTOR = "0x7daf5d66";
const GET_TOKEN_X_SELECTOR = "0x05e8746d";
const GET_TOKEN_Y_SELECTOR = "0xda10610c";
const DECIMALS_SELECTOR = "0x313ce567";
const BALANCE_OF_SELECTOR = "0x00fdd58e";
const TOTAL_SUPPLY_SELECTOR = "0xbd85b039";
const GET_BIN_SELECTOR = "0x0abe9688";

const DEFAULT_LOG_BLOCK_SPAN = 5_000n;
const DEFAULT_RPC_BATCH_SIZE = 100;
const DEFAULT_RPC_TIMEOUT_MS = 10_000;
const MAX_FACTORY_PAIRS = 128;
const MAX_TRANSFER_LOGS = 4_096;
const MAX_POSITION_BINS = 2_048;
const MAX_UINT24 = 0xff_ff_ffn;

/**
 * Creates the production owner-position reader used by analytics.
 *
 * LBToken does not expose holder enumeration. Candidate bin IDs are therefore
 * reconstructed from the pair's TransferBatch ownership events, then every
 * balance and claim is read again at the requested canonical block hash. Event
 * history is only an index: it is never trusted as the current balance.
 */
export async function createPositionSnapshotProvider(options = {}) {
  const config = await loadConfig(options);
  await assertRpcChain(config);

  return {
    async load(ownerValue, headValue) {
      // The zero address is the mint/burn sentinel and would match essentially
      // every LBToken lifecycle event. It is not a wallet and must never become
      // an unbounded public history query.
      const owner = nonZeroAddress(ownerValue, "owner");
      const head = canonicalHead(headValue, config.startBlock);
      await attestHead(config, head);

      const block = { blockHash: head.hash, requireCanonical: true };
      const pairs = await loadFactoryPairs(config, block);
      if (pairs.length === 0) {
        await attestHead(config, head);
        return [];
      }

      const candidates = await loadCandidateBins(config, owner, head.number, pairs);
      if (candidates.size === 0) {
        await attestHead(config, head);
        return [];
      }

      const identities = await loadPairIdentities(config, [...candidates.keys()], block);
      const balances = await loadBalances(config, owner, candidates, block);
      const claims = await loadClaims(config, balances, block);

      // Range-based eth_getLogs cannot be hash-pinned. Re-attesting the same
      // numbered head after all reads makes any concurrent reorg fail closed.
      await attestHead(config, head);

      return [...candidates.keys()]
        .sort((left, right) => left.localeCompare(right))
        .map((pair, sequence) => ({
          ...identities.get(pair),
          kind: "position-snapshot",
          owner,
          bins: (claims.get(pair) ?? []).sort(compareBins),
          source: {
            eventId: `${head.hash}:${pair}:${owner}:position`,
            transactionHash: null,
            logIndex: null,
            sequence,
            kind: "block-snapshot"
          }
        }));
    }
  };
}

async function loadConfig(options) {
  const rpcUrl = nonEmpty(options.rpcUrl ?? process.env.ANALYTICS_RPC_URL, "ANALYTICS_RPC_URL");
  const manifestPath = nonEmpty(
    options.manifestPath ?? process.env.ANALYTICS_MANIFEST_PATH,
    "ANALYTICS_MANIFEST_PATH"
  );
  let parsedUrl;
  try {
    parsedUrl = new URL(rpcUrl);
  } catch {
    throw new Error("ANALYTICS_RPC_URL must be an absolute HTTP(S) URL");
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new Error("ANALYTICS_RPC_URL must be an HTTP(S) URL");
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error("ANALYTICS_MANIFEST_PATH must contain valid JSON", { cause: error });
  }

  const chainId = positiveSafeInteger(manifest?.chainId, "manifest chainId");
  const startBlock = unsignedBigInt(manifest?.startBlock, "manifest startBlock");
  const factory = nonZeroAddress(manifest?.contracts?.lbFactory, "manifest LBFactory");
  const logBlockSpan = boundedBigInt(
    options.logBlockSpan ?? process.env.ANALYTICS_POSITION_LOG_BLOCK_SPAN ?? DEFAULT_LOG_BLOCK_SPAN,
    1n,
    100_000n,
    "ANALYTICS_POSITION_LOG_BLOCK_SPAN"
  );
  const rpcBatchSize = boundedInteger(
    options.rpcBatchSize ?? process.env.ANALYTICS_POSITION_RPC_BATCH_SIZE ?? DEFAULT_RPC_BATCH_SIZE,
    1,
    250,
    "ANALYTICS_POSITION_RPC_BATCH_SIZE"
  );
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? process.env.ANALYTICS_POSITION_RPC_TIMEOUT_MS ?? DEFAULT_RPC_TIMEOUT_MS,
    250,
    60_000,
    "ANALYTICS_POSITION_RPC_TIMEOUT_MS"
  );

  return { rpcUrl, manifestPath, chainId, startBlock, factory, logBlockSpan, rpcBatchSize, timeoutMs };
}

async function assertRpcChain(config) {
  const actual = unsignedBigInt(await rpc(config, "eth_chainId", []), "RPC chain ID");
  if (actual !== BigInt(config.chainId)) {
    throw new Error(`RPC chain ID ${actual} does not match manifest chain ID ${config.chainId}`);
  }
}

async function attestHead(config, head) {
  const block = await rpc(config, "eth_getBlockByNumber", [quantity(head.number), false]);
  if (!block || typeof block !== "object") throw new Error("Requested canonical block is unavailable");
  const number = unsignedBigInt(block.number, "RPC block number");
  const blockHash = hash(block.hash, "RPC block hash");
  const timestamp = unsignedBigInt(block.timestamp, "RPC block timestamp");
  if (number !== head.number || blockHash !== head.hash || timestamp !== BigInt(head.timestamp)) {
    throw new Error("Requested canonical head no longer matches the RPC chain");
  }
}

async function loadFactoryPairs(config, block) {
  const rawCount = await ethCall(config, config.factory, GET_NUMBER_OF_PAIRS_SELECTOR, block);
  const count = decodeSingleWord(rawCount, "factory pair count");
  if (count > BigInt(MAX_FACTORY_PAIRS)) {
    throw new Error(`Factory pair count exceeds the ${MAX_FACTORY_PAIRS}-pair safety bound`);
  }
  const calls = Array.from({ length: Number(count) }, (_, index) => ({
    to: config.factory,
    data: `${GET_PAIR_AT_INDEX_SELECTOR}${encodeWord(BigInt(index))}`
  }));
  const results = await ethCallBatch(config, calls, block);
  const pairs = results.map((result, index) =>
    nonZeroAddress(decodeAddressWord(result, `factory pair ${index}`), `factory pair ${index}`)
  );
  if (new Set(pairs).size !== pairs.length) throw new Error("Factory returned duplicate pair addresses");
  return pairs.sort((left, right) => left.localeCompare(right));
}

async function loadCandidateBins(config, owner, headNumber, pairs) {
  const knownPairs = new Set(pairs);
  const candidates = new Map();
  const seenLogs = new Set();
  const ownerTopic = addressTopic(owner);
  let observedLogs = 0;

  for (let from = config.startBlock; from <= headNumber; from += config.logBlockSpan) {
    const to = minBigInt(headNumber, from + config.logBlockSpan - 1n);
    const [outgoing, incoming] = await Promise.all([
      rpc(config, "eth_getLogs", [{
        fromBlock: quantity(from),
        toBlock: quantity(to),
        topics: [TRANSFER_BATCH_TOPIC, null, ownerTopic]
      }]),
      rpc(config, "eth_getLogs", [{
        fromBlock: quantity(from),
        toBlock: quantity(to),
        topics: [TRANSFER_BATCH_TOPIC, null, null, ownerTopic]
      }])
    ]);
    for (const collection of [outgoing, incoming]) {
      if (!Array.isArray(collection)) throw new Error("RPC returned an invalid TransferBatch log response");
      observedLogs += collection.length;
      if (observedLogs > MAX_TRANSFER_LOGS) {
        throw new Error(`Owner TransferBatch history exceeds the ${MAX_TRANSFER_LOGS}-log safety bound`);
      }
      for (const log of collection) {
        const parsed = transferLog(log, owner, config.startBlock, headNumber);
        if (!knownPairs.has(parsed.pair)) continue;
        if (seenLogs.has(parsed.key)) continue;
        seenLogs.add(parsed.key);
        let ids = candidates.get(parsed.pair);
        if (ids === undefined) {
          ids = new Set();
          candidates.set(parsed.pair, ids);
        }
        for (const id of parsed.ids) {
          ids.add(id);
          if (totalCandidateBins(candidates) > MAX_POSITION_BINS) {
            throw new Error(`Owner position history exceeds the ${MAX_POSITION_BINS}-bin safety bound`);
          }
        }
      }
    }
  }
  return candidates;
}

function transferLog(value, owner, startBlock, headNumber) {
  if (!value || typeof value !== "object" || value.removed === true) {
    throw new Error("RPC returned an invalid canonical TransferBatch log");
  }
  const pair = address(value.address, "TransferBatch pair");
  const blockNumber = unsignedBigInt(value.blockNumber, "TransferBatch block number");
  if (blockNumber < startBlock || blockNumber > headNumber) {
    throw new Error("RPC returned a TransferBatch log outside the requested range");
  }
  const blockHash = hash(value.blockHash, "TransferBatch block hash");
  const transactionHash = hash(value.transactionHash, "TransferBatch transaction hash");
  const logIndex = unsignedBigInt(value.logIndex, "TransferBatch log index");
  if (!Array.isArray(value.topics) || value.topics.length !== 4 ||
      normalizeHex(value.topics[0]) !== TRANSFER_BATCH_TOPIC) {
    throw new Error("RPC returned malformed TransferBatch topics");
  }
  const from = topicAddress(value.topics[2], "TransferBatch from");
  const to = topicAddress(value.topics[3], "TransferBatch to");
  if (from !== owner && to !== owner) throw new Error("RPC returned an owner-unscoped TransferBatch log");
  const { ids, amounts } = decodeTransferBatchData(value.data);
  if (ids.length !== amounts.length) throw new Error("TransferBatch IDs and amounts differ in length");
  for (const id of ids) {
    if (id > MAX_UINT24) throw new Error("TransferBatch bin ID exceeds uint24");
  }
  return {
    pair,
    ids,
    key: `${pair}:${blockHash}:${transactionHash}:${logIndex}`
  };
}

async function loadPairIdentities(config, pairs, block) {
  const pairCalls = pairs.flatMap((pair) => [
    { to: pair, data: GET_TOKEN_X_SELECTOR },
    { to: pair, data: GET_TOKEN_Y_SELECTOR }
  ]);
  const pairResults = await ethCallBatch(config, pairCalls, block);
  const tokenPairs = new Map();
  const tokens = new Set();
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    const tokenX = nonZeroAddress(decodeAddressWord(pairResults[index * 2], `${pair} tokenX`), `${pair} tokenX`);
    const tokenY = nonZeroAddress(decodeAddressWord(pairResults[index * 2 + 1], `${pair} tokenY`), `${pair} tokenY`);
    if (tokenX === tokenY) throw new Error(`Pair ${pair} returned identical tokens`);
    tokenPairs.set(pair, { tokenX, tokenY });
    tokens.add(tokenX);
    tokens.add(tokenY);
  }
  const sortedTokens = [...tokens].sort((left, right) => left.localeCompare(right));
  const decimalResults = await ethCallBatch(
    config,
    sortedTokens.map((token) => ({ to: token, data: DECIMALS_SELECTOR })),
    block
  );
  const decimals = new Map();
  for (let index = 0; index < sortedTokens.length; index += 1) {
    const value = decodeSingleWord(decimalResults[index], `${sortedTokens[index]} decimals`);
    if (value > 255n) throw new Error(`Token ${sortedTokens[index]} returned invalid decimals`);
    decimals.set(sortedTokens[index], Number(value));
  }
  return new Map(pairs.map((pair) => {
    const tokensForPair = tokenPairs.get(pair);
    return [pair, {
      pair,
      ...tokensForPair,
      decimalsX: decimals.get(tokensForPair.tokenX),
      decimalsY: decimals.get(tokensForPair.tokenY)
    }];
  }));
}

async function loadBalances(config, owner, candidates, block) {
  const entries = [];
  for (const pair of [...candidates.keys()].sort((left, right) => left.localeCompare(right))) {
    for (const id of [...candidates.get(pair)].sort(compareBigInts)) entries.push({ pair, id });
  }
  const ownerWord = encodeAddressWord(owner);
  const results = await ethCallBatch(config, entries.map(({ pair, id }) => ({
    to: pair,
    data: `${BALANCE_OF_SELECTOR}${ownerWord}${encodeWord(id)}`
  })), block);
  return entries.flatMap((entry, index) => {
    const liquidity = decodeSingleWord(results[index], `${entry.pair} bin ${entry.id} balance`);
    return liquidity === 0n ? [] : [{ ...entry, liquidity }];
  });
}

async function loadClaims(config, balances, block) {
  const calls = balances.flatMap(({ pair, id }) => [
    { to: pair, data: `${TOTAL_SUPPLY_SELECTOR}${encodeWord(id)}` },
    { to: pair, data: `${GET_BIN_SELECTOR}${encodeWord(id)}` }
  ]);
  const results = await ethCallBatch(config, calls, block);
  const claims = new Map();
  for (let index = 0; index < balances.length; index += 1) {
    const { pair, id, liquidity } = balances[index];
    const supply = decodeSingleWord(results[index * 2], `${pair} bin ${id} total supply`);
    const [reserveX, reserveY] = decodeWords(results[index * 2 + 1], 2, `${pair} bin ${id} reserves`);
    if (supply === 0n || liquidity > supply) throw new Error(`Pair ${pair} bin ${id} returned invalid supply`);
    if (reserveX > ((1n << 128n) - 1n) || reserveY > ((1n << 128n) - 1n)) {
      throw new Error(`Pair ${pair} bin ${id} returned invalid reserves`);
    }
    const bins = claims.get(pair) ?? [];
    bins.push({
      binId: String(id),
      liquidity,
      amountX: (reserveX * liquidity) / supply,
      amountY: (reserveY * liquidity) / supply
    });
    claims.set(pair, bins);
  }
  return claims;
}

async function ethCall(config, to, data, block) {
  return rpc(config, "eth_call", [{ to, data }, block]);
}

async function ethCallBatch(config, calls, block) {
  if (calls.length === 0) return [];
  const results = [];
  for (let index = 0; index < calls.length; index += config.rpcBatchSize) {
    const chunk = calls.slice(index, index + config.rpcBatchSize);
    results.push(...await rpcBatch(config, chunk.map((call) => ({
      method: "eth_call",
      params: [call, block]
    }))));
  }
  return results;
}

async function rpc(config, method, params) {
  const response = await postRpc(config, { id: 1, jsonrpc: "2.0", method, params });
  if (!response || typeof response !== "object" || response.id !== 1) {
    throw new Error(`${method} returned an invalid JSON-RPC response`);
  }
  if (response.error) throw new Error(`${method} failed: ${rpcErrorMessage(response.error)}`);
  if (!("result" in response)) throw new Error(`${method} returned no result`);
  return response.result;
}

async function rpcBatch(config, calls) {
  const request = calls.map((call, index) => ({
    id: index + 1,
    jsonrpc: "2.0",
    method: call.method,
    params: call.params
  }));
  const response = await postRpc(config, request);
  if (!Array.isArray(response) || response.length !== request.length) {
    throw new Error("RPC batch returned an invalid response count");
  }
  const byId = new Map();
  for (const entry of response) {
    if (!entry || typeof entry !== "object" || !Number.isSafeInteger(entry.id) || byId.has(entry.id)) {
      throw new Error("RPC batch returned invalid response IDs");
    }
    byId.set(entry.id, entry);
  }
  return request.map(({ id, method }) => {
    const entry = byId.get(id);
    if (!entry) throw new Error("RPC batch omitted a response");
    if (entry.error) throw new Error(`${method} failed: ${rpcErrorMessage(entry.error)}`);
    if (!("result" in entry)) throw new Error(`${method} returned no result`);
    return entry.result;
  });
}

async function postRpc(config, body) {
  let response;
  try {
    response = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs)
    });
  } catch (error) {
    throw new Error("RPC request failed", { cause: error });
  }
  if (!response.ok) throw new Error(`RPC request returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch (error) {
    throw new Error("RPC returned invalid JSON", { cause: error });
  }
}

function canonicalHead(value, startBlock) {
  if (!value || typeof value !== "object") throw new Error("Canonical head is required");
  const number = unsignedBigInt(value.number, "canonical head number");
  if (number < startBlock) throw new Error("Canonical head predates the deployment manifest");
  const timestamp = positiveSafeInteger(value.timestamp, "canonical head timestamp");
  return { number, hash: hash(value.hash, "canonical head hash"), timestamp };
}

function decodeTransferBatchData(value) {
  const bytes = hexBytes(value, "TransferBatch data");
  if (bytes.length < 64 || bytes.length % 32 !== 0) throw new Error("TransferBatch data has invalid length");
  const idsOffset = wordAt(bytes, 0, "TransferBatch IDs offset");
  const amountsOffset = wordAt(bytes, 32, "TransferBatch amounts offset");
  return {
    ids: dynamicWords(bytes, idsOffset, "TransferBatch IDs"),
    amounts: dynamicWords(bytes, amountsOffset, "TransferBatch amounts")
  };
}

function dynamicWords(bytes, offsetValue, label) {
  if (offsetValue > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} offset is too large`);
  const offset = Number(offsetValue);
  if (offset % 32 !== 0 || offset < 64 || offset + 32 > bytes.length) throw new Error(`${label} offset is invalid`);
  const lengthValue = wordAt(bytes, offset, `${label} length`);
  if (lengthValue > BigInt(MAX_POSITION_BINS)) throw new Error(`${label} exceeds the safety bound`);
  const length = Number(lengthValue);
  if (offset + 32 + length * 32 > bytes.length) throw new Error(`${label} is truncated`);
  return Array.from({ length }, (_, index) => wordAt(bytes, offset + 32 + index * 32, label));
}

function decodeSingleWord(value, label) {
  return decodeWords(value, 1, label)[0];
}

function decodeWords(value, count, label) {
  const bytes = hexBytes(value, label);
  if (bytes.length !== count * 32) throw new Error(`${label} returned ${bytes.length} bytes, expected ${count * 32}`);
  return Array.from({ length: count }, (_, index) => wordAt(bytes, index * 32, label));
}

function decodeAddressWord(value, label) {
  const bytes = hexBytes(value, label);
  if (bytes.length !== 32 || bytes.subarray(0, 12).some((byte) => byte !== 0)) {
    throw new Error(`${label} returned an invalid address word`);
  }
  return address(`0x${bytes.subarray(12).toString("hex")}`, label);
}

function wordAt(bytes, offset, label) {
  if (offset < 0 || offset + 32 > bytes.length) throw new Error(`${label} is truncated`);
  return BigInt(`0x${bytes.subarray(offset, offset + 32).toString("hex")}`);
}

function hexBytes(value, label) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error(`${label} is invalid hex`);
  return Buffer.from(value.slice(2), "hex");
}

function topicAddress(value, label) {
  if (typeof value !== "string" || !/^0x0{24}[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${label} topic is invalid`);
  return address(`0x${value.slice(-40)}`, label);
}

function addressTopic(value) {
  return `0x${"0".repeat(24)}${value.slice(2)}`;
}

function encodeAddressWord(value) {
  return `${"0".repeat(24)}${value.slice(2)}`;
}

function encodeWord(value) {
  if (value < 0n || value >= (1n << 256n)) throw new Error("Cannot encode out-of-range uint256");
  return value.toString(16).padStart(64, "0");
}

function quantity(value) {
  return `0x${value.toString(16)}`;
}

function totalCandidateBins(candidates) {
  let total = 0;
  for (const ids of candidates.values()) total += ids.size;
  return total;
}

function rpcErrorMessage(error) {
  if (typeof error?.message !== "string" || error.message.trim() === "") return "JSON-RPC error";
  return error.message.slice(0, 300).replaceAll(/https?:\/\/\S+/g, "[redacted-url]");
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value.trim();
}

function address(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${label} is not an EVM address`);
  return value.toLowerCase();
}

function nonZeroAddress(value, label) {
  const parsed = address(value, label);
  if (parsed === "0x0000000000000000000000000000000000000000") {
    throw new Error(`${label} must not be the zero address`);
  }
  return parsed;
}

function hash(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} is not a block hash`);
  return value.toLowerCase();
}

function normalizeHex(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function unsignedBigInt(value, label) {
  if ((typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") ||
      (typeof value === "string" && !/^(?:0x[0-9a-fA-F]+|0|[1-9][0-9]*)$/.test(value))) {
    throw new Error(`${label} is not an unsigned integer`);
  }
  let parsed;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${label} is not an unsigned integer`);
  }
  if (parsed < 0n) throw new Error(`${label} is not an unsigned integer`);
  return parsed;
}

function positiveSafeInteger(value, label) {
  const parsed = unsignedBigInt(value, label);
  const number = Number(parsed);
  if (parsed === 0n || !Number.isSafeInteger(number)) throw new Error(`${label} is not a positive safe integer`);
  return number;
}

function boundedInteger(value, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function boundedBigInt(value, minimum, maximum, label) {
  const parsed = unsignedBigInt(value, label);
  if (parsed < minimum || parsed > maximum) throw new Error(`${label} is outside its safety bound`);
  return parsed;
}

function minBigInt(left, right) {
  return left < right ? left : right;
}

function compareBigInts(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareBins(left, right) {
  return compareBigInts(BigInt(left.binId), BigInt(right.binId));
}
