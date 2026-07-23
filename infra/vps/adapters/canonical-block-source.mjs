import { readFile } from "node:fs/promises";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const UINT128_MASK = (1n << 128n) - 1n;
const Q128 = 1n << 128n;
const USD_SCALE = 10n ** 18n;
const MAX_UINT24 = 0xff_ff_ff;
const POOL_BIN_RADIUS = 40;
const MAX_INCREMENTAL_BIN_READS = POOL_BIN_RADIUS * 2 + 1;

const DEFAULT_MANIFEST_PATH = "/run/feather/config/deployment.json";
const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_CONFIRMATIONS = 2;
const DEFAULT_REORG_RETENTION_BLOCKS = 256;
const DEFAULT_RPC_TIMEOUT_MS = 15_000;
const DEFAULT_RPC_RETRIES = 4;
const DEFAULT_DISCOVERY_BLOCK_SPAN = 10_000;
const DEFAULT_PRICE_SAMPLE_BLOCK_INTERVAL = 5;
const MAX_PAGE_SIZE = 250;
const MAX_PAIRS = 1_000;
const MAX_LOGS_PER_PAGE = 10_000;
const MAX_ABI_ARRAY_LENGTH = 2_048;
const MAX_RPC_RESPONSE_BYTES = 16 * 1024 * 1024;

const TOPIC = Object.freeze({
  pairCreated: "0x2c8d104b27c6b7f4492017a6f5cf3803043688934ebcaa6a03540beeaf976aff",
  swap: "0xad7d6f97abf51ce18e17a38f4d70e975be9c0708474987bb3e26ad21bd93ca70",
  deposit: "0x87f1f9dcf5e8089a3e00811b6a008d8f30293a3da878cb1fe8c90ca376402f8a",
  withdraw: "0xa32e146844d6144a22e94c586715a1317d58a8aa3581ec33d040113ddcb24350",
  transferBatch: "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb",
  compositionFees: "0x3f0b46725027bb418b2005f4683538eccdbcdf1de2b8649a29dbd9c507d16ff4",
  collectedProtocolFees: "0x3f41a5ddc53701cc7db577ade4f1fca9838a8ec0b5ea50b9f0f5d17bc4554e32",
  staticFeeParametersSet: "0xd09e5ddc721ff14c5c1e66a305cbba1fd70b82c5232bc391aad6f55e62e4b046",
  flashLoan: "0xd126bd9d94daca8e55ffd8283fac05394aec8326c6b1639e1e8a445fbe8bbc7d",
  forcedDecay: "0x282afaeeae84c1d85ad1424a3aa2ddbedaeefca3b1e53d889d15265fe44db7fc"
});

const MODELED_PAIR_TOPICS = new Set([TOPIC.swap, TOPIC.deposit, TOPIC.withdraw, TOPIC.transferBatch]);
const SNAPSHOT_TRIGGER_TOPICS = new Set([
  TOPIC.compositionFees,
  TOPIC.collectedProtocolFees,
  TOPIC.staticFeeParametersSet,
  TOPIC.flashLoan,
  TOPIC.forcedDecay
]);
const TRACKED_PAIR_TOPICS = [...MODELED_PAIR_TOPICS, ...SNAPSHOT_TRIGGER_TOPICS];

const SELECTOR = Object.freeze({
  decimals: "0x313ce567",
  getTokenX: "0x05e8746d",
  getTokenY: "0xda10610c",
  getBinStep: "0x17f11ecc",
  getReserves: "0x0902f1ac",
  getActiveId: "0xdbe65edc",
  getBin: "0x0abe9688",
  totalSupply: "0xbd85b039",
  getStaticFeeParameters: "0x7ca0de30",
  getVariableFeeParameters: "0x8d7024e5",
  getPriceFromId: "0x4c7cffbd",
  latestRoundData: "0xfeaf968c",
  description: "0x7284e416"
});

/**
 * Canonical Sepolia analytics source backed only by an authenticated JSON-RPC
 * endpoint. The endpoint is supplied at runtime; it is never persisted or
 * included in errors. Every state read uses an EIP-1898 canonical block-hash
 * reference so a reorg cannot combine logs and state from different forks.
 */
