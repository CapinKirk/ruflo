# R360 / POR Manual Replay & Remediation Tools

**Purpose:** Operational reference for three utility n8n workflows built during the R360/POR migration. When a real form submission either fails to write to Salesforce (Zapier bug, n8n error, etc.) or needs to be re-processed for debugging, this runbook tells you exactly which tool to use, how to invoke it, and what to expect downstream.

**Owner:** RevOps engineer or SF Admin.

**Companion docs:**
- Build plan: `../../migration-plans/r360-n8n-build-plan.md`
- Pre-cutover runbook: `pre-cutover-validation.md`
- Parallel-run runbook: `parallel-run-validation.md`
- Audit script: `scripts/audit-lead-capture.sh`

---

## When to use which tool

| Situation | Target org | Known identifier | Use |
|---|---|---|---|
| Debugging why UAT shadow processed a submission a certain way | UAT only | Email | Tool 1 |
| Backfilling a UAT shadow submission that was lost mid-flight | UAT only | Email | Tool 1 |
| Remediating a real lead that Zapier failed in PROD | PROD | `entry_id` or Email | Tool 2 |
| Checking which Salesforce user the n8n PROD credential authenticates as | N/A (diagnostic) | None | Tool 3 |

**Decision rule:**
- If you are writing to PROD Salesforce — Tool 2. No exceptions.
- If you are writing to UAT Salesforce (shadow investigation) — Tool 1.
- If you are diagnosing a credential identity question — Tool 3.

Always run Tool 1 against UAT FIRST when you plan to use Tool 2. Confirm the resolver selects the right path before you fire into prod.

---

## Tool 1: Manual Replay by Email (UAT)

### Purpose

Re-fire UAT shadow processing for any WPForm entry. Queries the WordPress DB by email address, then POSTs each matching entry back through the UAT receiver (`/r360/contact-form`). Useful when:

- A real-time webhook failed mid-flight AND the dead-letter cron didn't catch it.
- You want to debug why shadow processing decided a specific path for a specific submission.
- You are testing resolver / writer logic changes against a real-world payload without touching prod data.

**This tool writes ONLY to UAT Salesforce.** It will NOT affect production Lead, Contact, or Inbound_Log records.

### Workflow details

| Field | Value |
|---|---|
| n8n workflow ID | `Rs0F5BLsyzVih8V4` |
| n8n webhook URL | `https://n8nweb.ec-ops.org/webhook/r360-manual-replay` |
| Target org | UAT (`por-uat`) |

### Inputs

POST body with a single field:

```json
{"email": "person@example.com"}
```

The workflow queries `wp_wpforms_entries` for the most recent 1-5 entries matching that email across ALL form IDs. It does not filter by `form_id` — if the person submitted multiple R360 forms (Contact Form + Get a Demo), you may get up to 5 replays.

### How to invoke

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"email": "person@example.com"}' \
  https://n8nweb.ec-ops.org/webhook/r360-manual-replay
```

Replace `person@example.com` with the submitter's actual email address.

### Example — debug a specific lost shadow submission

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"email": "kirk@enterprise-rental.com"}' \
  https://n8nweb.ec-ops.org/webhook/r360-manual-replay
```

Expected response on success: HTTP 200. The workflow immediately launches a background execution — the 200 only confirms the webhook received the payload, not that the downstream write completed. Check results in n8n (§ Where to check results).

### What happens downstream

1. Workflow queries `wp_wpforms_entries` for up to 5 entries matching the email (ORDER BY `date_created DESC`).
2. For each entry, it determines the appropriate UAT receiver based on `form_id` and POSTs the full WP entry payload to `/r360/contact-form` (UAT endpoint).
3. The UAT receiver chain runs: resolver → writer → sub-notify (UAT). Standard shadow processing — same logic as a live real-time webhook.
4. Writer upserts Lead/Contact in UAT and creates/updates a `Lead_Inbound_Log__c` row. If the `Idempotency_Hash__c` already exists (prior shadow write landed), the row is marked `Status__c = 'replayed_duplicate'` and the Lead/Contact is not touched again. This is safe to re-run.

### Where to check results

**n8n execution log:**

Navigate to `https://n8nweb.ec-ops.org` → Executions → filter by workflow `Rs0F5BLsyzVih8V4`. The execution's output nodes show what the WP DB returned and what the receiver accepted.

**UAT Salesforce — Lead_Inbound_Log__c:**

