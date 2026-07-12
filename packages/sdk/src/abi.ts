export const lbRouterAbi = [
  {
    type: "function",
    name: "createLBPair",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenX", type: "address" },
      { name: "tokenY", type: "address" },
      { name: "activeId", type: "uint24" },
      { name: "binStep", type: "uint16" }
    ],
    outputs: [{ name: "pair", type: "address" }]
  },
  {
    type: "function",
    name: "getFactory",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "factory", type: "address" }]
  },
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
    name: "swapExactTokensForNATIVE",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMinNATIVE", type: "uint256" },
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
    name: "swapExactNATIVEForTokens",
    stateMutability: "payable",
    inputs: [
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
    name: "addLiquidityNATIVE",
    stateMutability: "payable",
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
  },
  {
    type: "function",
    name: "removeLiquidityNATIVE",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "binStep", type: "uint16" },
      { name: "amountTokenMin", type: "uint256" },
      { name: "amountNATIVEMin", type: "uint256" },
      { name: "ids", type: "uint256[]" },
      { name: "amounts", type: "uint256[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [
      { name: "amountToken", type: "uint256" },
      { name: "amountNATIVE", type: "uint256" }
    ]
  }
] as const;

export const lbQuoterAbi = [
  {
    type: "function",
    name: "getFactoryV2_2",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "factory", type: "address" }]
  },
  {
    type: "function",
    name: "getRouterV2_2",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "router", type: "address" }]
  },
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
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false }
    ]
  },
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
    type: "event",
    name: "CompositionFees",
    anonymous: false,
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "id", type: "uint24", indexed: false },
      { name: "totalFees", type: "bytes32", indexed: false },
      { name: "protocolFees", type: "bytes32", indexed: false }
    ]
  },
  {
    type: "event",
    name: "DepositedToBins",
    anonymous: false,
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "ids", type: "uint256[]", indexed: false },
      { name: "amounts", type: "bytes32[]", indexed: false }
    ]
  },
  {
    type: "event",
    name: "WithdrawnFromBins",
    anonymous: false,
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "ids", type: "uint256[]", indexed: false },
      { name: "amounts", type: "bytes32[]", indexed: false }
    ]
  },
  {
    type: "event",
    name: "TransferBatch",
    anonymous: false,
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "ids", type: "uint256[]", indexed: false },
      { name: "amounts", type: "uint256[]", indexed: false }
    ]
  },
  {
    type: "function",
    name: "implementation",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "implementation", type: "address" }]
  },
  {
    type: "function",
    name: "getFactory",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "factory", type: "address" }]
  },
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
    name: "getBinStep",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "binStep", type: "uint16" }]
  },
  {
    type: "function",
    name: "getPriceFromId",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint24" }],
    outputs: [{ name: "price", type: "uint256" }]
  },
  {
    type: "function",
    name: "getIdFromPrice",
    stateMutability: "view",
    inputs: [{ name: "price", type: "uint256" }],
    outputs: [{ name: "id", type: "uint24" }]
  },
  {
    type: "function",
    name: "getStaticFeeParameters",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "baseFactor", type: "uint16" },
      { name: "filterPeriod", type: "uint16" },
      { name: "decayPeriod", type: "uint16" },
      { name: "reductionFactor", type: "uint16" },
      { name: "variableFeeControl", type: "uint24" },
      { name: "protocolShare", type: "uint16" },
      { name: "maxVolatilityAccumulator", type: "uint24" }
    ]
  },
  {
    type: "function",
    name: "getVariableFeeParameters",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "volatilityAccumulator", type: "uint24" },
      { name: "volatilityReference", type: "uint24" },
      { name: "idReference", type: "uint24" },
      { name: "timeOfLastUpdate", type: "uint40" }
    ]
  },
  {
    type: "function",
    name: "getLBHooksParameters",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "hooksParameters", type: "bytes32" }]
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

export const lbFactoryAbi = [
  {
    type: "event",
    name: "LBPairCreated",
    anonymous: false,
    inputs: [
      { indexed: true, name: "tokenX", type: "address" },
      { indexed: true, name: "tokenY", type: "address" },
      { indexed: true, name: "binStep", type: "uint256" },
      { indexed: false, name: "LBPair", type: "address" },
      { indexed: false, name: "pid", type: "uint256" }
    ]
  },
  {
    type: "function",
    name: "getOpenBinSteps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "openBinSteps", type: "uint256[]" }]
  },
  {
    type: "function",
    name: "getNumberOfQuoteAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "numberOfQuoteAssets", type: "uint256" }]
  },
  {
    type: "function",
    name: "getQuoteAssetAtIndex",
    stateMutability: "view",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [{ name: "asset", type: "address" }]
  },
  {
    type: "function",
    name: "isQuoteAsset",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "isQuote", type: "bool" }]
  },
  {
    type: "function",
    name: "getPreset",
    stateMutability: "view",
    inputs: [{ name: "binStep", type: "uint256" }],
    outputs: [
      { name: "baseFactor", type: "uint256" },
      { name: "filterPeriod", type: "uint256" },
      { name: "decayPeriod", type: "uint256" },
      { name: "reductionFactor", type: "uint256" },
      { name: "variableFeeControl", type: "uint256" },
      { name: "protocolShare", type: "uint256" },
      { name: "maxVolatilityAccumulator", type: "uint256" },
      { name: "isOpen", type: "bool" }
    ]
  },
  {
    type: "function",
    name: "getLBPairImplementation",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "implementation", type: "address" }]
  },
  {
    type: "function",
    name: "getLBPairInformation",
    stateMutability: "view",
    inputs: [
      { name: "tokenX", type: "address" },
      { name: "tokenY", type: "address" },
      { name: "binStep", type: "uint256" }
    ],
    outputs: [
      {
        name: "lbPairInformation",
        type: "tuple",
        components: [
          { name: "binStep", type: "uint16" },
          { name: "LBPair", type: "address" },
          { name: "createdByOwner", type: "bool" },
          { name: "ignoredForRouting", type: "bool" }
        ]
      }
    ]
  }
] as const;

export const lbHooksAbi = [
  {
    type: "function",
    name: "getLBPair",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "pair", type: "address" }]
  },
  {
    type: "function",
    name: "isLinked",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "linked", type: "bool" }]
  }
] as const;