export async function createBlockSource(options = {}) {
  const config = await loadConfig(options);
  const decimals = new Map();
  const canonicalBlocks = new Map();
  let pairs = new Map();
  let poolProgress = new Map();
  let priceRounds = new Map();
  let nextBlock = config.startBlock;
  let firstFetch = true;
  let identityRefreshPending = false;

  await assertChain(config);

  async function startupCursor(checkpoint, signal) {
    const persistedCursor = checkpoint?.persistedCursor;
    const retainedHead = checkpoint?.retainedHead;
    if (persistedCursor === null || retainedHead === null || retainedHead === undefined) return null;
    const cursor = parseCursor(persistedCursor);
    const retainedNumber = safeNumber(retainedHead.number, "retained canonical head number");
    if (
      retainedNumber < config.startBlock ||
      cursor < config.startBlock ||
      cursor > retainedNumber + 1
    ) return null;

    const rawHeader = await rpc(config, "eth_getBlockByNumber", [quantity(retainedNumber), false], signal);
    const header = parseHeader(rawHeader, retainedNumber);
    if (header.hash !== hash(retainedHead.hash, "retained canonical head hash") ||
      header.timestamp !== safeNumber(retainedHead.timestamp, "retained canonical head timestamp")) {
      // An offline reorg invalidated the persisted cursor. A complete replay is
      // the only safe recovery because the checkpoint interface exposes only
      // the retained head, not its materialized source suffix.
      return null;
    }

    const rebuiltPairs = await discoverPairsThrough(config, decimals, header, signal);
    const activeEntries = await mapWithConcurrency([...rebuiltPairs.values()], config.pairConcurrency, async (identity) => {
      const result = await ethCall(config, identity.pair, SELECTOR.getActiveId, canonicalBlockRef(header), signal);
      return [identity.pair, {
        activeId: safeUint(decodeSingleWord(result, `active ID for ${identity.pair}`), 24, `active ID for ${identity.pair}`)
      }];
    });
    pairs = rebuiltPairs;
    poolProgress = new Map(activeEntries);
    // The checkpoint contract does not expose retained oracle rounds. Start
    // empty so the first sampled live block re-emits one authenticated current
    // round. The engine's token-scoped sequence dedupe makes normal restarts
    // idempotent, while a newly introduced policy cannot remain sample-less
    // until a slow feed's next heartbeat.
    priceRounds = new Map();
    const block = {
      chainId: config.chainId,
      number: BigInt(header.number),
      hash: header.hash,
      parentHash: header.parentHash,
      timestamp: header.timestamp,
      prices: [],
      events: []
    };
    canonicalBlocks.clear();
    canonicalBlocks.set(header.number, {
      block,
      pairsAfter: clonePairs(pairs),
      poolProgressAfter: clonePoolProgress(poolProgress),
      priceRoundsAfter: clonePriceRounds(priceRounds)
    });
    nextBlock = retainedNumber + 1;
    firstFetch = false;
    // Live ingestion advances the retained canonical head without rewriting the
    // completed backfill cursor. Resume from the attested head, then publish one
    // fresh snapshot on the next canonical block so newly added identity fields
    // can enrich legacy checkpoints without mutating an already-persisted block.
    identityRefreshPending = true;
    return String(nextBlock);
  }

  async function fetchPage(cursor, signal) {
    const requestedStart = firstFetch
      ? config.startBlock
      : cursor === null
        ? config.startBlock
        : parseCursor(cursor);
    const target = await canonicalTarget(config, signal);
    const canonicalHead = canonicalHeadFromHeader(target);
    const reorgStart = await findReorgStart(config, canonicalBlocks, target.number, signal);
    const start = reorgStart === null ? requestedStart : Math.min(requestedStart, reorgStart);
    let rewindTo = null;

    if (reorgStart !== null) {
      if (reorgStart > target.number) {
        const retained = canonicalBlocks.get(target.number);
        if (retained === undefined || retained.block.hash !== target.hash) {
          throw new Error(`Cannot reconcile rolled-back canonical head ${target.number}`);
        }
        rewindTo = canonicalHeadFromBlock(retained.block);
      }
      for (const number of [...canonicalBlocks.keys()]) {
        if (number >= reorgStart) canonicalBlocks.delete(number);
      }
      const ancestor = canonicalBlocks.get(reorgStart - 1);
      pairs = clonePairs(ancestor?.pairsAfter ?? new Map());
      poolProgress = clonePoolProgress(ancestor?.poolProgressAfter ?? new Map());
      priceRounds = clonePriceRounds(ancestor?.priceRoundsAfter ?? new Map());
    }

    if (start > target.number) {
      nextBlock = target.number + 1;
      firstFetch = false;
      return {
        blocks: [],
        canonicalHead,
        nextCursor: String(nextBlock),
        hasMore: false,
        rewindTo
      };
    }

    const end = Math.min(target.number, start + config.pageSize - 1);
    const cachedBlocks = [];
    let cacheMiss = false;
    for (let number = start; number <= end; number += 1) {
      const cached = canonicalBlocks.get(number);
      if (cached === undefined) {
        cacheMiss = true;
        break;
      }
      cachedBlocks.push(cached.block);
      pairs = clonePairs(cached.pairsAfter);
      poolProgress = clonePoolProgress(cached.poolProgressAfter);
      priceRounds = clonePriceRounds(cached.priceRoundsAfter);
    }

    let blocks = cachedBlocks;
    if (cacheMiss) {
      if (cachedBlocks.length !== 0) {
        throw new Error("Canonical source cache contains a non-contiguous requested page");
      }
      const expectedParentHash = start === config.startBlock
        ? null
        : canonicalBlocks.get(start - 1)?.block.hash ?? null;
      if (start > config.startBlock && expectedParentHash === null) {
        throw new Error(`Cannot hash-pin canonical page ${start}-${end} without its retained parent`);
      }
      const loaded = await loadRange(
        config,
        decimals,
        pairs,
        poolProgress,
        priceRounds,
        start,
        end,
        expectedParentHash,
        identityRefreshPending,
        signal
      );
      blocks = loaded.blocks;
      pairs = loaded.pairs;
      poolProgress = loaded.poolProgress;
      priceRounds = loaded.priceRounds;
      if (identityRefreshPending && loaded.blocks.length > 0) identityRefreshPending = false;
      for (const state of loaded.states) {
        canonicalBlocks.set(safeNumber(state.block.number, "canonical block number"), {
          block: state.block,
          pairsAfter: state.pairsAfter,
          poolProgressAfter: state.poolProgressAfter,
          priceRoundsAfter: state.priceRoundsAfter
        });
        trimCanonicalCache(canonicalBlocks, config.reorgRetentionBlocks);
      }
    }

    nextBlock = end + 1;
    firstFetch = false;
    return {
      blocks,
      canonicalHead,
      nextCursor: String(nextBlock),
      hasMore: end < target.number,
      rewindTo
    };
  }

  async function followLive(ingest, reconcileHead, signal) {
    let cursor = String(nextBlock);
    while (!signal?.aborted) {
      const page = await fetchPage(cursor, signal);
      if (page.rewindTo !== null) {
        if (typeof reconcileHead !== "function") {
          throw new Error("Canonical source detected a rollback without a head reconciler");
        }
        await reconcileHead(page.rewindTo);
      }
      for (const block of page.blocks) {
        if (signal?.aborted) return;
        await ingest(block);
      }
      if (!page.hasMore && page.canonicalHead !== null) {
        if (typeof reconcileHead !== "function") {
          throw new Error("Canonical source cannot attest its head without a reconciler");
        }
        await reconcileHead(page.canonicalHead);
      }
      cursor = page.nextCursor ?? cursor;
      if (!page.hasMore && !await abortableDelay(config.pollIntervalMs, signal)) return;
    }
  }

  return { fetchPage, startupCursor, followLive };
}

