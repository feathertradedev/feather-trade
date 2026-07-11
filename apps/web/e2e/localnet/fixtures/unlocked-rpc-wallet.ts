import type { Page } from "@playwright/test";
import type { Address, Hex } from "viem";

export interface UnlockedRpcWalletOptions {
  account: Address;
  chainId: number;
  rpcUrl: string;
}

export interface UnlockedRpcWalletSnapshot {
  calls: string[];
  gasEstimateRequests: Array<Record<string, unknown>>;
  estimatedGasLimits: Hex[];
  sentTransactions: Array<Record<string, unknown>>;
  transactionHashes: Hex[];
}

export async function installUnlockedRpcWallet(page: Page, options: UnlockedRpcWalletOptions): Promise<void> {
  await page.addInitScript(
    ({ account, chainId, rpcUrl }) => {
      type Listener = (...args: unknown[]) => void;
      interface WalletState {
        calls: string[];
        gasEstimateRequests: Array<Record<string, unknown>>;
        estimatedGasLimits: string[];
        sentTransactions: Array<Record<string, unknown>>;
        transactionHashes: string[];
      }

      const listeners = new Map<string, Set<Listener>>();
      const state: WalletState = {
        calls: [],
        gasEstimateRequests: [],
        estimatedGasLimits: [],
        sentTransactions: [],
        transactionHashes: []
      };
      let requestId = 1;

      async function forward(method: string, params: unknown[] = []): Promise<unknown> {
        const response = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: requestId++, jsonrpc: "2.0", method, params })
        });
        if (!response.ok) throw new Error(`Unlocked RPC wallet received HTTP ${response.status}`);

        const payload = (await response.json()) as { error?: { code?: number; message?: string }; result?: unknown };
        if (payload.error) {
          const error = new Error(payload.error.message ?? `RPC ${method} failed`) as Error & { code?: number };
          error.code = payload.error.code;
          throw error;
        }
        return payload.result;
      }

      function emit(event: string, ...args: unknown[]): void {
        for (const listener of listeners.get(event) ?? []) listener(...args);
      }

      const provider = {
        _metamask: { isUnlocked: async () => true },
        isMetaMask: true,
        async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
          state.calls.push(method);

          switch (method) {
            case "eth_accounts":
            case "eth_requestAccounts":
              return [account];
            case "wallet_requestPermissions":
              return [{ parentCapability: "eth_accounts", caveats: [{ type: "restrictReturnedAccounts", value: [account] }] }];
            case "eth_chainId":
              return `0x${chainId.toString(16)}`;
            case "net_version":
              return String(chainId);
            case "wallet_switchEthereumChain": {
              const requested = (params?.[0] as { chainId?: string } | undefined)?.chainId;
              if (requested === `0x${chainId.toString(16)}`) return null;
              const error = new Error(`Unlocked test wallet is fixed to chain ${chainId}`) as Error & { code?: number };
              error.code = 4902;
              throw error;
            }
            case "wallet_addEthereumChain":
              return null;
            case "eth_sendTransaction": {
              const requested = (params?.[0] ?? {}) as Record<string, unknown>;
              const { gas: _requestedGas, ...requestedWithoutGas } = requested;
              const estimateRequest = { ...requestedWithoutGas, from: account };
              const estimatedGas = await forward("eth_estimateGas", [estimateRequest]);
              if (typeof estimatedGas !== "string") {
                throw new Error("Unlocked RPC wallet received a non-hex gas estimate");
              }
              const gas = (BigInt(estimatedGas) * 120n + 99n) / 100n;
              const transaction = { ...estimateRequest, gas: `0x${gas.toString(16)}` };
              state.gasEstimateRequests.push(estimateRequest);
              state.estimatedGasLimits.push(estimatedGas);
              state.sentTransactions.push(transaction);
              const hash = (await forward(method, [transaction])) as string;
              state.transactionHashes.push(hash);
              return hash;
            }
            default:
              return forward(method, params ?? []);
          }
        },
        on(event: string, listener: Listener): void {
          const eventListeners = listeners.get(event) ?? new Set<Listener>();
          eventListeners.add(listener);
          listeners.set(event, eventListeners);
        },
        removeListener(event: string, listener: Listener): void {
          listeners.get(event)?.delete(listener);
        },
        emit
      };

      const browserWindow = window as typeof window & { __unlockedRpcWalletState?: WalletState; ethereum?: unknown };
      Object.defineProperty(browserWindow, "ethereum", { configurable: true, value: provider });
      Object.defineProperty(browserWindow, "__unlockedRpcWalletState", { configurable: true, value: state });

      const announce = () =>
        window.dispatchEvent(
          new CustomEvent("eip6963:announceProvider", {
            detail: {
              info: {
                icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
                name: "Unlocked Anvil Wallet",
                rdns: "io.metamask",
                uuid: "robinhood-lb-anvil-wallet"
              },
              provider
            }
          })
        );

      window.addEventListener("eip6963:requestProvider", announce);
      queueMicrotask(announce);
    },
    options
  );
}

export async function readUnlockedRpcWallet(page: Page): Promise<UnlockedRpcWalletSnapshot> {
  return page.evaluate(() => {
    const state = (
      window as typeof window & {
        __unlockedRpcWalletState: {
          calls: string[];
          gasEstimateRequests: Array<Record<string, unknown>>;
          estimatedGasLimits: Hex[];
          sentTransactions: Array<Record<string, unknown>>;
          transactionHashes: Hex[];
        };
      }
    ).__unlockedRpcWalletState;

    return {
      calls: [...state.calls],
      gasEstimateRequests: [...state.gasEstimateRequests],
      estimatedGasLimits: [...state.estimatedGasLimits],
      sentTransactions: [...state.sentTransactions],
      transactionHashes: [...state.transactionHashes]
    };
  });
}
