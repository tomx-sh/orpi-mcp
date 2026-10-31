import { z } from "zod";
import { NeotimmClient, NeotimmError } from "./neotimm";
import { documentSourceSchema, ledgerOptionsSchema, ledgerRows, periodSchema, rows, type Row } from "./consultation";

export const exportOptionsSchema = z.object({
  dataset: z.enum(["documents", "invoice_control", "balance", "balance_entries", "general_ledger", "budgets", "meetings", "requests", "dossiers", "accounting_entries", "contacts", "lots", "contracts", "council_invoices", "quotes", "work_orders"]),
  source: documentSourceSchema.optional(),
  exerciseId: z.uuid().optional(),
  period: periodSchema.default("courant"),
  rowId: z.uuid().optional(),
  ledgerOptions: ledgerOptionsSchema.default({}),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(10_000).default(1000),
});

export async function exportRows(api: NeotimmClient, actor: string, role: string, options: z.infer<typeof exportOptionsSchema>): Promise<Row[]> {
  const required = (value: string | undefined, field: string) => {
    if (!value) throw new NeotimmError(`Provide ${field} for this CSV dataset.`);
    return value;
  };
  switch (options.dataset) {
    case "documents": {
      if (!options.source) throw new NeotimmError("Provide a document source for this CSV dataset.");
      return api.listSourceDocuments(actor, role, options.source);
    }
    case "invoice_control": return (await api.getInvoiceControl(actor, role, required(options.exerciseId, "exerciseId"))).invoices;
    case "balance": return (await api.getAccountingBalance(actor, role, options.period)).rows;
    case "balance_entries": return (await api.getBalanceEntries(actor, role, options.period, required(options.rowId, "rowId"))).entries;
    case "general_ledger": return ledgerRows((await api.getGeneralLedger(actor, role, required(options.exerciseId, "exerciseId"), options.ledgerOptions)).data);
    case "budgets": return api.getPropertyBudget(actor, role);
    case "meetings": return api.listGeneralMeetings(actor, role);
    case "requests": return api.listRequests(actor);
    case "dossiers": return api.listDossiers(actor, role);
    case "council_invoices": case "quotes": case "work_orders": {
      const summary = await api.getCouncilSummary(actor, role);
      const key = { council_invoices: "mo_liste_factures", quotes: "mo_liste_devis_fournisseur", work_orders: "mo_liste_commandes_fournisseur" }[options.dataset];
      return rows(summary[key] ?? []);
    }
    case "accounting_entries": {
      const summary = await api.getSummary(actor, role);
      return rows(summary.mo_compta ?? []).flatMap((group) => rows(group.mo_liste_ecritures ?? []).map((entry) => ({ accountGroup: group.libelle, ...entry })));
    }
    default: {
      const summary = await api.getSummary(actor, role);
      const key = { contacts: "mo_liste_contacts", lots: "mo_liste_lots", contracts: "mo_liste_contrats" }[options.dataset];
      return rows(summary[key] ?? []);
    }
  }
}