async function loadRange(
  config,
  decimals,
  initialPairs,
  initialProgress,
  initialPriceRounds,
  start,
  end,
  expectedParentHash,
  forceIdentityRefresh,
  signal
) {
  const pairs = clonePairs(initialPairs);
  const poolProgress = clonePoolProgress(initialProgress);
  const priceRounds = clonePriceRounds(initialPriceRounds);
  const headers = await loadHeaders(config, start, end, signal);
  assertHeaderChain(headers, config, start);
  if (expectedParentHash !== null && headers[0].parentHash !== expectedParentHash) {
    throw new Error(`Canonical page parent changed before block ${start}`);
  }
  const headerByNumber = new Map(headers.map((header) => [header.number, header]));

  const factoryLogs = await getLogs(config, {
    address: config.factory,
    fromBlock: quantity(start),
    toBlock: quantity(end),
    topics: [TOPIC.pairCreated]
  }, signal);
  validateLogs(factoryLogs, headerByNumber, config.factory, "factory");

  const discoveredAddresses = factoryLogs.map(parsePairCreatedLog).map((entry) => entry.pair);
  const pairAddresses = [...new Set([...pairs.keys(), ...discoveredAddresses])].sort();
  if (pairAddresses.length > config.maxPairs) {
    throw new Error(`Discovered pool count exceeds configured bound ${config.maxPairs}`);
  }

  const pairLogs = pairAddresses.length === 0
    ? []
    : await getPairLogs(config, pairAddresses, start, end, signal);
  validateLogs(pairLogs, headerByNumber, new Set(pairAddresses), "pair");
  if (factoryLogs.length + pairLogs.length > MAX_LOGS_PER_PAGE) {
    throw new Error(`Canonical log page exceeds the ${MAX_LOGS_PER_PAGE}-log safety bound`);
  }

  const factoryByBlock = groupLogs(factoryLogs);
  const pairByBlock = groupLogs(pairLogs);
  const blocks = [];
  const states = [];

  for (const header of headers) {
    const blockFactoryLogs = factoryByBlock.get(header.number) ?? [];
    for (const log of blockFactoryLogs) {
      const created = parsePairCreatedLog(log);
      const identity = await readAndVerifyPairIdentity(config, decimals, created, header, header, signal);
      const current = pairs.get(identity.pair);
      if (current !== undefined && !sameIdentity(current, identity)) {
        throw new Error(`Pool identity changed for ${identity.pair}`);
      }
      pairs.set(identity.pair, identity);
    }

    const logs = pairByBlock.get(header.number) ?? [];
    const logsByPair = new Map();
    for (const log of logs) {
      const identity = pairs.get(log.address);
      if (identity === undefined) {
        throw new Error(`Pair log precedes canonical factory discovery for ${log.address}`);
      }
      const entries = logsByPair.get(log.address) ?? [];
      entries.push(log);
      logsByPair.set(log.address, entries);
    }

    const createdInBlock = new Set(blockFactoryLogs.map((log) => parsePairCreatedLog(log).pair));
    const refreshIdentities = new Set(
      forceIdentityRefresh && header === headers[0] ? pairs.keys() : []
    );
    const touchedPairs = [...new Set([...createdInBlock, ...logsByPair.keys(), ...refreshIdentities])].sort();
    const eventsByPair = new Map();
    const snapshots = [];

    await mapWithConcurrency(touchedPairs, config.pairConcurrency, async (pairAddress) => {
      const identity = pairs.get(pairAddress);
      if (identity === undefined) throw new Error(`Missing canonical identity for ${pairAddress}`);
      const pairLogsForBlock = logsByPair.get(pairAddress) ?? [];
      const [pairState, swapPrices] = await Promise.all([
        readPairState(config, identity, header, signal),
        readSwapPrices(config, identity, pairLogsForBlock, header, signal)
      ]);
      const parsed = parsePairEvents(identity, pairState, pairLogsForBlock, swapPrices);
      eventsByPair.set(pairAddress, parsed);
      const snapshotSource = blockSnapshotSource(header.hash, `${pairAddress}:pool`, 0);
      const observation = await buildPoolStateObservation({
        config,
        header,
        identity,
        pairState,
        priorActiveId: poolProgress.get(pairAddress)?.activeId ?? null,
        events: parsed.map((entry) => ({ ...entry.event, source: entry.source })),
        rawSourceEventIds: pairLogsForBlock.map(logEventId),
        snapshotSource,
        forceReplace: createdInBlock.has(pairAddress) || refreshIdentities.has(pairAddress),
        signal
      });
      snapshots.push({ identity, pairState, snapshotSource, observation });
      poolProgress.set(pairAddress, { activeId: pairState.activeId });
    });

    const ordered = [...eventsByPair.values()].flat().sort((left, right) => left.logIndex - right.logIndex);
    assertUniqueLogIdentities(ordered);
    const events = ordered.map((entry, sequence) => ({
      ...entry.event,
      source: { ...entry.source, sequence }
    }));
    snapshots.sort((left, right) => left.identity.pair.localeCompare(right.identity.pair));
    for (const [index, snapshot] of snapshots.entries()) {
      const source = { ...snapshot.snapshotSource, sequence: events.length + index };
      events.push({
        ...snapshot.identity,
        reserveX: snapshot.pairState.reserveX,
        reserveY: snapshot.pairState.reserveY,
        activeId: snapshot.pairState.activeId,
        binStep: snapshot.pairState.binStep,
        marketPriceQuoteE18: snapshot.pairState.marketPriceQuoteE18,
        kind: "pair-snapshot",
        source,
        poolState: {
          ...snapshot.observation,
          sourceEventIds: snapshot.observation.sourceEventIds.length === 0
            ? [source.eventId]
            : snapshot.observation.sourceEventIds
        }
      });
    }

    const shouldSamplePrices = config.chainlinkFeeds.length !== 0 &&
      (createdInBlock.size !== 0 || logs.length !== 0 || header.number % config.priceSampleBlockInterval === 0);
    const sampledPrices = shouldSamplePrices
      ? await readChainlinkPrices(config, header, signal)
      : [];
    const prices = [];
    for (const sample of sampledPrices) {
      if (priceRounds.get(sample.token) !== sample.sequence) prices.push(sample);
      priceRounds.set(sample.token, sample.sequence);
    }

    const block = {
      chainId: config.chainId,
      number: BigInt(header.number),
      hash: header.hash,
      parentHash: header.parentHash,
      timestamp: header.timestamp,
      // Oracle reads are hash-pinned to this canonical block and independently
      // re-read by the verifier before they can reach the analytics engine.
      // DEX state never becomes an authoritative TVL price sample.
      prices,
      events
    };
    blocks.push(block);
    states.push({
      block,
      pairsAfter: clonePairs(pairs),
      poolProgressAfter: clonePoolProgress(poolProgress),
      priceRoundsAfter: clonePriceRounds(priceRounds)
    });
  }

  return { blocks, states, pairs, poolProgress, priceRounds };
}

async function loadHeaders(config, start, end, signal) {
  const numbers = Array.from({ length: end - start + 1 }, (_, index) => start + index);
  return mapWithConcurrency(numbers, config.headerConcurrency, async (number) => {
    const raw = await rpc(config, "eth_getBlockByNumber", [quantity(number), false], signal);
    return parseHeader(raw, number);
  });
}

async function readChainlinkPrices(config, header, signal) {
  if (config.chainlinkFeeds.length === 0) return [];
  return mapWithConcurrency(config.chainlinkFeeds, config.headerConcurrency, async (feed) => {
    const result = await ethCall(
      config,
      feed.feedId,
      SELECTOR.latestRoundData,
      canonicalBlockRef(header),
      signal
    );
    const [roundId, answerWord, startedAtWord, updatedAtWord, answeredInRound] = decodeWords(
      result,
      5,
      `Chainlink latestRoundData for ${feed.feedId}`
    );
    assertFitsUnsigned(roundId, 80, `Chainlink round ID for ${feed.feedId}`);
    assertFitsUnsigned(answeredInRound, 80, `Chainlink answeredInRound for ${feed.feedId}`);
    if (roundId === 0n) throw new Error(`Chainlink round ID is zero for ${feed.feedId}`);
    const answer = signedWord(answerWord);
    if (answer <= 0n) throw new Error(`Chainlink answer is not positive for ${feed.feedId}`);
    const startedAt = safeUint256Number(startedAtWord, `Chainlink startedAt for ${feed.feedId}`);
    const updatedAt = safeUint256Number(updatedAtWord, `Chainlink updatedAt for ${feed.feedId}`);
    if (startedAt === 0 || updatedAt === 0 || startedAt > updatedAt) {
      throw new Error(`Chainlink round timestamps are invalid for ${feed.feedId}`);
    }
    if (updatedAt > header.timestamp) {
      throw new Error(`Chainlink round timestamp is after canonical block ${header.number}`);
    }
    if (answeredInRound < roundId) {
      throw new Error(`Chainlink answeredInRound precedes round ID for ${feed.feedId}`);
    }
    const priceUsdE18 = scaleToE18(answer, feed.feedDecimals, feed.feedId);
    return {
      token: feed.token,
      source: "chainlink-data-feeds",
      feedId: feed.feedId,
      priceUsdE18,
      // AggregatorV3 Data Feeds do not expose a confidence interval. Zero is
      // the explicit N/A representation and the matching policy requires zero.
      confidenceUsdE18: 0n,
      observedAt: updatedAt,
      sequence: roundId,
      signedReport: null
    };
  });
}

async function discoverPairsThrough(config, decimals, head, signal) {
  const logs = [];
  for (let start = config.startBlock; start <= head.number; start += config.discoveryBlockSpan) {
    const end = Math.min(head.number, start + config.discoveryBlockSpan - 1);
    logs.push(...await getLogs(config, {
      address: config.factory,
      fromBlock: quantity(start),
      toBlock: quantity(end),
      topics: [TOPIC.pairCreated]
    }, signal));
    if (logs.length > config.maxPairs) throw new Error(`Discovered pool count exceeds configured bound ${config.maxPairs}`);
  }
  const creationBlocks = [...new Set(logs.map((log) => log.blockNumber))];
  const headers = await mapWithConcurrency(creationBlocks, config.headerConcurrency, async (number) =>
    parseHeader(await rpc(config, "eth_getBlockByNumber", [quantity(number), false], signal), number)
  );
  const creationHeaderByNumber = new Map(headers.map((header) => [header.number, header]));
  validateLogs(logs, creationHeaderByNumber, config.factory, "factory");
  const creations = logs.sort(compareLogs).map(parsePairCreatedLog);
  const duplicate = firstDuplicate(creations.map((created) => created.pair));
  if (duplicate !== null) throw new Error(`Factory emitted duplicate canonical pool creation for ${duplicate}`);
  const entries = await mapWithConcurrency(creations, config.pairConcurrency, async (created) => {
    const creationHeader = creationHeaderByNumber.get(created.log.blockNumber);
    if (creationHeader === undefined || creationHeader.hash !== created.log.blockHash) {
      throw new Error(`Canonical creation header is unavailable for ${created.pair}`);
    }
    return [
      created.pair,
      await readAndVerifyPairIdentity(config, decimals, created, head, creationHeader, signal)
    ];
  });
  return new Map(entries);
}

