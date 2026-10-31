# ORPI / Neotimm MCP

A personal, read-only MCP server using Next.js App Router and `mcp-handler` v2. Endpoint: `/api/mcp` (Streamable HTTP). No browser, AI provider, or database is required at runtime.

## Local configuration

Use Bun and Node.js 24 or later (required by the PDF parser). Run commands from this directory. `package.json` declares this minimum for Vercel too.

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

| Tool | Purpose |
| --- | --- |
| `list_accounts` | Discover accessible business accounts and their `actorId` |
| `list_roles` | List property roles and balances for an account |
| `get_account_summary` | Read accounting entries, lots, contacts, contracts, and membership |
| `list_document_categories` | List categories with optional `individual`, `collective`, or `all` scope |
| `list_documents` | List a category's documents, dates, labels, and IDs |
| `read_document` | Extract selected PDF pages as text |
| `download_document` | Retrieve the original PDF as an embedded MCP resource |
| `list_requests` | Read existing requests to the property manager |
| `list_dossiers` | Read existing dossiers and their task information |
| `get_property_budget` | Read financial-year budgets and actual spending by expense class |
| `get_council_summary` | Read council invoices, quotes, work orders, and budgets |
| `list_general_meetings` | Read meeting dates, status, and document references |
| `list_invoice_exercises` | List current-charge and works exercises for invoice control |
| `get_invoice_control` | Read detailed invoice-control lines, VAT, suppliers, status, and PDF references |
| `get_accounting_balance` | Read previous/current/next-period hierarchical balance rows |
| `get_balance_entries` | Consult entries behind an authorized balance row |
| `list_ledger_exercises` | Discover general-ledger exercises and date ranges |
| `get_general_ledger` | Generate the site's preview as JSON, PDF text, or a PDF attachment |
| `export_csv` | Export any supported document/accounting table to CSV |

All tools are annotated read-only. No voting, payments, request creation, or status updates are exposed. Responses include private financial and contact data. The upstream routes and observed response shapes are documented in [docs/upstream-api.md](docs/upstream-api.md).

## Consulting documents

For category browsing, select a category with `list_document_categories` and pass its `ms_template_id` as `templateId` to `list_documents`. That original calling convention still works.

Documents can also be discovered through the `source` argument to `list_documents`:

| Source | Required selection |
| --- | --- |
| `category` | `templateId`, optional `scope`: `individual`, `collective`, or `all` |
| `invoice_control` | `exerciseId` from `list_invoice_exercises` |
| `general_meeting` | `meetingId` (`mu_ag_id`) from `list_general_meetings` |
| `account_summary` | Account and role; includes document references in accounting/contracts |
| `council_summary` | Account and role; includes invoices, quotes, and work-order references |
| `requests` | Account and role; document references in the account's existing requests |
| `balance_entries` | `period` and `rowId` (`ms_data_id`) from `get_accounting_balance` |
| `dossier` | `dossierId`, optionally `taskId` (`f2`) from that dossier's `mo_liste_tache` |

Example source: `{"kind":"invoice_control","exerciseId":"<verified exercise UUID>"}`. Every returned document includes `ms_gedid`, `ms_ged_nom`, and `source`. Pass the same `source` with `documentId=ms_gedid` to `read_document` or `download_document`. Document membership is rechecked at its origin before fetching bytes; arbitrary document IDs/URLs are not accepted.

`read_document` accepts `startPage` (default 1) and `pageCount` (default 3, maximum 5). It returns page-numbered text and `nextPage`. Each page returns up to 10,000 characters: if `nextTextOffset` is present, request the same page again with `textOffset` set to that value. PDFs are limited to 8 MiB for text parsing. Scanned pages may have no embedded text; OCR is not configured, and tables can lose layout.

`download_document` supports originals up to 32 MiB. Small PDFs return a complete embedded PDF attachment. Larger files return binary chunks of at most 2 MiB: follow `nextOffset` using `byteOffset`, concatenate in offset order, and verify the final SHA-256. `chunkSize` can request a smaller chunk. Partial chunks use `application/octet-stream` and must not be opened individually as PDFs. No public URL is created. Client attachment support varies.

Upstream missing/invalid documents remain unavailable; the wrapper does not fabricate a PDF or substitute another account's document. The electronic-invoice tab is a fiscal-settings form, with no additional consultation list observed.

## Council accounting and CSV

Invoice-control access requires council membership and the role's invoice-control visibility flag. Select an exercise using `list_invoice_exercises`, then call `get_invoice_control` for invoice rows including chapter, rubric, nature, supplier, VAT, amount, status, and document references. Existing reports/status fields are readable; validation and report submission are not exposed.

