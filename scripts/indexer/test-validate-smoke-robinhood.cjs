#!/usr/bin/env node

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const validator = path.join(repoRoot, "scripts/indexer/validate-smoke-robinhood.cjs");
const factory = "0x2222222222222222222222222222222222222222";
const pair = "0x1111111111111111111111111111111111111111";
const tokenX = "0x5555555555555555555555555555555555555555";
const tokenY = "0x6666666666666666666666666666666666666666";
const activeId = "8388608";
const blockHash = `0x${"ab".repeat(32)}`;
const rpcUrl = "https://rpc.example/archive?api-key=validator-secret-canary";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeManifest() {
  return {
    startBlock: 100,
    contracts: {
      lbFactory: factory
    }
  };
}

function makeResponse(overrides = {}) {
  const data = {
    _meta: {
      hasIndexingErrors: false,
      block: {
        number: 110,
        hash: blockHash
      }
    },
    factories: [
      {
        id: factory,
        pairCount: "1",
        quoteAssetCount: "1",
        presetCount: "1"
      }
    ],
    pairs: [
      {
        id: pair,
        factory: { id: factory },
        tokenX: { id: tokenX },
        tokenY: { id: tokenY },
        binStep: "10",
        activeId,
        reserveX: "100",
        reserveY: "200",
        swapCount: "1",
        depositCount: "1",
        withdrawCount: "1"
      }
    ],
    bins: [
      {
        id: `${pair}-${activeId}`,
        pair: { id: pair },
        binId: activeId,
        reserveX: "90",
        reserveY: "110",
        totalSupply: "300"
      }
    ],
    swaps: [
      {
        id: "swap-1",
        pair: { id: pair },
        activeId,
        amountsIn: "0x01",
        amountInX: "1",
        amountInY: "0",
        amountsOut: "0x02",
        amountOutX: "0",
        amountOutY: "2",
        transactionHash: "0xswap"
      }
    ],
    liquidityEvents: [
      {
        id: "deposit-1",
        pair: { id: pair },
        type: "DEPOSIT",
        ids: [activeId],
        amounts: ["0x01"],
        amountX: "5",
        amountY: "6",
        transactionHash: "0xdeposit"
      },
      {
        id: "withdraw-1",
        pair: { id: pair },
        type: "WITHDRAW",
        ids: [activeId],
        amounts: ["0x01"],
        amountX: "1",
        amountY: "2",
        transactionHash: "0xwithdraw"
      }
    ],
    positions: [
      {
        id: "position-1",
        pair: { id: pair },
        owner: "0x4444444444444444444444444444444444444444",
        liquidity: "300",
        bin: { binId: activeId }
      }
    ]
  };

  return {
    data: {
      ...data,
      ...overrides
    }
  };
}

