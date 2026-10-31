// Bun loads .env.local. Print statuses/counts, never personal responses or tokens.
const url = process.env.MCP_URL ?? "http://127.0.0.1:3000/api/mcp";
const token = process.env.MCP_ACCESS_TOKEN;
if (!token) throw new Error("Set MCP_ACCESS_TOKEN before running this check.");
let id = 0;

async function rpc(method: string, params: unknown, bearer: string = token!) {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
}

async function result(method: string, params: unknown) {
  const response = await rpc(method, params);
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const text = await response.text();
  const message = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6))).find((value) => value.id === id)
    : JSON.parse(text);
  if (!message || message.error) throw new Error(`${method}: protocol error`);
  return message.result;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const value = await result("tools/call", { name, arguments: args });
  if (value.isError) throw new Error(`${name} failed. Check server configuration and upstream account access.`);
  return JSON.parse(value.content[0].text);
}

async function main() {
  if ((await rpc("tools/list", {}, "")).status !== 401) throw new Error("Unauthenticated request was not rejected.");
  if ((await rpc("tools/list", {}, "invalid-token")).status !== 401) throw new Error("Invalid token was not rejected.");
  console.log("Missing and invalid MCP tokens: rejected (401)");
  const init = await result("initialize", {
    protocolVersion: "2025-06-18", capabilities: {},
    clientInfo: { name: "orpi-mcp-check", version: "0.1.0" },
  });
  console.log(`MCP initialization: ${init.serverInfo.name}`);
  const { tools } = await result("tools/list", {});
  console.log(`Tools: ${tools.map((tool: { name: string }) => tool.name).join(", ")}`);
  if (tools.length !== 4 || tools.some((tool: { annotations?: { readOnlyHint?: boolean } }) => !tool.annotations?.readOnlyHint)) {
    throw new Error("Expected exactly four read-only tools.");
  }
  if (process.argv.includes("--live")) {
    const accounts = await call("list_accounts");
    console.log(`Live account discovery: ${accounts.length} account(s)`);
    if (!accounts.length) throw new Error("No account available to test.");
    const actorId = accounts[0].acteur_id;
    const roles = await call("list_roles", { actorId });
    console.log(`Live roles: ${roles.length} role(s)`);
    if (!roles.length) throw new Error("No role available to test.");
    const roleId = roles[0].ms_role_id;
    const summary = await call("get_account_summary", { actorId, roleId });
    console.log(`Live summary: ${Object.keys(summary).length} fields`);
    const categories = await call("list_document_categories", { actorId, roleId });
    console.log(`Live document categories: ${categories.length}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "MCP check failed.");
  process.exitCode = 1;
});