`get_accounting_balance` uses `period: precedent|courant|suivant` (default `courant`). It returns raw upstream hierarchical rows, which can overlap at different levels: do not sum all rows as if they were independent accounts. Pass a detail row's `ms_data_id` as `rowId` to `get_balance_entries`. The detail endpoint uses the site's `pn_nombre=30`; inspect `mn_nb_ligne`/`mn_no_ligne` for completeness. For a full-period entry export, use the general ledger. The role's balance-visibility flag is required.

Use `list_ledger_exercises` to get `mu_exer_id`, then pass it as `exerciseId` to `get_general_ledger`. Optional `options` include `startDate`, `endDate` (valid ISO dates within that exercise), `accountingClass`, `accountCode`, and `thirdPartyCode`. `format` is `json` (structured data), `text` (paginated PDF text), or `pdf` (generated attachment, up to 2 MiB; narrow the date range for a larger report). The backend's preview mode `/grandlivre/archivagesyndic/0` with `avecged:0` is used, with the same Firebase token. Archive/mail modes are never called. Council membership and the website's grand-ledger feature flag are required.

`export_csv` returns an attached UTF-8 CSV with BOM and semicolon delimiters. Supported `dataset` values:

- `documents` (provide `source`), `invoice_control` (provide `exerciseId`).
- `balance` (optional `period`), `balance_entries` (`period` and `rowId`).
- `general_ledger` (`exerciseId`, optional `ledgerOptions` with the same filters).
- `budgets`, `meetings`, `requests`, `dossiers`, `accounting_entries`, `contacts`, `lots`, `contracts`, `council_invoices`, `quotes`, `work_orders`.

Use `offset` and `limit` (default 1,000, maximum 10,000) and follow the returned `nextOffset` to export remaining rows. Each CSV attachment is capped at 1 MiB; reduce `limit` if necessary. Headers use upstream field names; nested metadata is JSON. Ledger entries include account-context columns. Quoting preserves delimiters, newlines, accents, and zero/negative numeric values. Formula-like text is escaped for spreadsheet opening. This is CSV built from the authorized data, not a byte-for-byte copy of the website's Excel/multi-section CSV layout. No monetary totals are recalculated.

## Authentication

There are two separate credentials:

- MCP clients send `Authorization: Bearer <MCP_ACCESS_TOKEN>` on every request. This is personal API-key authentication, not OAuth. Missing/incorrect credentials get HTTP 401; an unconfigured server fails closed with HTTP 503.
- The server signs in to Firebase using the Neotimm email/password, obtains an ID/refresh token pair, and uses the ID token to access Neotimm. It renews before expiry and retains replacement refresh tokens in instance memory. Concurrent calls within an instance share authentication work. A cold Vercel instance signs in afresh. Account restrictions or additional login challenges can still prevent sign-in.

No credentials are logged or returned by tools. Upstream requests disable caching, cookies, and redirects. Most have a 15-second timeout; ledger requests allow 45 seconds. A 401 gets one renewal retry; a 403 remains a permission failure. The wrapper validates account/role membership before requesting role data. Neotimm remains responsible for its own authorization.

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
# Additionally signs in and calls the tools against the configured account:
bun run smoke --live
```

Override `MCP_URL` to check a different local port or deployed endpoint. Smoke checks print statuses/counts instead of personal data. Unit tests mock authentication and cover token expiry, replacement refresh tokens, concurrent login, retries, and account boundaries. They do not establish that real password login succeeds; `--live` checks that end to end.

Latest local validation: 33 tests, TypeScript, and the production build passed. Live checks cover all 19 tools, document sources, binary chunk reconstruction, and every supported CSV dataset. The current-exercise ledger export contains 403 entry/context rows and its PDF has 14 pages. Invoice control returns 33 lines and 32 distinct document references. Balance reads were also verified for previous/current/next periods.

Requests and dossiers are empty for this account. Their non-empty attachments cannot be verified live here; membership checks and field mapping are tested against the site's source contract. Missing upstream documents remain unavailable. Text extraction has no OCR, binary downloads are capped at 32 MiB, and CSV pages at 1 MiB. See the continuation parameters above for supported pagination/chunking.

The initial release was deployed and connected successfully in Codex Desktop. This expanded release is validated locally; deployment and the client's handling of the new attachments still need verification. No validation, reporting, email, archive, voting, or fiscal-setting write operations are exposed.

## References

- [Vercel MCP guide](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel)
- [Codex MCP configuration](https://developers.openai.com/codex/mcp/)
- [Hermes MCP configuration](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference)
- [Firebase REST authentication](https://firebase.google.com/docs/reference/rest/auth)
- [Vercel Secret environment variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables)
- [unpdf PDF extraction](https://github.com/unjs/unpdf)
- [Vercel Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
