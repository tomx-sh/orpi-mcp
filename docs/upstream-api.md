# Verified Neotimm read API

Base: `https://extranet-4c-kd4tnagsqa-ew.a.run.app`, discovered from the website's `/getEnv.php` configuration. Routes were recovered from the website's JavaScript and independently called using the configured owner's account. No credentials or personal response payloads are recorded here.

The wrapper sends a Firebase ID token in `Authorization: Bearer ...`, plus `x-status: 1` and the selected business account in `x-acteur` when applicable. Firebase UID and business actor ID are distinct. Requests omit cookies and disable redirects and response caching.

| Endpoint | Method | Observed result |
| --- | --- | --- |
| `/acteur/role` | GET | Accessible business accounts; `acteur_id` selects one |
| `/role/liste?acteurId={actorId}` | GET | Property roles; `ms_role_id` and `ms_role_aid_immeuble` provide role/property IDs |
| `/role/fiche/{roleId}/{actorId}/false` | GET | Account summary, accounting, lots, contacts, contracts, visibility flags |
| `/document/categorie` | POST | Category or document listing, depending on the request body |
| `/ged/buffer/{documentId}/{actorId}` | GET | Original PDF bytes, HTTP 200 with `application/pdf` |
| `/demande/extranet/{actorId}` | GET | Existing requests; empty array for the tested account |
| `/dossiers/{roleId}` | GET | Existing dossiers; empty array for the tested role |
| `/exercice/{propertyId}` | GET | Three financial-year periods, including budgets and actual spending |
| `/role/fiche/{roleId}/{actorId}/true` | GET | Council summary with invoices, quotes, work orders, budgets |
| `/ag/{propertyId}/{actorId}` | GET | General meetings with dates, status, document references, voting eligibility flags |
| `/ag/factures/{propertyId}` | GET | Invoice-control exercises, including works |
| `/ag/validation/{encodedJson}` | GET | Detailed invoice-control data for a verified exercise |
| `/balance/{period}/{propertyId}` | GET | Raw hierarchical balance rows for precedent/courant/suivant |
| `/balance_detail` | POST | Read entries behind a verified balance account |
| `/document/dossier/tache/{roleId}/{id}/{DOSSIER-or-TACHE}` | GET | Dossier/task attachments; membership is checked against the role's dossier tree |

All implemented calls are reads. Document listing uses POST because that is the site's read API contract. GET on `/document/categorie` returns 404.

## Document listing

```json
{
  "pu_roleid": "<verified role ID>",
  "pb_collective": true,
  "pb_individuel": true,
  "pb_cs": false,
  "pb_liste_template": true
}
```

Set `pb_cs` from the role summary's `mb_membre_cs` boolean; never infer council membership from a caller-supplied flag. For category discovery, `pb_liste_template` is true. Records have `ms_template_id` and `ms_template_nom`. Categories can exist without any documents.

For documents, set `pb_liste_template` to false and add `pau_templates: [templateId]`. Individual-only scope sets collective false; collective-only scope sets individual false. Documents include:

- `ms_gedid`: document identifier used in the PDF route.
- `ms_ged_nom`, `ms_doc_titre`, `md_ged_date`: display names and date.
- `ms_template_id`, `ms_template_nom`: category.
- `ms_type_cible`: individual/collective target.
- `mo_labels`: label metadata.

Verified both individual calls for funds and collective signed meeting minutes. The wrapper validates the selected category against the selected role and scope and validates the document against that category's returned list. It never forwards a caller-supplied remote URL.

## Budgets and council information

Financial-year records include `ms_exer_libelle`, `ms_periode`, `md_periode_debut`, `md_periode_fin`, `mo_budget`, `mo_jauges`, and `mo_tableaux`. The latter contains expense-class budgets, actual invoices, quantities, and nested details. The wrapper requires `mb_visibilite_budgets === true` before requesting these records.

Council access requires `mb_membre_cs === true`. The observed response includes 30 invoices, five quote requests, four work orders, and budget totals. It is returned as upstream data without modifying invoice approval state.

