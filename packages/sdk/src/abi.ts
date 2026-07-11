export const lbRouterAbi = [
  {
    type: "error",
    name: "LBRouter__DeadlineExceeded",
    inputs: [
      { name: "deadline", type: "uint256" },
      { name: "currentTimestamp", type: "uint256" }
    ]
  },
  {
    type: "function",
    name: "getSwapOut",
    stateMutability: "view",
    inputs: [
      { name: "LBPair", type: "address" },
      { name: "amountIn", type: "uint128" },
      { name: "swapForY", type: "bool" }
    ],
    outputs: [
      { name: "amountInLeft", type: "uint128" },
      { name: "amountOut", type: "uint128" },
      { name: "fee", type: "uint128" }
    ]
  },
  {
    type: "function",
    name: "swapExactTokensForTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      {
        name: "path",
        type: "tuple",
        components: [
          { name: "pairBinSteps", type: "uint256[]" },
          { name: "versions", type: "uint8[]" },
          { name: "tokenPath", type: "address[]" }
        ]
      },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [{ name: "amountOut", type: "uint256" }]
  },
  {
    type: "function",
    name: "addLiquidity",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "liquidityParameters",
        type: "tuple",
        components: [
          { name: "tokenX", type: "address" },
          { name: "tokenY", type: "address" },
          { name: "binStep", type: "uint256" },
          { name: "amountX", type: "uint256" },
          { name: "amountY", type: "uint256" },
          { name: "amountXMin", type: "uint256" },
          { name: "amountYMin", type: "uint256" },
          { name: "activeIdDesired", type: "uint256" },
          { name: "idSlippage", type: "uint256" },
          { name: "deltaIds", type: "int256[]" },
          { name: "distributionX", type: "uint256[]" },
          { name: "distributionY", type: "uint256[]" },
          { name: "to", type: "address" },
          { name: "refundTo", type: "address" },
          { name: "deadline", type: "uint256" }
        ]
      }
    ],
    outputs: [
      { name: "amountXAdded", type: "uint256" },
      { name: "amountYAdded", type: "uint256" },
      { name: "amountXLeft", type: "uint256" },
      { name: "amountYLeft", type: "uint256" },
      { name: "depositIds", type: "uint256[]" },
      { name: "liquidityMinted", type: "uint256[]" }
    ]
  },
  {
    type: "function",
    name: "removeLiquidity",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenX", type: "address" },
      { name: "tokenY", type: "address" },
      { name: "binStep", type: "uint16" },
      { name: "amountXMin", type: "uint256" },
      { name: "amountYMin", type: "uint256" },
      { name: "ids", type: "uint256[]" },
      { name: "amounts", type: "uint256[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [
      { name: "amountX", type: "uint256" },
      { name: "amountY", type: "uint256" }
    ]
  }
] as const;

export const lbQuoterAbi = [
  {
    type: "function",
    name: "findBestPathFromAmountIn",
    stateMutability: "view",
    inputs: [
      { name: "route", type: "address[]" },
      { name: "amountIn", type: "uint128" }
    ],
    outputs: [
      {
        name: "quote",
        type: "tuple",
        components: [
          { name: "route", type: "address[]" },
          { name: "pairs", type: "address[]" },
          { name: "binSteps", type: "uint256[]" },
          { name: "versions", type: "uint8[]" },
          { name: "amounts", type: "uint128[]" },
          { name: "virtualAmountsWithoutSlippage", type: "uint128[]" },
          { name: "fees", type: "uint128[]" }
        ]
      }
    ]
  }
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" }
    ],
    outputs: [{ name: "allowance", type: "uint256" }]
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [{ name: "approved", type: "bool" }]
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }]
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "decimals", type: "uint8" }]
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "symbol", type: "string" }]
  }
] as const;

export const lbPairAbi = [
  {
    type: "function",
    name: "getTokenX",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "tokenX", type: "address" }]
  },
  {
    type: "function",
    name: "getTokenY",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "tokenY", type: "address" }]
  },
  {
    type: "function",
    name: "getActiveId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "activeId", type: "uint24" }]
  },
  {
    type: "function",
    name: "getBin",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint24" }],
    outputs: [
      { name: "binReserveX", type: "uint128" },
      { name: "binReserveY", type: "uint128" }
    ]
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "totalSupply", type: "uint256" }]
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "id", type: "uint256" }
    ],
    outputs: [{ name: "balance", type: "uint256" }]
  },
  {
    type: "function",
    name: "isApprovedForAll",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" }
    ],
    outputs: [{ name: "approved", type: "bool" }]
  },
  {
    type: "function",
    name: "approveForAll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "approved", type: "bool" }
    ],
    outputs: []
  }
] as const;
