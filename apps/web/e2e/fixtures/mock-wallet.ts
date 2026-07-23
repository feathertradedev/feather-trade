import type { Page } from "@playwright/test";

export const LOCALNET_CHAIN_ID = 31_337;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46_630;
export const DEFAULT_ACCOUNT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

export interface MockWalletOptions {
  account?: `0x${string}`;
  additionalProviders?: Array<{
    account: `0x${string}`;
    name: string;
    rdns: string;
    uuid: string;
  }>;
  allowTransactions?: boolean;
  chainId?: number;
  connectMode?: "ready" | "disconnected" | "locked" | "permission-rejected" | "provider-error" | "unauthorized";
  primaryProvider?: { name: string; rdns: string; uuid: string };
  rejectTransactions?: boolean;
  switchMode?: "ready" | "add-required" | "add-rejected" | "switch-rejected";
  transactionDelayMs?: number;
  transactionHash?: `0x${string}`;
  transactionHashes?: `0x${string}`[];
  transactionMode?: "ready" | "ambiguous" | "controlled";
}

export interface MockWalletSnapshot {
  accounts: string[];
  addChainCalls: number[];
  chainId: number;
  calls: string[];
  rejectTransactions: boolean;
  sentTransactions: unknown[];
  switchChainCalls: number[];
}

