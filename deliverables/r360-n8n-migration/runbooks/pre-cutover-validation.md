# R360 Pre-Cutover Validation Runbook

**Purpose:** Operational checklist for the days BEFORE Day 0 of the R360 Zapier→n8n migration. Closes credential, schema, and provisioning gaps that, if hit on Day 0, would block the build team mid-flight.

**Owner:** Kirk Bennett (RevOps lead) executes; SF Admin signs off.

**When to run:** Day -7 through Day -1 of the build sequence (before Day 0).

**Companion docs:**
- Build plan: `../../migration-plans/r360-n8n-build-plan.md`
- Parallel-run runbook: `parallel-run-validation.md` (executes after this one passes)
- Audit script: `scripts/audit-lead-capture.sh` (used by parallel-run, referenced here in §4)

---

## §1 Credentials procurement matrix

All credentials below must exist in Kirk's 1Password vault `RevOps / R360 n8n Migration` BEFORE Day 0. Each row's verification command should return success.

| # | Credential | Owner | ETA | 1Password path | Verification command |
|---|---|---|---|---|---|
| 1 | SF integration user OAuth (UAT) | SF Admin | Day -7 | `/RevOps/R360/sf-integration-user-uat` | `sf data query -q "SELECT Id FROM User WHERE Username='r360.n8n@pointofrental.com.uat' LIMIT 1" --target-org por-uat` |
| 2 | SF integration user OAuth (PROD) | SF Admin | Day -3 | `/RevOps/R360/sf-integration-user-prod` | `sf data query -q "SELECT Id FROM User WHERE Username='r360.n8n@pointofrental.com' LIMIT 1" --target-org por-prod` |
| 3 | WPForms Webhook addon license key | Web team | Day -7 | `/RevOps/R360/wpforms-webhook-addon` | Confirm in WP Admin → WPForms → Addons → Webhooks status = Active |
| 4 | WordPress DB read-only credentials | Web team | Day -7 | `/RevOps/R360/wordpress-db-readonly` | See §2 below |
| 5 | Slack bot token (R360 channels) | Slack workspace admin | Day -5 | `/RevOps/R360/slack-bot-r360` | `curl -H "Authorization: Bearer $TOKEN" https://slack.com/api/auth.test` should return `ok: true` |
| 6 | Slack bot token (Pre-Discovery) | Slack workspace admin | Day -5 | `/RevOps/R360/slack-bot-pre-discovery` | same |
| 7 | Apollo API key | Marketing Ops | Day -5 | `/RevOps/R360/apollo-api` | `curl -H "X-Api-Key: $KEY" https://api.apollo.io/api/v1/users/me` returns 200 |
| 8 | Perplexity API key | Marketing Ops | Day -5 | `/RevOps/R360/perplexity-api` | `curl -H "Authorization: Bearer $KEY" https://api.perplexity.ai/chat/completions -d '{"model":"sonar-pro","messages":[{"role":"user","content":"hi"}]}'` returns 200 |
| 9 | OpenAI API key | Marketing Ops | Day -5 | `/RevOps/R360/openai-api` | `curl -H "Authorization: Bearer $KEY" https://api.openai.com/v1/models` returns 200; verify gpt-5.1 in the list |
| 10 | Gmail SMTP for marketing@ | IT | Day -7 | `/RevOps/R360/gmail-smtp-marketing` | Send test email via `sendmail` or `swaks` |
| 11 | n8n queue mode infra (Redis + Postgres) | DevOps | Day -10 | `/RevOps/R360/n8n-queue-mode-infra` | n8n status page shows queue mode active; `redis-cli ping` returns PONG; Postgres connection works |
| 12 | Live Zapier catch URLs (4 feeders) | Kirk | Day -7 | `/RevOps/R360/zapier-catch-urls` | `curl -X POST <each_url> -d '{"test":true}'` returns Zapier 200 OK |

If ANY row's ETA slips, escalate to Kirk + SF Admin to re-baseline Day 0.

---

## §2 WordPress `wp_wpforms_entries` schema confirmation