```
sf data query \
  --target-org por-uat \
  -q "SELECT Id, Name, Status__c, Source__c, External_Submission_Id__c, n8n_Execution_Id__c, Error_Message__c \
      FROM Lead_Inbound_Log__c \
      WHERE CreatedDate = TODAY \
      ORDER BY CreatedDate DESC \
      LIMIT 10"
```

Match `n8n_Execution_Id__c` to the execution ID you saw in the n8n log.

**UAT Salesforce — Lead:**

```
sf data query \
  --target-org por-uat \
  -q "SELECT Id, FirstName, LastName, Email, Status, OwnerId \
      FROM Lead \
      WHERE Email = 'person@example.com' \
      ORDER BY CreatedDate DESC \
      LIMIT 5"
```

### Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| HTTP 200 but no new Inbound_Log row | Entry email not found in WP DB, or WP DB connection down | Check n8n execution log for the WP DB query node output; verify WP DB credentials in n8n |
| Inbound_Log row with `Status__c = 'replayed_duplicate'` | Idempotency hash already existed (prior run landed) | Expected — the lead is already in UAT SF. Query Lead by email to confirm. |
| Inbound_Log row with `Status__c = 'failed'` and an error message | Writer error (FLS gap, validation rule, etc.) | Check `Error_Message__c` on the log row; fix the underlying issue; re-run the tool |
| Multiple Inbound_Log rows created | Person submitted more than one R360 form | Expected — tool replays up to LIMIT 5 entries |

---

## Tool 2: PROD Lead Remediation Loader

### Purpose

Re-process a specific WPForm entry into **production Salesforce**. Used when Zapier failed to write a real lead (task error, timeout, partial write) and the existing prod Lead or Contact needs to be brought to the state the n8n integration would have produced.

**This tool writes to PROD Salesforce.** Treat it with the same caution as a manual data load script. Read the PROD warnings section before invoking.

### Workflow details

| Field | Value |
|---|---|
| n8n workflow ID | `3DJyRIYqpG89f8r5` |
| n8n webhook URL | `https://n8nweb.ec-ops.org/webhook/r360-prod-oneoff` |
| Target org | PROD (`por-prod`) |
| Credential | `[SF Integration User] PROD` (cred ID `x11R2LzrMkyi8UnN`) |
| Running as | POR Integration user (`sfintegration@pointofrental.com`, `0050L00000822fcQAA`) |

**Sub-workflows called:**
- `R360 Sub: Resolver (PROD 1-off)` — workflow ID `CcKJlCMdNXi49qQR`
- `R360 Sub: Writer (PROD 1-off)` — workflow ID `y8ewU4PRMB3xiC1a`

These are production-pointed clones of the UAT resolver/writer with credentials and base URLs swapped. They do NOT call sub-notify — no Slack pings to AEs for remediation loads (intentional).

### Inputs

POST body with either `entry_id` or `email`. If both are provided, `entry_id` wins.

**Preferred — by entry_id (most precise):**

```json
{"entry_id": "1261"}
```

**Fallback — by email (queries most recent WP entry for that email):**

```json
{"email": "person@example.com"}
```

`entry_id` values come from `wp_wpforms_entries.entry_id` (bigint). You can find them in WP Admin → WPForms → Entries, or by querying the WP DB directly.

### How to invoke

**By entry_id (recommended):**

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"entry_id": "1261"}' \
  https://n8nweb.ec-ops.org/webhook/r360-prod-oneoff
```

**By email:**

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"email": "michael.stafford@rpmd.com"}' \
  https://n8nweb.ec-ops.org/webhook/r360-prod-oneoff
```

### What happens downstream

1. Workflow queries `wp_wpforms_entries` using the supplied identifier.
2. Resolver runs the standard path-selection logic (Path A: new lead / Path B: existing lead update / Path C: contact update, etc.) against PROD SF.
3. Writer upserts the Lead or Contact in PROD SF with the full POR/R360 field set.
4. Writer creates a `Lead_Inbound_Log__c` row in PROD SF.
5. `CampaignMember` add runs (if the entry maps to a campaign). Duplicate CampaignMember adds fail silently with `onError: continueRegularOutput` — re-running the same entry will NOT create a second CampaignMember.
6. Sub-notify is NOT called — no AE Slack DM or email fires from a remediation load. If the AE needs to know, notify them manually.

### Where to check results