export async function installMockWallet(page: Page, options: MockWalletOptions = {}): Promise<void> {
  await page.addInitScript(
    ({ account, additionalProviders, allowTransactions, chainId, connectMode, primaryProvider, rejectTransactions, switchMode, transactionDelayMs, transactionHash, transactionHashes, transactionMode }) => {
      type Listener = (...args: unknown[]) => void;
      type ProviderState = Window["__mockWalletState"];

      function toHex(value: number) {
        return `0x${value.toString(16)}`;
      }

      function createProviderState(providerAccount: string): ProviderState {
        return {
          accounts: connectMode === "locked" ? [] : [providerAccount],
          addChainCalls: [],
          chainId,
          calls: [],
          rejectTransactions,
          sentTransactions: [],
          switchChainCalls: []
        };
      }

      function createProvider(state: ProviderState, transactionReleases: Array<() => void>) {
        const listeners = new Map<string, Set<Listener>>();

        function emit(event: string, ...args: unknown[]) {
          for (const listener of listeners.get(event) ?? []) listener(...args);
        }

        function on(event: string, listener: Listener) {
          const eventListeners = listeners.get(event) ?? new Set();
          eventListeners.add(listener);
          listeners.set(event, eventListeners);
        }

        function removeListener(event: string, listener: Listener) {
          listeners.get(event)?.delete(listener);
        }

        function rpcError(message: string, code: number) {
          const error = new Error(message) as Error & { code: number };
          error.code = code;
          return error;
        }

        async function request({ method, params }: { method: string; params?: unknown[] }) {
          state.calls.push(method);

          switch (method) {
            case "eth_accounts": return state.accounts;
            case "eth_requestAccounts":
              if (connectMode === "disconnected") throw rpcError("Provider disconnected", 4_900);
              if (connectMode === "locked") throw rpcError("Wallet is locked", 4_100);
              if (connectMode === "unauthorized") throw rpcError("Unauthorized account access", 4_100);
              if (connectMode === "provider-error") throw rpcError("Provider internal failure", -32_603);
              return state.accounts;
            case "wallet_requestPermissions":
              if (connectMode === "disconnected") throw rpcError("Provider disconnected", 4_900);
              if (connectMode === "permission-rejected") throw rpcError("User rejected account permission", 4_001);
              if (connectMode === "unauthorized") throw rpcError("Unauthorized account access", 4_100);
              if (connectMode === "provider-error") throw rpcError("Provider internal failure", -32_603);
              return [{ parentCapability: "eth_accounts", caveats: [{ type: "restrictReturnedAccounts", value: state.accounts }] }];
            case "eth_chainId":
              return toHex(state.chainId);
            case "net_version":
              return String(state.chainId);
            case "wallet_switchEthereumChain": {
              const requested = params?.[0] as { chainId?: string } | undefined;
              if (typeof requested?.chainId !== "string") throw new Error("Missing chainId");
              const nextChainId = Number.parseInt(requested.chainId, 16);
              if (switchMode === "switch-rejected") throw rpcError("User rejected network switch", 4_001);
              if ((switchMode === "add-required" || switchMode === "add-rejected") && !state.addChainCalls.includes(nextChainId)) {
                throw rpcError("Unrecognized chain", 4_902);
              }
              state.chainId = nextChainId;
              state.switchChainCalls.push(nextChainId);
              emit("chainChanged", toHex(nextChainId));
              return null;
            }
            case "wallet_addEthereumChain": {
              const requested = params?.[0] as { chainId?: string } | undefined;
              const nextChainId = typeof requested?.chainId === "string" ? Number.parseInt(requested.chainId, 16) : NaN;
              if (switchMode === "add-rejected") throw rpcError("User rejected adding network", 4_001);
              if (Number.isFinite(nextChainId)) {
                state.addChainCalls.push(nextChainId);
                state.chainId = nextChainId;
                state.switchChainCalls.push(nextChainId);
                emit("chainChanged", toHex(nextChainId));
              }
              return null;
            }
            case "eth_sendTransaction": {
              const transactionIndex = state.sentTransactions.length;
              state.sentTransactions.push(params?.[0] ?? null);
              if (!allowTransactions) throw new Error("Mock wallet should not receive guarded transactions");
              if (transactionMode === "controlled") await new Promise<void>((resolve) => transactionReleases.push(resolve));
              if (transactionDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, transactionDelayMs));
              if (state.rejectTransactions) {
                const rejection = new Error("User rejected the transaction request") as Error & { code: number };
                rejection.code = 4001;
                throw rejection;
              }
              if (transactionMode === "ambiguous") throw rpcError("Transport closed after possible broadcast", -32_603);
              return transactionHashes[transactionIndex] ?? transactionHash;
            }
            default:
              throw new Error(`Unhandled mock wallet method: ${method}`);
          }
        }

        return {
          _metamask: { isUnlocked: async () => connectMode !== "locked" },
          isMetaMask: true,
          request,
          on,
          removeListener,
          emit
        };
      }

      const providerDefinitions = [
        {
          account,
          name: primaryProvider.name,
          rdns: primaryProvider.rdns,
          uuid: primaryProvider.uuid
        },
        ...additionalProviders
      ];
      const providers = providerDefinitions.map((definition) => {
        const state = createProviderState(definition.account);
        const transactionReleases: Array<() => void> = [];
        return { definition, provider: createProvider(state, transactionReleases), state, transactionReleases };
      });
      const [{ provider, state }] = providers;

      Object.defineProperty(window, "ethereum", {
        configurable: true,
        value: provider
      });
      Object.defineProperty(window, "__mockWalletState", {
        configurable: true,
        value: state
      });
      Object.defineProperty(window, "__mockWalletStates", {
        configurable: true,
        value: Object.fromEntries(providers.map(({ definition, state: providerState }) => [definition.rdns, providerState]))
      });
      Object.defineProperty(window, "__mockWalletControl", {
        configurable: true,
        value: {
          disconnect(rdns = providerDefinitions[0].rdns) {
            const selected = providers.find((item) => item.definition.rdns === rdns);
            selected?.provider.emit("disconnect", { code: 4_900, message: "Disconnected" });
          },
          releaseNextTransaction(rdns = providerDefinitions[0].rdns) {
            providers.find((item) => item.definition.rdns === rdns)?.transactionReleases.shift()?.();
          },
          setAccounts(accounts: string[], rdns = providerDefinitions[0].rdns) {
            const selected = providers.find((item) => item.definition.rdns === rdns);
            if (!selected) return;
            selected.state.accounts = [...accounts];
            selected.provider.emit("accountsChanged", [...accounts]);
          },
          setChain(nextChainId: number, rdns = providerDefinitions[0].rdns) {
            const selected = providers.find((item) => item.definition.rdns === rdns);
            if (!selected) return;
            selected.state.chainId = nextChainId;
            selected.provider.emit("chainChanged", toHex(nextChainId));
          }
        }
      });

      const announceProviders = () => {
        for (const { definition, provider: announcedProvider } of providers) {
          window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
            detail: {
              info: {
                icon: "",
                name: definition.name,
                rdns: definition.rdns,
                uuid: definition.uuid
              },
              provider: announcedProvider
            },
          }));
        }
      };
      window.addEventListener("eip6963:requestProvider", announceProviders);
      queueMicrotask(announceProviders);
    },
    {
      account: options.account ?? DEFAULT_ACCOUNT,
      additionalProviders: options.additionalProviders ?? [],
      allowTransactions: options.allowTransactions ?? false,
      chainId: options.chainId ?? LOCALNET_CHAIN_ID,
      connectMode: options.connectMode ?? "ready",
      primaryProvider: options.primaryProvider ?? { name: "Mock MetaMask", rdns: "io.metamask", uuid: "robinhood-lb-mock-wallet" },
      rejectTransactions: options.rejectTransactions ?? false,
      switchMode: options.switchMode ?? "ready",
      transactionDelayMs: options.transactionDelayMs ?? 0,
      transactionHash: options.transactionHash ?? "0x1111111111111111111111111111111111111111111111111111111111111111",
      transactionHashes: options.transactionHashes ?? [],
      transactionMode: options.transactionMode ?? "ready"
    }
  );
}