function assertHeaderChain(headers, config, start) {
  for (let index = 1; index < headers.length; index += 1) {
    if (headers[index].parentHash !== headers[index - 1].hash) {
      throw new Error(`RPC returned a non-canonical header sequence at block ${headers[index].number}`);
    }
  }
  if (headers[0]?.number !== start || headers.at(-1)?.number !== start + headers.length - 1) {
    throw new Error("RPC header page is not contiguous");
  }
  if (headers.some((header) => header.number < config.startBlock)) {
    throw new Error("RPC header page precedes the deployment block");
  }
}

async function getPairLogs(config, pairAddresses, start, end, signal) {
  const chunks = chunk(pairAddresses, config.addressesPerLogRequest);
  const pages = await mapWithConcurrency(chunks, config.logConcurrency, (addresses) => getLogs(config, {
    address: addresses,
    fromBlock: quantity(start),
    toBlock: quantity(end),
    topics: [TRACKED_PAIR_TOPICS]
  }, signal));
  return pages.flat().sort(compareLogs);
}

async function getLogs(config, filter, signal) {
  const result = await rpc(config, "eth_getLogs", [filter], signal);
  if (!Array.isArray(result)) throw new Error("RPC eth_getLogs result is not an array");
  return result.map(parseLog).sort(compareLogs);
}

function validateLogs(logs, headerByNumber, expectedAddress, label) {
  const ids = new Set();
  for (const log of logs) {
    const header = headerByNumber.get(log.blockNumber);
    if (header === undefined || header.hash !== log.blockHash) {
      throw new Error(`${label} log is not pinned to the captured canonical header`);
    }
    if (expectedAddress instanceof Set ? !expectedAddress.has(log.address) : log.address !== expectedAddress) {
      throw new Error(`${label} log came from an unexpected address`);
    }
    const id = `${log.transactionHash}:${log.logIndex}`;
    if (ids.has(id)) throw new Error(`Duplicate canonical log ${id}`);
    ids.add(id);
  }
}

function parsePairCreatedLog(log) {
  expectTopic(log, TOPIC.pairCreated, 4, "LBPairCreated");
  const tokenX = topicAddress(log.topics[1], "LBPairCreated tokenX");
  const tokenY = topicAddress(log.topics[2], "LBPairCreated tokenY");
  const binStep = safeUint(BigInt(log.topics[3]), 16, "LBPairCreated binStep topic");
  const pair = wordAddress(log.data, 0, "LBPairCreated pair");
  const pid = word(log.data, 1, "LBPairCreated pid");
  return { pair, tokenX, tokenY, binStep, pid, log };
}

async function readAndVerifyPairIdentity(config, decimals, created, observationHeader, creationHeader, signal) {
  const blockRef = canonicalBlockRef(observationHeader);
  const [tokenXResult, tokenYResult, binStepResult] = await Promise.all([
    ethCall(config, created.pair, SELECTOR.getTokenX, blockRef, signal),
    ethCall(config, created.pair, SELECTOR.getTokenY, blockRef, signal),
    ethCall(config, created.pair, SELECTOR.getBinStep, blockRef, signal)
  ]);
  const tokenX = decodeAddressResult(tokenXResult, "pair tokenX");
  const tokenY = decodeAddressResult(tokenYResult, "pair tokenY");
  const binStep = safeUint(decodeSingleWord(binStepResult, "pair bin step"), 16, "pair bin step");
  if (tokenX !== created.tokenX || tokenY !== created.tokenY || binStep !== created.binStep) {
    throw new Error(`Factory event identity does not match deployed pool ${created.pair}`);
  }
  const [decimalsX, decimalsY] = await Promise.all([
    tokenDecimals(config, decimals, tokenX, blockRef, signal),
    tokenDecimals(config, decimals, tokenY, blockRef, signal)
  ]);
  return {
    pair: created.pair,
    tokenX,
    tokenY,
    decimalsX,
    decimalsY,
    binStep,
    factoryAddress: config.factory,
    createdAtBlock: BigInt(creationHeader.number),
    createdAtBlockHash: creationHeader.hash,
    creationTransactionHash: created.log.transactionHash,
    creationLogIndex: created.log.logIndex
  };
}

async function readPairState(config, identity, header, signal) {
  const blockRef = canonicalBlockRef(header);
  const [reservesResult, activeResult, binStepResult, staticResult, variableResult] = await Promise.all([
    ethCall(config, identity.pair, SELECTOR.getReserves, blockRef, signal),
    ethCall(config, identity.pair, SELECTOR.getActiveId, blockRef, signal),
    ethCall(config, identity.pair, SELECTOR.getBinStep, blockRef, signal),
    ethCall(config, identity.pair, SELECTOR.getStaticFeeParameters, blockRef, signal),
    ethCall(config, identity.pair, SELECTOR.getVariableFeeParameters, blockRef, signal)
  ]);
  const [reserveX, reserveY] = decodeWords(reservesResult, 2, "pair reserves");
  assertFitsUnsigned(reserveX, 128, "pair reserveX");
  assertFitsUnsigned(reserveY, 128, "pair reserveY");
  const activeId = safeUint(decodeSingleWord(activeResult, "active ID"), 24, "active ID");
  const binStep = safeUint(decodeSingleWord(binStepResult, "bin step"), 16, "bin step");
  if (binStep !== identity.binStep || binStep === 0) throw new Error(`Pool bin step changed for ${identity.pair}`);
  const priceResult = await ethCall(
    config,
    identity.pair,
    `${SELECTOR.getPriceFromId}${encodeWord(BigInt(activeId))}`,
    blockRef,
    signal
  );
  const marketPriceQuoteE18 = normalizePrice(
    decodeSingleWord(priceResult, "active-bin price"),
    identity.decimalsX,
    identity.decimalsY,
    identity.pair
  );
  return {
    reserveX,
    reserveY,
    activeId,
    binStep,
    marketPriceQuoteE18,
    feeState: decodeFeeState(staticResult, variableResult)
  };
}

async function readSwapPrices(config, identity, logs, header, signal) {
  const ids = [...new Set(logs
    .filter((log) => log.topics[0] === TOPIC.swap)
    .map((log) => parseSwapLog(log).activeId))];
  const blockRef = canonicalBlockRef(header);
  const entries = await mapWithConcurrency(ids, config.pairConcurrency, async (activeId) => {
    const result = await ethCall(
      config,
      identity.pair,
      `${SELECTOR.getPriceFromId}${encodeWord(BigInt(activeId))}`,
      blockRef,
      signal
    );
    return [activeId, normalizePrice(
      decodeSingleWord(result, `Swap ${activeId} price`),
      identity.decimalsX,
      identity.decimalsY,
      identity.pair
    )];
  });
  return new Map(entries);
}

