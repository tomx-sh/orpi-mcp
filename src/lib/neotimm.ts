import { z } from "zod";

const apiBase = "https://extranet-4c-kd4tnagsqa-ew.a.run.app";
const actorSchema = z.object({ acteur_id: z.string().uuid() }).passthrough();
const roleSchema = z.object({ ms_role_id: z.string().uuid() }).passthrough();
const summarySchema = z.object({ mb_membre_cs: z.boolean().nullish() }).passthrough();
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

  private async fetch(url: string, init: RequestInit = {}) {
    try {
      return await this.fetcher(url, {
        ...init,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
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

  private async request(path: string, actorId?: string, body?: unknown) {
    const send = async (session: Session) => this.fetch(apiBase + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "x-status": "1",
        ...(actorId ? { "x-acteur": actorId } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
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
    return response.json();
  }

  async listAccounts() {
    return z.array(actorSchema).parse(await this.request("/acteur/role"));
  }

  async listRoles(actorId: string) {
    const accounts = await this.listAccounts();
    if (!accounts.some((account) => account.acteur_id === actorId)) {
      throw new NeotimmError("This account is not associated with the configured Neotimm login.");
    }
    return z.array(roleSchema).parse(await this.request(
      `/role/liste?acteurId=${encodeURIComponent(actorId)}`, actorId,
    ));
  }

  async getSummary(actorId: string, roleId: string) {
    const roles = await this.listRoles(actorId);
    if (!roles.some((role) => role.ms_role_id === roleId)) {
      throw new NeotimmError("This role is not associated with the selected account.");
    }
    return summarySchema.parse(await this.request(
      `/role/fiche/${encodeURIComponent(roleId)}/${encodeURIComponent(actorId)}/false`, actorId,
    ));
  }

  async listDocumentCategories(actorId: string, roleId: string) {
    const summary = await this.getSummary(actorId, roleId);
    return z.array(z.object({
      ms_template_id: z.string(),
      ms_template_nom: z.string(),
    }).passthrough()).parse(await this.request("/document/categorie", actorId, {
      pu_roleid: roleId,
      pb_collective: true,
      pb_individuel: true,
      pb_cs: summary.mb_membre_cs === true,
      pb_liste_template: true,
    }));
  }
}
