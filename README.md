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
