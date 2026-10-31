import { describe, expect, test } from "bun:test";
import { checkMcpAuth } from "../src/lib/mcp-auth";
import { NeotimmClient } from "../src/lib/neotimm";

const actorId = "11111111-1111-4111-8111-111111111111";
const roleId = "22222222-2222-4222-8222-222222222222";
const config = { email: "owner@example.com", password: "private-password", apiKey: "project-key" };
const login = { idToken: "first-token", refreshToken: "first-refresh", expiresIn: "3600" };
const json = (value: unknown, status = 200) => Response.json(value, { status });

function harness(responses: Response[], now: () => number = Date.now) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    return response;
  }) as typeof fetch;
  return { client: new NeotimmClient(config, fetcher, now), calls };
}

describe("MCP access", () => {
  test("fails closed when unconfigured and rejects missing/wrong tokens", () => {
    const secret = "a".repeat(64);
    const request = (token?: string) => new Request("http://localhost/api/mcp", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    expect(checkMcpAuth(request(), undefined)?.status).toBe(503);
    expect(checkMcpAuth(request(), "short")?.status).toBe(503);
    expect(checkMcpAuth(request(), secret)?.status).toBe(401);
    expect(checkMcpAuth(request("wrong"), secret)?.status).toBe(401);
    expect(checkMcpAuth(request(secret), secret)).toBeUndefined();
  });
});

describe("Neotimm sessions", () => {
  test("shares one fresh sign-in across concurrent reads and sends no password to Neotimm", async () => {
    const { client, calls } = harness([
      json(login), json([{ acteur_id: actorId }]), json([{ acteur_id: actorId }]),
    ]);
    await Promise.all([client.listAccounts(), client.listAccounts()]);
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toContain("accounts:signInWithPassword");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      email: config.email, password: config.password, returnSecureToken: true,
    });
    for (const call of calls.slice(1)) {
      expect(call.init.body).toBeUndefined();
      expect(new Headers(call.init.headers).get("Authorization")).toBe("Bearer first-token");
    }
    for (const call of calls) {
      expect(call.init.credentials).toBe("omit");
      expect(call.init.cache).toBe("no-store");
      expect(call.init.redirect).toBe("error");
    }
  });

  test("renews before expiry and uses the replacement refresh token on the next renewal", async () => {
    let clock = 0;
    const { client, calls } = harness([
      json(login), json([]),
      json({ id_token: "second-token", refresh_token: "second-refresh", expires_in: "3600" }), json([]),
      json({ id_token: "third-token", refresh_token: "third-refresh", expires_in: "3600" }), json([]),
    ], () => clock);
    await client.listAccounts();
    clock = 3_550_000;
    await client.listAccounts();
    clock += 3_550_000;
    await client.listAccounts();
    expect(new URLSearchParams(calls[2].init.body as string).get("refresh_token")).toBe("first-refresh");
    expect(new Headers(calls[3].init.headers).get("Authorization")).toBe("Bearer second-token");
    expect(new URLSearchParams(calls[4].init.body as string).get("refresh_token")).toBe("second-refresh");
  });

  test("renews and retries a 401 once, but does not retry a 403", async () => {
    const { client, calls } = harness([
      json(login), json({}, 401),
      json({ id_token: "renewed", refresh_token: "refresh", expires_in: "3600" }), json([]),
      json({}, 403),
    ]);
    await client.listAccounts();
    expect(new Headers(calls[3].init.headers).get("Authorization")).toBe("Bearer renewed");
    await expect(client.listAccounts()).rejects.toThrow("HTTP 403");
    expect(calls).toHaveLength(5);
  });

  test("can sign in again after a refresh credential becomes invalid", async () => {
    let clock = 0;
    const { client, calls } = harness([
      json(login), json([]), json({}, 400), json(login), json([]),
    ], () => clock);
    await client.listAccounts();
    clock = 3_600_000;
    await client.listAccounts();
    expect(calls[3].url).toContain("accounts:signInWithPassword");
  });

  test("does not expose authentication response bodies in errors", async () => {
    const { client } = harness([json({ error: { message: "sensitive-upstream-value" } }, 400)]);
    await expect(client.listAccounts()).rejects.toThrow("Neotimm sign-in failed.");
  });
});

describe("Account boundaries", () => {
  test("rejects an account not returned by the configured login before requesting its roles", async () => {
    const { client, calls } = harness([json(login), json([])]);
    await expect(client.listRoles(actorId)).rejects.toThrow("not associated");
    expect(calls).toHaveLength(2);
  });

  test("rejects a role not returned for the selected account before requesting its summary", async () => {
    const { client, calls } = harness([json(login), json([{ acteur_id: actorId }]), json([])]);
    await expect(client.getSummary(actorId, roleId)).rejects.toThrow("not associated");
    expect(calls).toHaveLength(3);
  });

  test("derives council document access from the account summary", async () => {
    const { client, calls } = harness([
      json(login), json([{ acteur_id: actorId }]), json([{ ms_role_id: roleId }]),
      json({ mb_membre_cs: false }), json([{ ms_template_id: "template", ms_template_nom: "Avis Appel" }]),
    ]);
    await client.listDocumentCategories(actorId, roleId);
    expect(calls[4].url).toEndWith("/document/categorie");
    expect(JSON.parse(calls[4].init.body as string)).toEqual({
      pu_roleid: roleId, pb_collective: true, pb_individuel: true,
      pb_cs: false, pb_liste_template: true,
    });
  });
});
