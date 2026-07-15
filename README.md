# Feather Trade

Feather Trade is an independently branded Liquidity Book DEX targeting Robinhood Chain.

## Current Artifacts

- `contracts/joe-v2` - Vendored LFJ Liquidity Book v2 core contracts pinned for Wave 1.
- `packages/sdk` - Typed chain, manifest, routing, swap, and liquidity helpers.
- `indexer/subgraph` - Liquidity Book indexing and GraphQL schema.
- `apps/web` - Feather Trade web application.

## Phase 1 Build Direction

The first wave focuses on the smallest credible core: Liquidity Book v2.2 contracts, Robinhood/localnet deployment configuration, SDK and frontend chain config, and a core UX indexer. Liquidity entry uses the canonical router, including native one-sided deposits; any optional swap-then-add composition is an explicitly non-atomic, multi-transaction client workflow. The former on-chain Zap design is archived in the historical Wave 1 documents and is not part of the product or release surface.

## Development

Install submodules after cloning:

```sh
git submodule update --init
```

Copy `.env.example` if you need Robinhood RPC, deployment variables, or
provider-backed fork-test variables for local scripts.

The Feather Trade web surface only renders public links that have an explicit,
configured HTTPS destination. Set `VITE_FEATHER_DOCS_URL`,
`VITE_FEATHER_SECURITY_URL`, `VITE_FEATHER_X_URL`, and
`VITE_FEATHER_DISCORD_URL` to HTTPS destinations to enable those optional
launch-footer links; invalid or unset destinations are
deliberately omitted.

Set `VITE_REOWN_PROJECT_ID` to a project ID from the Reown Dashboard to enable
the unified wallet chooser, including WalletConnect QR and mobile deep links.
Without it, local development keeps a compact EIP-6963 browser-wallet chooser
and does not send wallet-discovery traffic to Reown.

### Fresh local product stack

The owned full-stack command starts an isolated Anvil deployment, Graph Node,
IPFS, Postgres, the local analytics service, and the web app. It always replaces
only the Compose project and process IDs recorded for this stack; it does not
reuse an unrelated RPC, database, or browser session.

```sh
pnpm localstack:up
```

Startup is successful only after the strict health gate proves that the
deployment manifest chain ID, RPC head, Graph Node `_meta` head, and analytics
head agree exactly by block number and hash. Analytics must also report fresh
`READY` state, complete backfill, complete coverage bounds, and available local
price policies. The web endpoint must serve HTML with the generated localnet
manifest and analytics URL wired into its Vite process.

The default isolated endpoints are:

- RPC: `http://127.0.0.1:18545`
- GraphQL: `http://127.0.0.1:18000/subgraphs/name/robinhood-lb/localnet`
- Analytics: `http://127.0.0.1:18787/graphql`
- Web: `http://127.0.0.1:15173`

Re-run the same fail-closed health check without restarting anything:

```sh
pnpm localstack:health
```

Stop the owned processes and remove the isolated Graph Node/IPFS/Postgres
volumes:

```sh
pnpm localstack:down
```

Runtime logs, PIDs, the analytics checkpoint, and the bounded JSON health
result stay below the ignored `.local/full-stack` directory. Anvil runs in
silent mode so account keys are not copied into validation logs. The stack does
not read or export a Brave profile, extension storage, wallet password, or any
unrelated browser data. Adapter modules and price policies are repository-owned
local fixtures under `scripts/localnet`; they are not production price or RPC
trust sources.

Run the orchestration syntax and strict-health fixtures with:

```sh
pnpm localstack:test
```

The stack writes a credential-free environment file after successful startup.
Load it, choose a non-deployer Anvil account, and use the fail-closed fixture
commands to capture a pre-write snapshot or prepare an account:

```sh
source .local/full-stack/stack.env
OWNER=0x0000000000000000000000000000000000000001

pnpm localstack:fixture:snapshot -- --manifest "$LOCALNET_MANIFEST_PATH" --rpc-url "$LOCALNET_RPC_URL" --owner "$OWNER"
pnpm localstack:fixture:clean -- --manifest "$LOCALNET_MANIFEST_PATH" --rpc-url "$LOCALNET_RPC_URL" --owner "$OWNER"
pnpm localstack:fixture:empty -- --manifest "$LOCALNET_MANIFEST_PATH" --rpc-url "$LOCALNET_RPC_URL" --owner "$OWNER"
pnpm localstack:fixture:reset-approvals -- --manifest "$LOCALNET_MANIFEST_PATH" --rpc-url "$LOCALNET_RPC_URL" --owner "$OWNER"
```

The clean and empty profiles refuse a reused owner. Every mutating fixture emits
its complete pre-write snapshot before applying changes and then emits the
postcondition snapshot. The reset command removes exact ERC-20 router
allowances and pair-wide LB approval only. A separately owned wrong-chain Anvil
can be attested without touching application state:

```sh
pnpm localstack:fixture:wrong-chain -- --rpc-url http://127.0.0.1:18546 --expected-chain-id 31338
```

Pool-creation asset readiness remains explicitly blocked by issue #21: the
immutable local mock deployment exposes matching metadata only for WNATIVE, so
there are not two distinct policy-compatible assets. These fixture commands do
not weaken token identity, relabel the generic ERC20 mock, or claim that the
pool-create journey passed.

Build the imported contracts from the repository root:

```sh
forge build
```

Run the deterministic core smoke suite:

```sh
pnpm test
```

The full local upstream suite is available as an intentional slow lane. It uses
a high Forge gas limit for upstream oracle stress tests, and excludes
provider-backed fork integration tests plus the upstream oracle-length fork
helper:

```sh
pnpm contracts:test:full
```

Avalanche fork integration tests require a stable archive-capable provider in
`AVALANCHE_RPC_URL`:

```sh
AVALANCHE_RPC_URL=<archive-or-stable-provider> pnpm contracts:test:fork
```

Before launch, run the combined local and fork lane when provider access is
available:

```sh
AVALANCHE_RPC_URL=<archive-or-stable-provider> pnpm contracts:test:exhaustive
```