function writeJson(dir, name, value) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function writeFakeCast(dir) {
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const castPath = path.join(binDir, "cast");
  fs.writeFileSync(
    castPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.FAKE_CAST_LOG) fs.appendFileSync(process.env.FAKE_CAST_LOG, JSON.stringify(args) + "\\n");
if (args.includes("--rpc-url")) process.exit(8);
if (process.env.FAKE_CAST_FAIL === "1") {
  console.error("fixture failure for " + process.env.ETH_RPC_URL);
  process.exit(9);
}
if (args[0] === "block") {
  if (args[1] !== "110" || args[2] !== "--field" || args[3] !== "hash") process.exit(4);
  console.log(process.env.FAKE_RPC_BLOCK_HASH || "${blockHash}");
  process.exit(0);
}
const signature = args[2];
if (args[0] !== "call") process.exit(2);
const blockIndex = args.indexOf("--block");
if (blockIndex === -1 || args[blockIndex + 1] !== "110") process.exit(5);
if (signature === "getActiveId()(uint24)") console.log("${activeId}");
else if (signature === "getReserves()(uint128,uint128)") console.log("100\\n200");
else if (signature === "getBin(uint24)(uint128,uint128)") console.log("90\\n110");
else if (signature === "totalSupply(uint256)(uint256)") console.log("300");
else process.exit(3);
`
  );
  fs.chmodSync(castPath, 0o755);
  return binDir;
}

function runValidator({ env = {}, expectedPair = pair, includeRpc = false, manifest, response, rpcHeadBlock = "120" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robinhood-smoke-test-"));
  const responsePath = writeJson(dir, "response.json", response);
  const manifestPath = writeJson(dir, "manifest.json", manifest);
  const binDir = writeFakeCast(dir);
  const castLog = path.join(dir, "cast-calls.jsonl");
  const args = [validator, responsePath, manifestPath];
  if (includeRpc) {
    args.push(expectedPair, rpcHeadBlock);
  }
  const result = childProcess.spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      ...(includeRpc ? { ETH_RPC_URL: rpcUrl, FAKE_CAST_LOG: castLog } : {}),
      ...env
    }
  });
  result.castLog = castLog;
  return result;
}

function expectPass(name, input, assertion) {
  const result = runValidator(input);
  assert(result.status === 0, `${name} should pass:\n${result.stderr}\n${result.stdout}`);
  if (assertion) assertion(JSON.parse(result.stdout), result);
}

function expectFail(name, input, pattern) {
  const result = runValidator(input);
  const output = `${result.stdout}\n${result.stderr}`;
  assert(result.status !== 0, `${name} should fail`);
  assert(pattern.test(output), `${name} failed with unexpected output:\n${output}`);
}

expectPass(
  "full smoke with RPC checks",
  {
    includeRpc: true,
    manifest: makeManifest(),
    response: makeResponse()
  },
  (output, result) => {
    assert(output.requiredActivity.withdrawals === 1, "withdrawal count should be summarized");
    assert(output.rpcChecks[0].activeBinTotalSupply === "300", "active bin totalSupply should be checked");
    assert(output.rpcBlockHash === blockHash, "indexed block hash should match the RPC hash");
    const calls = fs.readFileSync(result.castLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert(calls.length === 5, `expected one block and four pinned contract reads, got ${calls.length}`);
    assert(calls.every((args) => !args.includes("--rpc-url")), "RPC URL must not appear in cast argv");
    assert(calls.filter((args) => args[0] === "call").every((args) => args[args.indexOf("--block") + 1] === "110"), "all calls must pin indexed block 110");
  }
);

expectFail(
  "stale indexer head",
  {
    env: { INDEXER_ROBINHOOD_MAX_LAG_BLOCKS: "5" },
    includeRpc: true,
    manifest: makeManifest(),
    response: makeResponse(),
    rpcHeadBlock: "120"
  },
  /10 blocks behind RPC head 120; max lag is 5/i
);

expectFail(
  "indexed block hash mismatch",
  {
    env: { FAKE_RPC_BLOCK_HASH: `0x${"cd".repeat(32)}` },
    includeRpc: true,
    manifest: makeManifest(),
    response: makeResponse()
  },
  /does not match RPC block 110 hash/i
);

const secretFailure = runValidator({
  env: { FAKE_CAST_FAIL: "1" },
  includeRpc: true,
  manifest: makeManifest(),
  response: makeResponse()
});
assert(secretFailure.status !== 0, "RPC child failure should fail closed");
const secretFailureOutput = `${secretFailure.stdout}\n${secretFailure.stderr}`;
assert(!secretFailureOutput.includes(rpcUrl), "tokenized RPC URL leaked through child-process failure");
assert(!secretFailureOutput.includes("validator-secret-canary"), "RPC token canary leaked through child-process failure");
assert(/failed against the configured RPC/i.test(secretFailureOutput), `unexpected sanitized failure: ${secretFailureOutput}`);

expectFail(
  "missing withdrawal",
  {
    manifest: makeManifest(),
    response: makeResponse({
      liquidityEvents: makeResponse().data.liquidityEvents.filter((event) => event.type !== "WITHDRAW")
    })
  },
  /missing a nonzero indexed withdrawal|expected a nonzero indexed withdrawal/i
);

expectPass("allow empty pre-liquidity endpoint", {
  env: { INDEXER_ROBINHOOD_ALLOW_EMPTY: "1" },
  expectedPair: "",
  manifest: makeManifest(),
  response: makeResponse({
    factories: [{ id: factory, pairCount: "0", quoteAssetCount: "1", presetCount: "1" }],
    pairs: [],
    bins: [],
    swaps: [],
    liquidityEvents: [],
    positions: []
  })
});

expectFail(
  "allow empty fails after pairs exist",
  {
    env: { INDEXER_ROBINHOOD_ALLOW_EMPTY: "1" },
    includeRpc: true,
    manifest: makeManifest(),
    response: makeResponse({
      bins: [],
      swaps: [],
      liquidityEvents: [],
      positions: []
    })
  },
  /ALLOW_EMPTY=1 is only allowed for pre-liquidity endpoint checks/i
);

expectFail(
  "zero decoded swap amounts",
  {
    manifest: makeManifest(),
    response: makeResponse({
      swaps: [
        {
          id: "swap-1",
          pair: { id: pair },
          activeId,
          amountsIn: "0x01",
          amountInX: "0",
          amountInY: "0",
          amountsOut: "0x02",
          amountOutX: "0",
          amountOutY: "0",
          transactionHash: "0xswap"
        }
      ]
    })
  },
  /missing a decoded indexed swap|expected a decoded indexed swap/i
);

expectFail(
  "active bin mismatch",
  {
    includeRpc: true,
    manifest: makeManifest(),
    response: makeResponse({
      bins: [
        {
          id: `${pair}-${activeId}`,
          pair: { id: pair },
          binId: activeId,
          reserveX: "91",
          reserveY: "110",
          totalSupply: "300"
        }
      ]
    })
  },
  /active bin .* reserves do not match RPC getBin/i
);

expectFail(
  "pair attached to wrong factory",
  {
    manifest: makeManifest(),
    response: makeResponse({
      pairs: [
        {
          ...makeResponse().data.pairs[0],
          factory: { id: "0x7777777777777777777777777777777777777777" }
        }
      ]
    })
  },
  /attached to factory .* expected/i
);

expectFail(
  "unsampled pair attached to wrong factory",
  {
    manifest: makeManifest(),
    response: makeResponse({
      factories: [
        {
          id: factory,
          pairCount: "6",
          quoteAssetCount: "1",
          presetCount: "1"
        }
      ],
      pairs: [
        makeResponse().data.pairs[0],
        ...Array.from({ length: 4 }, (_, index) => ({
          ...makeResponse().data.pairs[0],
          id: `0x${String(index + 10).repeat(40).slice(0, 40)}`
        })),
        {
          ...makeResponse().data.pairs[0],
          id: "0x9999999999999999999999999999999999999999",
          factory: { id: "0x7777777777777777777777777777777777777777" }
        }
      ]
    })
  },
  /attached to factory .* expected/i
);

expectFail(
  "pair token ids must be distinct addresses",
  {
    manifest: makeManifest(),
    response: makeResponse({
      pairs: [
        {
          ...makeResponse().data.pairs[0],
          tokenY: { id: tokenX }
        }
      ]
    })
  },
  /tokenX and tokenY are identical/i
);

expectFail(
  "pair bin step must be positive",
  {
    manifest: makeManifest(),
    response: makeResponse({
      pairs: [
        {
          ...makeResponse().data.pairs[0],
          binStep: "0"
        }
      ]
    })
  },
  /binStep must be >= 1/i
);

expectFail(
  "factory pair count cannot trail returned pairs",
  {
    manifest: makeManifest(),
    response: makeResponse({
      factories: [
        {
          id: factory,
          pairCount: "1",
          quoteAssetCount: "1",
          presetCount: "1"
        }
      ],
      pairs: [
        makeResponse().data.pairs[0],
        {
          ...makeResponse().data.pairs[0],
          id: "0x8888888888888888888888888888888888888888"
        }
      ]
    })
  },
  /pairCount .* below returned pair count/i
);

console.log("validate-smoke-robinhood fixture tests passed");
