# Token Assets

Static Wave 1 development logos are served by Vite from `/token-assets`.

## Files

- `wnative.svg` covers the localnet wrapped-native placeholder.
- `usdc.svg` and `usdt.svg` cover localnet mock stablecoin placeholders.
- `weth.svg` covers WETH placeholders across localnet, Robinhood testnet, and Robinhood mainnet.
- `usdg.svg` covers the Robinhood mainnet USDG starter placeholder.

## Provenance

The current SVG files are original development placeholders created for this
repository. They are not copied from token projects, Robinhood, LFJ, Trader Joe,
Joepegs, or any third-party media kit.

For production token logos, record the source, license, approval, and reviewer
in this README before adding or replacing the SVG. Keep logos self-contained and
served from `/token-assets`; do not hotlink remote artwork from token lists.

## Branding Constraints

These placeholders are original development assets. Do not add LFJ, Trader Joe, JOE token, Joepegs, mascot, farm, chef, or media-kit artwork here. Do not add Robinhood product logos unless approval and source tracking are recorded first. The network name `Robinhood Chain` may be used to identify the target chain.

## Validation

From the repository root:

```sh
pnpm tokens:validate
```

The validator checks token-list structure, public Robinhood no-mock/no-localnet
rules, public token-risk metadata, Robinhood mainnet quote-asset tagging,
manifest quote-asset reconciliation, and referenced SVG presence.

For localnet deployments with non-default token addresses, resolve `addressRef`
entries from `deployments/localnet/latest.json`; the shared placeholder paths
stay stable.