**n8n execution log:**

Navigate to `https://n8nweb.ec-ops.org` → Executions → filter by workflow `3DJyRIYqpG89f8r5`. The resolver sub-execution and writer sub-execution are nested calls — check all three executions (orchestrator + resolver + writer) to trace the full chain.

**PROD Salesforce — Lead_Inbound_Log__c:**

```
sf data query \
  --target-org por-prod \
  -q "SELECT Id, Name, Status__c, Source__c, External_Submission_Id__c, n8n_Execution_Id__c, Error_Message__c \
      FROM Lead_Inbound_Log__c \
      ORDER BY CreatedDate DESC \
      LIMIT 5"
```

**PROD Salesforce — Lead (verify update applied):**

```
sf data query \
  --target-org por-prod \
  -q "SELECT Id, FirstName, LastName, Email, Status, Company, \
             R360_Product__c, POR_Product__c, LeadSource \
      FROM Lead \
      WHERE Email = 'person@example.com' \
      ORDER BY CreatedDate DESC \
      LIMIT 3"
```

**Real-world reference:** Entry 1261 (Michael Stafford, RPMD) was remediated on 2026-05-17. Zapier failed the original update→convert step. Tool 2 pulled the WP entry, resolver found the existing prod Lead `00Qan00000mYOZ3EAO`, ran Path B (Lead update), and the writer applied the full POR/R360 field set. Inbound_Log row `LIL-0000000` created in PROD. Use that execution as a reference in the n8n log.

### Recommended usage pattern

1. **Locate the entry.** Find the `entry_id` in WP Admin → WPForms → Entries, or from the failed Zapier task's payload.
2. **Fire Tool 1 first.** Run the same entry (by email) through Tool 1 against UAT. Confirm the resolver chose the correct path and the writer produced the expected SF field values in UAT.
3. **Confirm UAT result.** Query `Lead_Inbound_Log__c` in UAT to verify `Status__c = 'written'` and the Lead fields look correct.
4. **Fire Tool 2.** Once UAT validation passes, fire Tool 2 with the `entry_id` against PROD.
5. **Verify PROD result.** Check `Lead_Inbound_Log__c` in PROD and the Lead/Contact record for the expected field values.
6. **Notify AE manually** if they need to act on the remediated lead (Tool 2 does not send sub-notify).

### PROD warnings

- There is no rate limiting on this webhook. Do NOT loop-invoke it against large batches of entries. For bulk remediation (>10 entries), contact RevOps lead to design a controlled replay approach.
- The webhook URL is unauthenticated. Anyone with the URL can fire a prod write. Do not share it in public channels.
- Each invocation creates a PROD `Lead_Inbound_Log__c` row. These are permanent audit records — they are intentional, not side effects to work around.
- Plauti DupCheck is bypassed at the field level (`dupcheck__dc3DisableDuplicateCheck__c = true`) — the integration user's FLS grants this. The resolver's fuzzy-match logic handles dedup; Plauti DupCheck provides a fallback layer at the SF side (build plan §15).

### Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| HTTP 200 but no Inbound_Log row in PROD | Resolver threw an exception before the writer ran | Check resolver sub-execution in n8n log for error output |
| Inbound_Log row with `Status__c = 'replayed_duplicate'` | Entry was already written to PROD by the original Zapier task (partially succeeded) | The existing record is correct — no further action. Verify Lead/Contact fields manually. |
| Inbound_Log row with `Status__c = 'failed'` | Writer error (FLS gap, validation rule, required field null) | Check `Error_Message__c`; fix the root cause; re-invoke Tool 2 |
| Wrong resolver path selected (e.g., Path A when you expected Path B) | Email not matching existing Lead/Contact in prod | Query prod for the record by `entry_id` email to confirm the record exists and the email matches exactly (case-sensitive in the resolver's SOQL) |

---

## Tool 3: whoami probe

### Purpose

Identify which Salesforce user a given n8n credential authenticates as. Used during cutover diagnostics — e.g., "the PROD cred isn't writing — which user is it actually running as?" Confirms the credential is correctly pointed at the expected integration user before attempting a prod remediation.

### Workflow details

| Field | Value |
|---|---|
| n8n workflow ID | `iqDwXDw4FqNRCNEy` |
| n8n webhook URL | `https://n8nweb.ec-ops.org/webhook/r360-whoami` |
| Current behavior | Hardcoded to query PROD cred `x11R2LzrMkyi8UnN` |

### Inputs

Empty POST body:

```json
{}
```

### How to invoke

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{}' \
  https://n8nweb.ec-ops.org/webhook/r360-whoami
```

### What happens downstream

The workflow calls Salesforce `/services/oauth2/userinfo` using the PROD credential. Returns the OAuth identity of that credential.

### Example output

```json
{
  "user_id": "0050L00000822fcQAA",
  "name": "POR Integration",
  "email": "sfintegration@pointofrental.com",
  "preferred_username": "sfintegration@pointofrental.com"
}
```

If the output matches the expected integration user, the credential is correctly configured. If you see an unexpected user (e.g., a personal user account), the credential binding in n8n is wrong and must be fixed before any prod remediation.

### Where to check results

The JSON response is returned inline in the HTTP response body — no separate lookup needed. If the response is an error (401, 400), the OAuth token may be expired or the credential misconfigured in n8n. Refresh the credential via n8n UI → Credentials → `[SF Integration User] PROD` → reconnect.

### Customizing for other credentials

As built, Tool 3 probes only the PROD cred (`x11R2LzrMkyi8UnN`). To check a different credential (e.g., the UAT cred, or a future second integration user):

1. In n8n, duplicate workflow `iqDwXDw4FqNRCNEy`.
2. In the duplicated workflow, find the Salesforce HTTP Request node that calls `/services/oauth2/userinfo`.
3. Swap the credential binding to the credential you want to probe.
4. Activate the duplicated workflow on a new webhook path (e.g., `/r360-whoami-uat`).
5. Invoke the new webhook.

Do not modify the original workflow — it serves as the canonical PROD probe.

---

## Common scenarios

### Scenario A: "Zapier failed this lead in prod — fix it"

This is the primary use case for Tool 2.

**Step 1 — Identify the WP entry.**

Find the `entry_id` from the failed Zapier task payload, or look it up in WP Admin → WPForms → Entries → search by email. Note the `entry_id` integer.

**Step 2 — Verify the credential is correct (optional but recommended for first use).**

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{}' \
  https://n8nweb.ec-ops.org/webhook/r360-whoami
```

Confirm the response shows `sfintegration@pointofrental.com`. If not, fix the PROD credential binding in n8n before proceeding.

**Step 3 — Test against UAT first.**

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"email": "failed.lead@theircompany.com"}' \
  https://n8nweb.ec-ops.org/webhook/r360-manual-replay
```

Query UAT `Lead_Inbound_Log__c` and the Lead record to confirm correct resolver path and field values.

**Step 4 — Fire against PROD.**

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"entry_id": "1261"}' \
  https://n8nweb.ec-ops.org/webhook/r360-prod-oneoff
```

**Step 5 — Verify PROD results.**

```
sf data query \
  --target-org por-prod \
  -q "SELECT Id, Name, Status__c, n8n_Execution_Id__c, Error_Message__c \
      FROM Lead_Inbound_Log__c \
      ORDER BY CreatedDate DESC \
      LIMIT 3"
```

Check `Status__c = 'written'`. Query the Lead/Contact for updated field values.

**Step 6 — Notify the AE manually** (Tool 2 does not send sub-notify). Slack the AE with the remediated lead's name, company, and SF record link.

---

### Scenario B: "Why did UAT shadow process this submission as Path X?"

This is the primary use case for Tool 1.

**Step 1 — Identify the email address** from the WPForms entry or your Inbound_Log query.

**Step 2 — Fire Tool 1.**

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"email": "person@theircompany.com"}' \
  https://n8nweb.ec-ops.org/webhook/r360-manual-replay
```

**Step 3 — Pull the n8n execution.**

Go to `https://n8nweb.ec-ops.org` → Executions → filter by workflow `Rs0F5BLsyzVih8V4`. Open the execution and step through the resolver node outputs. The Code node in the resolver emits a `resolved_path` field in its output — this tells you which branch was selected and why.

**Step 4 — Cross-reference in UAT SF.**

```
sf data query \
  --target-org por-uat \
  -q "SELECT Id, Status__c, Source__c, Resolver_Path__c, n8n_Execution_Id__c, Error_Message__c \
      FROM Lead_Inbound_Log__c \
      WHERE CreatedDate = TODAY \
      ORDER BY CreatedDate DESC \
      LIMIT 5"
```

