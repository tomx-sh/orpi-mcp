import { z } from "zod";

export type Row = Record<string, unknown>;
export const periodSchema = z.enum(["precedent", "courant", "suivant"]);
export const ledgerOptionsSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  accountingClass: z.enum(["1", "2", "4", "5", "6", "7"]).optional(),
  accountCode: z.string().regex(/^\d{1,12}$/).optional(),
  thirdPartyCode: z.string().min(1).max(50).optional(),
});
export type LedgerOptions = z.infer<typeof ledgerOptionsSchema>;
export const documentSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("category"), templateId: z.string().min(1).max(100), scope: z.enum(["individual", "collective", "all"]).default("all") }),
  z.object({ kind: z.literal("invoice_control"), exerciseId: z.uuid() }),
  z.object({ kind: z.literal("general_meeting"), meetingId: z.uuid() }),
  z.object({ kind: z.literal("account_summary") }),
  z.object({ kind: z.literal("council_summary") }),
  z.object({ kind: z.literal("requests") }),
  z.object({ kind: z.literal("balance_entries"), period: periodSchema, rowId: z.uuid() }),
  z.object({ kind: z.literal("dossier"), dossierId: z.uuid(), taskId: z.uuid().optional() }),
]);
export type DocumentSource = z.infer<typeof documentSourceSchema>;
export type Period = z.infer<typeof periodSchema>;
export const rows = (value: unknown): Row[] => z.array(z.record(z.string(), z.unknown())).parse(value);

export function invoiceRows(exercise: Row): Row[] {
  const result: Row[] = [];
  for (const chapter of rows(exercise.ms_exer_info ?? []))
    for (const rubric of rows(chapter.ms_chapitre_info ?? []))
      for (const nature of rows(rubric.ms_rubrique_info ?? []))
        for (const invoice of rows(nature.ms_nature_info ?? [])) result.push({
          chapterCode: chapter.ms_chapitre_code, chapterTitle: chapter.ms_chapitre_intitule,
          rubricCode: rubric.ms_rubrique_code, rubricTitle: rubric.ms_rubrique_intitule,
          natureCode: nature.ms_nature_code, natureTitle: nature.ms_nature_intitule,
          ...invoice,
        });
  return result;
}

export function ledgerRows(data: Row): Row[] {
  return rows(data.mo_journaux ?? []).flatMap((account) => {
    const { mo_ecritures, ...metadata } = account;
    const prefix = Object.fromEntries(Object.entries(metadata).map(([k, v]) => [`account.${k}`, v]));
    const entries = rows(mo_ecritures ?? []);
    return entries.length ? entries.map((entry) => ({ ...prefix, ...entry })) : [prefix];
  });
}

// Only known document-ID fields are followed, never arbitrary URLs or other IDs.
const gedKeys = new Set(["ms_gedid", "ms_ged_id", "ged_id", "mu_ged_id", "mu_piece_gedid", "ms_contrat_gedid", "ms_facture_ged"]);
export function documentReferences(value: unknown, source: DocumentSource) {
  const result = new Map<string, Row & { ms_gedid: string; ms_ged_nom: string; source: DocumentSource }>();
  function visit(node: unknown) {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    const record = node as Row;
    for (const [key, v] of Object.entries(record)) {
      if (gedKeys.has(key) && typeof v === "string" && z.uuid().safeParse(v).success && !/^0{8}-/.test(v)) {
        const name = [record.ms_ged_nom, record.ms_nom_fichier, record.ged_nom, record.ms_piecedet_libelle,
          record.ms_piece_libelle, record.ms_ecriture_libelle, record.ms_contrat_objet, record.ms_os_libelle].find(x => typeof x === "string" && x);
        if (!result.has(v)) result.set(v, { ...record, ms_gedid: v, ms_ged_nom: typeof name === "string" ? name : v, source });
      }
      if (typeof v === "object") visit(v);
    }
  }
  visit(value);
  return [...result.values()];
}
