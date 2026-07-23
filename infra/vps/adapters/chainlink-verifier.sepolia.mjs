const SEPOLIA_CHAIN_ID = 11_155_111;
const MAX_RPC_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_RPC_TIMEOUT_MS = 15_000;
const DEFAULT_RPC_RETRIES = 4;
const MAX_HEADER_CACHE_SIZE = 256;

const SELECTOR = Object.freeze({
  decimals: "0x313ce567",
  description: "0x7284e416",
  latestRoundData: "0xfeaf968c"
});

/**
 * Independently verifies Chainlink AggregatorV3 Data Feed samples against the
 * exact canonical block submitted to analytics. The canonical source and this
 * verifier both read the feed; caller-provided values are never treated as
 * evidence.
 *
 * This file is intentionally dependency-free so the runtime can import its
 * custody-verified bytes through a data URL.
 */
export async function createPriceVerifier(options = {}) {
  if ((options.environment ?? process.env.ANALYTICS_ENVIRONMENT) !== "testnet") {
    throw new Error("The Sepolia Chainlink verifier requires ANALYTICS_ENVIRONMENT=testnet");
  }
  const rpcUrl = nonEmpty(options.rpcUrl ?? process.env.ANALYTICS_RPC_URL, "ANALYTICS_RPC_URL");
  validateRpcUrl(rpcUrl, options.allowInsecureRpc === true);
  const config = {
    rpcUrl,
    rpcTimeoutMs: boundedPositive(options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS, 120_000, "RPC timeout"),
    rpcRetries: boundedNonNegative(options.rpcRetries ?? DEFAULT_RPC_RETRIES, 10, "RPC retries")
  };
  const policies = parsePolicies(options.pricePolicies ?? []);
  if (policies.size === 0) throw new Error("At least one Chainlink Data Feed price policy is required");

  const chainId = hexQuantity(await rpc(config, "eth_chainId", []), "eth_chainId");
  if (chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(`RPC chain ID ${chainId} does not match Sepolia ${SEPOLIA_CHAIN_ID}`);
  }
  const uniqueFeeds = new Map([...policies.values()].map((policy) => [policy.feedId, policy]));
  await Promise.all([...uniqueFeeds.values()].map((policy) => verifyFeedIdentity(config, policy)));

  const headerCache = new Map();
  return Object.freeze({
    async verify(submission, context) {
      if (submission?.source !== "chainlink-data-feeds") {
        throw new Error("Sepolia Chainlink verifier accepts only chainlink-data-feeds submissions");
      }
      if (submission.signedReport !== null) {
        throw new Error("Chainlink Data Feed submissions must not include a signed Data Streams report");
      }
      const token = address(submission.token, "price submission token");
      const policy = policies.get(token);
      if (policy === undefined) throw new Error(`No Chainlink Data Feed policy exists for ${token}`);
      const submittedFeed = address(submission.feedId, "price submission feedId");
      if (submittedFeed !== policy.feedId) throw new Error(`Chainlink feed does not match the policy for ${token}`);

      const canonical = await canonicalHeader(config, context, headerCache);
      const round = await readRound(config, policy, canonical);
      return {
        token,
        source: "chainlink-data-feeds",
        feedId: policy.feedId,
        priceUsdE18: round.priceUsdE18,
        confidenceUsdE18: 0n,
        observedAt: round.updatedAt,
        sequence: round.roundId,
        verifiedBy: `chainlink-data-feed:${policy.feedId}:${SEPOLIA_CHAIN_ID}`
      };
    }
  });
}

async function verifyFeedIdentity(config, policy) {
  const code = await rpc(config, "eth_getCode", [policy.feedId, "latest"]);
  if (typeof code !== "string" || !/^0x[0-9a-fA-F]+$/.test(code) || /^0x0*$/.test(code)) {
    throw new Error(`Chainlink feed ${policy.feedId} has no code on Sepolia`);
  }
  const [decimalsResult, descriptionResult] = await Promise.all([
    ethCall(config, policy.feedId, SELECTOR.decimals, "latest"),
    ethCall(config, policy.feedId, SELECTOR.description, "latest")
  ]);
  const decimals = safeUint(decodeSingleWord(decimalsResult, `Chainlink decimals for ${policy.feedId}`), 8, "Chainlink decimals");
  if (decimals !== policy.feedDecimals) {
    throw new Error(`Chainlink feed ${policy.feedId} decimals ${decimals} do not match policy ${policy.feedDecimals}`);
  }
  const description = decodeAbiString(descriptionResult, `Chainlink description for ${policy.feedId}`);
  if (description !== policy.feedDescription) {
    throw new Error(`Chainlink feed ${policy.feedId} description does not match policy`);
  }
}