If the wrong path was taken (e.g., Path A new-lead instead of Path B update), investigate whether the UAT SF org has the matching Lead/Contact by email. UAT data may differ from prod — this is a common source of path divergence during debugging.

---

### Scenario C: "Cutover: which user does our prod n8n cred authenticate as?"

This is the primary use case for Tool 3.

**Step 1 — Invoke the probe.**

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{}' \
  https://n8nweb.ec-ops.org/webhook/r360-whoami
```

**Step 2 — Verify the response.**

Expected:

```json
{
  "user_id": "0050L00000822fcQAA",
  "name": "POR Integration",
  "email": "sfintegration@pointofrental.com",
  "preferred_username": "sfintegration@pointofrental.com"
}
```

**Step 3 — If the response shows a different user:**

The n8n credential `x11R2LzrMkyi8UnN` (`[SF Integration User] PROD`) is either bound to the wrong OAuth app or the token has been refreshed under a different user's session. Resolve in n8n → Credentials → reconnect using the correct connected app and the `sfintegration@pointofrental.com` service account credentials.

**Step 4 — If the response returns a 401 or empty body:**

The credential's access token is expired and n8n failed to refresh it. Re-authenticate the credential in n8n UI. After reconnecting, re-run the probe to confirm.

**Step 5 — After confirming the correct user,** proceed with any planned prod remediation (Tool 2) or cutover activity.

---

## Audit / Logging

Every Tool 1 and Tool 2 invocation creates one or more `Lead_Inbound_Log__c` rows:

| Tool | Org | Object |
|---|---|---|
| Tool 1 (UAT replay) | `por-uat` | `Lead_Inbound_Log__c` |
| Tool 2 (PROD remediation) | `por-prod` | `Lead_Inbound_Log__c` |

Each row includes:

- `n8n_Execution_Id__c` — links back to the specific n8n execution for full trace
- `Status__c` — `written`, `replayed_duplicate`, or `failed`
- `Error_Message__c` — populated on failures
- `Source__c` — identifies the WPForm source (`wpform_29710`, `wpform_29712`, etc.)
- `External_Submission_Id__c` — the WP `entry_id`

**To find the n8n execution from an Inbound_Log row:**

1. Note the `n8n_Execution_Id__c` value from the SF row.
2. Open n8n at `https://n8nweb.ec-ops.org` → Executions → search by execution ID.

As of 2026-05-17, PROD has one Inbound_Log row: `LIL-0000000` (entry 1261, Michael Stafford, RPMD). This is the baseline row confirming Tool 2 has been exercised in production.

---

## Safety notes

**No rate limiting on Tool 2.** The PROD webhook accepts unlimited invocations. Do not batch-replay large sets of entries through it without coordinating with the RevOps lead first. For bulk remediation, design a controlled replay using the WP DB query + Tool 2 calls spaced apart.

**Unauthenticated webhook endpoints.** All three webhook URLs (`/r360-manual-replay`, `/r360-prod-oneoff`, `/r360-whoami`) have no auth header requirement in the current implementation. They rely on URL obscurity. Before sharing these URLs beyond the RevOps/SF Admin team or adding them to any public documentation, add an `Authorization` header check in the n8n webhook node's authentication settings.

**CampaignMember duplicate adds are silently no-ops.** Tool 2's PROD writer has `onError: continueRegularOutput` on the CampaignMember upsert node. Re-running the same entry multiple times will NOT create duplicate CampaignMember rows. This is intentional — idempotent remediation.

**No AE notification from Tool 2.** The PROD orchestrator does not call sub-notify. Zapier's existing AE notification already fired for the original submission (or was the thing that failed). Duplicate Slack DMs to AEs for remediation activity would cause confusion. Notify AEs manually when appropriate.

**UAT data divergence.** UAT SF and PROD SF do not share the same Lead/Contact records. A path decision that looks wrong in UAT (e.g., Path A new-lead when you expected Path B) may be correct in PROD where the record already exists. Always confirm PROD state before concluding there is a resolver bug.

**Plauti DupCheck fallback.** The resolver's fuzzy email-match handles the primary dedup. SF-side Plauti DupCheck provides a secondary catch for cases the resolver misses (build plan §15). A re-run through Tool 2 will hit Plauti DupCheck on the PROD side — the `dupcheck__dc3DisableDuplicateCheck__c = true` field suppresses the blocking check but does not suppress Plauti's logging.
