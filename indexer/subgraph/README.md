# Robinhood LB Subgraph

Wave 1 indexes the LB v2.2 core event surface needed by the swap/liquidity UX:

- `LBFactory`: pair creation, presets, quote assets, ignored routing state.
- `LBPair`: swaps, bin deposits/withdrawals, LB token transfers, composition fees, protocol fee collection, static fee config changes, hooks parameter changes.

`subgraph.yaml` is generated from `subgraph.template.yaml`. When `deployments/localnet/latest.json` exists, the local factory address and `startBlock` follow the current deployment manifest; otherwise generation uses the deterministic default Anvil address so clean builds can still compile the mappings. There is no custom Zap data source; direct router operations are represented by the underlying `Swap`, `LiquidityEvent`, and position entities.

## Local Build

```sh
pnpm localnet:up
pnpm indexer:generate:local
pnpm indexer:codegen
pnpm indexer:build
```

`pnpm indexer:codegen`, `pnpm indexer:build`, and `pnpm indexer:deploy:local` regenerate the ignored `subgraph.yaml` automatically. Set `LOCALNET_MANIFEST_PATH` or `INDEXER_LOCAL_MANIFEST` when testing a non-default local deployment, and `INDEXER_LOCAL_NETWORK` when rendering a different Graph network name.

## Robinhood Build

Robinhood testnet/mainnet builds must render from a Robinhood deployment
manifest, then use the `:rendered` commands so the localnet generator does not
overwrite `subgraph.yaml`:

```sh
ROBINHOOD_ENV=testnet pnpm indexer:generate:robinhood
pnpm indexer:codegen:rendered
pnpm indexer:build:rendered
```

For a non-default Robinhood manifest path, use the Robinhood wrapper so
non-Robinhood manifests are rejected before rendering:

```sh
pnpm indexer:generate:robinhood --manifest deployments/robinhood/testnet/latest.json
```

No-secret CI also proves both public environment render/build paths from
example manifests:

```sh
pnpm indexer:build:robinhood:testnet
pnpm indexer:build:robinhood:mainnet
```

The renderer maps manifest environments to Graph network slugs:

- `environment: "testnet"` -> `robinhood-testnet`
- `environment: "mainnet"` -> `robinhood-mainnet`

Pass `--network <slug>` only when testing a non-standard Graph Node network name.

## Local Graph Node

Start the local deployment and Graph Node stack, then deploy the subgraph:

```sh
pnpm localnet:up
pnpm indexer:up
pnpm indexer:deploy:local
pnpm sdk:example:localnet:liquidity
pnpm sdk:example:localnet:swap
pnpm indexer:smoke:local
```

The local Graph Node HTTP query endpoint is `http://localhost:8000/subgraphs/name/robinhood-lb/localnet`.
The compose stack uses immutable tag-and-digest references:

- `graphprotocol/graph-node:v0.44.0@sha256:c14c6d8e2b2b1ed89f6a89babf48d807b18a43e372fda7fb495d3a9050b65b8b`
- `ipfs/kubo:v0.29.0@sha256:53236eaeb876c6d837ee7b04a9b0e737a22e5f4471d0f99fb499fba28034aa61`
- `postgres:16.13-alpine@sha256:4e6e670bb069649261c9c18031f0aded7bb249a5b6664ddec29c013a89310d50`

Postgres is initialized with the `C` locale required by Graph Node. Keep all
three image references identical in the local and self-hosted Compose files.
For an upgrade, verify the replacement digest for the deployment platform,
stage the full stack, update both Compose files and these docs together, then
run `pnpm graph-node:validate` before merging.
The smoke check reads the same localnet manifest and fails unless Graph Node has indexed the current factory, all seeded pair addresses, a nonzero seeded swap, a nonzero deposit event, a nonzero LP position, and the local RPC head hash.
`pnpm localnet:up` starts Anvil with `LOCALNET_ANVIL_HOST=127.0.0.1` by default for loopback-only local work. If Docker cannot reach the host RPC through `host.docker.internal`, run `LOCALNET_ANVIL_HOST=0.0.0.0 pnpm localnet:up`; that improves container reachability but exposes the RPC beyond loopback, so use it only on trusted networks.

CI executes the same pinned stack with `pnpm indexer:e2e:graph-node`. The runner
requires an isolated port `8545`, deploys the local contracts and subgraph, runs
swap and liquidity transactions, verifies factory/pair/bin/position/swap/deposit/withdraw mappings, and reconciles Pair fee aggregates against indexed Swap and CompositionFees rows. It uses its own Compose project and alternate host ports, so a developer stack may remain running; `GRAPH_NODE_E2E_*_PORT` variables override those ports when needed. The runner always captures compose logs and removes only its Graph Node, Postgres, IPFS, volumes, and owned Anvil process.

Query examples:

```graphql
{
  pairs(first: 10) {
    id
    tokenX { id }
    tokenY { id }
    binStep
    reserveX
    reserveY
    totalVolumeX
    totalVolumeY
    swapCount
    depositCount
  }
  swaps(first: 10, orderBy: timestamp, orderDirection: desc) {
    pair { id }
    activeId
    amountInX
    amountInY
    amountOutX
    amountOutY
  }
  positions(first: 10, where: { liquidity_gt: 0 }) {
    owner
    bin { binId }
    liquidity
  }
}
```

## Robinhood Smoke

After deploying the rendered subgraph to Goldsky or a self-hosted Graph Node,
run the Robinhood smoke check against a broadcast deployment manifest:

```sh
ROBINHOOD_ENV=testnet \
ROBINHOOD_MANIFEST_PATH=deployments/robinhood/testnet/latest.json \
INDEXER_ROBINHOOD_ENDPOINT=https://api.goldsky.com/api/public/<project_id>/subgraphs/<name>/<version>/gn \
INDEXER_ROBINHOOD_RPC_URL=https://<archive-rpc> \
pnpm indexer:smoke:robinhood
```

The smoke script captures a fresh RPC head on every retry, reads the indexer's
current block, and pins all entity, active-bin, block-hash, and direct RPC reads
to that single indexed block. RPC credentials are supplied to child commands
through the environment and are suppressed from failure output. It validates
`_meta.hasIndexingErrors`, indexed head/start block, the manifest factory,
expected pairs when `INDEXER_ROBINHOOD_EXPECT_PAIRS` is set, and sampled pair
active IDs/reserves against direct RPC reads. Set
`INDEXER_ROBINHOOD_ALLOW_EMPTY=1` only for a pre-liquidity endpoint check.

Wave 1 selected Goldsky Subgraphs as the first managed production path and
self-hosted Graph Node as the fallback. See
`docs/wave-2/robinhood-subgraph-deployment.md` for the Goldsky deployment path
and `docs/wave-2/self-hosted-graph-node-runbook.md` for the fallback runbook.
