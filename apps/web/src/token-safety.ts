import { formatUnits, parseUnits, type Address } from "viem";

import { tokenActionBlocker, tokenSupportsExecutableApproval, type TokenAction, type TokenMetadata } from "@robinhood-lb/sdk/tokens";

export const UINT256_MAX = (1n << 256n) - 1n;

export type TokenAmountError =
  | "empty"
  | "invalid-format"
  | "overprecision"
  | "overflow"
  | "zero"
  | "over-balance";

export interface TokenAmountResult {
  amount: bigint | null;
  error: TokenAmountError | null;
}

export function parseTokenAmount(value: string, decimals: number, balance: bigint | null = null): TokenAmountResult {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { amount: null, error: "empty" };
  if (trimmed.length > 336) return { amount: null, error: "overflow" };
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255 || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) {
    return { amount: null, error: "invalid-format" };
  }
  const normalizedForLength = trimmed.replace(/^0+/, "") || "0";
  if (normalizedForLength.length > decimals + 80) return { amount: null, error: "overflow" };
  const fraction = trimmed.split(".")[1] ?? "";
  if (fraction.length > decimals) return { amount: null, error: "overprecision" };

  try {
    const amount = parseUnits(trimmed, decimals);
    if (amount > UINT256_MAX) return { amount: null, error: "overflow" };
    if (amount === 0n) return { amount, error: "zero" };
    if (balance !== null && amount > balance) return { amount, error: "over-balance" };
    return { amount, error: null };
  } catch {
    return { amount: null, error: "overflow" };
  }
}

export function tokenAmountErrorMessage(error: TokenAmountError | null, decimals: number): string | null {
  switch (error) {
    case null:
      return null;
    case "empty":
    case "invalid-format":
      return "Enter a valid token amount";
    case "overprecision":
      return `This token supports at most ${decimals} decimal places`;
    case "overflow":
      return "Amount exceeds the maximum executable token value";
    case "zero":
      return "Enter an amount greater than zero";
    case "over-balance":
      return "Amount exceeds the connected wallet balance";
  }
}

export function safeMaxAmount(input: {
  asset: "native" | "token";
  balance: bigint;
  gasReserveWei?: bigint;
}): bigint {
  if (input.balance < 0n || input.balance > UINT256_MAX) throw new Error("Balance is outside uint256 bounds");
  if (input.asset === "token") return input.balance;
  if (input.gasReserveWei === undefined) throw new Error("Native Max requires a reviewed gas reserve");
  const reserve = input.gasReserveWei;
  if (reserve < 0n || reserve > UINT256_MAX) throw new Error("Gas reserve is outside uint256 bounds");
  return input.balance > reserve ? input.balance - reserve : 0n;
}

export function maxAmountInput(input: {
  asset: "native" | "token";
  balance: bigint;
  decimals: number;
  gasReserveWei?: bigint;
}): string {
  if (!Number.isSafeInteger(input.decimals) || input.decimals < 0 || input.decimals > 255) {
    throw new Error("Token decimals must be an integer from 0 to 255");
  }
  if (input.asset === "native" && input.decimals !== 18) throw new Error("Native ETH Max requires 18 decimals");
  return formatUnits(safeMaxAmount(input), input.decimals);
}

export function tokenExecutionBlocker(token: TokenMetadata | null, action: TokenAction): string | null {
  if (token === null) return "Token identity is unavailable";
  return tokenActionBlocker(token, action);
}

export function assertExecutableTokenAction(tokens: readonly (TokenMetadata | null)[], action: TokenAction): void {
  for (const token of tokens) {
    const blocker = tokenExecutionBlocker(token, action);
    if (blocker !== null) throw new Error(blocker);
  }
}

export function deterministicTokenFallback(token: Pick<TokenMetadata, "address" | "symbol">): { color: string; label: string } {
  const hash = token.address.slice(2).toLowerCase().split("").reduce((value, character) => (value * 33 + character.charCodeAt(0)) >>> 0, 5381);
  return {
    color: `hsl(${hash % 360} 62% 46%)`,
    label: token.symbol.slice(0, 2).toUpperCase() || "?"
  };
}

export function approvalMode(token: TokenMetadata | null): "standard" | "special / excluded" {
  return token !== null && tokenSupportsExecutableApproval(token) ? "standard" : "special / excluded";
}

export function exactApprovalDisclosure(input: {
  amount: bigint | null;
  spender: Address | null;
  token: TokenMetadata | null;
}): string {
  const token = input.token;
  return [
    `Token: ${token?.symbol ?? "unknown"}`,
    `Address: ${token?.address ?? "unknown"}`,
    `Network: ${token?.chainId ?? "unknown"}`,
    `Exact raw amount: ${input.amount?.toString() ?? "invalid"}`,
    `Decimals: ${token?.decimals ?? "unknown"}`,
    `Spender: ${input.spender ?? "unknown"}`,
    `Mode: ${approvalMode(token)}`,
    `Approval behavior: ${token?.approvalBehavior ?? "missing / excluded"}`
  ].join(" · ");
}

export function financialTokenIdentityLabel(token: TokenMetadata | null, address: Address | string | null): string {
  return token === null
    ? `Unlisted token (${address ?? "address unavailable"})`
    : `${token.name} (${token.symbol} · ${token.address}) · chain ${token.chainId} · review ${token.risk.reviewStatus}`;
}

export function poolChoiceIdentityLabel(input: {
  address: Address;
  tokenX: TokenMetadata | null;
  tokenXAddress: Address;
  tokenY: TokenMetadata | null;
  tokenYAddress: Address;
}): string {
  const symbols = `${input.tokenX?.symbol ?? "Unknown"} / ${input.tokenY?.symbol ?? "Unknown"}`;
  return `${symbols} · ${financialTokenIdentityLabel(input.tokenX, input.tokenXAddress)} / ${financialTokenIdentityLabel(input.tokenY, input.tokenYAddress)} · pool ${input.address}`;
}
