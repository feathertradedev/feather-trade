# Generic EVM deployments

This directory contains ignored runtime output from the network-agnostic
Liquidity Book core deployer. Those generated files are deployment evidence,
not public web configuration. A reviewed network may additionally have a
tracked `public.json` projection containing the same deployment identity plus
browser-safe public endpoints. Never copy the private deployment RPC into that
projection.

The deployer creates and configures:

- `LBFactory`
- the `LBPair` implementation
- `LBRouter`
- `LBQuoter`

It registers wrapped native plus up to four existing quote assets and installs
the standard bin-step-10 preset. It does not deploy mock tokens, create a pool,
seed liquidity, change transaction builders, or modify protocol contracts.

## Chain-scoped preset policy

Sepolia's approved factory preset matrix is versioned in
`deployments/evm/sepolia/preset-policy.json`. It deliberately approves only
steps 10 and 20. Both use a 0.10% static fee and a calculated 0.59% maximum
fee; step 10 provides finer volatile-market granularity while step 20 provides
a wider high-volatility testnet option. The step-10 WETH/USDC identity remains
deprecated and unfunded, while the step-20 identity is canonical.
The policy records the reviewed Liquidity Book `bips-config.sol` parameter
reference and the explicit Sepolia step-20 adaptation instead of implying the
live values were copied blindly.

Mainnet does not inherit this matrix. It requires a separate explicit policy
approval before any owner transaction.

Run the read-only live diff:

```sh
pnpm evm:presets:check
```

Use `EVM_PRESET_RPC_URL` to select another endpoint. The command fails if the
chain, factory owner, configured/open step set, exact parameters, or calculated
fee bounds differ from policy. `pnpm evm:presets:plan` first simulates every
owner-only `setPreset` call and prints deterministic `cast send` commands; it
never broadcasts. An operator must review the diff and simulation before
explicitly executing any printed command with the factory-owner key.

Closing or replacing a preset affects only future creation. Existing pools
remain immutable and addressable by exact pair plus bin step; a migration or
deprecation requires a new versioned policy rather than silent rerouting.

## Inputs

Required variables:

- `EVM_DEPLOY_NETWORK`: lowercase output slug, such as `sepolia`
- `EVM_DEPLOY_EXPECTED_CHAIN_ID`: exact positive chain ID
- `EVM_DEPLOY_RPC_URL`: private/provider RPC used only by Cast and Forge
- `EVM_DEPLOYER_PRIVATE_KEY`: local 32-byte deployer key
- `EVM_DEPLOY_WNATIVE_ADDRESS`: existing wrapped-native contract

Optional quote assets use `EVM_DEPLOY_QUOTE_ASSET_0` through `_3`. Chain display
metadata uses `EVM_DEPLOY_CHAIN_NAME`, `EVM_DEPLOY_NATIVE_CURRENCY`,
`EVM_DEPLOY_RPC_ENV_VAR`, `EVM_DEPLOY_EXPLORER_URL`, and
`EVM_DEPLOY_VERIFIER_URL`. `EVM_DEPLOY_MANIFEST_PATH` and
`EVM_DEPLOY_OUTPUT_DIR` can override the default artifact locations. A real
Forge run must keep its manifest beneath `deployments/`, which is the writable
path allowed by `foundry.toml`.

Neither `EVM_DEPLOY_RPC_URL` nor the private key is placed in the Forge command,
sanitized log, broadcast receipts, or `lb.evm.v1` manifest. Foundry does place
the RPC URL in a resumable script cache while it runs. The wrapper creates all
artifacts owner-only (`umask 077`) and removes that script-specific cache on
success and ordinary failure without deleting the broadcast receipts. After an
uncatchable process kill, rerunning the wrapper clears any stale cache before
Forge starts.

## Dry run

`pnpm evm:dry-run` is the default safe rehearsal. It validates the RPC chain,
token bytecode, address uniqueness, and configuration before Forge runs. Output
is written to `deployments/evm/<network>/dry-run.json`.

## Broadcast

A broadcast additionally requires `EVM_DEPLOY_CONFIRM_CHAIN_ID` to exactly
equal `EVM_DEPLOY_EXPECTED_CHAIN_ID`:

```bash
EVM_DEPLOY_CONFIRM_CHAIN_ID=11155111 pnpm evm:deploy
```

The wrapper writes to a pending manifest first. Only a successful Forge run,
manifest validation, and post-broadcast bytecode checks promote it atomically to
`deployments/evm/<network>/latest.json`. Forge receipts remain under
`broadcast/deploy-evm.s.sol/<chain-id>/`. The deployment uses multiple
transactions: if a later transaction fails, earlier contracts can still exist
on-chain even though `latest.json` is not promoted. Inspect the retained Forge
receipts before retrying a failed broadcast.

## Sepolia from a private local shell

This keeps both secrets out of shell history and keeps the deployer key off
disk. The protected transient RPC cache is handled as described above. Run it
from the repository root:

```bash
bash -c '
  set -euo pipefail
  IFS= read -r -s -p "Sepolia RPC URL: " EVM_DEPLOY_RPC_URL </dev/tty; printf "\n"
  IFS= read -r -s -p "Sepolia deployer private key: " EVM_DEPLOYER_PRIVATE_KEY </dev/tty; printf "\n"

  export EVM_DEPLOY_RPC_URL EVM_DEPLOYER_PRIVATE_KEY
  export EVM_DEPLOY_NETWORK=sepolia
  export EVM_DEPLOY_EXPECTED_CHAIN_ID=11155111
  export EVM_DEPLOY_WNATIVE_ADDRESS=0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9
  export EVM_DEPLOY_QUOTE_ASSET_0=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
  export EVM_DEPLOY_CHAIN_NAME="Ethereum Sepolia"
  export EVM_DEPLOY_RPC_ENV_VAR=SEPOLIA_RPC_URL
  export EVM_DEPLOY_EXPLORER_URL=https://sepolia.etherscan.io
  export EVM_DEPLOY_VERIFIER_URL=https://api-sepolia.etherscan.io/api

  pnpm evm:dry-run
  EVM_DEPLOY_CONFIRM_CHAIN_ID=11155111 pnpm evm:deploy
'
```

The wrapped Ether address is the deployed Sepolia WETH contract shown by
[Etherscan](https://sepolia.etherscan.io/token/0x7b79995e5f793a07bc00c21412e50ecae098e7f9).
The quote asset is Circle's documented
[Sepolia USDC](https://developers.circle.com/stablecoins/usdc-contract-addresses).
