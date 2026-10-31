import "server-only";
import { createHash } from "node:crypto";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { checkMcpAuth } from "@/lib/mcp-auth";
import { NeotimmClient, NeotimmError } from "@/lib/neotimm";
import { toolCatalog } from "@/lib/tool-catalog";
import { documentSourceSchema, ledgerOptionsSchema, periodSchema, type DocumentSource } from "@/lib/consultation";
import { exportOptionsSchema, exportRows } from "@/lib/export-data";
import { toCsv } from "@/lib/csv";

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
const scopeInput = z.enum(["individual", "collective", "all"]).default("all");
const categoryInput = roleInput.extend({ scope: scopeInput });
const documentListInput = categoryInput.extend({
  templateId: z.string().min(1).max(100).optional().describe("Legacy category selection; alternatively provide source"),
  source: documentSourceSchema.optional().describe("Document origin returned by list_documents; supports categories, invoices, meetings, summaries, balance entries and dossiers"),
});
const documentInput = documentListInput.extend({
  documentId: z.uuid().describe("ms_gedid returned by list_documents"),
});
const exerciseInput = roleInput.extend({ exerciseId: z.uuid() });
const balanceInput = roleInput.extend({ period: periodSchema.default("courant") });
const balanceEntriesInput = balanceInput.extend({ rowId: z.uuid().describe("ms_data_id of a detail row from get_accounting_balance") });

function resolveSource(input: z.infer<typeof documentListInput>): DocumentSource {
  if (input.source) return input.source;
  if (input.templateId) return { kind: "category", templateId: input.templateId, scope: input.scope };
  throw new NeotimmError("Provide source, or templateId for a category document.");
}

function pdfAttachment(bytes: Uint8Array, uri: string, metadata: unknown) {
  if (bytes.length > 2 * 1024 * 1024) throw new NeotimmError("PDF attachment exceeds 2 MiB. Use text reading or narrow the ledger date range.");
  return { content: [
    { type: "text" as const, text: JSON.stringify(metadata) },
    { type: "resource" as const, resource: { uri, mimeType: "application/pdf", blob: Buffer.from(bytes).toString("base64") } },
  ] };
}

