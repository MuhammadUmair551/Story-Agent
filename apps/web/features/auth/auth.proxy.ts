import { createApiConfiguration, readWebEnvironment } from "@/config";
export const proxyAccountApi = async (request: Request, path: readonly string[]): Promise<Response> => {
  const fail = (status: number, error: string) => Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
  if (!["auth", "story-agent"].includes(path[0] ?? "") || path.some((part) => !part || part === "." || part === ".." || /[/\\]/.test(part))) return fail(404, "Route was not found.");
  const source = new URL(request.url); const origin = request.headers.get("Origin");
  // Next can construct request.url with its internal hostname. Host identifies the
  // browser-facing authority; never trust an arbitrary X-Forwarded-Host instead.
  const host = request.headers.get("Host") ?? source.host;
  let sameOrigin = false;
  if (origin) {
    try {
      const candidate = new URL(origin);
      const secure = candidate.protocol === "https:" || (candidate.protocol === "http:" && ["127.0.0.1", "localhost"].includes(candidate.hostname));
      sameOrigin = secure && candidate.origin === origin && candidate.host === host.toLowerCase();
    } catch { sameOrigin = false; }
  }
  if (request.headers.get("Sec-Fetch-Site") === "cross-site" || (origin && !sameOrigin) || (!["GET", "HEAD"].includes(request.method) && !sameOrigin)) return fail(403, "Request verification failed.");
  const base = new URL(createApiConfiguration(readWebEnvironment()).baseUrl);
  const target = new URL(`${base.href.replace(/\/$/, "")}/${path.map(encodeURIComponent).join("/")}`); target.search = source.search;
  const headers = new Headers();
  for (const name of ["Content-Type", "X-CSRF-Token", "X-Request-Id"]) { const value = request.headers.get(name); if (value) headers.set(name, value); }
  if (origin) headers.set("Origin", origin);
  const cookies = (request.headers.get("Cookie") ?? "").split(";").map((part) => part.trim()).filter((part) => /^(?:__Host-story_session|story_session)=/.test(part));
  if (cookies.length) headers.set("Cookie", cookies.join("; "));
  const chunks: Uint8Array[] = []; let length = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.length; if (length > 256 * 1024) { await reader.cancel(); return fail(413, "Request is too large."); } chunks.push(next.value); }
  }
  try {
    const response = await fetch(target, { method: request.method, headers, ...(length ? { body: Buffer.concat(chunks) } : {}), redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(110_000) });
    const outgoing = new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
    for (const name of ["Content-Type", "X-Request-Id"]) { const value = response.headers.get(name); if (value) outgoing.set(name, value); }
    for (const value of response.headers.getSetCookie()) outgoing.append("Set-Cookie", value);
    return new Response(response.body, { status: response.status, headers: outgoing });
  } catch { return fail(502, "The API is unavailable. Please try again."); }
};
