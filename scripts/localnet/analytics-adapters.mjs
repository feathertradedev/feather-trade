import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const UINT128_MASK = (1n << 128n) - 1n;
const Q128 = 1n << 128n;
const USD_SCALE = 10n ** 18n;
const GET_PRICE_FROM_ID_SELECTOR = "0x4c7cffbd";
const GET_BIN_SELECTOR = "0x0abe9688";
const TOTAL_SUPPLY_SELECTOR = "0xbd85b039";
const GET_STATIC_FEE_PARAMETERS_SELECTOR = "0x7ca0de30";
const GET_VARIABLE_FEE_PARAMETERS_SELECTOR = "0x8d7024e5";
const POOL_BIN_RADIUS = 40;
const MAX_INCREMENTAL_BIN_READS = POOL_BIN_RADIUS * 2 + 1;
const MAX_UINT24 = 0xff_ff_ff;
const DEFAULT_REORG_RETENTION_BLOCKS = 256;
const DEFAULT_RPC_URL = "http://127.0.0.1:8545";
const DEFAULT_INDEXER_URL = "http://127.0.0.1:8000/subgraphs/name/robinhood-lb/localnet";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_MANIFEST_PATH = resolve(REPO_ROOT, "deployments/examples/localnet.example.json");
const DEFAULT_POLICY_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "analytics-price-policies.json");

const HEAD_QUERY = `
  query LocalAnalyticsHead {
    _meta { block { number hash } hasIndexingErrors }
  }
`;

const BLOCK_QUERY = `
  query LocalAnalyticsBlock($block: Int!, $blockNumber: BigInt!) {
    _meta(block: { number: $block }) { block { number hash } hasIndexingErrors }
    pairs(first: 1000, block: { number: $block }) {
      id address reserveX reserveY activeId binStep
      tokenX { id address }
      tokenY { id address }
    }
    swaps(first: 1000, block: { number: $block }, where: { blockNumber: $blockNumber }) {
      id pair { id } activeId amountInX amountInY amountOutX amountOutY totalFeeX totalFeeY protocolFeeX protocolFeeY
      transactionHash
    }
    liquidityEvents(first: 1000, block: { number: $block }, where: { blockNumber: $blockNumber }) {
      id pair { id } type ids amounts transactionHash
    }
    transferBatchEvents(first: 1000, block: { number: $block }, where: { blockNumber: $blockNumber }) {
      id pair { id } from to ids amounts transactionHash
    }
  }
`;

const POSITION_QUERY = `
  query LocalAnalyticsPositions($block: Int!, $owner: Bytes!) {
    _meta(block: { number: $block }) { block { number hash } hasIndexingErrors }
    positions(first: 1000, block: { number: $block }, where: { owner: $owner }) {
      id liquidity
      pair {
        id address
        tokenX { id address }
        tokenY { id address }
      }
      bin { binId reserveX reserveY totalSupply }
    }
  }
`;

