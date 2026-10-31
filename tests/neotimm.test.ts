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

describe("Additional read access", () => {
  test("denies council information to a non-member without requesting the council endpoint", async () => {
    const { client, calls } = harness([
      json(login), json([{ acteur_id: actorId }]), json([{ ms_role_id: roleId }]), json({ mb_membre_cs: false }),
    ]);
    await expect(client.getCouncilSummary(actorId, roleId)).rejects.toThrow("Council membership");
    expect(calls).toHaveLength(4);
  });

  test("respects hidden budgets before requesting financial-year data", async () => {
    const { client, calls } = harness([
      json(login), json([{ acteur_id: actorId }]), json([{ ms_role_id: roleId }]), json({ mb_visibilite_budgets: false }),
    ]);
    await expect(client.getPropertyBudget(actorId, roleId)).rejects.toThrow("not visible");
    expect(calls).toHaveLength(4);
  });

  test("uses the role's property ID for meetings", async () => {
    const propertyId = "33333333-3333-4333-8333-333333333333";
    const { client, calls } = harness([
      json(login), json([{ acteur_id: actorId }]),
      json([{ ms_role_id: roleId, ms_role_aid_immeuble: propertyId }]), json([]),
    ]);
    await client.listGeneralMeetings(actorId, roleId);
    expect(calls[3].url).toEndWith(`/ag/${propertyId}/${actorId}`);
  });
});

describe("Document boundaries", () => {
  const documentId = "44444444-4444-4444-8444-444444444444";
  const category = { ms_template_id: "template", ms_template_nom: "Avis Appel" };
  const document = { ms_gedid: documentId, ms_ged_nom: "Test PDF", ms_template_id: "template" };
  const context = () => [
    json(login), json([{ acteur_id: actorId }]), json([{ ms_role_id: roleId }]),
    json({ mb_membre_cs: false }), json([category]),
  ];

  test("does not request documents for a category outside the selected role", async () => {
    const { client, calls } = harness(context());
    await expect(client.listDocuments(actorId, roleId, "other-template")).rejects.toThrow("not available");
    expect(calls).toHaveLength(5);
  });

  test("does not fetch a PDF absent from the authorized document listing", async () => {
    const { client, calls } = harness([...context(), json([])]);
    await expect(client.getDocument(actorId, roleId, "template", documentId)).rejects.toThrow("not in");
    expect(calls).toHaveLength(6);
  });

  test("preserves individual-only scope when discovering and listing documents", async () => {
    const { client, calls } = harness([...context(), json([document])]);
    await client.listDocuments(actorId, roleId, "template", "individual");
    for (const call of calls.slice(4)) {
      expect(JSON.parse(call.init.body as string)).toMatchObject({
        pb_collective: false, pb_individuel: true, pb_cs: false,
      });
    }
  });

  test("rejects an advertised oversized attachment before reading its body", async () => {
    const response = new Response("%PDF-test", { headers: { "content-type": "application/pdf", "content-length": "1000" } });
    const { client } = harness([...context(), json([document]), response]);
    await expect(client.getDocument(actorId, roleId, "template", documentId, "all", 32)).rejects.toThrow("size limit");
    expect(response.bodyUsed).toBe(true);
  });

  test("enforces the actual byte limit on chunked responses", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("%PDF-"));
        controller.enqueue(new Uint8Array(40));
        controller.close();
      },
    }), { headers: { "content-type": "application/pdf" } });
    const { client } = harness([...context(), json([document]), response]);
    await expect(client.getDocument(actorId, roleId, "template", documentId, "all", 32)).rejects.toThrow("size limit");
  });

  test("rejects an HTML response masquerading as a PDF", async () => {
    const { client } = harness([
      ...context(), json([document]),
      new Response("<html>error</html>", { headers: { "content-type": "application/pdf" } }),
    ]);
    await expect(client.getDocument(actorId, roleId, "template", documentId)).rejects.toThrow("invalid PDF");
  });

  test("returns original bytes only after document membership and PDF checks", async () => {
    const { client, calls } = harness([
      ...context(), json([document]),
      new Response("%PDF-test", { headers: { "content-type": "application/pdf" } }),
    ]);
    const result = await client.getDocument(actorId, roleId, "template", documentId);
    expect(new TextDecoder().decode(result.bytes)).toBe("%PDF-test");
    expect(calls[6].url).toEndWith(`/ged/buffer/${documentId}/${actorId}`);
    expect(new Headers(calls[6].init.headers).get("Authorization")).toBe("Bearer first-token");
  });
});