function parsePairEvents(identity, pairState, logs, swapPrices) {
  const transfers = logs
    .filter((log) => log.topics[0] === TOPIC.transferBatch)
    .map(parseTransferBatchLog);
  const consumedTransfers = new Set();
  const ordered = [];
  const common = {
    ...identity,
    reserveX: pairState.reserveX,
    reserveY: pairState.reserveY,
    activeId: pairState.activeId,
    binStep: pairState.binStep,
    marketPriceQuoteE18: pairState.marketPriceQuoteE18
  };

  for (const log of logs) {
    const topic = log.topics[0];
    if (topic === TOPIC.transferBatch) continue;
    if (SNAPSHOT_TRIGGER_TOPICS.has(topic)) continue;
    if (topic === TOPIC.swap) {
      const decoded = parseSwapLog(log);
      const marketPriceQuoteE18 = swapPrices.get(decoded.activeId);
      if (marketPriceQuoteE18 === undefined) throw new Error(`Missing exact Swap price for active ID ${decoded.activeId}`);
      ordered.push(eventEntry(log, {
        ...common,
        kind: "swap",
        activeId: decoded.activeId,
        marketPriceQuoteE18,
        amountInX: decoded.amountsIn.amountX,
        amountInY: decoded.amountsIn.amountY,
        feeX: decoded.totalFees.amountX,
        feeY: decoded.totalFees.amountY,
        protocolFeeX: decoded.protocolFees.amountX,
        protocolFeeY: decoded.protocolFees.amountY
      }));
      continue;
    }
    if (topic === TOPIC.deposit || topic === TOPIC.withdraw) {
      const kind = topic === TOPIC.deposit ? "deposit" : "withdraw";
      const decoded = parseLiquidityLog(log, kind);
      const matchIndex = transfers.findIndex((transfer, index) =>
        !consumedTransfers.has(index) &&
        transfer.transactionHash === log.transactionHash &&
        equalBigIntArrays(transfer.ids, decoded.ids) &&
        (kind === "deposit" ? transfer.from === ZERO_ADDRESS : transfer.to === ZERO_ADDRESS)
      );
      if (matchIndex < 0) throw new Error(`Missing ${kind} TransferBatch for ${log.transactionHash}`);
      consumedTransfers.add(matchIndex);
      const transfer = transfers[matchIndex];
      const owner = kind === "deposit" ? transfer.to : transfer.from;
      ordered.push(eventEntry(log, {
        ...common,
        kind,
        owner,
        bins: decoded.ids.map((id, index) => ({
          binId: id.toString(),
          liquidityDelta: kind === "deposit" ? transfer.amounts[index] : -transfer.amounts[index],
          ...decodePackedAmounts(decoded.amounts[index])
        }))
      }));
      continue;
    }
    throw new Error(`Unsupported canonical pair event topic ${topic}`);
  }

  transfers.forEach((transfer, index) => {
    if (consumedTransfers.has(index)) return;
    if (transfer.from === ZERO_ADDRESS || transfer.to === ZERO_ADDRESS) {
      throw new Error(`Unmatched mint or burn TransferBatch ${transfer.transactionHash}:${transfer.log.logIndex}`);
    }
    ordered.push(eventEntry(transfer.log, {
      pair: identity.pair,
      tokenX: identity.tokenX,
      tokenY: identity.tokenY,
      decimalsX: identity.decimalsX,
      decimalsY: identity.decimalsY,
      kind: "position-transfer",
      from: transfer.from,
      to: transfer.to,
      bins: transfer.ids.map((id, binIndex) => ({
        binId: id.toString(),
        liquidity: transfer.amounts[binIndex]
      }))
    }));
  });
  return ordered.sort((left, right) => left.logIndex - right.logIndex);
}

function parseSwapLog(log) {
  expectTopic(log, TOPIC.swap, 3, "Swap");
  const words = decodeWords(log.data, 6, "Swap data");
  return {
    activeId: safeUint(words[0], 24, "Swap active ID"),
    amountsIn: decodePackedAmounts(words[1]),
    amountsOut: decodePackedAmounts(words[2]),
    volatilityAccumulator: safeUint(words[3], 24, "Swap volatility accumulator"),
    totalFees: decodePackedAmounts(words[4]),
    protocolFees: decodePackedAmounts(words[5])
  };
}

function parseLiquidityLog(log, kind) {
  expectTopic(log, kind === "deposit" ? TOPIC.deposit : TOPIC.withdraw, 3, kind);
  const ids = dynamicWords(log.data, 0, `${kind} IDs`);
  const amounts = dynamicWords(log.data, 1, `${kind} amounts`);
  if (ids.length === 0 || ids.length !== amounts.length) {
    throw new Error(`${kind} IDs/amounts length mismatch`);
  }
  ids.forEach((id) => assertFitsUnsigned(id, 24, `${kind} bin ID`));
  return { ids, amounts };
}

function parseTransferBatchLog(log) {
  expectTopic(log, TOPIC.transferBatch, 4, "TransferBatch");
  const ids = dynamicWords(log.data, 0, "TransferBatch IDs");
  const amounts = dynamicWords(log.data, 1, "TransferBatch amounts");
  if (ids.length === 0 || ids.length !== amounts.length) {
    throw new Error("TransferBatch IDs/amounts length mismatch");
  }
  ids.forEach((id) => assertFitsUnsigned(id, 24, "TransferBatch bin ID"));
  return {
    log,
    logIndex: log.logIndex,
    transactionHash: log.transactionHash,
    from: topicAddress(log.topics[2], "TransferBatch from"),
    to: topicAddress(log.topics[3], "TransferBatch to"),
    ids,
    amounts
  };
}

async function buildPoolStateObservation({
  config,
  header,
  identity,
  pairState,
  priorActiveId,
  events,
  snapshotSource,
  rawSourceEventIds,
  forceReplace,
  signal
}) {
  const selection = forceReplace
    ? { binIds: centeredBinWindow(pairState.activeId), replaceBinWindow: true }
    : selectObservedBinIds({ priorActiveId, activeId: pairState.activeId, events });
  const blockRef = canonicalBlockRef(header);
  const binUpdates = await mapWithConcurrency(selection.binIds, config.binConcurrency, (binId) =>
    readPoolBin(config, identity.pair, binId, blockRef, signal)
  );
  const sourceEventIds = events
    .map((event) => event.source?.eventId)
    .filter((eventId) => typeof eventId === "string");
  sourceEventIds.push(...rawSourceEventIds);
  if (selection.replaceBinWindow || sourceEventIds.length === 0) sourceEventIds.push(snapshotSource.eventId);
  return {
    feeState: pairState.feeState,
    binUpdates,
    sourceEventIds: [...new Set(sourceEventIds)].sort(),
    replaceBinWindow: selection.replaceBinWindow
  };
}

function selectObservedBinIds({ priorActiveId, activeId, events }) {
  if (priorActiveId === null) return { binIds: centeredBinWindow(activeId), replaceBinWindow: true };
  const ids = new Set();
  let cursor = priorActiveId;
  let exceeded = false;
  const addRange = (left, right) => {
    const low = Math.max(0, Math.min(left, right));
    const high = Math.min(MAX_UINT24, Math.max(left, right));
    if (high - low + 1 > MAX_INCREMENTAL_BIN_READS) {
      exceeded = true;
      return;
    }
    for (let id = low; id <= high; id += 1) {
      ids.add(id);
      if (ids.size > MAX_INCREMENTAL_BIN_READS) {
        exceeded = true;
        return;
      }
    }
  };
  for (const event of events) {
    if (event.kind === "swap") {
      addRange(cursor, event.activeId);
      cursor = event.activeId;
    } else if (event.kind === "deposit" || event.kind === "withdraw") {
      for (const bin of event.bins) ids.add(safeNumber(bin.binId, "liquidity bin ID"));
    }
  }
  addRange(cursor, activeId);
  ids.add(activeId);
  if (activeId > priorActiveId) addRange(priorActiveId + POOL_BIN_RADIUS + 1, activeId + POOL_BIN_RADIUS);
  if (activeId < priorActiveId) addRange(activeId - POOL_BIN_RADIUS, priorActiveId - POOL_BIN_RADIUS - 1);
  if (exceeded || ids.size > MAX_INCREMENTAL_BIN_READS) {
    return { binIds: centeredBinWindow(activeId), replaceBinWindow: true };
  }
  return { binIds: [...ids].sort((left, right) => left - right), replaceBinWindow: false };
}