The reconciliation cron (every 10 min) reads directly from the WP DB. Confirm the schema matches the cron's expectations BEFORE the cron is deployed.

```bash
#!/bin/bash
# wp-schema-check.sh — runs DESCRIBE on wp_wpforms_entries and a sample SELECT
set -euo pipefail

DB_HOST="${WP_DB_HOST:?set WP_DB_HOST}"
DB_USER="${WP_DB_USER:?set WP_DB_USER}"
DB_PASS="${WP_DB_PASS:?set WP_DB_PASS}"
DB_NAME="${WP_DB_NAME:?set WP_DB_NAME}"

echo "=== Schema check ==="
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "DESCRIBE wp_wpforms_entries"

echo ""
echo "=== Sample data (last 5 R360 entries) ==="
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
  SELECT entry_id, form_id, LEFT(fields, 200) AS fields_preview, date_created
  FROM wp_wpforms_entries
  WHERE form_id IN (29710, 29712, 29714, 33076)
  ORDER BY date_created DESC
  LIMIT 5
"

echo ""
echo "=== Count by form_id (last 7 days) ==="
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
  SELECT form_id, COUNT(*) AS n
  FROM wp_wpforms_entries
  WHERE date_created >= NOW() - INTERVAL 7 DAY
  GROUP BY form_id
  ORDER BY form_id
"
```

**Expected columns:** `entry_id` (bigint, PK), `form_id` (int), `fields` (longtext, JSON), `date_created` (datetime).

**Pass criteria:**
- All 4 expected columns present with the expected types
- Sample row's `fields` JSON parses cleanly (`echo "$json" | jq .`)
- Form ID 29710 (Contact Form) has at least 10 entries in last 7 days (sanity check that the form is alive)

**If schema differs:** open ticket with Web team. Do NOT proceed; the reconciliation cron will silently miss entries with the wrong column names.

---

## §3 SocialIntents Bot live-payload sniffer

The 3-location persona detection (build plan §9.1) is best-effort against the spec. Verify it against real production payloads.

### Setup (Day -5)

1. Deploy a temporary n8n workflow `temp-bot-sniffer.json` to UAT n8n:
   ```
   [Webhook /r360/bot-sniffer] → [Code: log entire body to file] → [Respond 200]
   ```