async function canonicalHeader(config, context, cache) {
  if (context === null || typeof context !== "object") throw new Error("Canonical block context is required");
  const number = bigintValue(context.blockNumber, "canonical block number");
  if (number < 0n) throw new Error("Canonical block number cannot be negative");
  const blockHash = hash(context.blockHash, "canonical block hash");
  const blockTimestamp = safeNumber(context.blockTimestamp, "canonical block timestamp");
  let pending = cache.get(blockHash);
  if (pending === undefined) {
    pending = rpc(config, "eth_getBlockByHash", [blockHash, false]).then((raw) => {
      if (raw === null || typeof raw !== "object") throw new Error("Canonical block is missing from the RPC");
      const actualHash = hash(raw.hash, "RPC canonical block hash");
      const actualNumber = BigInt(hexQuantityString(raw.number, "RPC canonical block number"));
      const actualTimestamp = hexQuantity(raw.timestamp, "RPC canonical block timestamp");
      if (actualHash !== blockHash || actualNumber !== number || actualTimestamp !== blockTimestamp) {
        throw new Error("Canonical block context does not match the RPC block");
      }
      return { number, hash: blockHash, timestamp: blockTimestamp };
    });
    cache.set(blockHash, pending);
    while (cache.size > MAX_HEADER_CACHE_SIZE) cache.delete(cache.keys().next().value);
  }
  try {
    return await pending;
  } catch (error) {
    cache.delete(blockHash);
    throw error;
  }
}

async function readRound(config, policy, header) {
  const result = await ethCall(
    config,
    policy.feedId,
    SELECTOR.latestRoundData,
    { blockHash: header.hash, requireCanonical: true }
  );
  const [roundId, answerWord, startedAtWord, updatedAtWord, answeredInRound] = decodeWords(
    result,
    5,
    `Chainlink latestRoundData for ${policy.feedId}`
  );
  assertFitsUnsigned(roundId, 80, `Chainlink round ID for ${policy.feedId}`);
  assertFitsUnsigned(answeredInRound, 80, `Chainlink answeredInRound for ${policy.feedId}`);
  if (roundId === 0n) throw new Error(`Chainlink round ID is zero for ${policy.feedId}`);
  const answer = signedWord(answerWord);
  if (answer <= 0n) throw new Error(`Chainlink answer is not positive for ${policy.feedId}`);
  const startedAt = safeUint256Number(startedAtWord, `Chainlink startedAt for ${policy.feedId}`);
  const updatedAt = safeUint256Number(updatedAtWord, `Chainlink updatedAt for ${policy.feedId}`);
  if (startedAt === 0 || updatedAt === 0 || startedAt > updatedAt) {
    throw new Error(`Chainlink round timestamps are invalid for ${policy.feedId}`);
  }
  if (updatedAt > header.timestamp) {
    throw new Error(`Chainlink round timestamp is after canonical block ${header.number}`);
  }
  if (answeredInRound < roundId) {
    throw new Error(`Chainlink answeredInRound precedes round ID for ${policy.feedId}`);
  }
  return {
    roundId,
    updatedAt,
    priceUsdE18: scaleToE18(answer, policy.feedDecimals, policy.feedId)
  };
}

function parsePolicies(value) {
  if (!Array.isArray(value)) throw new Error("Price policies must be an array");
  const result = new Map();
  for (const [index, policy] of value.entries()) {
    if (policy?.source !== "chainlink-data-feeds") continue;
    const token = address(policy.token, `Chainlink price policy ${index} token`);
    const feedId = address(policy.feedId, `Chainlink price policy ${index} feedId`);
    if (result.has(token)) throw new Error(`Duplicate Chainlink price policy for ${token}`);
    const feedDecimals = safeNumber(policy.feedDecimals, `Chainlink price policy ${index} feedDecimals`);
    if (feedDecimals > 36) throw new Error(`Chainlink price policy ${index} feedDecimals exceeds 36`);
    const feedDescription = nonEmpty(policy.feedDescription, `Chainlink price policy ${index} feedDescription`);
    if (!Number.isSafeInteger(policy.maxAgeSeconds) || policy.maxAgeSeconds <= 0) {
      throw new Error(`Chainlink price policy ${index} maxAgeSeconds must be positive`);
    }
    if (policy.maxConfidenceBps !== 0) {
      throw new Error(`Chainlink price policy ${index} maxConfidenceBps must be zero`);
    }
    result.set(token, { token, feedId, feedDecimals, feedDescription });
  }
  return result;
}

async function ethCall(config, to, data, blockRef) {
  const result = await rpc(config, "eth_call", [{ to, data }, blockRef]);
  return hexData(result, "RPC eth_call result");
}