function centeredBinWindow(activeId) {
  const low = Math.max(0, activeId - POOL_BIN_RADIUS);
  const high = Math.min(MAX_UINT24, activeId + POOL_BIN_RADIUS);
  return Array.from({ length: high - low + 1 }, (_, index) => low + index);
}

async function readPoolBin(config, pair, binId, blockRef, signal) {
  const argument = encodeWord(BigInt(binId));
  const [reservesResult, supplyResult] = await Promise.all([
    ethCall(config, pair, `${SELECTOR.getBin}${argument}`, blockRef, signal),
    ethCall(config, pair, `${SELECTOR.totalSupply}${argument}`, blockRef, signal)
  ]);
  const [reserveX, reserveY] = decodeWords(reservesResult, 2, `bin ${binId} reserves`);
  const totalSupply = decodeSingleWord(supplyResult, `bin ${binId} total supply`);
  assertFitsUnsigned(reserveX, 128, `bin ${binId} reserveX`);
  assertFitsUnsigned(reserveY, 128, `bin ${binId} reserveY`);
  return { binId: String(binId), reserveX, reserveY, totalSupply };
}

function decodeFeeState(staticResult, variableResult) {
  const values = decodeWords(staticResult, 7, "static fee parameters");
  const variable = decodeWords(variableResult, 4, "variable fee parameters");
  [0, 1, 2, 3, 5].forEach((index) => assertFitsUnsigned(values[index], 16, `static fee parameter ${index}`));
  [4, 6].forEach((index) => assertFitsUnsigned(values[index], 24, `static fee parameter ${index}`));
  [0, 1, 2].forEach((index) => assertFitsUnsigned(variable[index], 24, `variable fee parameter ${index}`));
  assertFitsUnsigned(variable[3], 40, "variable fee timeOfLastUpdate");
  return {
    static: {
      baseFactor: values[0],
      filterPeriod: values[1],
      decayPeriod: values[2],
      reductionFactor: values[3],
      variableFeeControl: values[4],
      protocolShare: values[5],
      maxVolatilityAccumulator: values[6]
    },
    variable: {
      volatilityAccumulator: variable[0],
      volatilityReference: variable[1],
      idReference: variable[2],
      timeOfLastUpdate: variable[3]
    }
  };
}

async function tokenDecimals(config, cache, token, blockRef, signal) {
  if (cache.has(token)) return cache.get(token);
  const result = await ethCall(config, token, SELECTOR.decimals, blockRef, signal);
  const value = safeUint(decodeSingleWord(result, `decimals for ${token}`), 8, `decimals for ${token}`);
  cache.set(token, value);
  return value;
}

async function canonicalTarget(config, signal) {
  const rawHead = await rpc(config, "eth_blockNumber", [], signal);
  const head = hexQuantity(rawHead, "eth_blockNumber");
  const number = head - config.confirmations;
  if (number < config.startBlock) {
    throw new Error(`Confirmed RPC head ${number} is behind deployment block ${config.startBlock}`);
  }
  const raw = await rpc(config, "eth_getBlockByNumber", [quantity(number), false], signal);
  return parseHeader(raw, number);
}

async function findReorgStart(config, canonicalBlocks, targetNumber, signal) {
  const numbers = [...canonicalBlocks.keys()];
  const hasOrphanedSuffix = numbers.some((number) => number > targetNumber);
  const overlapping = numbers.filter((number) => number <= targetNumber).sort((left, right) => right - left);
  if (overlapping.length === 0) {
    if (hasOrphanedSuffix) throw new Error("Canonical rollback exceeds retained source history");
    return null;
  }
  for (const number of overlapping) {
    const raw = await rpc(config, "eth_getBlockByNumber", [quantity(number), false], signal);
    const header = parseHeader(raw, number);
    if (header.hash === canonicalBlocks.get(number).block.hash) {
      if (hasOrphanedSuffix && number === targetNumber) return targetNumber + 1;
      return number === overlapping[0] ? null : number + 1;
    }
  }
  throw new Error(`Canonical reorg exceeds the retained ${config.reorgRetentionBlocks}-block window`);
}

async function assertChain(config) {
  const actual = hexQuantity(await rpc(config, "eth_chainId", []), "eth_chainId");
  if (actual !== config.chainId) throw new Error(`RPC chain ID ${actual} does not match deployment manifest ${config.chainId}`);
  const code = await rpc(config, "eth_getCode", [config.factory, "latest"]);
  if (typeof code !== "string" || !/^0x[0-9a-fA-F]+$/.test(code) || /^0x0*$/.test(code)) {
    throw new Error("Deployment factory has no code on the configured RPC chain");
  }
  const feeds = new Map(config.chainlinkFeeds.map((feed) => [feed.feedId, feed]));
  await mapWithConcurrency([...feeds.values()], config.headerConcurrency, async (feed) => {
    const feedCode = await rpc(config, "eth_getCode", [feed.feedId, "latest"]);
    if (typeof feedCode !== "string" || !/^0x[0-9a-fA-F]+$/.test(feedCode) || /^0x0*$/.test(feedCode)) {
      throw new Error(`Chainlink feed ${feed.feedId} has no code on the configured RPC chain`);
    }
    const [decimalsResult, descriptionResult] = await Promise.all([
      ethCall(config, feed.feedId, SELECTOR.decimals, "latest"),
      ethCall(config, feed.feedId, SELECTOR.description, "latest")
    ]);
    const decimals = safeUint(decodeSingleWord(decimalsResult, `Chainlink decimals for ${feed.feedId}`), 8, "Chainlink decimals");
    if (decimals !== feed.feedDecimals) {
      throw new Error(`Chainlink feed ${feed.feedId} decimals ${decimals} do not match policy ${feed.feedDecimals}`);
    }
    const description = decodeAbiString(descriptionResult, `Chainlink description for ${feed.feedId}`);
    if (description !== feed.feedDescription) {
      throw new Error(`Chainlink feed ${feed.feedId} description does not match policy`);
    }
  });
}

