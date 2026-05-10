# R360 n8n Workflow Skeletons

These 17 n8n workflow JSON files are **skeletons** for the R360 lead-capture migration. Each contains the node tree, connection wiring, and Code node bodies copy-pasted from the build plan. Credentials are placeholders — bind at import time.

The build team's job: import, bind credentials, fine-tune polling intervals, run UAT tests. The skeletons save ~1 day of greenfield wiring.

## File inventory

```
n8n/
├── sub-normalize-payload.json              ~100 lines — Text Formatter FN (§6.1)
├── sub-r360-resolver.json                  ~250 lines — dedup + 4-path branch + ReQuery (§5.2-§5.4)
├── sub-r360-writer.json                    ~250 lines — 8 sub-paths + empty-key filter (§7.1-§7.6)
├── sub-convert-lead.json                    ~30 lines — HTTP convertLead (§2.2)
├── sub-notify.json                         ~120 lines — Slack DM + Gmail SMTP, 5 templates
├── sub-error-handler.json                  ~120 lines — Error Trigger + Inbound_Log + Slack page + retry escalation
├── receivers/
│   ├── wpform-r360-contact-form.json        ~80 lines — form 29710, full field map
│   ├── wpform-r360-watch-video.json         ~90 lines — form 29712, 15-min Wait, email-only
│   ├── wpform-r360-get-demo.json            ~80 lines — form 29714, 15-min Wait, email-only
│   ├── socialintents-r360-branch.json      ~150 lines — bot persona detection + normalization to WPForms shape
│   ├── webhook-pre-discovery-r360.json     ~250 lines — async pattern, 9-step API chain (§8)
│   └── wpform-r360-faq.json                 ~30 lines — form 33076, Google Sheets only
└── cron/
    ├── r360-wpforms-reconciliation.json    ~100 lines — every 10 min, MySQL poll, replay missing
    ├── r360-deadletter-replay.json          ~80 lines — every 5 min, retry failed rows
    ├── r360-daily-leadops.json              ~80 lines — 8am Central, daily report Slack post
    └── r360-parallel-run-reconciliation.json ~150 lines — hourly, Zapier-vs-n8n set diff, parallel-run only
```

**Total:** 16 workflows + this README, ~1,950 lines of JSON skeleton.

## Import procedure

For each environment (UAT, prod):

1. **n8n queue mode prerequisite** — confirm the n8n instance is running in queue mode with Redis + Postgres. The Pre-Discovery receiver requires async + worker pool. See `runbooks/pre-cutover-validation.md` §1.
2. Import each JSON file in order (sub-* first, receivers next, cron last):
   - Settings → Workflows → Import from File
3. Bind credentials by name (the JSON references `{{credential:NAME}}` placeholders):
   - `salesforce_uat` (or `salesforce_prod`) — OAuth2 to por-uat / por-prod with R360_n8n_Integration permission set
   - `slack_r360` — bot token for #r360-leads-* channels (different from POR Slack)
   - `gmail_smtp_marketing` — SMTP for marketing@pointofrental.com
   - `wp_db_readonly` — MySQL read-only on R360 WordPress DB (for reconciliation cron)
   - `perplexity_api` — Bearer token (HTTP Header Auth)
   - `apollo_api` — API key (HTTP Header Auth)
   - `openai_api` — OpenAI API key
   - `zapier_platform_api` — for parallel-run reconciliation cron (parallel-run window only)
   - `n8n_internal_api` — for parallel-run reconciliation cron
   - `google_sheets_marketing` — only for FAQ receiver
4. Bind environment variables:
   - `N8N_BASE_URL` — base URL of this n8n instance (e.g., `https://n8n-uat.por.internal`)
   - `WORKFLOW_ID_NORMALIZE` — sub-normalize-payload's workflow ID after import
   - `WORKFLOW_ID_R360_RESOLVER` — sub-r360-resolver's ID
   - `WORKFLOW_ID_R360_WRITER` — sub-r360-writer's ID
   - `WORKFLOW_ID_NOTIFY` — sub-notify's ID
   - `SLACK_CHANNEL_R360_DAILY` — `#r360-leads-daily` channel ID
   - `SLACK_CHANNEL_R360_ERRORS` — `#r360-leads-errors` channel ID
   - `SLACK_CHANNEL_R360_PARALLEL_RUN` — `#r360-leads-parallel-run` channel ID
5. Bind error workflow on every receiver + sub-* + cron:
   - Settings → Error Workflow → select `sub-error-handler`
6. Test imports by clicking "Execute Workflow" on each sub-workflow with a fixture payload.
7. Activate workflows individually:
   - sub-* first (must be active before receivers can call them)
   - receivers next (one-at-a-time during initial deploy)
   - cron last (start with reconciliation cron disabled; enable only after Day 0 readiness gate passes per `runbooks/pre-cutover-validation.md` §7)

## Per-workflow status / TODOs

Each JSON file's `meta.todo` array enumerates remaining wiring that the n8n developer must complete before activation:

