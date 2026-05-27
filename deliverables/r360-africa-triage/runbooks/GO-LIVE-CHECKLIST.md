# Go-Live Checklist — R360 Africa Triage

**Status:** Code complete · Reviewer pass clean · Smoke approved · n8n deploy is manual UI work.

Execute in this exact order. Each step has its own checkbox so you can pause and resume.

## Pre-flight (verify before touching n8n)

- [ ] Both Slack DMs delivered: yours (`ts 1779853276.893579`) + Dean's (`ts 1779885150.990699`)
- [ ] Webhook click rendering correctly (dark mode + rocket animation)
- [ ] Regression test passes: `node deliverables/r360-africa-triage/tests/regression-test.mjs`
- [ ] You have admin access to n8n at `https://n8nweb.ec-ops.org`

---

## Step 1 — Import the triage workflow

1. Open https://n8nweb.ec-ops.org
2. Workflows → top right → **Import from File**
3. Select `/Users/prestonharris/Claude-Codex/Ruflo/deliverables/r360-africa-triage/n8n/sub-r360-africa-triage.json`
4. After import, **copy the new workflow ID** from the URL bar (it will be 16 chars like `Hx2Zi7z2rKoqKSSE`). Save it here: `_________________`

---

## Step 2 — Bind credentials in the imported triage workflow

Open the imported workflow. Three Salesforce nodes + three HTTP/Slack nodes need creds.

**Salesforce nodes** (currently bound to `[RH] UAT` placeholder):
- [ ] `SF Upsert: Lead_Inbound_Log__c (africa_pending)` → bind to **`[RH] PROD`** (xcaUlnMRl2TUlXiK per CLAUDE.md)
- [ ] `SF Update: Lead_Inbound_Log__c (decision)` → bind to **`[RH] PROD`**

**Slack HTTP nodes** (currently `SLACK_CREDENTIAL_PLACEHOLDER`):
- [ ] `Slack: DM Dean Hammond` → bind to the n8n Slack credential (the same one your other R360 workflows use — check `sub-notify` for the credential ID)
- [ ] `Slack: DM Kirk Bennett` → same Slack credential
- [ ] `Slack: notify channel (visibility-only)` → same Slack credential
- [ ] `Slack: notify channel (decision)` → same Slack credential

> Need to find the Slack cred ID? Open any node in `sub-notify` (workflow ID `Hx2Zi7z2rKoqKSSE`) that posts to `chat.postMessage` and copy the credential it uses.

---

## Step 3 — Set workflow settings on the triage workflow

In the triage workflow:

- [ ] Settings → **Error Workflow** → select `sub-error-handler`
- [ ] Settings → **Execution Timeout** → 24 hours (86400 seconds)
- [ ] Settings → **Save execution data** → enable (already set in JSON, verify in UI)

---

## Step 4 — Activate the triage workflow

- [ ] Toggle the workflow to **Active** (top right). This MUST be done before re-importing the resolver, because the resolver will call into this workflow immediately.

---

## Step 5 — Re-import the modified resolver

