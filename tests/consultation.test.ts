import { expect, test } from "bun:test";
import { NeotimmClient } from "../src/lib/neotimm";
import { documentReferences, invoiceRows, ledgerRows } from "../src/lib/consultation";
import { toCsv } from "../src/lib/csv";

const actor = "11111111-1111-4111-8111-111111111111";
const role = "22222222-2222-4222-8222-222222222222";
const property = "33333333-3333-4333-8333-333333333333";
const exercise = "44444444-4444-4444-8444-444444444444";
const docId = "55555555-5555-4555-8555-555555555555";
const rowId = "66666666-6666-4666-8666-666666666666";
const json = (v: unknown) => Response.json(v);
const context = (flags: Record<string, boolean> = {}) => [
  json({ idToken: "token", refreshToken: "refresh", expiresIn: "3600" }),
  json([{ acteur_id: actor }]), json([{ ms_role_id: role, ms_role_aid_immeuble: property }]),
  json({ mb_membre_cs: true, mb_visibilite_controle_factures_cs: true, mb_visibilite_controle_balances_cs: true, ...flags }),
];
function harness(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    return response;
  }) as typeof fetch;
  return { api: new NeotimmClient({ email: "test@example.com", password: "password", apiKey: "key" }, fetcher), calls };
}
const ledgerExercise = { mu_exer_id: exercise, md_exer_date_debut: "2026-01-01", md_exer_date_fin: "2026-12-31" };

test("invoice control refuses an exercise not associated with the verified property", async () => {
  const { api, calls } = harness([...context(), json([])]);
  await expect(api.getInvoiceControl(actor, role, exercise)).rejects.toThrow("not available");
  expect(calls).toHaveLength(5);
  expect(calls.some(x => x.url.includes("/ag/validation/"))).toBe(false);
});

test("invoice permission is checked even for a council member", async () => {
  const { api, calls } = harness(context({ mb_visibilite_controle_factures_cs: false }));
  await expect(api.listInvoiceExercises(actor, role)).rejects.toThrow("not available");
  expect(calls).toHaveLength(4);
});

test("balance detail refuses a row that was not in the authorized balance", async () => {
  const { api, calls } = harness([...context(), json([{ ms_exer_libelle: "Exercice_courant", mb_aEcriture: true }]), json([])]);
  await expect(api.getBalanceEntries(actor, role, "courant", rowId)).rejects.toThrow("Select a detail row");
  expect(calls).toHaveLength(6);
});

test("ledger cannot access other exercises or archive/mail endpoints", async () => {
  const denied = harness([...context(), json(1), json([])]);
  await expect(denied.api.getGeneralLedger(actor, role, exercise)).rejects.toThrow("not available");
  expect(denied.calls).toHaveLength(6);
  const { api, calls } = harness([...context(), json(1), json([ledgerExercise]),
    json([Buffer.from("%PDF-test").toString("base64"), JSON.stringify({ mo_general: {}, mo_journaux: [] })]),
  ]);
  await api.getGeneralLedger(actor, role, exercise, { accountingClass: "6", startDate: "2026-02-01", endDate: "2026-02-28" });
  const last = calls.at(-1)!;
  expect(last.url).toBe("https://ws-4c-kd4tnagsqa-ew.a.run.app/grandlivre/archivagesyndic/0");
  expect(JSON.parse(last.init.body as string)).toMatchObject({
    mandant: property, exerid: exercise, DATE_DEBUT: "20260201", DATE_FIN: "20260228", classe: 6, avecged: 0,
  });
});

