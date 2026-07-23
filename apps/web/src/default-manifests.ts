import type {
  LocalnetDeploymentManifest,
  RobinhoodDeploymentManifest,
  SepoliaDeploymentManifest
} from "@robinhood-lb/sdk/manifest";

export const localnetDefaultManifest = {
  chainId: 31_337,
  deployer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  environment: "localnet",
  schemaVersion: "lb.localnet.v1",
  sourceJoeV2Commit: "067c6ccf5b8ff1526d03fa3e4c65ec45d01c1f73",
  startBlock: 0,
  endpoints: {
    rpcUrl: "http://127.0.0.1:8545",
    indexerUrl: "http://127.0.0.1:8000/subgraphs/name/robinhood-lb/localnet",
    apiUrl: "http://127.0.0.1:3001",
    tokenListUrl: null
  },
  contracts: {
    lbFactory: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
    lbPairImplementation: "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
    lbQuoter: "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
    lbRouter: "0x0165878A594ca255338adfa4d48449f69242Eb8F"
  },
  ownership: {
    feeRecipient: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    initialOwner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    lbFactoryOwner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
  },
  tokens: {
    usdc: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    usdt: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
    weth: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
    wnative: "0x5FbDB2315678afecb367f032d93F642f64180aa3"
  },
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
  seededPools: {
    wethUsdc: {
      activeId: 8_396_213,
      binStep: 10,
      pair: "0xBF57b75d71d91e13C97693e4e5B850B0bE638DAc",
      tokenX: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
      tokenY: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
    }
  },
  constructorArgs: {
    feeRecipient: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    flashLoanFee: 5_000_000_000_000,
    initialOwner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    routerFactoryV1: "0x0000000000000000000000000000000000000000",
    routerFactoryV2_1: "0x0000000000000000000000000000000000000000",
    routerLegacyFactoryV2: "0x0000000000000000000000000000000000000000",
    routerLegacyRouterV2: "0x0000000000000000000000000000000000000000",
    routerWNative: "0x5FbDB2315678afecb367f032d93F642f64180aa3"
  },
  smoke: {
    liquidityAmountX: "15000000000000000000",
    liquidityAmountY: "30000000000000000000000",
    swapAmountIn: 1_000_000_000_000_000,
    swapAmountOut: 1_998_594_640_439_506_130,
    swapTokenIn: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
    swapTokenOut: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
  }
} as const satisfies LocalnetDeploymentManifest;

export const robinhoodTestnetDefaultManifest = {
  chainId: 46_630,
  deployer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  environment: "testnet",
  schemaVersion: "lb.robinhood.v1",
  sourceJoeV2Commit: "067c6ccf5b8ff1526d03fa3e4c65ec45d01c1f73",
  startBlock: 88_727_015,
  endpoints: {
    rpcUrl: "https://rpc.testnet.chain.robinhood.com",
    indexerUrl: null,
    apiUrl: null,
    tokenListUrl: null
  },
  chain: {
    explorerUrl: "https://explorer.testnet.chain.robinhood.com",
    name: "Robinhood Chain Testnet",
    nativeCurrency: "ETH",
    rpcEnvVar: "ROBINHOOD_TESTNET_RPC_URL",
    verifierUrl: "https://explorer.testnet.chain.robinhood.com/api/"
  },
  contracts: {
    lbFactory: "0x70eE76691Bdd9696552AF8d4fd634b3cF79DD529",
    lbPairImplementation: "0x8B190573374637f144AC8D37375d97fd84cBD3a0",
    lbQuoter: "0x162700d1613DfEC978032A909DE02643bC55df1A",
    lbRouter: "0x9385556B571ab92bf6dC9a0DbD75429Dd4d56F91"
  },
  ownership: {
    feeRecipient: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    initialOwner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    lbFactoryOwner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
  },
  tokens: {
    wrappedNative: "0x7943e237c7F95DA44E0301572D358911207852Fa"
  },
  quoteAssets: {
    extra0: "0x0000000000000000000000000000000000000000",
    extra1: "0x0000000000000000000000000000000000000000",
    extra2: "0x0000000000000000000000000000000000000000",
    extra3: "0x0000000000000000000000000000000000000000",
    wrappedNative: "0x7943e237c7F95DA44E0301572D358911207852Fa"
  },
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
    feeRecipient: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    flashLoanFee: 5_000_000_000_000,
    initialOwner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    quoterFactoryV1: "0x0000000000000000000000000000000000000000",
    quoterFactoryV2_1: "0x0000000000000000000000000000000000000000",
    quoterFactoryV2_2: "0x70eE76691Bdd9696552AF8d4fd634b3cF79DD529",
    quoterLegacyFactoryV2: "0x0000000000000000000000000000000000000000",
    quoterLegacyRouterV2: "0x0000000000000000000000000000000000000000",
    quoterRouterV2_1: "0x0000000000000000000000000000000000000000",
    quoterRouterV2_2: "0x9385556B571ab92bf6dC9a0DbD75429Dd4d56F91",
    routerFactoryV1: "0x0000000000000000000000000000000000000000",
    routerFactoryV2_1: "0x0000000000000000000000000000000000000000",
    routerLegacyFactoryV2: "0x0000000000000000000000000000000000000000",
    routerLegacyRouterV2: "0x0000000000000000000000000000000000000000",
    routerWNative: "0x7943e237c7F95DA44E0301572D358911207852Fa"
  }
} as const satisfies RobinhoodDeploymentManifest;

