#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");

const environments = {
  sepolia: {
    chainId: 11_155_111,
    environment: "sepolia",
    explorerUrl: "https://sepolia.etherscan.io",
    indexerUrl: null,
    name: "Ethereum Sepolia",
    rpcEnvVar: "SEPOLIA_RPC_URL",
    rpcUrl: "https://ethereum-sepolia.example.com",
    schemaVersion: "lb.evm.v1",
    tokenList: "packages/sdk/src/token-lists/sepolia.json",
    verifierUrl: "https://api-sepolia.etherscan.io/api"
  },
  robinhoodTestnet: {
    chainId: 46_630,
    environment: "testnet",
    explorerUrl: "https://explorer.testnet.chain.robinhood.com",
    indexerUrl: "https://indexer.testnet.example.com/subgraphs/name/robinhood-lb-testnet",
    name: "Robinhood Chain Testnet",
    rpcEnvVar: "ROBINHOOD_TESTNET_RPC_URL",
    rpcUrl: "https://rpc.testnet.example.com",
    schemaVersion: "lb.robinhood.v1",
    tokenList: "packages/sdk/src/token-lists/robinhood-testnet.json",
    verifierUrl: "https://explorer.testnet.chain.robinhood.com/api/"
  },
  robinhood: {
    chainId: 4_663,
    environment: "mainnet",
    explorerUrl: "https://robinhoodchain.blockscout.com",
    indexerUrl: "https://indexer.mainnet.example.com/subgraphs/name/robinhood-lb",
    name: "Robinhood Chain",
    rpcEnvVar: "ROBINHOOD_RPC_URL",
    rpcUrl: "https://rpc.mainnet.example.com",
    schemaVersion: "lb.robinhood.v1",
    tokenList: "packages/sdk/src/token-lists/robinhood.json",
    verifierUrl: "https://robinhoodchain.blockscout.com/api/"
  }
};

const addresses = {
  deployer: "0x1111111111111111111111111111111111111111",
  lbFactory: "0x5555555555555555555555555555555555555555",
  lbPairImplementation: "0x6666666666666666666666666666666666666666",
  lbQuoter: "0x7777777777777777777777777777777777777777",
  lbRouter: "0x8888888888888888888888888888888888888888"
};

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const config = environments[options.environment];
  if (config === undefined) {
    throw new Error("--environment must be sepolia, robinhoodTestnet, or robinhood");
  }

  if (typeof options.out !== "string" || options.out.length === 0) {
    throw new Error("--out is required");
  }

  const outputPath = path.resolve(repoRoot, options.out);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(buildManifest(config), null, 2)}\n`);
  console.log(path.relative(repoRoot, outputPath));
}

function buildManifest(config) {
  const tokenList = JSON.parse(fs.readFileSync(path.join(repoRoot, config.tokenList), "utf8"));
  const wrappedNative = tokenList.tokens.find((token) => token.tags?.includes("wrapped-native"))?.address;
  if (typeof wrappedNative !== "string") {
    throw new Error(`${config.tokenList} is missing a wrapped-native token`);
  }

  const quoteAssets = {
    extra0: "0x0000000000000000000000000000000000000000",
    extra1: "0x0000000000000000000000000000000000000000",
    extra2: "0x0000000000000000000000000000000000000000",
    extra3: "0x0000000000000000000000000000000000000000",
    wrappedNative
  };
  const quoteToken = tokenList.tokens.find((token) => token.tags?.includes("quote"));
  if (quoteToken?.address) quoteAssets.extra0 = quoteToken.address;

  return {
    chainId: config.chainId,
    deployer: addresses.deployer,
    environment: config.environment,
    schemaVersion: config.schemaVersion,
    ...(config.schemaVersion === "lb.evm.v1"
      ? {
          sourceCommit: "067c6ccf5b8ff1526d03fa3e4c65ec45d01c1f73",
          sourceTreeDirty: false
        }
      : { sourceJoeV2Commit: "067c6ccf5b8ff1526d03fa3e4c65ec45d01c1f73" }),
    startBlock: 1,
    endpoints: {
      rpcUrl: config.rpcUrl,
      indexerUrl: config.indexerUrl,
      apiUrl: null,
      tokenListUrl: null
    },
    chain: {
      explorerUrl: config.explorerUrl,
      name: config.name,
      nativeCurrency: "ETH",
      rpcEnvVar: config.rpcEnvVar,
      verifierUrl: config.verifierUrl
    },
    contracts: {
      lbFactory: addresses.lbFactory,
      lbPairImplementation: addresses.lbPairImplementation,
      lbQuoter: addresses.lbQuoter,
      lbRouter: addresses.lbRouter
    },
    ownership: {
      feeRecipient: addresses.deployer,
      initialOwner: addresses.deployer,
      lbFactoryOwner: addresses.deployer
    },
    tokens: {
      wrappedNative
    },
    quoteAssets,
    factoryPreset: {
      baseFactor: 10_000,
      binStep: 10,
      decayPeriod: 600,
      filterPeriod: 30,
      maxVolatilityAccumulator: 350_000,
      open: true,
      protocolShare: 0,
      reductionFactor: 5_000,
      variableFeeControl: 40_000
    },
    constructorArgs: {
      feeRecipient: addresses.deployer,
      flashLoanFee: 5_000_000_000_000,
      initialOwner: addresses.deployer,
      quoterFactoryV1: "0x0000000000000000000000000000000000000000",
      quoterFactoryV2_1: "0x0000000000000000000000000000000000000000",
      quoterFactoryV2_2: addresses.lbFactory,
      quoterLegacyFactoryV2: "0x0000000000000000000000000000000000000000",
      quoterLegacyRouterV2: "0x0000000000000000000000000000000000000000",
      quoterRouterV2_1: "0x0000000000000000000000000000000000000000",
      quoterRouterV2_2: addresses.lbRouter,
      routerFactoryV1: "0x0000000000000000000000000000000000000000",
      routerFactoryV2_1: "0x0000000000000000000000000000000000000000",
      routerLegacyFactoryV2: "0x0000000000000000000000000000000000000000",
      routerLegacyRouterV2: "0x0000000000000000000000000000000000000000",
      routerWNative: wrappedNative
    }
  };
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${arg}`);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    options[toCamelCase(arg.slice(2))] = next;
    index += 1;
  }
  return options;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function printHelp() {
  console.log("Usage: node scripts/web/create-public-config-fixture.cjs --environment <sepolia|robinhoodTestnet|robinhood> --out <path>");
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
