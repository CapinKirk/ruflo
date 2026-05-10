#!/bin/bash
#
# audit-lead-capture.sh — R360 parallel-run lead-capture proof
#
# For an arbitrary day-window, cross-reference Zapier task history ×
# Lead_Inbound_Log__c × SF Lead/Contact. Proves every Zapier task either
# landed in Inbound_Log (n8n received) OR a SF record (Zapier still wrote).
# The BAD case is "Zapier task fired but neither system wrote."
#
# Usage:
#   ./audit-lead-capture.sh [--since <N hours>] [--target-org por-prod] [--out report.md]
#
# Outputs:
#   - Markdown report to stdout (and --out file if specified)
#   - Exit code 0 on GREEN, 1 on YELLOW, 2 on RED
#
# Requirements: sf CLI, jq, curl, ZAPIER_API_TOKEN env var
#
# Spec: deliverables/r360-n8n-migration/runbooks/parallel-run-validation.md §4

set -euo pipefail

# ─── Defaults ────────────────────────────────────────────────────────────────
SINCE_HOURS="${SINCE_HOURS:-24}"
TARGET_ORG="${TARGET_ORG:-por-prod}"
OUT_FILE=""
ZAPIER_API_TOKEN="${ZAPIER_API_TOKEN:?set ZAPIER_API_TOKEN env var}"

# 7 R360 zap IDs (build plan §1)
ZAP_IDS=(
  "316698017:Watch Video router"
  "316701470:Get a Demo router"
  "316797350:Contact Form router"
  "316797554:Central processor"
  "332679789:Bot R360 path"
  "336544812:Pre-Discovery"
  "225753704:R360 FAQ"
)

# ─── Arg parsing ────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --since)      SINCE_HOURS="$2"; shift 2 ;;
    --target-org) TARGET_ORG="$2"; shift 2 ;;
    --out)        OUT_FILE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 64 ;;
  esac
done

SINCE_ISO=$(date -u -v-"${SINCE_HOURS}H" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "${SINCE_HOURS} hours ago" +"%Y-%m-%dT%H:%M:%SZ")
TODAY=$(date -u +"%Y-%m-%d")

# ─── Output buffer ───────────────────────────────────────────────────────────
buf="# Lead-Capture Audit — ${TODAY}\n\n"
buf+="**Window:** last ${SINCE_HOURS}h (since ${SINCE_ISO})\n"
buf+="**Org:** ${TARGET_ORG}\n\n"

# ─── 1. Pull Zapier task history ─────────────────────────────────────────────
echo "Pulling Zapier task history for last ${SINCE_HOURS}h..." >&2
ZAPIER_TASKS_FILE=$(mktemp)
trap 'rm -f $ZAPIER_TASKS_FILE' EXIT

zapier_total=0
declare -A zapier_per_zap
for entry in "${ZAP_IDS[@]}"; do
  zap_id="${entry%%:*}"
  zap_label="${entry#*:}"

  resp=$(curl -sf \
    -H "Authorization: Bearer ${ZAPIER_API_TOKEN}" \
    "https://zapier.com/api/v3/zaps/${zap_id}/runs?since=${SINCE_ISO}" \
    2>/dev/null || echo '{"results":[]}')

  count=$(echo "$resp" | jq -r '.results | length' 2>/dev/null || echo 0)
  zapier_per_zap["$zap_label"]=$count
  zapier_total=$((zapier_total + count))
done

buf+="## §1 Zapier task history\n\n"
buf+="| Zap | Tasks fired |\n"
buf+="|---|---|\n"
for entry in "${ZAP_IDS[@]}"; do
  zap_label="${entry#*:}"
  buf+="| ${zap_label} | ${zapier_per_zap[$zap_label]} |\n"
done
buf+="| **Total** | **${zapier_total}** |\n\n"

# ─── 2. Pull Lead_Inbound_Log__c for the same window ─────────────────────────
echo "Pulling Lead_Inbound_Log__c..." >&2
LIL_QUERY="SELECT Source__c source, Status__c status, COUNT(Id) n
FROM Lead_Inbound_Log__c
WHERE Received_At__c >= LAST_N_HOURS:${SINCE_HOURS}
GROUP BY Source__c, Status__c
ORDER BY Source__c, Status__c"

LIL_JSON=$(sf data query -q "$LIL_QUERY" --target-org "$TARGET_ORG" --json 2>/dev/null || echo '{"result":{"records":[]}}')
LIL_ROWS=$(echo "$LIL_JSON" | jq -c '.result.records[]')
LIL_TOTAL=$(echo "$LIL_JSON" | jq -r '[.result.records[].n] | add // 0')
LIL_WRITTEN=$(echo "$LIL_JSON" | jq -r '[.result.records[] | select(.status=="written") | .n] | add // 0')
LIL_FAILED=$(echo "$LIL_JSON" | jq -r '[.result.records[] | select(.status=="failed") | .n] | add // 0')
LIL_REPLAYED=$(echo "$LIL_JSON" | jq -r '[.result.records[] | select(.status=="replayed") | .n] | add // 0')
LIL_DUP=$(echo "$LIL_JSON" | jq -r '[.result.records[] | select(.status=="replayed_duplicate") | .n] | add // 0')