async function loadConfig(options) {
  const manifestPath = options.manifestPath ?? process.env.ANALYTICS_MANIFEST_PATH ?? DEFAULT_MANIFEST_PATH;
  const manifest = options.manifest ?? JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest?.environment !== "sepolia") throw new Error("Canonical RPC adapter requires a Sepolia deployment manifest");
  const rpcUrl = nonEmpty(options.rpcUrl ?? process.env.ANALYTICS_RPC_URL, "ANALYTICS_RPC_URL");
  validateRpcUrl(rpcUrl, options.allowInsecureRpc === true);
  const chainId = safeNumber(manifest.chainId, "manifest chainId");
  if (chainId !== 11_155_111) throw new Error("Sepolia deployment manifest must use chain ID 11155111");
  const pageSize = boundedPositive(options.pageSize ?? process.env.ANALYTICS_RPC_PAGE_SIZE ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, "RPC page size");
  const reorgRetentionBlocks = boundedPositive(options.reorgRetentionBlocks ?? process.env.ANALYTICS_RPC_REORG_BLOCKS ?? DEFAULT_REORG_RETENTION_BLOCKS, 10_000, "reorg retention blocks");
  if (reorgRetentionBlocks <= pageSize) {
    throw new Error("Reorg retention must exceed the canonical RPC page size");
  }
  const chainlinkFeeds = parseChainlinkPolicies(options.pricePolicies ?? []);
  return {
    rpcUrl,
    chainId,
    factory: address(manifest.contracts?.lbFactory, "manifest LB factory"),
    startBlock: safeNumber(manifest.startBlock, "manifest startBlock"),
    pageSize,
    pollIntervalMs: boundedPositive(options.pollIntervalMs ?? process.env.ANALYTICS_RPC_POLL_MS ?? DEFAULT_POLL_INTERVAL_MS, 60_000, "RPC poll interval"),
    confirmations: boundedNonNegative(options.confirmations ?? process.env.ANALYTICS_RPC_CONFIRMATIONS ?? DEFAULT_CONFIRMATIONS, 128, "RPC confirmations"),
    reorgRetentionBlocks,
    rpcTimeoutMs: boundedPositive(options.rpcTimeoutMs ?? process.env.ANALYTICS_RPC_TIMEOUT_MS ?? DEFAULT_RPC_TIMEOUT_MS, 120_000, "RPC timeout"),
    rpcRetries: boundedNonNegative(options.rpcRetries ?? process.env.ANALYTICS_RPC_RETRIES ?? DEFAULT_RPC_RETRIES, 10, "RPC retries"),
    discoveryBlockSpan: boundedPositive(options.discoveryBlockSpan ?? process.env.ANALYTICS_RPC_DISCOVERY_BLOCK_SPAN ?? DEFAULT_DISCOVERY_BLOCK_SPAN, 100_000, "pair discovery block span"),
    priceSampleBlockInterval: boundedPositive(
      options.priceSampleBlockInterval ??
        process.env.ANALYTICS_CHAINLINK_SAMPLE_BLOCK_INTERVAL ??
        DEFAULT_PRICE_SAMPLE_BLOCK_INTERVAL,
      1_000,
      "Chainlink sample block interval"
    ),
    chainlinkFeeds,
    maxPairs: boundedPositive(options.maxPairs ?? process.env.ANALYTICS_RPC_MAX_PAIRS ?? MAX_PAIRS, MAX_PAIRS, "maximum pool count"),
    addressesPerLogRequest: boundedPositive(options.addressesPerLogRequest ?? 100, 500, "log request address count"),
    headerConcurrency: boundedPositive(options.headerConcurrency ?? 8, 32, "header concurrency"),
    logConcurrency: boundedPositive(options.logConcurrency ?? 4, 16, "log concurrency"),
    pairConcurrency: boundedPositive(options.pairConcurrency ?? 4, 16, "pair concurrency"),
    binConcurrency: boundedPositive(options.binConcurrency ?? 8, 32, "bin concurrency")
  };
}

