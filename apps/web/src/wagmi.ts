import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { localnetChain, robinhoodChain, robinhoodTestnetChain, sepoliaChain } from "@robinhood-lb/sdk/chains";
import { createConfig, http } from "wagmi";

import { publicReleaseEnvironment, registries } from "./config";

const reownProjectId = import.meta.env.VITE_REOWN_PROJECT_ID?.trim() ?? "";
const appOrigin = typeof window === "undefined" ? "https://feather.trade" : window.location.origin;

const walletNetworks = (
  publicReleaseEnvironment === "sepolia"
    ? [sepoliaChain]
    : publicReleaseEnvironment === "robinhoodTestnet"
      ? [robinhoodTestnetChain]
      : publicReleaseEnvironment === "robinhood"
        ? [robinhoodChain]
        : [localnetChain, sepoliaChain, robinhoodTestnetChain, robinhoodChain]
) as [
  typeof localnetChain | typeof sepoliaChain | typeof robinhoodTestnetChain | typeof robinhoodChain,
  ...Array<typeof localnetChain | typeof sepoliaChain | typeof robinhoodTestnetChain | typeof robinhoodChain>
];

const walletTransports: Record<number, ReturnType<typeof http>> = publicReleaseEnvironment === "sepolia"
  ? { [sepoliaChain.id]: http(registries.sepolia.endpoints.rpcUrl) }
  : publicReleaseEnvironment === "robinhoodTestnet"
    ? { [robinhoodTestnetChain.id]: http(registries.robinhoodTestnet.endpoints.rpcUrl) }
    : publicReleaseEnvironment === "robinhood"
      ? { [robinhoodChain.id]: http(registries.robinhood.endpoints.rpcUrl) }
      : {
          [localnetChain.id]: http(registries.localnet.endpoints.rpcUrl),
          [sepoliaChain.id]: http(registries.sepolia.endpoints.rpcUrl),
          [robinhoodTestnetChain.id]: http(registries.robinhoodTestnet.endpoints.rpcUrl),
          [robinhoodChain.id]: http(registries.robinhood.endpoints.rpcUrl)
        };

const wagmiAdapter = reownProjectId
  ? new WagmiAdapter({
      multiInjectedProviderDiscovery: true,
      networks: walletNetworks,
      projectId: reownProjectId,
      ssr: false,
      transports: walletTransports
    })
  : null;

export const wagmiConfig = wagmiAdapter?.wagmiConfig ?? createConfig({
  chains: walletNetworks,
  connectors: [],
  multiInjectedProviderDiscovery: true,
  transports: walletTransports
});

async function loadAppKit() {
  if (!wagmiAdapter) {
    throw new Error("Wallet modal is not configured");
  }
  const { createAppKit } = await import("@reown/appkit/react");
  return createAppKit({
      adapters: [wagmiAdapter],
      allWallets: "SHOW",
      allowUnsupportedChain: false,
      defaultNetwork: walletNetworks[0],
      enableBaseAccount: false,
      enableCoinbase: true,
      enableEIP6963: true,
      enableInjected: true,
      enableMobileFullScreen: true,
      enableNetworkSwitch: false,
      enableReconnect: false,
      enableWalletGuide: false,
      features: {
        allWallets: true,
        analytics: false,
        email: false,
        history: false,
        onramp: false,
        receive: false,
        send: false,
        socials: false,
        swaps: false
      },
      metadata: {
        description: "Liquidity Book trading with Feather Trade.",
        icons: [`${appOrigin}/feather/feather-mark-128.png`],
        name: "Feather Trade",
        url: appOrigin
      },
      networks: walletNetworks,
      projectId: reownProjectId,
      themeMode: "dark",
      themeVariables: {
        "--w3m-accent": "#4ac57c",
        "--w3m-border-radius-master": "2px",
        "--w3m-color-mix": "#141614",
        "--w3m-color-mix-strength": 18,
        "--w3m-font-family": "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif",
        "--w3m-z-index": 100
      }
    });
}

let appKitPromise: ReturnType<typeof loadAppKit> | null = null;
let walletModalOpen = false;
let walletModalSubscriptionAttached = false;
const walletModalSubscribers = new Set<(open: boolean) => void>();

export const walletModalConfigured = wagmiAdapter !== null;

export function walletModalIsOpen(): boolean {
  return walletModalOpen;
}

export function subscribeWalletModalOpen(listener: (open: boolean) => void): () => void {
  walletModalSubscribers.add(listener);
  listener(walletModalOpen);
  return () => walletModalSubscribers.delete(listener);
}

function observeWalletModal(appKit: Awaited<ReturnType<typeof loadAppKit>>): void {
  if (walletModalSubscriptionAttached) return;
  walletModalSubscriptionAttached = true;
  const publish = (open: boolean) => {
    if (walletModalOpen === open) return;
    walletModalOpen = open;
    for (const listener of walletModalSubscribers) listener(open);
  };
  publish(appKit.getState().open);
  appKit.subscribeState((state) => publish(state.open));
}

function publishWalletModalOpen(open: boolean): void {
  if (walletModalOpen === open) return;
  walletModalOpen = open;
  for (const listener of walletModalSubscribers) listener(open);
}

export async function openWalletModal(): Promise<void> {
  if (!walletModalConfigured) {
    throw new Error("Wallet modal is not configured");
  }
  const appKit = await (appKitPromise ??= loadAppKit());
  observeWalletModal(appKit);
  // Mark ownership before AppKit mounts its portal. This closes the small gap
  // in which an immediate Escape could otherwise reach the underlying wizard.
  publishWalletModalOpen(true);
  await appKit.open({ view: "Connect" });
}