test("ledger checks feature availability and date range before generation", async () => {
  const hidden = harness([...context(), json(0)]);
  await expect(hidden.api.listLedgerExercises(actor, role)).rejects.toThrow("not enabled");
  for (const dates of [
    { startDate: "2025-01-01", endDate: "2026-12-31" },
    { startDate: "2026-02-31", endDate: "2026-03-01" },
    { startDate: "2026-12-31", endDate: "2026-01-01" },
  ]) {
    const { api, calls } = harness([...context(), json(1), json([ledgerExercise])]);
    await expect(api.getGeneralLedger(actor, role, exercise, dates)).rejects.toThrow("valid YYYY-MM-DD");
    expect(calls).toHaveLength(6);
  }
});

test("meeting and dossier document access stays within selected verified records", async () => {
  const meeting = harness([context()[0], context()[1], context()[2], json([])]);
  await expect(meeting.api.listSourceDocuments(actor, role, { kind: "general_meeting", meetingId: exercise })).rejects.toThrow("not available");
  const dossier = harness([context()[0], context()[1], context()[2], json([{ dossier_id: exercise, mo_liste_tache: [] }])]);
  await expect(dossier.api.listSourceDocuments(actor, role, { kind: "dossier", dossierId: exercise, taskId: rowId })).rejects.toThrow("not part");
  expect(dossier.calls).toHaveLength(4);
});

test("document discovery recognizes known GED fields and ignores unrelated IDs and URLs", () => {
  const refs = documentReferences({
    ms_acteur_id: actor, ms_url_drive: "https://example.com/document", nested: [
      { ms_ged_id: docId, ms_nom_fichier: "Meeting minutes" }, { mu_piece_gedid: docId }, { ged_id: "not-a-uuid" },
    ],
  }, { kind: "account_summary" });
  expect(refs).toHaveLength(1);
  expect(refs[0]).toMatchObject({ ms_gedid: docId, ms_ged_nom: "Meeting minutes" });
});

test("invoice and ledger flattening preserve accounting context and zero amounts", () => {
  const invoices = invoiceRows({ ms_exer_info: [{ ms_chapitre_intitule: "Building", ms_chapitre_info: [
    { ms_rubrique_intitule: "Common", ms_rubrique_info: [{ ms_nature_intitule: "Water", ms_nature_info: [{ mx_piecedet_ttc: 0 }] }] },
  ] }] });
  expect(invoices).toMatchObject([{ chapterTitle: "Building", rubricTitle: "Common", natureTitle: "Water", mx_piecedet_ttc: 0 }]);
  expect(ledgerRows({ mo_journaux: [{ ms_journal_code: "401", mo_ecritures: [{ mx_ecriture_debit: 0 }] }] })).toEqual([
    { "account.ms_journal_code": "401", mx_ecriture_debit: 0 },
  ]);
});

test("CSV preserves accents, newlines, quotes, nulls and negative numeric amounts", () => {
  const csv = toCsv([{ name: 'Électricité; "test"\nligne', amount: -12.5, zero: 0, empty: null }]);
  expect(csv.text).toStartWith("\uFEFF");
  expect(csv.text).toContain('"Électricité; ""test""\nligne"');
  expect(csv.text).toContain('"-12.5";"0";""');
  expect(csv.rowCount).toBe(1);
});

test("CSV neutralizes text formulas and rejects oversized exports", () => {
  const csv = toCsv([{ value: " =HYPERLINK(\"https://example.com\")" }, { value: "@SUM(1)" }]);
  expect(csv.text).toContain("' =HYPERLINK");
  expect(csv.text).toContain("'@SUM");
  expect(() => toCsv([{ value: "a".repeat(1024 * 1024) }])).toThrow("exceeds 1 MiB");
  expect(toCsv([]).rowCount).toBe(0);
});

test("CSV pages can share stable columns when later rows contain additional fields", () => {
  const columns = ["name", "amount"];
  const first = toCsv([{ name: "first" }], columns);
  const second = toCsv([{ name: "second", amount: 0 }], columns);
  expect(first.text.split("\r\n")[0]).toBe(second.text.split("\r\n")[0]);
  expect(first.text).toContain('"first";""');
  expect(second.text).toContain('"second";"0"');
});
