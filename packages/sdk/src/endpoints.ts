export interface EndpointConfig {
  rpcUrl: string;
  indexerUrl: string | null;
  apiUrl: string | null;
  tokenListUrl: string | null;
}

export const defaultEndpoints = {
  localnet: {
    rpcUrl: "http://127.0.0.1:8545",
    indexerUrl: "http://127.0.0.1:8000/subgraphs/name/robinhood-lb/localnet",
    apiUrl: "http://127.0.0.1:3001",
    tokenListUrl: null
  },
  robinhood: {
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    indexerUrl: null,
    apiUrl: null,
    tokenListUrl: null
  },
  robinhoodTestnet: {
    rpcUrl: "https://rpc.testnet.chain.robinhood.com",
    indexerUrl: null,
    apiUrl: null,
    tokenListUrl: null
  }
} as const satisfies Record<string, EndpointConfig>;