export async function createBlockSource(options = {}) {
  const config = await loadConfig(options);
  const decimals = new Map();
  const canonicalBlocks = new Map();
  let poolProgress = new Map();
  let nextBlock = config.startBlock;
  let firstFetch = true;

  await assertLocalChain(config);

  function startupCursor() {
    // The source's poolProgress and canonical hash window are intentionally
    // process-local. Rebuild them from manifest startBlock on every process
    // start instead of treating a persisted service cursor as sufficient.
    return null;
  }

  async function fetchPage(cursor) {
    // poolProgress is intentionally process-local and affects whether a block
    // carries a sparse observation or a full replacement. A fresh adapter must
    // therefore rebuild it from the manifest's deployment block before it can
    // safely honor a persisted analytics cursor. This also guarantees that an
    // offline reorg which regrew past that cursor cannot skip its replacement
    // ancestors. Pages after the first successful fetch resume normally.
    const requestedStart = firstFetch
      ? config.startBlock
      : cursor === null
        ? config.startBlock
        : parseCursor(cursor);
    const target = await waitForExactHead(config);
    const canonicalHead = canonicalHeadFromTarget(target);
    const reorgStart = await findReorgStart(config, canonicalBlocks, target.number);
    const start = reorgStart === null ? requestedStart : Math.min(requestedStart, reorgStart);
    let rewindTo = null;
    if (reorgStart !== null) {
      if (reorgStart > target.number) {
        const retainedHead = canonicalBlocks.get(target.number)?.block;
        if (retainedHead === undefined || retainedHead.hash !== target.hash) {
          throw new Error(`Cannot reconcile rolled-back local head ${target.number}:${target.hash}`);
        }
        rewindTo = {
          number: retainedHead.number,
          hash: retainedHead.hash,
          timestamp: retainedHead.timestamp
        };
      }
      for (const number of [...canonicalBlocks.keys()]) {
        if (number >= reorgStart) canonicalBlocks.delete(number);
      }
      poolProgress = clonePoolProgress(canonicalBlocks.get(reorgStart - 1)?.poolProgressAfter ?? new Map());
    }
    if (start > target.number) {
      // A live cursor can sit beyond a head that rolled back between polls.
      // Continue from the attested head's child as the chain regrows.
      nextBlock = target.number + 1;
      firstFetch = false;
      return { blocks: [], canonicalHead, nextCursor: String(nextBlock), hasMore: false, rewindTo };
    }

    const end = Math.min(target.number, start + config.pageSize - 1);
    const blocks = [];
    for (let number = start; number <= end; number += 1) {
      const cached = canonicalBlocks.get(number);
      if (cached !== undefined) {
        blocks.push(cached.block);
        poolProgress = clonePoolProgress(cached.poolProgressAfter);
        continue;
      }
      const workingPoolProgress = clonePoolProgress(poolProgress);
      const block = await loadBlock(config, decimals, workingPoolProgress, number);
      poolProgress = workingPoolProgress;
      blocks.push(block);
      canonicalBlocks.set(number, { block, poolProgressAfter: clonePoolProgress(poolProgress) });
      trimCanonicalCache(canonicalBlocks, config.reorgRetentionBlocks);
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

  async function followLive(ingest, reconcileHead) {
    let cursor = String(nextBlock);
    while (!config.signal?.aborted) {
      const page = await fetchPage(cursor);
      if (page.rewindTo != null) {
        if (typeof reconcileHead !== "function") {
          throw new Error("Local analytics source detected a head rollback but no canonical-head reconciler is configured");
        }
        await reconcileHead(page.rewindTo);
      }
      for (const block of page.blocks) await ingest(block);
      if (!page.hasMore && page.canonicalHead != null) {
        if (typeof reconcileHead !== "function") {
          throw new Error("Local analytics source cannot attest its canonical head without a reconciler");
        }
        await reconcileHead(page.canonicalHead);
      }
      cursor = page.nextCursor ?? cursor;
      if (!page.hasMore) await delay(config.pollIntervalMs, config.signal);
    }
  }

  return { fetchPage, startupCursor, followLive };
}

function canonicalHeadFromTarget(target) {
  return {
    number: BigInt(target.number),
    hash: target.hash,
    timestamp: target.timestamp
  };
}

export async function createPositionSnapshotProvider(options = {}) {
  const config = await loadConfig(options);
  const decimals = new Map();
  await assertLocalChain(config);

  return {
    async load(ownerValue, head) {
      const owner = address(ownerValue, "owner");
      const number = safeNumber(head.number, "canonical head number");
      const expectedHash = hash(head.hash, "canonical head hash");
      const exactHead = await waitForExactHead(config);
      if (exactHead.number < number) {
        throw new Error(`Indexer head ${exactHead.number} is behind analytics head ${number}`);
      }
      if (exactHead.number === number && exactHead.hash !== expectedHash) {
        throw new Error(`Canonical head ${number} changed from ${expectedHash} to ${exactHead.hash}`);
      }
      const rpcBlock = await rpc(config, "eth_getBlockByNumber", [quantity(number), false]);
      assertRpcBlock(rpcBlock, number);
      if (normalize(rpcBlock.hash) !== expectedHash) {
        throw new Error(`RPC block ${number} hash ${rpcBlock.hash} does not match analytics head ${expectedHash}`);
      }

      const data = await graph(config, POSITION_QUERY, { block: number, owner });
      assertGraphMeta(data._meta, { number, hash: expectedHash });
      const positions = boundedRows(data.positions, "positions");
      const grouped = new Map();

      for (const row of positions) {
        const liquidity = unsigned(row.liquidity, "position liquidity");
        if (liquidity === 0n) continue;
        const pair = await pairIdentity(config, decimals, row.pair, number);
        const binId = decimal(row.bin?.binId, "position bin id");
        const reserveX = unsigned(row.bin?.reserveX, "bin reserveX");
        const reserveY = unsigned(row.bin?.reserveY, "bin reserveY");
        const totalSupply = unsigned(row.bin?.totalSupply, "bin totalSupply");
        if (totalSupply === 0n || liquidity > totalSupply) {
          throw new Error(`Invalid position supply for ${pair.pair} bin ${binId}`);
        }
        const current = grouped.get(pair.pair) ?? { ...pair, owner, kind: "position-snapshot", bins: [] };
        current.bins.push({
          binId,
          liquidity,
          amountX: (reserveX * liquidity) / totalSupply,
          amountY: (reserveY * liquidity) / totalSupply
        });
        grouped.set(pair.pair, current);
      }

      return [...grouped.values()]
        .map((snapshot) => ({ ...snapshot, bins: snapshot.bins.sort(compareBinIds) }))
        .sort((left, right) => left.pair.localeCompare(right.pair))
        .map((snapshot, sequence) => ({
          ...snapshot,
          source: blockSnapshotSource(expectedHash, `${snapshot.pair}:${owner}:position`, sequence)
        }));
    }
  };
}

async function loadBlock(config, decimals, poolProgress, number) {
  const rpcBlock = await rpc(config, "eth_getBlockByNumber", [quantity(number), false]);
  assertRpcBlock(rpcBlock, number);
  const blockHash = hash(rpcBlock.hash, `RPC block ${number} hash`);
  const data = await graph(config, BLOCK_QUERY, { block: number, blockNumber: String(number) });
  assertGraphMeta(data._meta, { number, hash: blockHash });

  const pairRows = boundedRows(data.pairs, "pairs");
  const identities = new Map();
  for (const row of pairRows) {
    const identity = await pairIdentity(config, decimals, row, number);
    identities.set(identity.pair, {
      ...identity,
      reserveX: unsigned(row.reserveX, "pair reserveX"),
      reserveY: unsigned(row.reserveY, "pair reserveY")
    });
  }

  const sourceRegistry = createSourceRegistry();
  const transfers = canonicalRows(data.transferBatchEvents, "transferBatchEvents", sourceRegistry)
    .map(({ row, source }) => parseTransfer(row, source));
  const consumedTransfers = new Set();
  const ordered = [];

  for (const { row, source } of canonicalRows(data.swaps, "swaps", sourceRegistry)) {
    const pair = requirePair(identities, row.pair?.id);
    const observation = await marketObservation(config, pair, safeNumber(row.activeId, "swap activeId"), number);
    const feeX = unsigned(row.totalFeeX, "swap totalFeeX");
    const feeY = unsigned(row.totalFeeY, "swap totalFeeY");
    const protocolFeeX = unsigned(row.protocolFeeX, "swap protocolFeeX");
    const protocolFeeY = unsigned(row.protocolFeeY, "swap protocolFeeY");
    if (protocolFeeX > feeX || protocolFeeY > feeY) {
      throw new Error(`Swap ${String(row.id)} protocol fee exceeds its total trader-paid fee`);
    }
    ordered.push({
      order: eventOrder(row.id),
      source,
      event: {
        ...pair,
        ...observation,
        kind: "swap",
        amountInX: unsigned(row.amountInX, "swap amountInX"),
        amountInY: unsigned(row.amountInY, "swap amountInY"),
        feeX,
        feeY,
        protocolFeeX,
        protocolFeeY
      }
    });
  }

  for (const { row, source } of canonicalRows(data.liquidityEvents, "liquidityEvents", sourceRegistry)) {
    const kind = String(row.type).toUpperCase() === "DEPOSIT"
      ? "deposit"
      : String(row.type).toUpperCase() === "WITHDRAW"
        ? "withdraw"
        : null;
    if (kind === null) throw new Error(`Unsupported liquidity event type ${String(row.type)}`);
    const pair = requirePair(identities, row.pair?.id);
    const ids = decimalsArray(row.ids, "liquidity ids");
    const packed = hexArray(row.amounts, "liquidity amounts");
    if (ids.length !== packed.length) throw new Error("Liquidity ids/amounts length mismatch");
    const transactionHash = hash(row.transactionHash, "liquidity transaction hash");
    const transferIndex = transfers.findIndex((candidate, index) =>
      !consumedTransfers.has(index) &&
      candidate.transactionHash === transactionHash &&
      candidate.pair === pair.pair &&
      equalArrays(candidate.ids, ids) &&
      (kind === "deposit" ? candidate.from === ZERO_ADDRESS : candidate.to === ZERO_ADDRESS)
    );
    if (transferIndex < 0) throw new Error(`Missing ${kind} TransferBatch for ${transactionHash}`);
    consumedTransfers.add(transferIndex);
    const transfer = transfers[transferIndex];
    const owner = kind === "deposit" ? transfer.to : transfer.from;
    const bins = ids.map((binId, index) => {
      const amounts = decodePackedAmounts(packed[index]);
      return {
        binId,
        liquidityDelta: kind === "deposit" ? transfer.amounts[index] : -transfer.amounts[index],
        amountX: amounts.amountX,
        amountY: amounts.amountY
      };
    });
    ordered.push({ order: eventOrder(row.id), source, event: { ...pair, kind, owner, bins } });
  }

  transfers.forEach((transfer, index) => {
    if (consumedTransfers.has(index) || transfer.from === ZERO_ADDRESS || transfer.to === ZERO_ADDRESS) return;
    const pair = requirePair(identities, transfer.pair);
    ordered.push({
      order: transfer.order,
      source: transfer.source,
      event: {
        pair: pair.pair,
        tokenX: pair.tokenX,
        tokenY: pair.tokenY,
        decimalsX: pair.decimalsX,
        decimalsY: pair.decimalsY,
        kind: "position-transfer",
        from: transfer.from,
        to: transfer.to,
        bins: transfer.ids.map((binId, index) => ({ binId, liquidity: transfer.amounts[index] }))
      }
    });
  });

  ordered.sort((left, right) => left.order - right.order);
  const events = ordered.map((entry, sequence) => ({
    ...entry.event,
    source: { ...entry.source, sequence }
  }));
  const logEventCount = events.length;
  const pairEntries = [...identities.values()].sort((left, right) => left.pair.localeCompare(right.pair));
  for (const [pairIndex, pair] of pairEntries.entries()) {
    const snapshotSource = blockSnapshotSource(blockHash, `${pair.pair}:pool`, logEventCount + pairIndex);
    const poolState = await poolStateObservation({
      config,
      number,
      pair,
      priorActiveId: poolProgress.get(pair.pair)?.activeId ?? null,
      events,
      snapshotSource
    });
    events.push({
      ...pair,
      kind: "pair-snapshot",
      source: snapshotSource,
      ...(poolState === null ? {} : { poolState })
    });
    poolProgress.set(pair.pair, { activeId: pair.activeId });
  }

  return {
    chainId: config.chainId,
    number: BigInt(number),
    hash: blockHash,
    parentHash: hash(rpcBlock.parentHash, `RPC block ${number} parent hash`),
    timestamp: hexQuantity(rpcBlock.timestamp, `RPC block ${number} timestamp`),
    prices: config.policies.map((policy) => ({
      token: policy.token,
      source: "fixed-test",
      feedId: policy.feedId,
      priceUsdE18: config.priceUsdE18,
      confidenceUsdE18: 0n,
      observedAt: hexQuantity(rpcBlock.timestamp, `RPC block ${number} timestamp`),
      sequence: BigInt(number),
      signedReport: null
    })),
    events
  };
}

async function findReorgStart(config, canonicalBlocks, targetNumber) {
  const cachedNumbers = [...canonicalBlocks.keys()];
  const hasOrphanedSuffix = cachedNumbers.some((number) => number > targetNumber);
  const overlapping = [...canonicalBlocks.keys()]
    .filter((number) => number <= targetNumber)
    .sort((left, right) => right - left);
  if (overlapping.length === 0) {
    if (hasOrphanedSuffix) {
      throw new Error(`Local head rollback exceeds the retained ${config.reorgRetentionBlocks}-block source window`);
    }
    return null;
  }

  for (const number of overlapping) {
    const rpcBlock = await rpc(config, "eth_getBlockByNumber", [quantity(number), false]);
    assertRpcBlock(rpcBlock, number);
    if (hash(rpcBlock.hash, `RPC block ${number} hash`) === canonicalBlocks.get(number).block.hash) {
      if (hasOrphanedSuffix && number === targetNumber) return targetNumber + 1;
      return number === overlapping[0] ? null : number + 1;
    }
  }
  throw new Error(`Local reorg exceeds the retained ${config.reorgRetentionBlocks}-block source window`);
}

function trimCanonicalCache(canonicalBlocks, retentionBlocks) {
  const numbers = [...canonicalBlocks.keys()].sort((left, right) => left - right);
  while (numbers.length > retentionBlocks) canonicalBlocks.delete(numbers.shift());
}

function clonePoolProgress(progress) {
  return new Map([...progress.entries()].map(([pair, value]) => [pair, { ...value }]));
}

async function poolStateObservation({ config, number, pair, priorActiveId, events, snapshotSource }) {
  if (pair.activeId === null || pair.activeId === undefined) return null;
  const touched = events.filter((event) =>
    event.pair === pair.pair && (event.kind === "swap" || event.kind === "deposit" || event.kind === "withdraw")
  );
  if (priorActiveId !== null && touched.length === 0 && priorActiveId === pair.activeId) return null;

  const selection = selectObservedBinIds({
    priorActiveId,
    activeId: pair.activeId,
    events: touched
  });
  const [feeState, binUpdates] = await Promise.all([
    readPoolFeeState(config, pair.pair, number),
    mapWithConcurrency(selection.binIds, 8, (binId) => readPoolBin(config, pair.pair, binId, number))
  ]);
  const sourceEventIds = touched.map((event) => event.source.eventId);
  if (selection.replaceBinWindow || sourceEventIds.length === 0) sourceEventIds.push(snapshotSource.eventId);
  return {
    feeState,
    binUpdates,
    sourceEventIds: [...new Set(sourceEventIds)],
    replaceBinWindow: selection.replaceBinWindow
  };
}

function selectObservedBinIds({ priorActiveId, activeId, events }) {
  if (priorActiveId === null) {
    return { binIds: centeredBinWindow(activeId), replaceBinWindow: true };
  }

  const ids = new Set();
  let cursor = priorActiveId;
  let exceeded = false;
  const addRange = (left, right) => {
    const low = Math.max(0, Math.min(left, right));
    const high = Math.min(MAX_UINT24, Math.max(left, right));
    if (high < low) return;
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
    if (event.kind === "swap" && event.activeId !== null && event.activeId !== undefined) {
      addRange(cursor, event.activeId);
      cursor = event.activeId;
    }
    if (event.kind === "deposit" || event.kind === "withdraw") {
      for (const bin of event.bins) {
        const binId = safeNumber(bin.binId, "liquidity bin id");
        ids.add(binId);
        if (ids.size > MAX_INCREMENTAL_BIN_READS) exceeded = true;
      }
    }
  }
  addRange(cursor, activeId);
  ids.add(activeId);

  if (activeId > priorActiveId) {
    addRange(priorActiveId + POOL_BIN_RADIUS + 1, activeId + POOL_BIN_RADIUS);
  } else if (activeId < priorActiveId) {
    addRange(activeId - POOL_BIN_RADIUS, priorActiveId - POOL_BIN_RADIUS - 1);
  }

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

async function readPoolBin(config, pair, binId, blockNumber) {
  if (!Number.isSafeInteger(binId) || binId < 0 || binId > MAX_UINT24) throw new Error("Pool bin ID is out of range");
  const argument = encodeWord(BigInt(binId));
  const [binResult, supplyResult] = await Promise.all([
    rpc(config, "eth_call", [{ to: pair, data: `${GET_BIN_SELECTOR}${argument}` }, quantity(blockNumber)]),
    rpc(config, "eth_call", [{ to: pair, data: `${TOTAL_SUPPLY_SELECTOR}${argument}` }, quantity(blockNumber)])
  ]);
  const [reserveX, reserveY] = decodeWords(binResult, 2, `bin ${binId} reserves for ${pair}`);
  const [totalSupply] = decodeWords(supplyResult, 1, `bin ${binId} total supply for ${pair}`);
  assertFitsUnsigned(reserveX, 128, `bin ${binId} reserveX`);
  assertFitsUnsigned(reserveY, 128, `bin ${binId} reserveY`);
  return { binId: String(binId), reserveX, reserveY, totalSupply };
}

async function readPoolFeeState(config, pair, blockNumber) {
  const block = quantity(blockNumber);
  const [staticResult, variableResult] = await Promise.all([
    rpc(config, "eth_call", [{ to: pair, data: GET_STATIC_FEE_PARAMETERS_SELECTOR }, block]),
    rpc(config, "eth_call", [{ to: pair, data: GET_VARIABLE_FEE_PARAMETERS_SELECTOR }, block])
  ]);
  const [baseFactor, filterPeriod, decayPeriod, reductionFactor, variableFeeControl, protocolShare, maxVolatilityAccumulator] =
    decodeWords(staticResult, 7, `static fee parameters for ${pair}`);
  const [volatilityAccumulator, volatilityReference, idReference, timeOfLastUpdate] =
    decodeWords(variableResult, 4, `variable fee parameters for ${pair}`);
  [baseFactor, filterPeriod, decayPeriod, reductionFactor, protocolShare]
    .forEach((value, index) => assertFitsUnsigned(value, 16, `static fee parameter ${index}`));
  [variableFeeControl, maxVolatilityAccumulator, volatilityAccumulator, volatilityReference, idReference]
    .forEach((value, index) => assertFitsUnsigned(value, 24, `fee parameter ${index}`));
  assertFitsUnsigned(timeOfLastUpdate, 40, "variable fee timeOfLastUpdate");
  return {
    static: { baseFactor, filterPeriod, decayPeriod, reductionFactor, variableFeeControl, protocolShare, maxVolatilityAccumulator },
    variable: { volatilityAccumulator, volatilityReference, idReference, timeOfLastUpdate }
  };
}

function decodeWords(value, count, label) {
  if (typeof value !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${count * 64}}$`).test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return Array.from({ length: count }, (_, index) => BigInt(`0x${value.slice(2 + index * 64, 2 + (index + 1) * 64)}`));
}

function encodeWord(value) {
  return value.toString(16).padStart(64, "0");
}

function assertFitsUnsigned(value, bits, label) {
  if (value < 0n || value >= 1n << BigInt(bits)) throw new Error(`${label} does not fit uint${bits}`);
}

async function mapWithConcurrency(values, limit, mapper) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index], index);
    }
  }));
  return results;
}

async function loadConfig(options) {
  const manifestPath = resolve(options.manifestPath ?? process.env.LOCALNET_MANIFEST_PATH ?? DEFAULT_MANIFEST_PATH);
  const policyPath = resolve(options.policyPath ?? process.env.ANALYTICS_PRICE_POLICIES ?? DEFAULT_POLICY_PATH);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.environment !== "localnet") throw new Error("Local analytics adapters require a localnet manifest");
  const policies = JSON.parse(await readFile(policyPath, "utf8"));
  if (!Array.isArray(policies) || policies.length === 0) throw new Error("Local analytics price policies must be a non-empty array");
  const normalizedPolicies = policies.map((policy) => {
    if (policy?.source !== "fixed-test") throw new Error("Local analytics price policies must use fixed-test source");
    return {
      token: address(policy.token, "price policy token"),
      feedId: nonEmptyString(policy.feedId, "price policy feedId")
    };
  });
  if (new Set(normalizedPolicies.map((policy) => policy.token)).size !== normalizedPolicies.length) {
    throw new Error("Local analytics price policy tokens must be unique");
  }
  return {
    rpcUrl: options.rpcUrl ?? process.env.LOCALNET_RPC_URL ?? manifest.endpoints?.rpcUrl ?? DEFAULT_RPC_URL,
    indexerUrl: options.indexerUrl ?? process.env.LOCALNET_INDEXER_URL ?? manifest.endpoints?.indexerUrl ?? DEFAULT_INDEXER_URL,
    chainId: safeNumber(manifest.chainId, "manifest chainId"),
    startBlock: safeNumber(manifest.startBlock, "manifest startBlock"),
    pageSize: boundedPositive(options.pageSize ?? process.env.ANALYTICS_LOCALNET_PAGE_SIZE ?? 50, 500, "page size"),
    pollIntervalMs: boundedPositive(options.pollIntervalMs ?? process.env.ANALYTICS_LOCALNET_POLL_MS ?? 1000, 60_000, "poll interval"),
    syncTimeoutMs: boundedPositive(options.syncTimeoutMs ?? process.env.ANALYTICS_LOCALNET_SYNC_TIMEOUT_MS ?? 60_000, 600_000, "sync timeout"),
    reorgRetentionBlocks: boundedPositive(
      options.reorgRetentionBlocks ?? process.env.ANALYTICS_LOCALNET_REORG_BLOCKS ?? DEFAULT_REORG_RETENTION_BLOCKS,
      10_000,
      "reorg retention blocks"
    ),
    priceUsdE18: positiveBigInt(options.priceUsdE18 ?? process.env.ANALYTICS_LOCALNET_PRICE_USD_E18 ?? "1000000000000000000", "local price"),
    policies: normalizedPolicies,
    signal: options.signal ?? null
  };
}

async function assertLocalChain(config) {
  const actual = hexQuantity(await rpc(config, "eth_chainId", []), "eth_chainId");
  if (actual !== config.chainId) throw new Error(`RPC chain ID ${actual} does not match localnet manifest ${config.chainId}`);
}

async function waitForExactHead(config) {
  const deadline = Date.now() + config.syncTimeoutMs;
  const rpcNumber = hexQuantity(await rpc(config, "eth_blockNumber", []), "eth_blockNumber");
  const rpcBlock = await rpc(config, "eth_getBlockByNumber", [quantity(rpcNumber), false]);
  assertRpcBlock(rpcBlock, rpcNumber);
  const rpcHash = hash(rpcBlock.hash, "RPC head hash");
  const rpcTimestamp = hexQuantity(rpcBlock.timestamp, "RPC head timestamp");
  while (true) {
    const data = await graph(config, HEAD_QUERY, {});
    const meta = parseGraphMeta(data._meta);
    if (meta.hasIndexingErrors) throw new Error("Indexer reports indexing errors");
    if (meta.number === rpcNumber) {
      if (meta.hash !== rpcHash) throw new Error(`RPC/indexer head hash mismatch at block ${rpcNumber}`);
      return { number: rpcNumber, hash: rpcHash, timestamp: rpcTimestamp };
    }
    // The local chain can advance while the indexer catches the captured
    // target. Per-block loads below still verify the canonical target hash.
    if (meta.number > rpcNumber) return { number: rpcNumber, hash: rpcHash, timestamp: rpcTimestamp };
    if (Date.now() >= deadline) throw new Error(`Indexer did not reach RPC head ${rpcNumber} before timeout`);
    await delay(Math.min(config.pollIntervalMs, 250), config.signal);
  }
}

async function pairIdentity(config, decimals, row, blockNumber) {
  const pair = address(row?.address ?? row?.id, "pair address");
  const tokenX = address(row?.tokenX?.address ?? row?.tokenX?.id, "tokenX address");
  const tokenY = address(row?.tokenY?.address ?? row?.tokenY?.id, "tokenY address");
  const identity = {
    pair,
    tokenX,
    tokenY,
    decimalsX: await tokenDecimals(config, decimals, tokenX, blockNumber),
    decimalsY: await tokenDecimals(config, decimals, tokenY, blockNumber)
  };
  if (row?.binStep === undefined || row?.binStep === null) return identity;
  const activeId = row?.activeId === null || row?.activeId === undefined ? null : safeNumber(row.activeId, "pair activeId");
  const binStep = safeNumber(row?.binStep, "pair binStep");
  return {
    ...identity,
    ...(activeId === null ? { activeId: null, binStep, marketPriceQuoteE18: null } : await marketObservation(config, { ...identity, binStep }, activeId, blockNumber))
  };
}

async function marketObservation(config, pair, activeId, blockNumber) {
  const binStep = safeNumber(pair.binStep, "pair binStep");
  if (activeId > 0xff_ff_ff || binStep <= 0 || binStep > 0xff_ff) throw new Error("Pair market identity is out of range");
  const calldata = `${GET_PRICE_FROM_ID_SELECTOR}${BigInt(activeId).toString(16).padStart(64, "0")}`;
  const result = await rpc(config, "eth_call", [{ to: pair.pair, data: calldata }, quantity(blockNumber)]);
  const priceQ128 = unsigned(result, `active-bin price for ${pair.pair}`);
  if (priceQ128 === 0n) throw new Error(`Active-bin price is zero for ${pair.pair}`);
  const marketPriceQuoteE18 = (priceQ128 * (10n ** BigInt(pair.decimalsX)) * USD_SCALE) /
    (Q128 * (10n ** BigInt(pair.decimalsY)));
  if (marketPriceQuoteE18 === 0n) throw new Error(`Normalized active-bin price is zero for ${pair.pair}`);
  return { activeId, binStep, marketPriceQuoteE18 };
}

async function tokenDecimals(config, cache, token, blockNumber) {
  if (cache.has(token)) return cache.get(token);
  const result = await rpc(config, "eth_call", [{ to: token, data: "0x313ce567" }, quantity(blockNumber)]);
  const value = Number(unsigned(result, `decimals for ${token}`));
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) throw new Error(`Invalid decimals for ${token}`);
  cache.set(token, value);
  return value;
}

function parseTransfer(row, source) {
  const ids = decimalsArray(row.ids, "transfer ids");
  const amounts = unsignedArray(row.amounts, "transfer amounts");
  if (ids.length !== amounts.length) throw new Error("Transfer ids/amounts length mismatch");
  return {
    order: eventOrder(row.id),
    pair: address(row.pair?.id, "transfer pair"),
    from: address(row.from, "transfer from"),
    to: address(row.to, "transfer to"),
    ids,
    amounts,
    transactionHash: hash(row.transactionHash, "transfer transaction hash"),
    source
  };
}

function createSourceRegistry() {
  return { byEventId: new Map(), byLog: new Map(), byLogIndex: new Map() };
}

function canonicalRows(value, label, registry) {
  const result = [];
  for (const row of boundedRows(value, label)) {
    const eventId = nonEmptyString(row?.id, `${label} event id`).toLowerCase();
    const transactionHash = hash(row?.transactionHash, `${label} transaction hash`);
    const logIndex = eventOrder(eventId);
    if (eventId !== `${transactionHash}-${logIndex}`) {
      throw new Error(`Canonical event id ${eventId} does not match transaction/log identity`);
    }
    const signature = JSON.stringify(row);
    const existingEvent = registry.byEventId.get(eventId);
    if (existingEvent !== undefined) {
      if (existingEvent.label !== label || existingEvent.signature !== signature) {
        throw new Error(`Conflicting duplicate canonical event id ${eventId}`);
      }
      continue;
    }
    const logKey = `${transactionHash}:${logIndex}`;
    const existingLog = registry.byLog.get(logKey);
    if (existingLog !== undefined && existingLog !== eventId) {
      throw new Error(`Conflicting canonical log identity ${logKey}`);
    }
    const existingLogIndex = registry.byLogIndex.get(logIndex);
    if (existingLogIndex !== undefined && existingLogIndex !== eventId) {
      throw new Error(`Conflicting canonical block log index ${logIndex}`);
    }
    registry.byEventId.set(eventId, { label, signature });
    registry.byLog.set(logKey, eventId);
    registry.byLogIndex.set(logIndex, eventId);
    result.push({
      row,
      source: { eventId, transactionHash, logIndex, sequence: 0, kind: "log" }
    });
  }
  return result;
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

export function decodePackedAmounts(value) {
  const packed = unsigned(value, "packed amounts");
  return { amountX: packed & UINT128_MASK, amountY: packed >> 128n };
}

function requirePair(identities, value) {
  const key = address(value, "event pair");
  const pair = identities.get(key);
  if (!pair) throw new Error(`Event references unknown pair ${key}`);
  return pair;
}

function assertGraphMeta(value, expected) {
  const meta = parseGraphMeta(value);
  if (meta.hasIndexingErrors) throw new Error("Indexer reports indexing errors");
  if (meta.number !== expected.number) throw new Error(`Indexer returned block ${meta.number}, expected ${expected.number}`);
  if (meta.hash !== expected.hash) {
    throw new Error(`RPC/indexer hash mismatch at block ${expected.number}`);
  }
}

function parseGraphMeta(value, requireHash = true) {
  if (value?.hasIndexingErrors !== false && value?.hasIndexingErrors !== true) {
    throw new Error("Indexer metadata is missing hasIndexingErrors");
  }
  const rawHash = value?.block?.hash;
  return {
    number: safeNumber(value?.block?.number, "indexer head number"),
    hash: rawHash === null && !requireHash ? null : hash(rawHash, "indexer head hash"),
    hasIndexingErrors: value?.hasIndexingErrors === true
  };
}

function assertRpcBlock(value, expectedNumber) {
  if (!value || typeof value !== "object") throw new Error(`RPC block ${expectedNumber} is missing`);
  const actual = hexQuantity(value.number, `RPC block ${expectedNumber} number`);
  if (actual !== expectedNumber) throw new Error(`RPC returned block ${actual}, expected ${expectedNumber}`);
  hash(value.hash, `RPC block ${expectedNumber} hash`);
  hash(value.parentHash, `RPC block ${expectedNumber} parent hash`);
}

async function rpc(config, method, params) {
  const payload = await postJson(config.rpcUrl, { id: 1, jsonrpc: "2.0", method, params });
  if (payload?.error) throw new Error(`${method}: ${payload.error.message ?? "JSON-RPC error"}`);
  return payload?.result;
}

async function graph(config, query, variables) {
  const payload = await postJson(config.indexerUrl, { query, variables });
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new Error(payload.errors.map((error) => error?.message ?? "GraphQL error").join("; "));
  }
  if (!payload?.data || typeof payload.data !== "object") throw new Error("Indexer returned no GraphQL data");
  return payload.data;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function boundedRows(value, label) {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label} response`);
  if (value.length >= 1000) throw new Error(`${label} reached the 1000-row local safety bound`);
  return value;
}

function eventOrder(id) {
  const match = /-(\d+)$/.exec(String(id));
  if (!match) throw new Error(`Event id ${String(id)} has no log index`);
  return safeNumber(match[1], "event log index");
}

function address(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`Invalid ${label}`);
  return normalize(value);
}

function hash(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Invalid ${label}`);
  return normalize(value);
}

function normalize(value) {
  return value.toLowerCase();
}

function decimal(value, label) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function unsigned(value, label) {
  if (typeof value !== "string" || !/^(?:0x[0-9a-fA-F]+|0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid ${label}`);
  const parsed = BigInt(value);
  if (parsed < 0n) throw new Error(`Invalid ${label}`);
  return parsed;
}

function positiveBigInt(value, label) {
  const parsed = unsigned(String(value), label);
  if (parsed === 0n) throw new Error(`${label} must be positive`);
  return parsed;
}

function decimalsArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value.map((entry) => decimal(entry, label));
}

function unsignedArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value.map((entry) => unsigned(entry, label));
}

function hexArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(entry))) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function hexQuantity(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`Invalid ${label}`);
  return safeNumber(BigInt(value), label);
}

function safeNumber(value, label) {
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  const number = Number(parsed);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Invalid ${label}`);
  return number;
}

function boundedPositive(value, maximum, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) throw new Error(`Invalid ${label}`);
  return parsed;
}

function parseCursor(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new Error("Invalid local analytics cursor");
  return safeNumber(value, "local analytics cursor");
}

function quantity(value) {
  return `0x${value.toString(16)}`;
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Invalid ${label}`);
  return value;
}

function equalArrays(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareBinIds(left, right) {
  const leftId = BigInt(left.binId);
  const rightId = BigInt(right.binId);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function delay(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const timeout = setTimeout(resolveDelay, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolveDelay();
    }, { once: true });
  });
}
