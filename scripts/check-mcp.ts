// Bun loads .env.local. Print statuses/counts, never personal responses or tokens.
import { toolCatalog } from "../src/lib/tool-catalog";
import { createHash } from "node:crypto";
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
  const expectedTools = Object.keys(toolCatalog);
  if (tools.length !== expectedTools.length || tools.some((tool: { name: string; annotations?: { readOnlyHint?: boolean } }) =>
    !expectedTools.includes(tool.name) || !tool.annotations?.readOnlyHint)) {
    throw new Error("The registered read-only tools do not match the tool catalogue.");
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
    const category = categories.find((item: { ms_template_nom: string }) => item.ms_template_nom === "Avis Appel") ?? categories[0];
    if (!category) throw new Error("No document category available to test.");
    const templateId = category.ms_template_id;
    const documents = await call("list_documents", { actorId, roleId, templateId });
    console.log(`Live documents in selected category: ${documents.length}`);
    if (!documents.length) throw new Error("No document in the selected category to test.");
    const documentArgs = { actorId, roleId, templateId, documentId: documents[0].ms_gedid };
    const text = await call("read_document", { ...documentArgs, startPage: 1, pageCount: 1 });
    if (!text.pages?.length || typeof text.pages[0].text !== "string") throw new Error("PDF extraction result is invalid.");
    console.log(`Live PDF text: ${text.totalPages} page(s), ${text.pages[0].text.length} characters on first page`);
    const download = await result("tools/call", { name: "download_document", arguments: documentArgs });
    if (download.isError) throw new Error("PDF attachment retrieval failed.");
    const attachment = download.content.find((item: { type: string }) => item.type === "resource");
    if (attachment?.resource?.mimeType !== "application/pdf") throw new Error("Missing PDF attachment.");
    const bytes = Buffer.from(attachment.resource.blob, "base64");
    if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("Invalid PDF attachment data.");
    console.log(`Live PDF attachment: ${bytes.length} bytes`);
    for (const byteOffset of [0, 64]) {
      const partial = await result("tools/call", { name: "download_document", arguments: { ...documentArgs, byteOffset, chunkSize: 64 } });
      if (partial.isError) throw new Error("Chunked PDF retrieval failed.");
      const metadata = JSON.parse(partial.content[0].text);
      const resource = partial.content.find((item: { type: string }) => item.type === "resource");
      if (metadata.byteOffset !== byteOffset || metadata.nextOffset !== byteOffset + 64 || metadata.sha256 !== createHash("sha256").update(bytes).digest("hex") ||
        !Buffer.from(resource.resource.blob, "base64").equals(bytes.subarray(byteOffset, byteOffset + 64))) throw new Error("PDF chunks do not match the original.");
    }
    console.log("Live PDF chunks: offsets and bytes match the original");
    const requests = await call("list_requests", { actorId });
    console.log(`Live requests: ${requests.length}`);
    const dossiers = await call("list_dossiers", { actorId, roleId });
    console.log(`Live dossiers: ${dossiers.length}`);
    const meetings = await call("list_general_meetings", { actorId, roleId });
    console.log(`Live general meetings: ${meetings.length}`);
    if (summary.mb_visibilite_budgets === true) {
      const budgets = await call("get_property_budget", { actorId, roleId });
      console.log(`Live budget periods: ${budgets.length}`);
    } else console.log("Budget check skipped: not visible for this role");
    if (summary.mb_membre_cs === true) {
      const council = await call("get_council_summary", { actorId, roleId });
      console.log(`Live council summary: ${Object.keys(council).length} fields`);
    } else console.log("Council check skipped: not a council member");

    const invoiceExercises = await call("list_invoice_exercises", { actorId, roleId });
    if (!invoiceExercises.length) throw new Error("No invoice exercise available for the full smoke check.");
    const invoiceExerciseId = invoiceExercises[0].ms_exer_id;
    const control = await call("get_invoice_control", { actorId, roleId, exerciseId: invoiceExerciseId });
    console.log(`Live invoice control: ${invoiceExercises.length} exercises, ${control.invoices.length} invoices in selected exercise`);
    const balance = await call("get_accounting_balance", { actorId, roleId, period: "courant" });
    const row = balance.rows.find((item: { ms_databal_compteid?: string }) => item.ms_databal_compteid);
    if (!row) throw new Error("No balance detail row available.");
    const entries = await call("get_balance_entries", { actorId, roleId, rowId: row.ms_data_id });
    console.log(`Live balance: ${balance.rows.length} rows, ${entries.entries.length} entries in selected account`);
    const ledgerExercises = await call("list_ledger_exercises", { actorId, roleId });
    const selected = ledgerExercises.find((item: { mb_courant: unknown }) => item.mb_courant === "true" || item.mb_courant === true) ?? ledgerExercises[0];
    if (!selected) throw new Error("No ledger exercise available.");
    const ledgerArgs = { actorId, roleId, exerciseId: selected.mu_exer_id };
    const ledger = await call("get_general_ledger", ledgerArgs);
    console.log(`Live ledger: ${ledgerExercises.length} exercises, ${ledger.data.mo_journaux.length} account groups`);
    const ledgerText = await call("get_general_ledger", { ...ledgerArgs, format: "text", pageCount: 1 });
    console.log(`Live ledger text: ${ledgerText.totalPages} pages, ${ledgerText.pages[0].text.length} characters on first page`);
    const ledgerPdf = await result("tools/call", { name: "get_general_ledger", arguments: { ...ledgerArgs, format: "pdf" } });
    if (ledgerPdf.isError || !ledgerPdf.content.some((item: { resource?: { mimeType: string } }) => item.resource?.mimeType === "application/pdf")) throw new Error("Missing generated ledger PDF.");
    console.log("Live ledger PDF attachment: verified");
    const sources = [
      { kind: "invoice_control", exerciseId: invoiceExerciseId },
      { kind: "account_summary" }, { kind: "council_summary" },
      { kind: "requests" },
      { kind: "balance_entries", period: "courant", rowId: row.ms_data_id },
      ...(meetings.length ? [{ kind: "general_meeting", meetingId: meetings[0].mu_ag_id }] : []),
    ];
    for (const source of sources) {
      const sourceDocs = await call("list_documents", { actorId, roleId, source });
      console.log(`Live document source ${source.kind}: ${sourceDocs.length} PDFs`);
      if (source.kind === "invoice_control" && sourceDocs.length) {
        const text = await call("read_document", { actorId, roleId, source, documentId: sourceDocs[0].ms_gedid, pageCount: 1 });
        console.log(`Live invoice PDF text: ${text.pages[0].text.length} characters`);
      }
    }
    for (const dataset of ["documents", "invoice_control", "balance", "balance_entries", "general_ledger", "budgets", "meetings", "requests", "dossiers", "accounting_entries", "contacts", "lots", "contracts", "council_invoices", "quotes", "work_orders"]) {
      const exported = await result("tools/call", { name: "export_csv", arguments: {
        actorId, roleId, dataset, exerciseId: dataset === "invoice_control" ? invoiceExerciseId : selected.mu_exer_id,
        rowId: row.ms_data_id, source: { kind: "category", templateId },
      } });
      if (exported.isError) throw new Error(`CSV export failed: ${dataset}`);
      const metadata = JSON.parse(exported.content[0].text);
      const file = exported.content.find((item: { resource?: { mimeType: string } }) => item.resource?.mimeType === "text/csv");
      if (!file?.resource.text.startsWith("\uFEFF")) throw new Error(`Missing UTF-8 CSV: ${dataset}`);
      console.log(`Live CSV ${dataset}: ${metadata.rowCount} rows`);
    }
    const csvPages = [];
    for (const offset of [0, 1]) {
      const page = await result("tools/call", { name: "export_csv", arguments: { actorId, roleId, dataset: "invoice_control", exerciseId: invoiceExerciseId, offset, limit: 1 } });
      if (page.isError) throw new Error("CSV pagination failed.");
      const meta = JSON.parse(page.content[0].text);
      if (meta.rowCount !== 1 || meta.offset !== offset || meta.totalRows !== control.invoices.length || meta.nextOffset !== offset + 1) throw new Error("Incorrect CSV pagination metadata.");
      csvPages.push(page.content.find((item: { resource?: { mimeType: string } }) => item.resource?.mimeType === "text/csv").resource.text);
    }
    if (csvPages[0].split("\r\n")[0] !== csvPages[1].split("\r\n")[0]) throw new Error("CSV columns changed across pages.");
    console.log("Live CSV pagination: counts, offsets and stable headers verified");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "MCP check failed.");
  process.exitCode = 1;
});
