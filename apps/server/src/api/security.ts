function loopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

export function isAllowedLocalRequest(request: Request): boolean {
  let requestUrl: URL;
  try { requestUrl = new URL(request.url); } catch { return false; }
  if (!loopback(requestUrl.hostname)) return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    return (originUrl.protocol === "http:" || originUrl.protocol === "https:") && loopback(originUrl.hostname);
  } catch {
    return false;
  }
}

export function forbiddenLocalRequestResponse(): Response {
  return Response.json({
    code: "VALIDATION_ERROR",
    message: "Requests are accepted only from a local loopback origin.",
  }, { status: 403 });
}