2. The Code node writes each payload to `/var/log/n8n/bot-sniffer/{timestamp}.json` (or n8n's persistent volume).
3. Configure SocialIntents to send to BOTH the existing Zapier URL AND the new sniffer URL (dual-fire — Zapier still gets every event).
4. Run the sniffer for **24 hours**.

### Validation (Day -4)

After 24h, retrieve the captured payloads and run them through the §9.1 detection logic.

```bash
#!/bin/bash
# bot-detection-validation.sh — runs §9.1 against captured payloads
set -euo pipefail

PAYLOAD_DIR="${1:?usage: $0 <payload_dir>}"
EXPECTED_R360_COUNT=3
EXPECTED_POR_COUNT=3

# For each captured JSON, classify and count matches
node <<'EOF'
const fs = require('fs');
const path = require('path');
const dir = process.env.PAYLOAD_DIR || './payloads';

function isR360(data) {
  let isRena = false;
  const summaryNickname = data?.user_info?.ids?.agent_nickname || data?.user_info?.agent_nickname;
  if (summaryNickname && (summaryNickname.includes('Rena Record') || summaryNickname.includes('Rosie'))) isRena = true;
  if (!isRena && Array.isArray(data.items)) {
    isRena = data.items.some(i => i.nickname && (i.nickname.includes('Rena') || i.nickname.includes('Rosie')));
  }
  if (!isRena && data.output_text) {
    try {
      const nested = JSON.parse(data.output_text);
      const nick = nested?.user_info?.ids?.agent_nickname;
      if (nick && (nick.includes('Rena Record') || nick.includes('Rosie'))) isRena = true;
    } catch (e) {
      if (data.output_text.includes('Rena') || data.output_text.includes('Rosie')) isRena = true;
    }
  }
  return isRena;
}

const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
let r360Count = 0, porCount = 0, ambig = 0;
for (const f of files) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const verdict = isR360(data);
  // Expect human-tagged ground truth in the filename or a sidecar metadata file:
  const truthFile = path.join(dir, f.replace('.json', '.truth'));
  const truth = fs.existsSync(truthFile) ? fs.readFileSync(truthFile, 'utf8').trim() : 'unknown';
  console.log(`${f}: detected=${verdict} truth=${truth}`);
  if (truth === 'r360' && verdict) r360Count++;
  if (truth === 'por' && !verdict) porCount++;
  if (truth === 'unknown') ambig++;
}
console.log(`\nR360 correctly detected: ${r360Count}`);
console.log(`POR correctly rejected: ${porCount}`);
console.log(`Ambiguous (no ground truth): ${ambig}`);
EOF
```

**Pass criteria:**
- ≥3 captured R360 conversations (Rena Record or Rosie persona) — ALL detected as R360 (zero false-negatives)
- ≥3 captured POR conversations (Penny Pointer or others) — ALL rejected (zero false-positives)
- 2+ ambiguous (anonymous visitor) — verdict is deterministic (same input → same output across re-runs)

**If ANY R360 false-negative:** STOP. Re-design detection logic with the real payload structure. R360 false-negatives lose enterprise leads — non-negotiable.

**If ANY POR false-positive:** STOP. POR leads misrouting to R360 path corrupts pipeline data.

After validation passes, capture the result in the Day 0 readiness checklist (§7).

---

## §4 22-ID prod SOQL audit script

Build plan §11 lists 22 hardcoded SF IDs (queues, RecordTypes, Users, Campaigns, Accounts). All must exist in prod AND have UAT counterparts before Day 0.

```bash
#!/bin/bash
# audit-22-ids.sh — validates all hardcoded IDs in both prod and UAT
set -euo pipefail

OUTPUT_FILE="${1:-22-id-audit-$(date +%Y%m%d).md}"

declare -a IDS=(
  # InsideSalesQueue (per region)
  "00G0L000004WbECUA0:Group:APAC InsideSales Queue"
  "00G4u000004AmQJEA0:Group:Africa InsideSales Queue"
  "00G0L000004WbEDUA0:Group:Europe InsideSales Queue"
  "00G0L000004WbEEUA0:Group:NA InsideSales Queue"
  # BusinessHours
  "01m0L00000001OZQAY:BusinessHours:APAC Hours"
  "01m0L00000001PcQAI:BusinessHours:Generic Hours"
  "01m0h0000005HbeAAE:BusinessHours:NA Hours"
  # AssignmentID (User Ids — AEs)
  "0050L000008hH5DQAU:User:Josh OConnell"
  "0050L000008uAHvQAM:User:Dean Hammond"
  "0054u0000094ck7AAA:User:Katie McFarland"
  # LeadAccountId (R360 region accounts)
  "001Ki000009wWMPIA2:Account:R360 Lead Account APAC"
  "001Ki000009wWM0IAM:Account:R360 Lead Account Europe"
  "0014u00002BFXvRAAX:Account:R360 Lead Account NA"
  # Lead RecordType
  "012Ki000000bpgRIAQ:RecordType:R360 Lead RT"
  # Case RecordType (Inside Sales)
  "0124u000000l5qwAAA:RecordType:Inside Sales Case RT"
  # Campaigns
  "701Ki000000cMwkIAE:Campaign:R360 Marketing Campaign"
  "7010L00000034Y7QAI:Campaign:Website Campaign"
  # Slack channel for errors (referenced in build plan, validated separately in §5)
  "C086VJY7Y9K:slack:cancellation-process"
  # Slack User IDs — fixed Pre-Discovery recipients
  "U02HR1T6PBK:slack:Pre-Discovery RevOps system owner"
  "U01B0955NEQ:slack:Pre-Discovery RevOps manager"
)

echo "# 22-ID SOQL Audit Report" > "$OUTPUT_FILE"
echo "Generated: $(date)" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"
echo "| ID | Type | Description | PROD | UAT |" >> "$OUTPUT_FILE"
echo "|---|---|---|---|---|" >> "$OUTPUT_FILE"

for entry in "${IDS[@]}"; do
  id="${entry%%:*}"
  rest="${entry#*:}"
  type="${rest%%:*}"
  desc="${rest#*:}"

  case "$type" in
    Group|User|Account|RecordType|Campaign|BusinessHours)
      object="$type"
      [ "$type" = "RecordType" ] && object="RecordType"
      prod_count=$(sf data query -q "SELECT Id FROM $object WHERE Id = '$id'" --target-org por-prod --json 2>/dev/null | jq -r '.result.totalSize' || echo "ERR")
      uat_id_subst="$id"  # UAT IDs differ — see UAT mapping table at §17.2
      uat_count=$(sf data query -q "SELECT Id FROM $object WHERE Id = '$uat_id_subst'" --target-org por-uat --json 2>/dev/null | jq -r '.result.totalSize' || echo "ERR")
      prod_status=$([ "$prod_count" = "1" ] && echo "✅ PASS" || echo "❌ FAIL ($prod_count)")
      uat_status=$([ "$uat_count" = "1" ] && echo "✅ PASS" || echo "⚠️ UAT-MAP-NEEDED")
      echo "| \`$id\` | $type | $desc | $prod_status | $uat_status |" >> "$OUTPUT_FILE"
      ;;
    slack)
      echo "| \`$id\` | $type | $desc | (manual: see §5) | (manual) |" >> "$OUTPUT_FILE"
      ;;
  esac
done

echo "" >> "$OUTPUT_FILE"
echo "**Audit complete.** Any FAIL row is a Day 0 blocker. UAT-MAP-NEEDED rows must be populated in the UAT mapping table at build plan §17.2." >> "$OUTPUT_FILE"

cat "$OUTPUT_FILE"
```

**Pass criteria:** every prod cell = ✅ PASS. Any ❌ FAIL is a Day 0 blocker — investigate via SF UI before proceeding. UAT-MAP-NEEDED rows go into the build plan §17.2 mapping table.

---

## §5 Slack channel + bot provisioning

Required channels (create in advance, invite the R360 bot to each):

- [ ] **`#r360-leads-daily`** — daily 8am LeadOps report from `r360-daily-leadops.json`
- [ ] **`#r360-leads-errors`** — error escalations from `sub-error-handler.json`
- [ ] **`#r360-leads-errors-uat`** — UAT-only error escalations (separate channel keeps prod alerts uncluttered)
- [ ] **`#r360-leads-parallel-run`** — hourly reconciliation summary + `/missed-lead {email}` triage bot (parallel-run window only)

Verification per channel:

```bash
# Confirm bot is in the channel
curl -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  "https://slack.com/api/conversations.members?channel=$CHANNEL_ID" \
  | jq -r '.members[]' | grep -q "$BOT_USER_ID" && echo "Bot in channel ✅" || echo "Bot NOT in channel ❌"

# Send test message
curl -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"channel\": \"$CHANNEL_ID\", \"text\": \"Day -1 readiness test from n8n bot\"}" \
  https://slack.com/api/chat.postMessage | jq '.ok'
```

Required AE Slack IDs in SF (validate by SOQL):

```sql
SELECT Id, Name, Email, Slack_ID__c
FROM User
WHERE Id IN ('0050L000008hH5DQAU', '0050L000008uAHvQAM', '0054u0000094ck7AAA')
```

Expected: 3 rows, all with `Slack_ID__c` populated (format `U0XXXXXXX`). If ANY is null, populate before Day 0 — graceful fallback to email exists, but loses the AE's individual notification.

DM smoke test (per AE):

```bash
# Open DM channel with the AE then post a test
curl -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"channel\": \"$AE_SLACK_ID\", \"text\": \"Day -1 readiness test — confirm receipt please\"}" \
  https://slack.com/api/chat.postMessage | jq '.ok'
```

Ask each AE to confirm receipt within the day.

---

## §6 Plauti DupCheck FLS check

The R360 lead-create path sets `dupcheck__dc3DisableDuplicateCheck__c = true` on Lead/Contact (build plan §7.1, §7.3). The integration user MUST have FLS Edit on this field, otherwise the SF write throws FIELD_INTEGRITY_EXCEPTION.

```sql
-- Confirm field exists on Lead and Contact in both prod and UAT
SELECT EntityDefinition.QualifiedApiName, QualifiedApiName, DataType
FROM FieldDefinition
WHERE QualifiedApiName = 'dupcheck__dc3DisableDuplicateCheck__c'
  AND EntityDefinition.QualifiedApiName IN ('Lead', 'Contact')
```

Expected: 2 rows (Lead + Contact), DataType=Boolean.

```sql
-- Confirm integration user profile / permset has Edit access
SELECT ParentId, Parent.Name, SObjectType, Field, PermissionsEdit
FROM FieldPermissions
WHERE Field IN ('Lead.dupcheck__dc3DisableDuplicateCheck__c',
                'Contact.dupcheck__dc3DisableDuplicateCheck__c')
  AND ParentId IN (
    SELECT PermissionSetId FROM PermissionSetAssignment
    WHERE Assignee.Username LIKE 'r360.n8n%'
  )
```

Expected: 2+ rows, `PermissionsEdit = true` on both. If false, add the field to `R360_n8n_Integration` permission set and redeploy.

---

## §7 Day 0 readiness gate checklist

**Single-page binary checklist.** SF Admin signs off when ALL items are PASS. No "kinda done" states allowed.

- [ ] §1 — All 12 credentials in 1Password, verification commands all return success
- [ ] §2 — WP DB schema confirmed (4 expected columns, sample data parses)
- [ ] §3 — Bot live-payload validation passed: 3/3 R360 detected, 3/3 POR rejected, 0 false-positives, 0 false-negatives
- [ ] §4 — 22-ID prod SOQL audit: every prod cell ✅ PASS
- [ ] §4 — UAT mapping table populated (build plan §17.2) for all UAT-MAP-NEEDED rows
- [ ] §5 — All 4 Slack channels exist, bot invited, test message posted successfully
- [ ] §5 — User.Slack_ID__c populated for Josh / Dean / Katie (verified via SOQL)
- [ ] §5 — DM smoke test acknowledged by each AE
- [ ] §6 — Plauti DupCheck field exists on Lead AND Contact in both orgs; integration user has FLS Edit
- [ ] **`Lead_Inbound_Log__c` deployed to UAT** via `sf project deploy start --target-org por-uat -d ../sf-metadata/`
- [ ] **`Lead_Inbound_LogTest.cls` runs green** in UAT (`sf apex run test --tests Lead_Inbound_LogTest --target-org por-uat --result-format human`)
- [ ] **n8n UAT instance live** in queue mode (Redis + Postgres healthy)
- [ ] All 16 n8n workflow JSON files imported into UAT n8n, credentials bound, workflows tested individually with fixture payloads
- [ ] sub-error-handler workflow ID bound as errorWorkflow on every other workflow

**Sign-off:**

```
SF Admin (name): ____________________
Date:            ____________________
Verdict:         [ ] Go for Day 0    [ ] Hold (notes below)
Notes:
```

After sign-off, archive this checklist as `migration-plans/uat-results/pre-cutover-readiness-{date}.md` and proceed to Day 0.

---

## Failure protocol

If any §1–§6 gate fails, STOP. Day 0 cannot proceed.

1. Identify root cause (which gate, which check)
2. Open ticket with the responsible owner per §1 matrix
3. Re-run the failed check after fix
4. Update Day 0 readiness checklist
5. Re-attempt sign-off

Total Day -7 to Day -1 effort: ~1 day of RevOps lead time + ~half day of SF Admin + ~half day of Web team. Cheap insurance vs. a Day 1 mid-flight blocker.
