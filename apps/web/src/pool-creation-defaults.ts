import { isAddressEqual, type Address } from "viem";

interface PoolCreationTokenOption {
  address: Address;
  tags: readonly string[];
  risk: {
    reviewStatus: string;
  };
}

export interface PoolCreationTokenDefaults {
  tokenX: Address | null;
  tokenY: Address | null;
}

/**
 * Pick a distinct base/quote pair for the create-pool wizard.
 *
 * Factories may allow wrapped native and stablecoins as quote assets. The UI
 * still needs a semantic quote currency, so a reviewed stablecoin is preferred
 * for token Y while wrapped native is preferred for token X.
 */
export function selectPoolCreationTokenDefaults(
  tokenOptions: readonly PoolCreationTokenOption[],
  quoteAssets: readonly Address[]
): PoolCreationTokenDefaults {
  const usable = tokenOptions.filter((token) => token.risk.reviewStatus !== "blocked");
  const discoveredQuotes = usable.filter((token) =>
    quoteAssets.some((quoteAsset) => isAddressEqual(quoteAsset, token.address))
  );
  const quoteToken = discoveredQuotes.find((token) => token.tags.includes("stablecoin"))
    ?? discoveredQuotes.find((token) => token.tags.includes("quote"))
    ?? discoveredQuotes[0]
    ?? null;
  const tokenY = quoteToken?.address ?? quoteAssets[0] ?? null;
  const distinct = usable.filter((token) => tokenY === null || !isAddressEqual(token.address, tokenY));
  const baseToken = distinct.find((token) => token.tags.includes("wrapped-native"))
    ?? distinct.find((token) => !discoveredQuotes.some((quote) => isAddressEqual(quote.address, token.address)))
    ?? distinct[0]
    ?? null;

  return {
    tokenX: baseToken?.address ?? null,
    tokenY
  };
}