const handler = createMcpHandler((server) => {
  server.registerTool("list_accounts", {
    description: toolCatalog.list_accounts,
    inputSchema: z.object({}), annotations,
  }, async () => toolResult((api) => api.listAccounts()));

  server.registerTool("list_roles", {
    description: toolCatalog.list_roles,
    inputSchema: accountInput, annotations,
  }, async ({ actorId }) => toolResult((api) => api.listRoles(actorId)));

  server.registerTool("get_account_summary", {
    description: toolCatalog.get_account_summary,
    inputSchema: roleInput, annotations,
  }, async ({ actorId, roleId }) => toolResult((api) => api.getSummary(actorId, roleId)));

  server.registerTool("list_document_categories", {
    description: toolCatalog.list_document_categories,
    inputSchema: categoryInput, annotations,
  }, async ({ actorId, roleId, scope }) => toolResult((api) => api.listDocumentCategories(actorId, roleId, scope)));

  server.registerTool("list_documents", {
    description: toolCatalog.list_documents,
    inputSchema: documentListInput, annotations,
  }, async (input) => toolResult((api) => api.listSourceDocuments(input.actorId, input.roleId, resolveSource(input))));

  server.registerTool("read_document", {
    description: toolCatalog.read_document,
    inputSchema: documentInput.extend({
      startPage: z.number().int().min(1).default(1),
      pageCount: z.number().int().min(1).max(5).default(3),
      textOffset: z.number().int().min(0).default(0),
    }), annotations,
  }, async (input) => toolResult(async (api) => {
    const { actorId, roleId, documentId, startPage, pageCount, textOffset } = input;
    const { document, bytes } = await api.getSourceDocument(actorId, roleId, resolveSource(input), documentId);
    const { readPdf } = await import("@/lib/pdf");
    return { document, ...await readPdf(bytes, startPage, pageCount, textOffset) };
  }));

  server.registerTool("download_document", {
    description: toolCatalog.download_document,
    inputSchema: documentInput.extend({
      byteOffset: z.number().int().min(0).default(0),
      chunkSize: z.number().int().min(1).max(2 * 1024 * 1024).default(2 * 1024 * 1024),
    }), annotations,
  }, async (input) => {
    try {
      const { actorId, roleId, documentId, byteOffset, chunkSize } = input;
      const { document, bytes } = await getClient().getSourceDocument(
        actorId, roleId, resolveSource(input), documentId, 32 * 1024 * 1024,
      );
      if (byteOffset >= bytes.length) throw new NeotimmError("Byte offset exceeds the document's size.");
      const chunk = bytes.subarray(byteOffset, byteOffset + chunkSize);
      const complete = byteOffset === 0 && chunk.length === bytes.length;
      const metadata = {
        document, mimeType: "application/pdf", totalBytes: bytes.length, byteOffset, bytes: chunk.length,
        nextOffset: byteOffset + chunk.length < bytes.length ? byteOffset + chunk.length : null,
        sha256: createHash("sha256").update(bytes).digest("hex"), complete,
        note: complete ? "Complete original PDF." : "Partial binary chunk: concatenate chunks in byteOffset order and verify the final SHA-256. Do not open individual chunks as PDFs.",
      };
      return { content: [
        { type: "text" as const, text: JSON.stringify(metadata) },
        { type: "resource" as const, resource: {
          uri: `neotimm://documents/${documentId}${complete ? "" : `?offset=${byteOffset}`}`,
          mimeType: complete ? "application/pdf" : "application/octet-stream", blob: Buffer.from(chunk).toString("base64"),
        } },
      ] };
    } catch (error) {
      return toolResult(async () => { throw error; });
    }
  });

  server.registerTool("list_requests", {
    description: toolCatalog.list_requests,
    inputSchema: accountInput, annotations,
  }, async ({ actorId }) => toolResult((api) => api.listRequests(actorId)));

  server.registerTool("list_dossiers", {
    description: toolCatalog.list_dossiers,
    inputSchema: roleInput, annotations,
  }, async ({ actorId, roleId }) => toolResult((api) => api.listDossiers(actorId, roleId)));

  server.registerTool("get_property_budget", {
    description: toolCatalog.get_property_budget,
    inputSchema: roleInput, annotations,
  }, async ({ actorId, roleId }) => toolResult((api) => api.getPropertyBudget(actorId, roleId)));

  server.registerTool("get_council_summary", {
    description: toolCatalog.get_council_summary,
    inputSchema: roleInput, annotations,
  }, async ({ actorId, roleId }) => toolResult((api) => api.getCouncilSummary(actorId, roleId)));

  server.registerTool("list_general_meetings", {
    description: toolCatalog.list_general_meetings,
    inputSchema: roleInput, annotations,
  }, async ({ actorId, roleId }) => toolResult((api) => api.listGeneralMeetings(actorId, roleId)));

  server.registerTool("list_invoice_exercises", { description: toolCatalog.list_invoice_exercises, inputSchema: roleInput, annotations },
    async ({ actorId, roleId }) => toolResult((api) => api.listInvoiceExercises(actorId, roleId)));
  server.registerTool("get_invoice_control", { description: toolCatalog.get_invoice_control, inputSchema: exerciseInput, annotations },
    async ({ actorId, roleId, exerciseId }) => toolResult((api) => api.getInvoiceControl(actorId, roleId, exerciseId)));
  server.registerTool("get_accounting_balance", { description: toolCatalog.get_accounting_balance, inputSchema: balanceInput, annotations },
    async ({ actorId, roleId, period }) => toolResult((api) => api.getAccountingBalance(actorId, roleId, period)));
  server.registerTool("get_balance_entries", { description: toolCatalog.get_balance_entries, inputSchema: balanceEntriesInput, annotations },
    async ({ actorId, roleId, period, rowId }) => toolResult((api) => api.getBalanceEntries(actorId, roleId, period, rowId)));
  server.registerTool("list_ledger_exercises", { description: toolCatalog.list_ledger_exercises, inputSchema: roleInput, annotations },
    async ({ actorId, roleId }) => toolResult((api) => api.listLedgerExercises(actorId, roleId)));
  server.registerTool("get_general_ledger", {
    description: toolCatalog.get_general_ledger,
    inputSchema: exerciseInput.extend({
      options: ledgerOptionsSchema.default({}), format: z.enum(["json", "text", "pdf"]).default("json"),
      startPage: z.number().int().min(1).default(1), pageCount: z.number().int().min(1).max(5).default(3), textOffset: z.number().int().min(0).default(0),
    }), annotations,
  }, async ({ actorId, roleId, exerciseId, options, format, startPage, pageCount, textOffset }) => {
    try {
      const { bytes, ...ledger } = await getClient().getGeneralLedger(actorId, roleId, exerciseId, options);
      if (format === "pdf") return pdfAttachment(bytes, `neotimm://ledger/${exerciseId}.pdf`, { exercise: ledger.exercise, startDate: ledger.startDate, endDate: ledger.endDate });
      if (format === "text") {
        const { readPdf } = await import("@/lib/pdf");
        return toolResult(async () => ({ exercise: ledger.exercise, ...await readPdf(bytes, startPage, pageCount, textOffset) }));
      }
      return toolResult(async () => ledger);
    } catch (error) { return toolResult(async () => { throw error; }); }
  });
  server.registerTool("export_csv", {
    description: toolCatalog.export_csv, inputSchema: roleInput.extend(exportOptionsSchema.shape), annotations,
  }, async ({ actorId, roleId, ...options }) => {
    try {
      const records = await exportRows(getClient(), actorId, roleId, options);
      const columns = [...new Set(records.flatMap((record) => Object.keys(record)))];
      const csv = toCsv(records.slice(options.offset, options.offset + options.limit), columns);
      return { content: [
        { type: "text" as const, text: JSON.stringify({ filename: `${options.dataset}.csv`, rowCount: csv.rowCount, totalRows: records.length, offset: options.offset, nextOffset: options.offset + csv.rowCount < records.length ? options.offset + csv.rowCount : null, columns: csv.columns, delimiter: ";", encoding: "UTF-8 with BOM", note: "CSV generated from the same authorized upstream data; headers use API field names. Nested values are JSON. Text formula prefixes are escaped. Follow nextOffset with the same selection to export remaining rows." }) },
        { type: "resource" as const, resource: { uri: `neotimm://exports/${options.dataset}.csv`, mimeType: "text/csv", text: csv.text } },
      ] };
    } catch (error) { return toolResult(async () => { throw error; }); }
  });
}, { serverInfo: { name: "orpi-mcp", version: "0.3.0" } });

async function authorizedHandler(request: Request) {
  const rejection = checkMcpAuth(request, process.env.MCP_ACCESS_TOKEN);
  if (rejection) return rejection;
  const response = await handler(request);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export { authorizedHandler as GET, authorizedHandler as POST };