export async function openMockWalletConnection(page: Page, providerName = "Mock MetaMask"): Promise<void> {
  const connectButton = page.getByTestId("wallet-connect-button");
  const accountButton = page.getByTestId("wallet-account-button");
  await connectButton.or(accountButton).first().waitFor({ state: "visible", timeout: 15_000 });
  if (!await accountButton.isVisible()) {
    await connectButton.click({ timeout: 15_000 }).catch(async (error: unknown) => {
      if (!await accountButton.isVisible()) throw error;
    });
  }
  if (await accountButton.isVisible()) return;
  const escapedName = providerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const appKitWallet = page.getByRole("button", { name: new RegExp(`${escapedName} installed`, "i") });
  await appKitWallet.or(accountButton).first().waitFor({ state: "visible", timeout: 15_000 });
  if (!await accountButton.isVisible()) await appKitWallet.click();
}

export async function openAndSelectMockWallet(page: Page, providerName = "Mock MetaMask"): Promise<void> {
  await openMockWalletConnection(page, providerName);
  const accountButton = page.getByTestId("wallet-account-button");
  const escapedName = providerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const appKitWallet = page.getByRole("button", { name: new RegExp(`${escapedName} installed`, "i") });
  await accountButton.waitFor({ state: "visible", timeout: 15_000 });
  await appKitWallet.waitFor({ state: "hidden", timeout: 15_000 });
}

export async function readMockWallet(page: Page): Promise<MockWalletSnapshot> {
  return page.evaluate(() => {
    const state = window.__mockWalletState;
    return {
      accounts: [...state.accounts],
      addChainCalls: [...state.addChainCalls],
      chainId: state.chainId,
      calls: [...state.calls],
      rejectTransactions: state.rejectTransactions,
      sentTransactions: [...state.sentTransactions],
      switchChainCalls: [...state.switchChainCalls]
    };
  });
}

declare global {
  interface Window {
    __mockWalletState: {
      accounts: string[];
      addChainCalls: number[];
      chainId: number;
      calls: string[];
      rejectTransactions: boolean;
      sentTransactions: unknown[];
      switchChainCalls: number[];
    };
    __mockWalletStates: Record<string, Window["__mockWalletState"]>;
    __mockWalletControl: {
      disconnect(rdns?: string): void;
      releaseNextTransaction(rdns?: string): void;
      setAccounts(accounts: string[], rdns?: string): void;
      setChain(chainId: number, rdns?: string): void;
    };
    ethereum?: unknown;
  }
}
