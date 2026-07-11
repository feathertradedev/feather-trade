# Liquidity Book Contracts

This package vendors the public LFJ Liquidity Book v2 contract repository as the core AMM implementation for the Robinhood Chain fork.

## Upstream Pin

- Repository: `https://github.com/lfj-gg/joe-v2`
- Imported commit: `067c6ccf5b8ff1526d03fa3e4c65ec45d01c1f73`
- Latest tagged release observed during import: `v2.2.0`
- License: MIT, preserved in `contracts/joe-v2/LICENSE`

The upstream README is preserved as `contracts/joe-v2/UPSTREAM_README.md` for technical reference. Local product naming and branding should live outside this vendored package.

## Build

From the repository root:

```sh
forge build
```

To run the full local upstream suite without provider-backed fork tests:

```sh
pnpm contracts:test:full
```

This command uses a high Forge gas limit for upstream max-oracle stress tests.

For the Wave 1 deterministic core baseline:

```sh
pnpm contracts:test:core
```

To run the upstream Avalanche fork integration lanes, provide a stable
archive-capable endpoint:

```sh
AVALANCHE_RPC_URL=<archive-or-stable-provider> pnpm contracts:test:fork
```

## Core Surface

The Wave 1 fork scope uses:

- `LBFactory` for pair deployment and registry management.
- `LBPair` and `LBToken` for bin liquidity, swaps, fees, oracle samples, and position accounting.
- `LBRouter` as the user-facing swap and liquidity entry point.
- `LBQuoter` for route discovery and quote simulation.
- Interfaces and libraries required by those contracts.

Staking, rewards, launchpads, NFTs, and analytics-only systems are intentionally out of this package.

## License Notes

The upstream repository top-level license is MIT and is preserved in `contracts/joe-v2/LICENSE`. Most Liquidity Book production contracts are MIT. Some legacy Joe V1 compatibility files under `src/interfaces` and `src/libraries` carry GPL-3.0 SPDX headers and should be reviewed before shipping any legacy routing surface.
