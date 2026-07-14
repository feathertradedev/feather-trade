export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isDocsPath = url.pathname === "/docs" || url.pathname.startsWith("/docs/");

    if (url.hostname === "app.feather.markets" && isDocsPath) {
      url.hostname = "feather.markets";
      return Response.redirect(url.toString(), 308);
    }

    if (url.hostname === "feather.markets" && !isDocsPath) {
      url.hostname = "app.feather.markets";
      return Response.redirect(url.toString(), 308);
    }

    let response = await env.ASSETS.fetch(request);
    if (response.status === 404 && isDocsPath) {
      const fallback = new URL("/index.html", url);
      response = await env.ASSETS.fetch(new Request(fallback, request));
    }

    if (!isDocsPath || !response.headers.get("content-type")?.includes("text/html")) return response;

    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'");
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
  }
};
