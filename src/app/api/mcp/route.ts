import "server-only";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { checkMcpAuth } from "@/lib/mcp-auth";
import { NeotimmClient, NeotimmError } from "@/lib/neotimm";

export const maxDuration = 60;

let client: NeotimmClient | undefined;

function getClient() {
  if (!client) {
    const email = process.env.NEOTIMM_EMAIL;
    const password = process.env.NEOTIMM_PASSWORD;
    const apiKey = process.env.NEOTIMM_FIREBASE_API_KEY;
    if (!email || !password || !apiKey) {
      throw new NeotimmError("Set NEOTIMM_EMAIL, NEOTIMM_PASSWORD, and NEOTIMM_FIREBASE_API_KEY on the server.");
    }
    client = new NeotimmClient({ email, password, apiKey });
  }
  return client;
}

async function toolResult(run: (client: NeotimmClient) => Promise<unknown>) {
  try {
    const data = await run(getClient());
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  } catch (error) {
    // Raw upstream errors can contain private responses. Only expose our messages.
    return {
      isError: true,
      content: [{ type: "text" as const, text: error instanceof NeotimmError
        ? error.message : "Neotimm returned an unexpected response. Try again later." }],
    };
  }
}

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const accountInput = z.object({ actorId: z.uuid().describe("Account acteur_id returned by list_accounts") });
const roleInput = accountInput.extend({ roleId: z.uuid().describe("ms_role_id returned by list_roles") });

const handler = createMcpHandler((server) => {
  server.registerTool("list_accounts", {
    description: "List the Neotimm accounts accessible to the configured owner. Start here to obtain an actorId.",
    inputSchema: z.object({}), annotations,
  }, async () => toolResult((api) => api.listAccounts()));

  server.registerTool("list_roles", {
    description: "List property roles and balances for an account returned by list_accounts.",
    inputSchema: accountInput, annotations,
  }, async ({ actorId }) => toolResult((api) => api.listRoles(actorId)));

  server.registerTool("get_account_summary", {
    description: "Read the selected property role's accounting entries, lots, contacts, contracts, and council information. Includes private financial data.",
    inputSchema: roleInput, annotations,
  }, async ({ actorId, roleId }) => toolResult((api) => api.getSummary(actorId, roleId)));

  server.registerTool("list_document_categories", {
    description: "List available document categories for a property role. Category presence does not establish that documents are available inside it.",
    inputSchema: roleInput, annotations,
  }, async ({ actorId, roleId }) => toolResult((api) => api.listDocumentCategories(actorId, roleId)));
}, { serverInfo: { name: "orpi-mcp", version: "0.1.0" } });

async function authorizedHandler(request: Request) {
  const rejection = checkMcpAuth(request, process.env.MCP_ACCESS_TOKEN);
  if (rejection) return rejection;
  const response = await handler(request);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export { authorizedHandler as GET, authorizedHandler as POST };
