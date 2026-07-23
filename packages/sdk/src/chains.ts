import type { Address, Chain } from "viem";

export const LOCALNET_CHAIN_ID = 31_337;
export const ROBINHOOD_CHAIN_ID = 4_663;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46_630;
export const SEPOLIA_CHAIN_ID = 11_155_111;

export const ROBINHOOD_WETH: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
export const ROBINHOOD_TESTNET_WETH: Address = "0x7943e237c7F95DA44E0301572D358911207852Fa";
export const SEPOLIA_WETH: Address = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
export const SEPOLIA_USDC: Address = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

export const sepoliaChain = {
  id: SEPOLIA_CHAIN_ID,
  name: "Ethereum Sepolia",
  nativeCurrency: {
    decimals: 18,
    name: "Sepolia Ether",
    symbol: "ETH"
  },
  rpcUrls: {
    default: { http: ["https://ethereum-sepolia-rpc.publicnode.com"] },
    public: { http: ["https://ethereum-sepolia-rpc.publicnode.com"] }
  },
  blockExplorers: {
    default: {
      name: "Etherscan",
      url: "https://sepolia.etherscan.io",
      apiUrl: "https://api-sepolia.etherscan.io/api"
    }
  },
  testnet: true
} as const satisfies Chain;

export const localnetChain = {
  id: LOCALNET_CHAIN_ID,
  name: "Local Anvil",
  nativeCurrency: {
    decimals: 18,
    name: "Ether",
    symbol: "ETH"
  },
  rpcUrls: {
    default: { http: ["http://127.0.0.1:8545"] }
  }
} as const satisfies Chain;

export const robinhoodChain = {
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: {
    decimals: 18,
    name: "Ether",
    symbol: "ETH"
  },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
    public: { http: ["https://rpc.mainnet.chain.robinhood.com"] }
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
      apiUrl: "https://robinhoodchain.blockscout.com/api/"
    }
  }
} as const satisfies Chain;

export const robinhoodTestnetChain = {
  id: ROBINHOOD_TESTNET_CHAIN_ID,
  name: "Robinhood Chain Testnet",
  nativeCurrency: {
    decimals: 18,
    name: "Ether",
    symbol: "ETH"
  },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.chain.robinhood.com"] },
    public: { http: ["https://rpc.testnet.chain.robinhood.com"] }
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://explorer.testnet.chain.robinhood.com",
      apiUrl: "https://explorer.testnet.chain.robinhood.com/api/"
    }
  }
} as const satisfies Chain;