Meetings include `mu_ag_id`, titles, dates, location, status, and `mo_liste_document` entries with `ms_ged_id` and `ms_nom_fichier`. Eligibility flags are informational; the MCP does not implement voting or attendance changes.

## Verification limits

The initial 12-tool expansion passed live checks through the local production build with fresh password authentication; the consultation/CSV expansion adds seven tools for a total of 19. The PDF parser and attachment bytes were checked in that same process. Requests and dossiers were verified only as empty lists for this account, so richer records are intentionally passed through without an invented schema. The API is undocumented and can change independently of this project. Upstream authorization remains the final authority.

## Detailed council consultation

Invoice-control exercise IDs come from `/ag/factures/{propertyId}`. The detail URL encodes `{"coproaid":"<verified property>","reprise":0,"exerid":"<verified exercise>"}` as one path segment. The response is an array; select `ms_exer_code` matching the requested exercise. Flatten `ms_exer_info → ms_chapitre_info → ms_rubrique_info → ms_nature_info` to invoice lines while retaining chapter/rubric/nature labels. These include supplier, date, VAT, TTC, validation/report status and `ms_gedid`. Only reading is implemented.

Balance details derive `ptab_comptes` from a returned row's `ms_databal_compteid`, never directly from caller input. Dates come from the verified period record. The body matches the site's read request: `pb_avec_annulation:true`, `pb_avec_noneditable:false`, `pb_avec_solde_anterieur:true`, `pb_extranet:true`, and `pn_nombre:30`. `pb_sans_450` is true for codes 4501–4505. The site performs additional display grouping; MCP balance output exposes raw hierarchical rows, without recomputing monetary totals.

Documents can originate outside the category list. The wrapper follows only known GED-ID fields in verified invoice-control lines, balance entries, meeting documents, account/council summaries, requests and dossiers/tasks. A selected document must still be returned by that origin when its PDF is fetched. No external `ms_url_drive`/other arbitrary URL is fetched.

## Grand ledger backend

Base: `https://ws-4c-kd4tnagsqa-ew.a.run.app`. The separate `/grand-livre/` frontend authenticates with the same Firebase ID token in extranet mode.

- GET `/grandlivre/exercices/{propertyId}` lists `mu_exer_id`, `md_exer_date_debut`, `md_exer_date_fin` and titles. `mb_courant` is a string in the observed response.
- POST `/grandlivre/archivagesyndic/0` generates the preview used for consultation and CSV. The wrapper always sets `avecged:0` and uses template `d623df76-5672-4e60-8220-f2bfb6e7e1c7`. It never calls archive/mail modes.
- Body: verified `mandant` and `exerid`, `DATE_DEBUT`/`DATE_FIN` as YYYYMMDD, optional `classe`, `compte_code` and `code_tiers` filters. Date ranges must remain inside the selected exercise.
- The response is `[base64Pdf, jsonString]`. Parse the second item to get `mo_general` metadata and `mo_journaux` account groups with `mo_ecritures`. The site generates its CSV in JavaScript from this data.
- The website's grand-ledger enablement flag is `/parametrage/extranet/51`. The wrapper requires it and council membership. Invoice/balance views additionally require their corresponding base-summary visibility flag.

Live direct verification found six invoice exercises, 33 invoice lines in the selected current exercise, 45/61/37 balance rows for previous/current/next periods, five ledger exercises, and a 42,198-byte ledger PDF containing 14 pages. Invoice PDFs outside category browsing were also fetched and parsed. PDF preview generation is an authorized read operation; invoice validations, reports, attendance, votes, and fiscal settings were not changed.

The “Facture électronique” tab was inspected: it exposes a fiscal-settings form, not an additional document listing. Dossier/task and request attachments could not be exercised with non-empty account data because those lists are empty; their membership checks have isolated tests based on the frontend's `dossier_id`, `mo_liste_tache[].f2`, and `mo_ged[].ged_id` contracts.
