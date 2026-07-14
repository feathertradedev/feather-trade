/**
 * Normalizes the complete GraphQL POST target supplied by configuration.
 * Consumers must use this URL as-is and must not append a transport path.
 */
export function normalizeAnalyticsEndpoint(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;

  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "" || url.hash !== "") return null;

    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}