export const robinhoodDefaultManifest = {
  chainId: 4_663,
  deployer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  environment: "mainnet",
  schemaVersion: "lb.robinhood.v1",
  sourceJoeV2Commit: "067c6ccf5b8ff1526d03fa3e4c65ec45d01c1f73",
  startBlock: 4_636_405,
  endpoints: {
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    indexerUrl: null,
    apiUrl: null,
    tokenListUrl: null
  },
  chain: {
    explorerUrl: "https://robinhoodchain.blockscout.com",
    name: "Robinhood Chain",
    nativeCurrency: "ETH",
    rpcEnvVar: "ROBINHOOD_RPC_URL",
    verifierUrl: "https://robinhoodchain.blockscout.com/api/"
  },
  contracts: {
    lbFactory: "0x0165878A594ca255338adfa4d48449f69242Eb8F",
    lbPairImplementation: "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
    lbQuoter: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
    lbRouter: "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6"
  },
  ownership: {
    feeRecipient: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    initialOwner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    lbFactoryOwner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
  },
  tokens: {
    wrappedNative: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"
  },
  quoteAssets: {
    extra0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    extra1: "0x0000000000000000000000000000000000000000",
    extra2: "0x0000000000000000000000000000000000000000",
    extra3: "0x0000000000000000000000000000000000000000",
    wrappedNative: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"
  },
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
    feeRecipient: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    flashLoanFee: 5_000_000_000_000,
    initialOwner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    quoterFactoryV1: "0x0000000000000000000000000000000000000000",
    quoterFactoryV2_1: "0x0000000000000000000000000000000000000000",
    quoterFactoryV2_2: "0x0165878A594ca255338adfa4d48449f69242Eb8F",
    quoterLegacyFactoryV2: "0x0000000000000000000000000000000000000000",
    quoterLegacyRouterV2: "0x0000000000000000000000000000000000000000",
    quoterRouterV2_1: "0x0000000000000000000000000000000000000000",
    quoterRouterV2_2: "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6",
    routerFactoryV1: "0x0000000000000000000000000000000000000000",
    routerFactoryV2_1: "0x0000000000000000000000000000000000000000",
    routerLegacyFactoryV2: "0x0000000000000000000000000000000000000000",
    routerLegacyRouterV2: "0x0000000000000000000000000000000000000000",
    routerWNative: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"
  }
} as const satisfies RobinhoodDeploymentManifest;

export const sepoliaDefaultManifest = {
  chainId: 11_155_111,
  deployer: "0xC1A4747D52CDBAac26294495c6f0be49a0f0DDAA",
  environment: "sepolia",
  schemaVersion: "lb.evm.v1",
  sourceCommit: "8a56eeb49d5413fd7b51d32cdd0b9fc82ffde83d",
  sourceTreeDirty: true,
  startBlock: 11_330_230,
  endpoints: {
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    indexerUrl: null,
    apiUrl: null,
    tokenListUrl: null
  },
  chain: {
    explorerUrl: "https://sepolia.etherscan.io",
    name: "Ethereum Sepolia",
    nativeCurrency: "ETH",
    rpcEnvVar: "SEPOLIA_RPC_URL",
    verifierUrl: "https://api-sepolia.etherscan.io/api"
  },
  contracts: {
    lbFactory: "0xe521A00F81A60b77Eb39EC2097F94aF532DFb811",
    lbPairImplementation: "0x82200929c2FFa1b591d01f63d7edD87321202624",
    lbQuoter: "0x3e347eC5BFe056550BB6956631f6D9617BB8dc4e",
    lbRouter: "0xF65e2408F167fF6a56F1392bB0bb0DaA06E2E9d6"
  },
  ownership: {
    feeRecipient: "0xC1A4747D52CDBAac26294495c6f0be49a0f0DDAA",
    initialOwner: "0xC1A4747D52CDBAac26294495c6f0be49a0f0DDAA",
    lbFactoryOwner: "0xC1A4747D52CDBAac26294495c6f0be49a0f0DDAA"
  },
  tokens: {
    wrappedNative: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9"
  },
  quoteAssets: {
    extra0: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    extra1: "0x0000000000000000000000000000000000000000",
    extra2: "0x0000000000000000000000000000000000000000",
    extra3: "0x0000000000000000000000000000000000000000",
    wrappedNative: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9"
  },
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
    feeRecipient: "0xC1A4747D52CDBAac26294495c6f0be49a0f0DDAA",
    flashLoanFee: 5_000_000_000_000,
    initialOwner: "0xC1A4747D52CDBAac26294495c6f0be49a0f0DDAA",
    quoterFactoryV1: "0x0000000000000000000000000000000000000000",
    quoterFactoryV2_1: "0x0000000000000000000000000000000000000000",
    quoterFactoryV2_2: "0xe521A00F81A60b77Eb39EC2097F94aF532DFb811",
    quoterLegacyFactoryV2: "0x0000000000000000000000000000000000000000",
    quoterLegacyRouterV2: "0x0000000000000000000000000000000000000000",
    quoterRouterV2_1: "0x0000000000000000000000000000000000000000",
    quoterRouterV2_2: "0xF65e2408F167fF6a56F1392bB0bb0DaA06E2E9d6",
    routerFactoryV1: "0x0000000000000000000000000000000000000000",
    routerFactoryV2_1: "0x0000000000000000000000000000000000000000",
    routerLegacyFactoryV2: "0x0000000000000000000000000000000000000000",
    routerLegacyRouterV2: "0x0000000000000000000000000000000000000000",
    routerWNative: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9"
  }
} as const satisfies SepoliaDeploymentManifest;