function parseChainlinkPolicies(policies) {
  if (!Array.isArray(policies)) throw new Error("Price policies must be an array");
  const feeds = [];
  const tokens = new Set();
  for (const [index, policy] of policies.entries()) {
    if (policy?.source !== "chainlink-data-feeds") continue;
    const token = address(policy.token, `Chainlink price policy ${index} token`);
    const feedId = address(policy.feedId, `Chainlink price policy ${index} feedId`);
    if (tokens.has(token)) throw new Error(`Duplicate Chainlink price policy for ${token}`);
    tokens.add(token);
    const feedDecimals = safeNumber(policy.feedDecimals, `Chainlink price policy ${index} feedDecimals`);
    if (feedDecimals > 36) throw new Error(`Chainlink price policy ${index} feedDecimals exceeds 36`);
    const feedDescription = nonEmpty(policy.feedDescription, `Chainlink price policy ${index} feedDescription`);
    if (!Number.isSafeInteger(policy.maxAgeSeconds) || policy.maxAgeSeconds <= 0) {
      throw new Error(`Chainlink price policy ${index} maxAgeSeconds must be positive`);
    }
    if (policy.maxConfidenceBps !== 0) {
      throw new Error(`Chainlink price policy ${index} maxConfidenceBps must be zero`);
    }
    feeds.push({
      token,
      feedId,
      feedDecimals,
      feedDescription
    });
  }
  return feeds;
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

let rpcSequence = 0;
async function rpc(config, method, params, signal) {
  let lastError;
  for (let attempt = 0; attempt <= config.rpcRetries; attempt += 1) {
    if (signal?.aborted) throw abortError();
    const id = ++rpcSequence;
    try {
      const response = await fetchWithTimeout(config.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
      }, config.rpcTimeoutMs, signal);
      const text = await boundedResponseText(response, MAX_RPC_RESPONSE_BYTES);
      if (!response.ok) {
        const error = new Error(`RPC ${method} returned HTTP ${response.status}`);
        error.transient = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        error.retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"));
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
      if (signal?.aborted || error?.name === "AbortError") throw error;
      lastError = error;
      const transient = error?.transient === true || error instanceof TypeError;
      if (!transient || attempt === config.rpcRetries) break;
      const backoff = error?.retryAfterMs ?? Math.min(250 * 2 ** attempt, 4_000);
      if (!await abortableDelay(backoff + Math.floor(Math.random() * 100), signal)) throw abortError();
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`RPC ${method} failed`);
}

async function fetchWithTimeout(url, init, timeoutMs, signal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (timedOut) {
      const timeoutError = new Error("RPC request timed out");
      timeoutError.transient = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function boundedResponseText(response, limit) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error("RPC response exceeds the configured safety bound");
  const text = await response.text();
  if (Buffer.byteLength(text) > limit) throw new Error("RPC response exceeds the configured safety bound");
  return text;
}

async function ethCall(config, to, data, blockRef, signal) {
  const result = await rpc(config, "eth_call", [{ to, data }, blockRef], signal);
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]*$/.test(result)) throw new Error("RPC eth_call returned invalid data");
  return result.toLowerCase();
}

function canonicalBlockRef(header) {
  return { blockHash: header.hash, requireCanonical: true };
}

function parseHeader(value, expectedNumber) {
  if (value === null || typeof value !== "object") throw new Error(`RPC block ${expectedNumber} is missing`);
  const number = hexQuantity(value.number, `RPC block ${expectedNumber} number`);
  if (number !== expectedNumber) throw new Error(`RPC returned block ${number}, expected ${expectedNumber}`);
  return {
    number,
    hash: hash(value.hash, `RPC block ${number} hash`),
    parentHash: hash(value.parentHash, `RPC block ${number} parent hash`),
    timestamp: hexQuantity(value.timestamp, `RPC block ${number} timestamp`)
  };
}

function parseLog(value) {
  if (value === null || typeof value !== "object" || value.removed === true) throw new Error("RPC returned an invalid or removed log");
  const topics = Array.isArray(value.topics) ? value.topics.map((topic, index) => hash(topic, `log topic ${index}`)) : null;
  if (topics === null || topics.length === 0) throw new Error("RPC log has no topics");
  const data = hexData(value.data, "log data");
  return {
    address: address(value.address, "log address"),
    blockNumber: hexQuantity(value.blockNumber, "log block number"),
    blockHash: hash(value.blockHash, "log block hash"),
    transactionHash: hash(value.transactionHash, "log transaction hash"),
    logIndex: hexQuantity(value.logIndex, "log index"),
    topics,
    data
  };
}

function eventEntry(log, event) {
  return {
    logIndex: log.logIndex,
    source: {
      eventId: `${log.transactionHash}-${log.logIndex}`,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
      sequence: 0,
      kind: "log"
    },
    event
  };
}

function logEventId(log) {
  return `${log.transactionHash}-${log.logIndex}`;
}

function blockSnapshotSource(blockHash, identity, sequence) {
  return {
    eventId: `${blockHash}:${identity}`,
    transactionHash: null,
    logIndex: null,
    sequence,
    kind: "block-snapshot"
  };
}

function assertUniqueLogIdentities(entries) {
  const eventIds = new Set();
  const indexes = new Set();
  for (const entry of entries) {
    if (eventIds.has(entry.source.eventId) || indexes.has(entry.logIndex)) {
      throw new Error(`Conflicting canonical log identity ${entry.source.eventId}`);
    }
    eventIds.add(entry.source.eventId);
    indexes.add(entry.logIndex);
  }
}

function groupLogs(logs) {
  const grouped = new Map();
  for (const log of logs) {
    const entries = grouped.get(log.blockNumber) ?? [];
    entries.push(log);
    grouped.set(log.blockNumber, entries);
  }
  for (const entries of grouped.values()) entries.sort(compareLogs);
  return grouped;
}

function compareLogs(left, right) {
  return left.blockNumber - right.blockNumber || left.logIndex - right.logIndex;
}

function expectTopic(log, topic, topicCount, label) {
  if (log.topics[0] !== topic || log.topics.length !== topicCount) throw new Error(`Invalid ${label} log topics`);
}

function dynamicWords(data, headIndex, label) {
  const offset = word(data, headIndex, `${label} offset`);
  if (offset % 32n !== 0n || offset > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Invalid ${label} offset`);
  const offsetWord = Number(offset / 32n);
  if (offsetWord < 2) throw new Error(`Invalid ${label} offset`);
  const length = word(data, offsetWord, `${label} length`);
  if (length > BigInt(MAX_ABI_ARRAY_LENGTH)) throw new Error(`${label} exceeds the ${MAX_ABI_ARRAY_LENGTH}-element safety bound`);
  const count = Number(length);
  return Array.from({ length: count }, (_, index) => word(data, offsetWord + 1 + index, `${label} element`));
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

function wordAddress(data, index, label) {
  const value = word(data, index, label);
  if (value >> 160n !== 0n) throw new Error(`Invalid ${label}`);
  return address(`0x${value.toString(16).padStart(40, "0")}`, label);
}

function decodeAddressResult(value, label) {
  return wordAddress(hexData(value, label), 0, label);
}

function topicAddress(value, label) {
  if (!/^0x0{24}[0-9a-f]{40}$/.test(value)) throw new Error(`Invalid ${label}`);
  return address(`0x${value.slice(-40)}`, label);
}

function decodePackedAmounts(value) {
  const packed = typeof value === "bigint" ? value : BigInt(value);
  return { amountX: packed & UINT128_MASK, amountY: packed >> 128n };
}

function normalizePrice(priceQ128, decimalsX, decimalsY, pair) {
  if (priceQ128 <= 0n) throw new Error(`Active-bin price is zero for ${pair}`);
  const normalized = (priceQ128 * 10n ** BigInt(decimalsX) * USD_SCALE) /
    (Q128 * 10n ** BigInt(decimalsY));
  if (normalized <= 0n) throw new Error(`Normalized active-bin price is zero for ${pair}`);
  return normalized;
}

function safeUint(value, bits, label) {
  const number = typeof value === "bigint" ? value : BigInt(value);
  assertFitsUnsigned(number, bits, label);
  if (number > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds safe integer range`);
  return Number(number);
}

function safeUint256Number(value, label) {
  const number = typeof value === "bigint" ? value : BigInt(value);
  assertFitsUnsigned(number, 256, label);
  if (number > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds safe integer range`);
  return Number(number);
}

function signedWord(value) {
  const wordValue = typeof value === "bigint" ? value : BigInt(value);
  assertFitsUnsigned(wordValue, 256, "signed ABI word");
  return wordValue >= 1n << 255n ? wordValue - (1n << 256n) : wordValue;
}

function scaleToE18(value, decimals, feedId) {
  const scaled = decimals <= 18
    ? value * 10n ** BigInt(18 - decimals)
    : value / 10n ** BigInt(decimals - 18);
  if (scaled <= 0n) throw new Error(`Chainlink price rounds to zero at 18 decimals for ${feedId}`);
  return scaled;
}

function assertFitsUnsigned(value, bits, label) {
  if (value < 0n || value >= 1n << BigInt(bits)) throw new Error(`${label} does not fit uint${bits}`);
}

function encodeWord(value) {
  if (value < 0n || value >= 1n << 256n) throw new Error("ABI word is out of range");
  return value.toString(16).padStart(64, "0");
}

function quantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function hexQuantity(value, label) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) throw new Error(`Invalid ${label}`);
  const number = BigInt(value);
  if (number > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds safe integer range`);
  return Number(number);
}

function hexData(value, label) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error(`Invalid ${label}`);
  return value.toLowerCase();
}

function hash(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Invalid ${label}`);
  return value.toLowerCase();
}

function address(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`Invalid ${label}`);
  return value.toLowerCase();
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new Error(`${label} is required`);
  return value;
}

function safeNumber(value, label) {
  const parsed = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return parsed;
}

function boundedPositive(value, maximum, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) throw new Error(`${label} must be between 1 and ${maximum}`);
  return parsed;
}

function boundedNonNegative(value, maximum, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new Error(`${label} must be between 0 and ${maximum}`);
  return parsed;
}

function parseCursor(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error("Canonical block cursor is invalid");
  return safeNumber(value, "canonical block cursor");
}

function canonicalHeadFromHeader(header) {
  return { number: BigInt(header.number), hash: header.hash, timestamp: header.timestamp };
}

function canonicalHeadFromBlock(block) {
  return { number: block.number, hash: block.hash, timestamp: block.timestamp };
}

function sameIdentity(left, right) {
  return left.pair === right.pair && left.tokenX === right.tokenX && left.tokenY === right.tokenY &&
    left.decimalsX === right.decimalsX && left.decimalsY === right.decimalsY && left.binStep === right.binStep &&
    left.factoryAddress === right.factoryAddress &&
    left.createdAtBlock === right.createdAtBlock &&
    left.createdAtBlockHash === right.createdAtBlockHash &&
    left.creationTransactionHash === right.creationTransactionHash &&
    left.creationLogIndex === right.creationLogIndex;
}

function clonePairs(value) {
  return new Map([...value.entries()].map(([key, entry]) => [key, { ...entry }]));
}

function clonePoolProgress(value) {
  return new Map([...value.entries()].map(([key, entry]) => [key, { ...entry }]));
}

function clonePriceRounds(value) {
  return new Map(value);
}

function trimCanonicalCache(cache, retentionBlocks) {
  const numbers = [...cache.keys()].sort((left, right) => left - right);
  while (numbers.length > retentionBlocks) cache.delete(numbers.shift());
}

function equalBigIntArrays(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function firstDuplicate(values) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

function chunk(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function mapWithConcurrency(values, limit, mapper) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await mapper(values[index], index);
    }
  }));
  return results;
}

async function abortableDelay(milliseconds, signal) {
  if (signal?.aborted) return false;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryAfterMilliseconds(value) {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 30_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 30_000)) : null;
}

function abortError() {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}