let rpcSequence = 0;
async function rpc(config, method, params) {
  let lastError;
  for (let attempt = 0; attempt <= config.rpcRetries; attempt += 1) {
    const id = ++rpcSequence;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.rpcTimeoutMs);
    try {
      const response = await fetch(config.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal
      });
      const text = await boundedResponseText(response);
      if (!response.ok) {
        const error = new Error(`RPC ${method} returned HTTP ${response.status}`);
        error.transient = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        throw error;
      }
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new Error(`RPC ${method} returned invalid JSON`, { cause: error });
      }
      if (payload?.id !== id || payload?.jsonrpc !== "2.0") throw new Error(`RPC ${method} returned a mismatched response`);
      if (payload.error !== undefined) {
        const message = typeof payload.error?.message === "string" ? payload.error.message.slice(0, 200) : "JSON-RPC error";
        const error = new Error(`RPC ${method} failed: ${message}`);
        error.transient = [-32005, -32016, -32603].includes(payload.error?.code);
        throw error;
      }
      if (!("result" in payload)) throw new Error(`RPC ${method} returned no result`);
      return payload.result;
    } catch (error) {
      lastError = error;
      const transient = error?.transient === true || error instanceof TypeError || error?.name === "AbortError";
      if (!transient || attempt === config.rpcRetries) break;
      await delay(Math.min(250 * 2 ** attempt, 4_000));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`RPC ${method} failed`);
}

async function boundedResponseText(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RPC_RESPONSE_BYTES) {
    throw new Error("RPC response exceeds the configured safety bound");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RPC_RESPONSE_BYTES) {
    throw new Error("RPC response exceeds the configured safety bound");
  }
  return text;
}

function decodeWords(value, count, label) {
  const data = hexData(value, label);
  if (data.length !== 2 + count * 64) throw new Error(`Invalid ${label}`);
  return Array.from({ length: count }, (_, index) => word(data, index, label));
}

function decodeSingleWord(value, label) {
  return decodeWords(value, 1, label)[0];
}

function decodeAbiString(value, label) {
  const data = hexData(value, label);
  const offset = word(data, 0, `${label} offset`);
  if (offset !== 32n) throw new Error(`Invalid ${label} offset`);
  const length = word(data, 1, `${label} length`);
  if (length > 256n) throw new Error(`${label} exceeds the 256-byte bound`);
  const byteLength = Number(length);
  const start = 2 + 2 * 64;
  const paddedLength = Math.ceil(byteLength / 32) * 64;
  if (data.length !== start + paddedLength) throw new Error(`Invalid ${label}`);
  const bytes = Buffer.from(data.slice(start, start + byteLength * 2), "hex");
  const decoded = bytes.toString("utf8");
  if (Buffer.from(decoded, "utf8").length !== byteLength || decoded.includes("\u0000")) {
    throw new Error(`Invalid ${label} UTF-8`);
  }
  return decoded;
}

function word(data, index, label) {
  const start = 2 + index * 64;
  const end = start + 64;
  if (!Number.isSafeInteger(index) || index < 0 || end > data.length) throw new Error(`Invalid ${label}`);
  return BigInt(`0x${data.slice(start, end)}`);
}

function signedWord(value) {
  assertFitsUnsigned(value, 256, "signed ABI word");
  return value >= 1n << 255n ? value - (1n << 256n) : value;
}

function scaleToE18(value, decimals, feedId) {
  const scaled = decimals <= 18
    ? value * 10n ** BigInt(18 - decimals)
    : value / 10n ** BigInt(decimals - 18);
  if (scaled <= 0n) throw new Error(`Chainlink price rounds to zero at 18 decimals for ${feedId}`);
  return scaled;
}

function safeUint(value, bits, label) {
  assertFitsUnsigned(value, bits, label);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds safe integer range`);
  return Number(value);
}

function safeUint256Number(value, label) {
  assertFitsUnsigned(value, 256, label);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds safe integer range`);
  return Number(value);
}

function assertFitsUnsigned(value, bits, label) {
  if (typeof value !== "bigint" || value < 0n || value >= 1n << BigInt(bits)) {
    throw new Error(`${label} does not fit uint${bits}`);
  }
}

function address(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`Invalid ${label}`);
  return value.toLowerCase();
}

function hash(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Invalid ${label}`);
  return value.toLowerCase();
}

function hexData(value, label) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error(`Invalid ${label}`);
  return value.toLowerCase();
}

function hexQuantity(value, label) {
  const parsed = hexQuantityString(value, label);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds safe integer range`);
  return Number(parsed);
}

function hexQuantityString(value, label) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return BigInt(value);
}

function bigintValue(value, label) {
  if (typeof value !== "bigint") throw new Error(`${label} must be a bigint`);
  return value;
}

function safeNumber(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new Error(`${label} is required`);
  return value;
}

function boundedPositive(value, maximum, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function boundedNonNegative(value, maximum, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${label} must be between 0 and ${maximum}`);
  }
  return parsed;
}

function validateRpcUrl(value, allowInsecure) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error("ANALYTICS_RPC_URL must be a valid URL", { cause: error });
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error("ANALYTICS_RPC_URL cannot contain credentials or a fragment");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(allowInsecure && parsed.protocol === "http:" && loopback)) {
    throw new Error("ANALYTICS_RPC_URL must use HTTPS outside explicit loopback tests");
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
