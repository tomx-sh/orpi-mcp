import { z } from "zod";
import { documentReferences, invoiceRows, ledgerOptionsSchema, rows, type DocumentSource, type LedgerOptions, type Period, type Row } from "./consultation";

const apiBase = "https://extranet-4c-kd4tnagsqa-ew.a.run.app";
const wsBase = "https://ws-4c-kd4tnagsqa-ew.a.run.app";
const actorSchema = z.object({ acteur_id: z.string().uuid() }).passthrough();
const roleSchema = z.object({
  ms_role_id: z.string().uuid(),
  ms_role_aid_immeuble: z.string().uuid().nullish(),
}).passthrough();
const summarySchema = z.object({ mb_membre_cs: z.boolean().nullish() }).passthrough();
const categorySchema = z.object({ ms_template_id: z.string(), ms_template_nom: z.string() }).passthrough();
const documentSchema = z.object({
  ms_gedid: z.string().uuid(),
  ms_ged_nom: z.string(),
  ms_template_id: z.string(),
}).passthrough();
const recordsSchema = z.array(z.record(z.string(), z.unknown()));
export type DocumentScope = "individual" | "collective" | "all";

function documentFlags(scope: DocumentScope) {
  return { pb_collective: scope !== "individual", pb_individuel: scope !== "collective" };
}
const tokenSchema = z.object({
  idToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.coerce.number().positive(),
});
const refreshSchema = z.object({
  id_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.coerce.number().positive(),
});

export class NeotimmError extends Error {}

type Session = { token: string; refreshToken: string; expiresAt: number };
type Config = { email: string; password: string; apiKey: string };

// This client is used only from the server route. Memory is an optimization:
// a new Vercel instance can always sign in again using its environment variables.
export class NeotimmClient {
  private session?: Session;
  private pendingSession?: Promise<Session>;

  constructor(
    private readonly config: Config,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async fetch(url: string, init: RequestInit = {}, timeout = 15_000) {
    try {
      return await this.fetcher(url, {
        ...init,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw new NeotimmError("Neotimm could not be reached. Try again later.");
    }
  }

  private async login(): Promise<Session> {
    const response = await this.fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(this.config.apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: this.config.email,
          password: this.config.password,
          returnSecureToken: true,
        }),
      },
    );
    if (!response.ok) {
      throw new NeotimmError("Neotimm sign-in failed. Check the server credentials and account access.");
    }
    const data = tokenSchema.parse(await response.json());
    return {
      token: data.idToken,
      refreshToken: data.refreshToken,
      expiresAt: this.now() + data.expiresIn * 1000,
    };
  }