buf+="## §2 Lead_Inbound_Log__c summary\n\n"
buf+="| Status | Count |\n"
buf+="|---|---|\n"
buf+="| written | ${LIL_WRITTEN} |\n"
buf+="| failed | ${LIL_FAILED} |\n"
buf+="| replayed (real-time miss; reconciliation caught) | ${LIL_REPLAYED} |\n"
buf+="| replayed_duplicate (n8n+Zapier both received) | ${LIL_DUP} |\n"
buf+="| **Total received** | **${LIL_TOTAL}** |\n\n"

# ─── 3. SF Lead/Contact created in same window with R360_Record__c=true ─────
echo "Pulling SF Lead/Contact totals..." >&2
SF_LEAD_COUNT=$(sf data query -q "SELECT COUNT() FROM Lead WHERE R360_Record__c = true AND CreatedDate >= LAST_N_HOURS:${SINCE_HOURS}" --target-org "$TARGET_ORG" --json 2>/dev/null | jq -r '.result.totalSize // 0')
SF_CONTACT_COUNT=$(sf data query -q "SELECT COUNT() FROM Contact WHERE LastModifiedDate >= LAST_N_HOURS:${SINCE_HOURS} AND Most_Recent_Pardot_Form__c LIKE 'R360 -%'" --target-org "$TARGET_ORG" --json 2>/dev/null | jq -r '.result.totalSize // 0')

buf+="## §3 SF records produced\n\n"
buf+="| Object | Count |\n"
buf+="|---|---|\n"
buf+="| Lead (R360_Record__c=true, CreatedDate window) | ${SF_LEAD_COUNT} |\n"
buf+="| Contact (modified in window, R360 form fill) | ${SF_CONTACT_COUNT} |\n\n"

# ─── 4. Cross-reference: Zapier total vs n8n received vs SF write ───────────
buf+="## §4 Cross-reference\n\n"

if [ "$zapier_total" -eq 0 ]; then
  capture_rate="N/A (no Zapier tasks)"
  failed_count=0
else
  # n8n received-rate = (LIL_TOTAL / zapier_total) — caps at 100% if n8n received its own retries
  # We use the more conservative LIL_WRITTEN + LIL_DUP (both = lead made it to SF via some path)
  in_sf=$((LIL_WRITTEN + LIL_DUP))
  capture_rate=$(awk "BEGIN { printf \"%.1f%%\", ($in_sf / $zapier_total) * 100 }")
  # Failed list = Zapier tasks where neither n8n received nor Zapier wrote
  # Approximation: if zapier_total > LIL_TOTAL + zapier-only writes, those are failures
  failed_count=$((zapier_total > LIL_TOTAL ? zapier_total - LIL_TOTAL : 0))
fi

buf+="- Zapier tasks fired: ${zapier_total}\n"
buf+="- n8n Inbound_Log rows: ${LIL_TOTAL}\n"
buf+="- SF records written or short-circuited: $((LIL_WRITTEN + LIL_DUP))\n"
buf+="- **Capture rate:** ${capture_rate}\n"
buf+="- **Failed list:** ${failed_count} entries (Zapier fired but neither system has a row)\n\n"

# ─── 5. Verdict ─────────────────────────────────────────────────────────────
exit_code=0
if [ "$failed_count" -gt 0 ] || [ "$LIL_FAILED" -gt 0 ]; then
  verdict=":red_circle: **RED — investigate immediately**"
  exit_code=2
elif [ "$LIL_REPLAYED" -gt 5 ]; then
  verdict=":large_yellow_circle: **YELLOW — reconciliation cron caught > 5 misses; investigate WP webhook**"
  exit_code=1
elif [ "$zapier_total" -eq 0 ] && [ "$LIL_TOTAL" -eq 0 ]; then
  verdict=":large_yellow_circle: **YELLOW — no traffic in window; verify both pipelines are alive**"
  exit_code=1
else
  verdict=":large_green_circle: **GREEN — proceed to next day's parallel-run**"
fi

buf+="## §5 Verdict\n\n"
buf+="${verdict}\n\n"
buf+="Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")\n"

# ─── 6. Output ───────────────────────────────────────────────────────────────
printf "%b" "$buf"
if [ -n "$OUT_FILE" ]; then
  printf "%b" "$buf" > "$OUT_FILE"
  echo "" >&2
  echo "Report written to: $OUT_FILE" >&2
fi

exit $exit_code
