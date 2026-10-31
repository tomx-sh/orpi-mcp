# ORPI / Neotimm MCP

A personal, read-only MCP server using Next.js App Router and `mcp-handler` v2. Endpoint: `/api/mcp` (Streamable HTTP). No browser, AI provider, or database is required at runtime.

## Local configuration

Use Bun and Node.js 20.9 or later. Run commands from this directory.

```sh
bun install
cp .env.example .env.local
chmod 600 .env.local
openssl rand -hex 32
```

If `.env.local` already exists, keep it; do not overwrite its values. Fill in:

| Variable | Purpose |
| --- | --- |
| `NEOTIMM_EMAIL` | Your Neotimm login email |
| `NEOTIMM_PASSWORD` | Your Neotimm password |
| `NEOTIMM_FIREBASE_API_KEY` | Public Firebase project key (provided in `.env.example`) |
| `MCP_ACCESS_TOKEN` | Separate random token for MCP clients; use the generated hex value |

Keep these server-side; never prefix them with `NEXT_PUBLIC_`. `.env.local` is ignored by Git. Next.js expands `$` in environment files: escape a literal dollar sign in a password as `\$`. Enter Vercel dashboard values literally.

```sh
bun dev
```

## Tools

1. `list_accounts`: discover business accounts associated with the configured login.
2. `list_roles`: select an `actorId` returned above and list its property roles.
3. `get_account_summary`: use that `actorId` and a returned `roleId` to read accounting, lots, contacts, contracts, and council information.
4. `list_document_categories`: list categories for that account/role, using the role's council visibility flag.

All tools are annotated read-only. Document listing and PDF downloads are not implemented yet. Tool responses include private financial and contact data.

## Authentication

There are two separate credentials:

- MCP clients send `Authorization: Bearer <MCP_ACCESS_TOKEN>` on every request. This is personal API-key authentication, not OAuth. Missing/incorrect credentials get HTTP 401; an unconfigured server fails closed with HTTP 503.
- The server signs in to Firebase using the Neotimm email/password, obtains an ID/refresh token pair, and uses the ID token to access Neotimm. It renews before expiry and retains replacement refresh tokens in instance memory. Concurrent calls within an instance share authentication work. A cold Vercel instance signs in afresh. Account restrictions or additional login challenges can still prevent sign-in.

No credentials are logged or returned by tools. Upstream requests disable caching, cookies, and redirects and have a 15-second timeout. A 401 gets one renewal retry; a 403 remains a permission failure. The wrapper validates account/role membership before requesting role data. Neotimm remains responsible for its own authorization.

Every holder of `MCP_ACCESS_TOKEN` can read the configured owner's data. Keep it distinct from your Neotimm password. Rotate it by updating the server and both clients.

## Deploy on Vercel

1. Import this Next.js project. If the repository root is the parent directory, set Vercel's Root Directory to `app`.
2. Add the four environment variables. Store the password and MCP access token as **Secret** variables. Do not assign production credentials to untrusted preview deployments.
3. Deploy. The MCP URL is `https://<your-project>.vercel.app/api/mcp`.
4. Configure clients below. If Vercel Deployment Protection is enabled, it must also permit those client requests; otherwise Vercel blocks them before they reach this route. Application bearer authentication must remain enabled.

No OAuth provider or Redis is needed for this personal setup. Environment-variable changes require a new deployment. Neotimm's undocumented routes can change independently of this server.

## Codex

Local Codex clients support configured bearer tokens as well as OAuth. In `~/.codex/config.toml`:

```toml
[mcp_servers.orpi]
url = "https://<your-project>.vercel.app/api/mcp"
bearer_token_env_var = "ORPI_MCP_TOKEN"
```

Set `ORPI_MCP_TOKEN` to the server's `MCP_ACCESS_TOKEN` in the environment available to Codex, then restart/reconnect. Desktop processes do not necessarily inherit a terminal's environment. Codex also supports configured HTTP headers where appropriate. Do not run `codex mcp login orpi`: that starts OAuth, which this server does not implement. Hosted plugin connection flows may have different requirements.

## Hermes Agent

In `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  orpi:
    url: "https://<your-project>.vercel.app/api/mcp"
    headers:
      Authorization: "Bearer ${ORPI_MCP_TOKEN}"
```

Put `ORPI_MCP_TOKEN` in the active Hermes profile's `.env` file (default: `~/.hermes/.env`), using the same value as the server's `MCP_ACCESS_TOKEN`. Reconnect/reload MCP after changing configuration. Do not set `auth: oauth` for this server.

## Verification

```sh
bun test
bun run check
bun run build
# With the app running and MCP_ACCESS_TOKEN configured:
bun run smoke
# Additionally signs in with the configured credentials and calls all four tools:
bun run smoke --live
```

Override `MCP_URL` to check a different local port or deployed endpoint. Smoke checks print statuses/counts instead of personal data. Unit tests mock authentication and cover token expiry, replacement refresh tokens, concurrent login, retries, and account boundaries. They do not establish that real password login succeeds; `--live` checks that end to end.

Verified locally on 2026-10-31: nine unit tests, TypeScript, and the production build passed. The live smoke check against the production-built server successfully performed fresh password login and called all four tools (one account, one role, 26 summary fields, 39 document categories). Unauthenticated and incorrect-token requests returned 401. Vercel deployment and connections from Codex/Hermes have not yet been tested.

## References

- [Vercel MCP guide](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel)
- [Codex MCP configuration](https://developers.openai.com/codex/mcp/)
- [Hermes MCP configuration](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference)
- [Firebase REST authentication](https://firebase.google.com/docs/reference/rest/auth)
- [Vercel Secret environment variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables)