- `sub-r360-resolver.json` — wire Find Lead/Contact to use generated leadQuery/contactQuery (NOT hardcoded WHERE); wire Switch outputs to Execute Workflow nodes calling sub-r360-writer
- `sub-r360-writer.json` — author 38-field Set node before A4b Create Lead; wire CampaignMember error fallback; **add `WORKFLOW_ID_CONVERT_LEAD` env var binding + Execute Workflow node** to call `sub-convert-lead` after a Lead-converting decision (currently `sub-convert-lead` is an **orphan** — valid + ready but no caller in this skeleton set)
- `sub-notify.json` — author 5 template strings; handle missing Slack_ID__c gracefully
- `socialintents-r360-branch.json` — pre-cutover validation of 3-location persona detection against ≥3 real R360 + 3 real POR conversations; **validate `$json.raw.tracking.*` paths for gclid/fbc/fbp/msclkid against a live SI payload** (spec doesn't enumerate them in Path K outbound — see build plan §9.2 note)
- `webhook-pre-discovery-r360.json` — author Set nodes for verbatim Perplexity prompt and ChatGPT R360 prompt; implement retry+backoff for Perplexity timeout
- `r360-parallel-run-reconciliation.json` — wire Merge node for 3 parallel inputs; loop over 7 zap IDs

### Orphan: `sub-convert-lead.json`

Valid, trigger-ready workflow that calls SF LeadConvert REST API. **Currently has no caller in this skeleton set.** Wire it in by:
1. Adding `WORKFLOW_ID_CONVERT_LEAD` env var (the workflow ID after import)
2. In `sub-r360-writer.json`, on a path that should convert a Lead (typically when an R360 Lead becomes Qualified mid-flow), add an `Execute Workflow` node referencing `$env.WORKFLOW_ID_CONVERT_LEAD`
3. Pass `{ leadId, LeadAccountId }` to it

## Redeploy procedure

When updating a workflow:

1. Export the workflow from n8n UI (Settings → Workflows → Export)
2. Diff against the file in this repo
3. Update the file in this repo, increment `versionId`
4. Commit to Ruflo
5. In the target environment: re-import (Settings → Workflows → Import from File, overwrite existing)
6. Verify credentials and env vars are still bound (n8n preserves these on overwrite-import in v1.x+)

## Validation

```bash
# Confirm all 16 JSON files are valid
for f in $(find . -name "*.json"); do jq empty "$f" || echo "INVALID: $f"; done

# Confirm no embedded production credentials (defense in depth — secrets should never be in JSON)
grep -rE 'sk-|xoxb-|AIza|0050L0|0014u00' .  || echo "No embedded creds — OK"
```

## See also

- Build plan: `migration-plans/r360-n8n-build-plan.md` — architecture reference
- Pre-cutover runbook: `../runbooks/pre-cutover-validation.md` — Day 0 readiness gate
- Parallel-run runbook: `../runbooks/parallel-run-validation.md` — 14-day prod parallel-run protocol
- SF metadata: `../sf-metadata/` — Lead_Inbound_Log__c object + 12 fields + perm set

---

## Live state (2026-05-10) — drift from repo to fix later

**Repo files diverged from live n8n.** When importing fresh, apply these patches that exist in the live workflows but NOT in the repo skeleton JSONs:

1. **SF customObject node parameter format** — repo skeletons use the wrong `additionalFields.fields.fieldsValues` structure. The correct n8n format is `customFieldsUi.customFieldsValues`. Verified by sampling existing workflows (Helpdesk Routed to Asana, WI-22446 Comment-DevOps-to-Salesforce).
2. **SF Update Lead_Inbound_Log__c (final state) and SF: Update Lead_Inbound_Log__c (failed)** — replaced with HTTP PATCH against `https://por--uat.sandbox.my.salesforce.com/services/data/v66.0/sobjects/Lead_Inbound_Log__c/{Id|Idempotency_Hash__c/{value}}`. n8n's customObject node doesn't expose upsert-by-external-id cleanly; HTTP REST is more reliable.
3. **Webhook receiver responseMode** — repo skeletons set `responseMode: "lastNode"`, which returns HTTP 500 if downstream branches end empty. Live workflows use `"onReceived"` for fire-and-forget receipts (Contact Form, Watch Video, Get a Demo, FAQ) and `"responseNode"` for the bot + Pre-Discovery (which need an explicit Respond to Webhook node).
4. **Pre-Discovery Apollo nodes** — `HTTP: Apollo enrich` and `SF Update Contact: MobilePhone (post-Apollo)` are `disabled: true` in the live workflow per v1 design decision.
5. **Slack channel IDs hardcoded** — env vars `SLACK_CHANNEL_R360_*` substituted with `C0AHXC6MXH6` (daily), `C02DJ9UVAET` (errors), `C06T48V2A0J` (parallel-run).
6. **Sub-workflow IDs** — env vars `WORKFLOW_ID_*` substituted with the actual created workflow IDs from `/tmp/r360-n8n-push-manifest.json`.

**To re-sync repo from live:** run `curl -H "X-N8N-API-KEY: $KEY" "$API/workflows/$WF_ID"` for each, save to the corresponding file path, strip the runtime metadata fields (`updatedAt`, `createdAt`, `versionId`, etc.). A formal sync script is a v2 item.

## Smoke-test verification (2026-05-10)

End-to-end verified against `por-uat`:
- POST to `https://n8nweb.ec-ops.org/webhook/r360/contact-form` returns HTTP 200 in <400ms
- Lead_Inbound_Log__c row created with all picklist values populated correctly: Source__c=`wpform_29710`, Status__c=`received`
- Idempotency proven: re-POSTing the same `entry_id` keeps the row count at 1 (upsert by SHA-256(form_id + ":" + entry_id))
- Distinct entries get distinct hashes and distinct rows

**Known gap:** the resolver's Switch outputs (paths B/C/D and the ReQuery 5-path Switch) go to empty branches in the skeleton, so the writer doesn't actually receive the resolver's decision and Status__c stays at `received` indefinitely. Wiring the resolver-to-writer hand-off requires explicit Set nodes that propagate `decisionPath`, `leadId`, `contactId`, `accountStatus`, etc. to the writer's expected input shape. Tracked as a v1.1 follow-up.
