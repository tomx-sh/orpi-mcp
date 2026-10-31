import { createHash, timingSafeEqual } from "node:crypto";

export function checkMcpAuth(request: Request, expectedToken: string | undefined): Response | undefined {
  if (!expectedToken || expectedToken.trim().length < 32) {
    return Response.json({ error: "Configure MCP_ACCESS_TOKEN with at least 32 characters." }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
  const header = request.headers.get("authorization");
  const supplied = header?.match(/^Bearer ([^\s]+)$/i)?.[1];
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!supplied || !timingSafeEqual(digest(supplied), digest(expectedToken))) {
    return Response.json({ error: "Unauthorized" }, {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="orpi-mcp"', "Cache-Control": "no-store" },
    });
  }
}