1. Open the existing `R360 Sub: Resolver` workflow (id `B5TE8DaCbbMqZatD`)
2. Workflows → ⋯ → **Import from File** → overwrite
3. Select `/Users/prestonharris/Claude-Codex/Ruflo/deliverables/r360-n8n-migration/n8n/sub-r360-resolver.json`
4. n8n will preserve existing credentials. Verify by spot-checking `SF HTTP: Find Lead` is still bound to PROD.
5. **Find the new node** `Execute: sub-r360-africa-triage` (it'll be in the top-right area of the canvas, since position is `[2100, 100]`)
6. Click it → in the workflow picker, select the triage workflow you imported in Step 1 (the one whose ID you saved). This replaces `AFRICA_TRIAGE_PLACEHOLDER`.
7. **Save** (Cmd+S)

---

## Step 6 — Pre-activation smoke (UAT-style, but in PROD)

Before sending a real Africa form fill, verify the wiring with a manual execution:

- [ ] Open the resolver workflow
- [ ] Right-click the `When Executed by Another Workflow` trigger → **Execute Node** with pinned data:

```json
{
  "Idempotency_Hash__c": "GOLIVE-SMOKE-001",
  "source": "wpform_29710",
  "BusinessEmail": "kirk.bennett+africasmoke@pointofrental.com",
  "formattedFirst": "Kirk",
  "formattedLast": "AfricaSmoke",
  "formattedEmail": "kirk.bennett+africasmoke@pointofrental.com",
  "formattedCompany": "Go-Live Smoke Test",
  "formattedCountry": "South Africa",
  "formattedRegion": "Africa",
  "WPFormName": "ContactForm",
  "Received_At__c": "2026-05-27T12:00:00Z",
  "Payload__c": "{}"
}
```

- [ ] Verify: Slack DM arrives in your inbox AND Dean's, with subject "🌍 Africa lead — human triage required"
- [ ] Verify: a `Lead_Inbound_Log__c` row exists in PROD with `Idempotency_Hash__c=GOLIVE-SMOKE-001` and `Status__c=africa_pending`
- [ ] **Click "Kill"** on your DM (we don't want to actually route a fake lead to MQL)
- [ ] Verify: the `Lead_Inbound_Log__c` row updates to `Status__c=africa_killed`
- [ ] Verify: no Lead/Contact was created in PROD SF for `kirk.bennett+africasmoke@pointofrental.com`

If any check fails → **deactivate the triage workflow immediately** and we'll debug. Rollback steps in `runbooks/README.md`.

---

## Step 7 — Active monitoring (first 24h post-cutover)

After Step 6 passes:

- [ ] Note the time. Watch `#marketing-lead-errors` for the next 24h.
- [ ] Spot-check `Lead_Inbound_Log__c` rows where `formattedRegion='Africa'` daily for the first week.
- [ ] If ANY non-Africa region's behavior changes (latency, missing notifications, wrong queue), deactivate the triage workflow — that would mean the IF: Africa triage? FALSE branch is misrouting, which is the highest-stakes regression to watch.

---

## Step 8 — Cleanup

After 24h with no issues:

- [ ] Delete the smoke `Lead_Inbound_Log__c` row (`GOLIVE-SMOKE-001`) if you don't want it lingering in reports
- [ ] Optional: open a PR on the local feature branch once you have a writable remote (the upstream `ruvnet/ruflo` is read-only for your account)

---

## Quick reference

| Item | Value |
|---|---|
| Triage workflow file | `deliverables/r360-africa-triage/n8n/sub-r360-africa-triage.json` |
| Resolver patch file | `deliverables/r360-n8n-migration/n8n/sub-r360-resolver.json` |
| Existing resolver ID | `B5TE8DaCbbMqZatD` |
| Existing sub-notify ID (for Slack cred lookup) | `Hx2Zi7z2rKoqKSSE` |
| Dean Slack ID | `U0135HAS0KA` |
| Kirk Slack ID | `U02HR1T6PBK` |
| Marketing-lead-errors channel | `C06TTMZB3RA` |
| Webhook smoke URL (now disposable) | `https://webhook.site/ecce62b5-31f8-4fdd-b915-268f86256625` |
| Regression test | `node deliverables/r360-africa-triage/tests/regression-test.mjs` |

## Rollback (any time)

1. n8n: Deactivate `sub-r360-africa-triage`
2. n8n: Edit resolver → open `IF: Africa triage?` → set condition right-value to something never-matched (e.g., `__DISABLED__`) → save. All Africa leads now fall through the FALSE branch and route normally.
3. To fully revert: re-import the pre-patch resolver from `git show 1ba911584:deliverables/r360-n8n-migration/n8n/sub-r360-resolver.json` (or any commit before `4bd82d903`).
