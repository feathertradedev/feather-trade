export type PoolWorkspaceTask = "market" | "swap" | "create" | "manage";
export type PoolWorkspaceIntent = "add" | "partial" | "full" | null;

export interface PoolWorkspaceRoute {
  poolId: string;
  task: PoolWorkspaceTask;
  intent: PoolWorkspaceIntent;
  source: "canonical" | "legacy";
}

const WORKSPACE_TASKS = new Set<PoolWorkspaceTask>(["market", "swap", "create", "manage"]);

export function parsePoolWorkspaceRoute(hash: string): PoolWorkspaceRoute | null {
  const segments = parseSegments(hash);
  const [route, first, second] = segments;

  if (route === "pools" && first !== undefined) {
    const poolId = decodeRoutePart(first);
    if (poolId === null) return null;
    const task = second === undefined ? "market" : WORKSPACE_TASKS.has(second as PoolWorkspaceTask) ? second as PoolWorkspaceTask : null;
    return task === null ? null : { poolId, task, intent: task === "create" ? "add" : null, source: "canonical" };
  }

  if (route === "swap" && first !== undefined) {
    const poolId = decodeRoutePart(first);
    return poolId === null ? null : { poolId, task: "swap", intent: null, source: "legacy" };
  }

  if (route !== "liquidity" || first === undefined) return null;
  const action = first === "add" || first === "withdraw" || first === "partial" || first === "full" ? first : null;
  const poolId = decodeRoutePart(action === null ? first : second);
  if (poolId === null) return null;
  if (action === "withdraw") return { poolId, task: "manage", intent: null, source: "legacy" };
  if (action === "partial" || action === "full") return { poolId, task: "manage", intent: action, source: "legacy" };
  return { poolId, task: "create", intent: "add", source: "legacy" };
}

export function poolWorkspaceHref(poolId: string, task: PoolWorkspaceTask = "market"): string {
  const encodedPoolId = encodeRoutePart(poolId);
  return `#/pools/${encodedPoolId}/${task}`;
}

function parseSegments(hash: string): string[] {
  const payload = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!payload.startsWith("/")) return [];
  const pathname = payload.split("?", 1)[0] ?? "";
  return pathname.split("/").filter(Boolean);
}

function encodeRoutePart(value: string): string {
  const decoded = decodeRoutePart(value);
  if (decoded === null) throw new Error("Invalid pool route identifier");
  return encodeURIComponent(decoded);
}

function decodeRoutePart(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.length === 0 || decoded === "." || decoded === ".." || /[%/\u0000-\u001f]/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}