  private async renew(): Promise<Session> {
    if (!this.session) return this.login();
    const response = await this.fetch(
      `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(this.config.apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: this.session.refreshToken,
        }).toString(),
      },
    );
    if (!response.ok) {
      if (response.status === 400 || response.status === 401) {
        // A revoked/invalid refresh credential may require a fresh sign-in.
        this.session = undefined;
        return this.login();
      }
      throw new NeotimmError("Neotimm token renewal failed. Try again later.");
    }
    const data = refreshSchema.parse(await response.json());
    return {
      token: data.id_token,
      refreshToken: data.refresh_token,
      expiresAt: this.now() + data.expires_in * 1000,
    };
  }

  private async getSession(): Promise<Session> {
    if (this.session && this.session.expiresAt > this.now() + 60_000) return this.session;
    // Share one login/refresh when concurrent tool calls arrive in one instance.
    if (!this.pendingSession) {
      this.pendingSession = this.renew().then((session) => {
        this.session = session;
        return session;
      }).finally(() => { this.pendingSession = undefined; });
    }
    return this.pendingSession;
  }

  private async requestResponse(path: string, actorId?: string, body?: unknown, service: "extranet" | "ws" = "extranet") {
    const send = async (session: Session) => this.fetch((service === "ws" ? wsBase : apiBase) + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "x-status": "1",
        ...(actorId ? { "x-acteur": actorId } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, service === "ws" ? 45_000 : 15_000);
    const session = await this.getSession();
    let response = await send(session);
    if (response.status === 401) {
      // Retry a read once with a renewed token; never retry permission failures.
      if (this.session === session) this.session.expiresAt = 0;
      response = await send(await this.getSession());
    }
    if (!response.ok) {
      throw new NeotimmError(`Neotimm returned HTTP ${response.status}.`);
    }
    return response;
  }

  private async request(path: string, actorId?: string, body?: unknown) {
    return (await this.requestResponse(path, actorId, body)).json();
  }

  async listAccounts() {
    return z.array(actorSchema).parse(await this.request("/acteur/role"));
  }

  private async requireAccount(actorId: string) {
    const accounts = await this.listAccounts();
    if (!accounts.some((account) => account.acteur_id === actorId)) {
      throw new NeotimmError("This account is not associated with the configured Neotimm login.");
    }
  }

  async listRoles(actorId: string) {
    await this.requireAccount(actorId);
    return z.array(roleSchema).parse(await this.request(
      `/role/liste?acteurId=${encodeURIComponent(actorId)}`, actorId,
    ));
  }

  private async requireRole(actorId: string, roleId: string) {
    const roles = await this.listRoles(actorId);
    const role = roles.find((role) => role.ms_role_id === roleId);
    if (!role) {
      throw new NeotimmError("This role is not associated with the selected account.");
    }
    return role;
  }

  private async getContext(actorId: string, roleId: string) {
    const role = await this.requireRole(actorId, roleId);
    const summary = summarySchema.parse(await this.request(
      `/role/fiche/${encodeURIComponent(roleId)}/${encodeURIComponent(actorId)}/false`, actorId,
    ));
    return { role, summary };
  }

  async getSummary(actorId: string, roleId: string) {
    return (await this.getContext(actorId, roleId)).summary;
  }

  async listDocumentCategories(actorId: string, roleId: string, scope: DocumentScope = "all") {
    const summary = await this.getSummary(actorId, roleId);
    return this.categories(actorId, roleId, summary.mb_membre_cs === true, scope);
  }

  private async categories(actorId: string, roleId: string, council: boolean, scope: DocumentScope) {
    return z.array(categorySchema).parse(await this.request("/document/categorie", actorId, {
      pu_roleid: roleId,
      ...documentFlags(scope),
      pb_cs: council,
      pb_liste_template: true,
    }));
  }

  async listDocuments(actorId: string, roleId: string, templateId: string, scope: DocumentScope = "all") {
    const summary = await this.getSummary(actorId, roleId);
    const council = summary.mb_membre_cs === true;
    const categories = await this.categories(actorId, roleId, council, scope);
    if (!categories.some((category) => category.ms_template_id === templateId)) {
      throw new NeotimmError("This document category is not available for the selected role and scope.");
    }
    return z.array(documentSchema).parse(await this.request("/document/categorie", actorId, {
      pu_roleid: roleId,
      ...documentFlags(scope),
      pb_cs: council,
      pb_liste_template: false,
      pau_templates: [templateId],
    }));
  }

  async getDocument(
    actorId: string, roleId: string, templateId: string, documentId: string,
    scope: DocumentScope = "all", maxBytes = 8 * 1024 * 1024,
  ) {
    return this.getSourceDocument(actorId, roleId, { kind: "category", templateId, scope }, documentId, maxBytes);
  }

  async getSourceDocument(actorId: string, roleId: string, source: DocumentSource, documentId: string, maxBytes = 8 * 1024 * 1024) {
    const documents = await this.listSourceDocuments(actorId, roleId, source);
    const document = documents.find((item) => item.ms_gedid === documentId);
    if (!document) {
      throw new NeotimmError("This document is not in the selected role's document list.");
    }
    const response = await this.requestResponse(
      `/ged/buffer/${encodeURIComponent(documentId)}/${encodeURIComponent(actorId)}`, actorId,
    );
    // Check both the declared and actual size, including chunked responses.
    const tooLarge = () => new NeotimmError(`This PDF exceeds the ${maxBytes / 1024 / 1024} MiB size limit.`);
    if (Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel();
      throw tooLarge();
    }
    if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/pdf") {
      await response.body?.cancel();
      throw new NeotimmError("Neotimm did not return a PDF for this document.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new NeotimmError("Neotimm returned an empty document.");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) {
          await reader.cancel();
          throw tooLarge();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
      throw new NeotimmError("Neotimm returned invalid PDF data.");
    }
    return { document, bytes };
  }

  async listRequests(actorId: string) {
    await this.requireAccount(actorId);
    return recordsSchema.parse(await this.request(`/demande/extranet/${encodeURIComponent(actorId)}`, actorId));
  }

  async listDossiers(actorId: string, roleId: string) {
    await this.requireRole(actorId, roleId);
    return recordsSchema.parse(await this.request(`/dossiers/${encodeURIComponent(roleId)}`, actorId));
  }

  async getCouncilSummary(actorId: string, roleId: string) {
    const summary = await this.getSummary(actorId, roleId);
    if (summary.mb_membre_cs !== true) {
      throw new NeotimmError("Council membership is required for this information.");
    }
    return z.record(z.string(), z.unknown()).parse(await this.request(
      `/role/fiche/${encodeURIComponent(roleId)}/${encodeURIComponent(actorId)}/true`, actorId,
    ));
  }

  private propertyId(role: z.infer<typeof roleSchema>) {
    if (!role.ms_role_aid_immeuble) throw new NeotimmError("No property is associated with this role.");
    return encodeURIComponent(role.ms_role_aid_immeuble);
  }

  async getPropertyBudget(actorId: string, roleId: string) {
    const { role, summary } = await this.getContext(actorId, roleId);
    if (summary.mb_visibilite_budgets !== true) {
      throw new NeotimmError("Property budgets are not visible for this role.");
    }
    return recordsSchema.parse(await this.request(`/exercice/${this.propertyId(role)}`, actorId));
  }

  async listGeneralMeetings(actorId: string, roleId: string) {
    const role = await this.requireRole(actorId, roleId);
    return recordsSchema.parse(await this.request(`/ag/${this.propertyId(role)}/${encodeURIComponent(actorId)}`, actorId));
  }

  private async councilContext(actorId: string, roleId: string, permission: string) {
    const context = await this.getContext(actorId, roleId);
    if (context.summary.mb_membre_cs !== true || context.summary[permission] !== true) {
      throw new NeotimmError("This council accounting view is not available for the selected role.");
    }
    return context;
  }

  async listInvoiceExercises(actorId: string, roleId: string) {
    const { role } = await this.councilContext(actorId, roleId, "mb_visibilite_controle_factures_cs");
    return rows(await this.request(`/ag/factures/${this.propertyId(role)}`, actorId));
  }

  async getInvoiceControl(actorId: string, roleId: string, exerciseId: string) {
    const { role } = await this.councilContext(actorId, roleId, "mb_visibilite_controle_factures_cs");
    const exercises = rows(await this.request(`/ag/factures/${this.propertyId(role)}`, actorId));
    if (!exercises.some((item) => item.ms_exer_id === exerciseId)) throw new NeotimmError("This invoice exercise is not available for the selected property.");
    const args = { coproaid: role.ms_role_aid_immeuble, reprise: 0, exerid: exerciseId };
    const all = rows(await this.request(`/ag/validation/${encodeURIComponent(JSON.stringify(args))}`, actorId));
    const exercise = all.find((item) => item.ms_exer_code === exerciseId);
    if (!exercise) throw new NeotimmError("Neotimm did not return the selected invoice exercise.");
    const { ms_exer_info: _chapters, ...metadata } = exercise;
    return { exercise: metadata, invoices: invoiceRows(exercise) };
  }

  async getAccountingBalance(actorId: string, roleId: string, period: Period) {
    const { role } = await this.councilContext(actorId, roleId, "mb_visibilite_controle_balances_cs");
    const exercises = rows(await this.request(`/exercice/${this.propertyId(role)}`, actorId));
    const exercise = exercises.find((item) => typeof item.ms_exer_libelle === "string" && item.ms_exer_libelle.endsWith(`_${period}`));
    if (!exercise || exercise.mb_aEcriture !== true) throw new NeotimmError("No accounting balance is available for this period.");
    const balance = rows(await this.request(`/balance/${period}/${this.propertyId(role)}`, actorId));
    return { period, exercise, rows: balance };
  }

  async getBalanceEntries(actorId: string, roleId: string, period: Period, rowId: string) {
    const balance = await this.getAccountingBalance(actorId, roleId, period);
    const row = balance.rows.find((item) => item.ms_data_id === rowId);
    if (!row || !z.uuid().safeParse(row.ms_databal_compteid).success) throw new NeotimmError("Select a detail row returned by get_accounting_balance.");
    const entries = rows(await this.request("/balance_detail", actorId, {
      ptab_comptes: [row.ms_databal_compteid], pb_avec_annulation: true, pb_avec_noneditable: false,
      pb_sans_450: ["4501", "4502", "4503", "4504", "4505"].includes(String(row.ms_databal_code)),
      pb_avec_solde_anterieur: true, pn_nombre: 30, pb_extranet: true,
      pd_date_fin: balance.exercise.md_periode_fin, pd_date_debut: balance.exercise.md_periode_debut,
    }));
    return { period, row, entries, note: "Upstream balance-detail request uses the website's pn_nombre=30. Check mn_nb_ligne/mn_no_ligne for completeness; use the general ledger for a full-period export." };
  }

  private async ledgerContext(actorId: string, roleId: string) {
    const { role, summary } = await this.getContext(actorId, roleId);
    if (summary.mb_membre_cs !== true) throw new NeotimmError("Council membership is required for the general ledger.");
    const enabled = await this.request("/parametrage/extranet/51", actorId);
    if (enabled !== 1 && enabled !== "1") throw new NeotimmError("The general ledger is not enabled for this extranet.");
    return role;
  }

  async listLedgerExercises(actorId: string, roleId: string) {
    const role = await this.ledgerContext(actorId, roleId);
    return rows(await (await this.requestResponse(`/grandlivre/exercices/${this.propertyId(role)}`, actorId, undefined, "ws")).json());
  }

  async getGeneralLedger(actorId: string, roleId: string, exerciseId: string, options: LedgerOptions = {}) {
    options = ledgerOptionsSchema.parse(options);
    const role = await this.ledgerContext(actorId, roleId);
    const exercises = rows(await (await this.requestResponse(`/grandlivre/exercices/${this.propertyId(role)}`, actorId, undefined, "ws")).json());
    const exercise = exercises.find((item) => item.mu_exer_id === exerciseId);
    if (!exercise) throw new NeotimmError("This ledger exercise is not available for the selected property.");
    const start = options.startDate ?? String(exercise.md_exer_date_debut);
    const end = options.endDate ?? String(exercise.md_exer_date_fin);
    const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
    if (!validDate(start) || !validDate(end) || start > end || start < String(exercise.md_exer_date_debut) || end > String(exercise.md_exer_date_fin)) {
      throw new NeotimmError("Choose valid YYYY-MM-DD dates within the selected ledger exercise.");
    }
    // Mode 0 + avecged:0 is the site's preview/export path. Never expose archive/mail modes.
    const response = await this.requestResponse("/grandlivre/archivagesyndic/0", actorId, {
      mandant: role.ms_role_aid_immeuble, exerid: exerciseId,
      DATE_DEBUT: start.replaceAll("-", ""), DATE_FIN: end.replaceAll("-", ""),
      classe: options.accountingClass ? Number(options.accountingClass) : null,
      compte_code: options.accountCode ?? null, code_tiers: options.thirdPartyCode ?? null,
      avecged: 0, trameid: "d623df76-5672-4e60-8220-f2bfb6e7e1c7",
    }, "ws");
    const payload = z.tuple([z.string(), z.union([z.string(), z.record(z.string(), z.unknown())])]).parse(await response.json());
    if (payload[0].length > 12 * 1024 * 1024) throw new NeotimmError("Ledger PDF exceeds 8 MiB. Narrow the date range.");
    const bytes = new Uint8Array(Buffer.from(payload[0], "base64"));
    if (bytes.length > 8 * 1024 * 1024 || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new NeotimmError("The generated ledger PDF is invalid or too large.");
    const data = z.record(z.string(), z.unknown()).parse(typeof payload[1] === "string" ? JSON.parse(payload[1]) : payload[1]);
    rows(data.mo_journaux ?? []);
    return { exercise, startDate: start, endDate: end, data, bytes };
  }

  async listSourceDocuments(actorId: string, roleId: string, source: DocumentSource): Promise<(Row & { ms_gedid: string; ms_ged_nom: string; source: DocumentSource })[]> {
    switch (source.kind) {
      case "category": return (await this.listDocuments(actorId, roleId, source.templateId, source.scope)).map((item) => ({ ...item, source }));
      case "invoice_control": return documentReferences((await this.getInvoiceControl(actorId, roleId, source.exerciseId)).invoices, source);
      case "account_summary": return documentReferences(await this.getSummary(actorId, roleId), source);
      case "council_summary": return documentReferences(await this.getCouncilSummary(actorId, roleId), source);
      case "requests": {
        await this.requireRole(actorId, roleId);
        return documentReferences(await this.listRequests(actorId), source);
      }
      case "balance_entries": return documentReferences((await this.getBalanceEntries(actorId, roleId, source.period, source.rowId)).entries, source);
      case "general_meeting": {
        const meetings = await this.listGeneralMeetings(actorId, roleId);
        const meeting = meetings.find((item) => item.mu_ag_id === source.meetingId);
        if (!meeting) throw new NeotimmError("This meeting is not available for the selected property.");
        return documentReferences(meeting.mo_liste_document ?? [], source);
      }
      case "dossier": {
        const dossiers = await this.listDossiers(actorId, roleId);
        const dossier = dossiers.find((item) => item.dossier_id === source.dossierId);
        if (!dossier) throw new NeotimmError("This dossier is not available for the selected role.");
        if (source.taskId && !rows(dossier.mo_liste_tache ?? []).some((task) => task.f2 === source.taskId)) throw new NeotimmError("This task is not part of the selected dossier.");
        const path = `${source.taskId ?? source.dossierId}/${source.taskId ? "TACHE" : "DOSSIER"}`;
        const data = rows(await this.request(`/document/dossier/tache/${encodeURIComponent(roleId)}/${path}`, actorId));
        return documentReferences(data[0]?.mo_ged ?? [], source);
      }
    }
  }
}
