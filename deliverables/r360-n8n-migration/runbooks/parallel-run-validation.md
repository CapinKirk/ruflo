# R360 Production Parallel-Run + Lead-Capture Validation Runbook

**Purpose:** First-class operational protocol for the dual-write window in PROD. Replaces the prior plan's 72-hour dual-write footnote with a staged, automated, multi-day validation that proves *no R360 lead is dropped*.

**User requirement (verbatim):** "I need this in production in parallel with Zapier, then validation everything is running smooth and getting all leads (as part of the plan)."

**Owner:** Kirk Bennett (RevOps lead) executes daily; SF Admin + SDR Manager + AM Manager sign off at Gate 4.

**Total operational effort across the 60-day window:** ~34 hours of RevOps time. Cheap insurance vs. one missed enterprise R360 deal.

**Companion docs:**
- Build plan: `../../migration-plans/r360-n8n-build-plan.md` §18 (Cutover) references this runbook
- Pre-cutover: `pre-cutover-validation.md` (must pass before this runbook starts)
- Audit script: `scripts/audit-lead-capture.sh`
- Reconciliation cron: `../n8n/cron/r360-parallel-run-reconciliation.json`

---

## §1 Parallel-run topology in PROD

Both Zapier (existing 7 zaps + central processor) AND n8n (4 receivers + cron) listen to the SAME WPForms / SocialIntents / Pre-Discovery sources. Both write to the SAME `Lead_Inbound_Log__c` (idempotency hash dedupes — first to write wins, second short-circuits).

```
WPForm 29710 ─┬─► Zapier 316698017+316797554 ─┐
              └─► n8n /r360/contact-form     ─┤
                                              │
WPForm 29712 ─┬─► Zapier 316701470+316797554 ─┤
              └─► n8n /r360/watch-video      ─┤
                                              ├─► Lead_Inbound_Log__c (SF)
WPForm 29714 ─┬─► Zapier 316797350+316797554 ─┤   first write wins (Idempotency_Hash__c)
              └─► n8n /r360/get-demo         ─┤   second write short-circuits to replayed_duplicate
                                              │
SocialIntents─┬─► Zapier 332679789 Path K     ─┤
              └─► n8n /r360/bot              ─┤
                                              │
Pre-Discov.  ─┬─► Zapier 336544812            ─┤
caller       └─► n8n /r360/pre-discovery     ─┘
                                              │
                                              ▼
                              Salesforce Lead/Contact/Account/Case/CampaignMember
                                              │
                                              ▼
                              Slack DM + Gmail email to AE / SDR
```

Both systems are idempotent (same `Idempotency_Hash__c`) — whichever lands first becomes the source of truth, and the second receiver short-circuits at the upsert. No double writes, no duplicate Leads/Contacts.

---

## §2 Parallel-run window — staged 14-day protocol

**Replaces the prior plan's 72-hour minimum.** The user requirement explicitly asked for validation that we're "getting all leads," which a 72h window cannot prove.

| Stage | Window | Activity | Cadence |
|---|---|---|---|
| **Quiet observation** | T+0 to T+72h (Days 1-3) | n8n receivers enabled. Daily 9am SOQL audit (build plan §17.8). Catch Day-1 surprises (auth errors, FLS gaps, schema drift). | Daily |
| **Active comparison** | T+72h to T+7d (Days 4-7) | Hourly Zapier-vs-n8n reconciliation cron (`r360-parallel-run-reconciliation.json`). SDR/AE feedback channel `#r360-leads-parallel-run` opened. `audit-lead-capture.sh` runs nightly. | Hourly + nightly |
| **Confidence-build** | T+7d to T+14d (Days 8-14) | Continue automated reconciliation. Sales team explicitly asked at standup: "any missed R360 leads?" Daily report shows trend lines. | Daily |
| **Gate 4 + Phase B trigger** | Day 15+ | Phase B Zapier-off begins (per build plan §18) — only after **Lead-Capture Sign-off Gate 4** is signed (§7 below). | one-time gate |

---

## §3 Automated Zapier-vs-n8n reconciliation cron

**Workflow:** `../n8n/cron/r360-parallel-run-reconciliation.json` (already authored).

**Schedule:** every hour during the 14-day window. Disabled on Day 15 when Phase B begins.

**Inputs (3 parallel queries each hour):**

1. **Zapier task history** — `GET https://zapier.com/api/v3/zaps/{zap_id}/runs?since=...` for all 7 R360 zaps (need `zapier_platform_api` token from pre-cutover §1 row 12)
2. **`Lead_Inbound_Log__c`** — SOQL `WHERE Received_At__c >= LAST_N_HOURS:1`
3. **n8n executions** — `GET ${N8N_BASE_URL}/api/v1/executions?startedAfter=...`

**Set difference math:**

- **Set A:** Zapier-fired entries (key: `source_form:entry_id`)
- **Set B:** n8n-received entries (key: `Source__c:External_Submission_Id__c`)
- **Set C:** entries with `Status__c='written'` (a subset of B)

Three diff queries:

| Diff | Meaning | Severity |
|---|---|---|
| `A - B` | Zapier received but n8n didn't | **P0** — auto-page on > 0 |
| `B - A` | n8n received but Zapier didn't | P2 — investigate (rare; should be 0 in parallel mode) |
| `(A ∩ B) - C` | Both received but neither wrote successfully | P1 — investigate |

**Hourly Slack post to `#r360-leads-parallel-run`:** counts per set, top-5 entries in each diff (with submitter email + form). Auto-page on `|A - B| > 0`.

```json
// Slack message template (built by the cron's Code node)
{
  "channel": "#r360-leads-parallel-run",
  "text": ":bar_chart: *Hourly recon (T+{stage}h)*\n• Zapier: 12 / n8n: 12 / written: 12\n• A-B: 0 / B-A: 0 / neither-wrote: 0\n:white_check_mark: All in sync."
}
```

**On `|A - B| > 0`:** auto-page `<!subteam^revops-oncall>` and Kirk via DM.

---

## §4 Lead-capture proof script — `audit-lead-capture.sh`

**Path:** `scripts/audit-lead-capture.sh`

**Purpose:** for an arbitrary day-window, cross-reference Zapier task history × `Lead_Inbound_Log__c` × SF Lead/Contact, prove every Zapier task either landed in `Lead_Inbound_Log__c` (n8n received) OR a SF Lead/Contact (Zapier still wrote it). The BAD case is "Zapier task fired but neither system wrote anything."

**Cadence:**
- Days 1-3 (quiet observation): nightly at 11pm Central
- Days 4-14 (active comparison + confidence-build): nightly + ALSO every 4 hours during staged decommission (Days 15-20)

**Outputs:** Markdown report archived to `migration-plans/uat-results/parallel-run-{date}.md`

**Report format:**

```markdown
# Lead-Capture Audit — 2026-05-18

## Summary
- Total Zapier tasks fired (last 24h): 47
- n8n received-rate: 100% (47/47)
- SF write-rate: 100% (47/47 produced a SF record)
- Idempotency proof: 23 rows had Status='replayed_duplicate' (n8n received after Zapier already wrote — expected during parallel mode)

## Failed list (CRITICAL — investigate immediately)
(none)

## By source
| Source | Zapier tasks | n8n received | SF records created |
|---|---|---|---|
| wpform_29710 | 24 | 24 (100%) | 24 |
| wpform_29712 | 8 | 8 (100%) | 8 |
| wpform_29714 | 6 | 6 (100%) | 6 |
| bot_r360 | 3 | 3 (100%) | 3 |
| webhook_pre_discovery | 6 | 6 (100%) | 6 |

## Verdict: GREEN — proceed to next day's parallel-run
```

If verdict is YELLOW or RED, escalate to Kirk + SF Admin within 30 min.

---

## §5 Sales team feedback loop

**Channel:** `#r360-leads-parallel-run`

**Bot command:** `/missed-lead {email}` — checks Zapier + Inbound_Log + SF Lead/Contact for that email in last 24h, posts triage summary in-thread within 30 seconds.

**Bot response template:**

```
:mag: *Triage report for kirk@enterprise-rental.com*

Last 24h:
• Zapier task: ✅ found (Zap 316797554, ran 2026-05-18 14:23 UTC, status: success)
• Lead_Inbound_Log__c: ✅ found (LIL-0000847, Source=wpform_29710, Status=written)
• SF Lead: ✅ found (00Q4u00001ABC, OwnerId = 0054u0000094ck7AAA Katie McFarland)
• SF Contact: not found (expected — new Lead, not yet converted)

Verdict: lead is in pipeline. Owner Katie should see it.
```

**Why this matters:** SDRs and AEs are the consumers of R360 leads. Their anxiety ("is something broken?") is the strongest signal of trouble — but only if they have a fast, low-friction way to ask. The Slack bot turns "I think we missed a lead" into "let me check first" in <30 seconds.

---

## §6 Daily standup template (5-min checklist)

**Owner:** RevOps lead. Posted to `#r360-leads-daily` each morning during the 14-day window.

```markdown
:date: *Daily R360 Standup — {date}*

- [ ] Last-24h `audit-lead-capture.sh` report reviewed — failed list: [empty | N rows]
- [ ] `#r360-leads-parallel-run` checked for SDR/AE flags — [no flags | N flags addressed]
- [ ] Hourly reconciliation cron log glanced — [no auto-pages | N pages]
- [ ] n8n queue depth healthy (Redis dashboard) — [< 100 | depth was N at peak]
- [ ] SF API consumption tracking — n8n at [X%] of daily limit (target: < 30% during parallel mode)

Verdict: :large_green_circle: GREEN | :large_yellow_circle: YELLOW | :red_circle: RED
```

Required posts: 14 consecutive days of GREEN to advance Gate 4.

YELLOW means "investigate but no Zapier rollback" — typically a single anomaly worth documenting.

RED means "Phase B is on hold" — escalate to Kirk + SF Admin + on-call.

---

## §7 Lead-Capture Sign-off Gate (Gate 4)

**This is a NEW gate, sits between Gate 3 (Parity 99.9%) and Phase B (Zapier-off).** Required for Phase B to proceed.

### Pass criteria — ALL must be met

- [ ] 14 consecutive days of GREEN daily standup verdicts in `#r360-leads-daily`
- [ ] 0 SDR/AE-reported missed leads in `#r360-leads-parallel-run`
- [ ] `audit-lead-capture.sh` final report shows **100% capture** (every Zapier task → either Inbound_Log row OR SF record)
- [ ] Hourly reconciliation cron `|A - B| = 0` for all 14 days (no Zapier-received-but-n8n-missed entries)
- [ ] Reconciliation cron's `replayed` count = 0 (real-time delivery is bulletproof; reconciliation is just safety)
- [ ] WP DB poll cron has fired ≥1× per 10-min window for the full 14 days (no missed reconciliation cycles)
- [ ] 0 P0 incidents (Zapier task fired but neither system wrote) in the 14-day window
- [ ] All Pre-Discovery webhooks completed within 280s p95 (validates the async pattern from build plan §8.4)

### Required sign-offs (all six must approve)

- [ ] **SF Admin** — confirms SF data integrity throughout the window
- [ ] **Sales Ops** — confirms AE routing matches expected behavior
- [ ] **Marketing Ops** — confirms UTM/click ID fields captured correctly
- [ ] **RevOps lead (Kirk)** — final RevOps go/no-go
- [ ] **SDR Manager** — *newly required, the consumer of inbound R360 leads*
- [ ] **AM Manager** — *newly required, the consumer of Customer-bucket Contact updates*

Acceptable mechanism: Slack ✅ in `#r360-leads-parallel-run` from each owner, archived to `migration-plans/uat-results/parallel-run-final-{date}.md`.

### If ANY criterion fails on Day 14

1. Extend parallel-run by another 7 days (reset to Day 8 mode — automated reconciliation continues)
2. Re-run the audit at Day 21
3. If still failing on Day 21: escalate scope re-evaluation to Kirk + Sales/Marketing leadership

Gate 4 passes → proceed to §8 staged decommission.

---

## §8 Phase B Zapier-off — staged decommission with reactivation safety net

**Replaces the build plan's prior single-Sunday cutover.** Stage decommission so any post-cutover regression isolates to one feeder.

### Daily decommission schedule

| Day | Disable | Monitoring window | Auto re-enable trigger |
|---|---|---|---|
| Day 15 | **316698017** (Watch Video router) | 24h | n8n received-rate < 99.9% for any 4h window → re-enable |
| Day 16 | **316701470** (Get a Demo router) | 24h | same |
| Day 17 | **316797350** (Contact Form router) | 24h | same |
| Day 18 | **332679789 Path K** (Bot R360 — Path J POR stays active) | 24h | same |
| Day 19 | **316797554** (central processor) | 24h | same |
| Day 20 | **336544812** (R360 Pre-Discovery) + **225753704** (R360 FAQ) | 48h | same |

### Reactivation safety net

During each 24-48h monitoring window, `audit-lead-capture.sh` runs **every 4 hours** instead of nightly. If `n8n received-rate < 99.9%` for any 4h window, IMMEDIATELY:

1. Re-enable the most-recently-disabled Zap
2. Pause the decommission
3. Page on-call RevOps + SF Admin
4. Investigate root cause before resuming
5. Document the incident in `migration-plans/uat-results/phase-b-incidents-{date}.md`

Resumption requires Kirk's explicit go-ahead in `#r360-leads-parallel-run`.

---

## §9 Post-Phase-B 30-day enhanced monitoring

| Window | Audit cadence | Verdict channel |
|---|---|---|
| Days 21-30 | Daily 9am audit (`audit-lead-capture.sh`) | `#r360-leads-daily` |
| Days 31-45 | Every-other-day audit | `#r360-leads-daily` |
| Days 46-60 | Weekly audit | `#r360-leads-daily` |
| Day 60 | Final all-clear announcement to RevOps + Sales leadership; archive parallel-run artifacts to `migration-plans/uat-results/` | one-time |

If ANY audit during this window shows < 99.9% capture, treat as a P1 incident — investigate within 24h.

---

## §10 Failure response protocol

Explicit playbook for the 6 rollback triggers from build plan §17.9, adapted for the prod parallel-run context.

### P0 — Zapier task fired but neither system wrote

**Detection:** `audit-lead-capture.sh` failed list > 0 OR hourly reconciliation cron `|A - B| > 0`
**Severity:** P0
**Action:**
1. Immediately re-enable affected Zap (if it was disabled in Phase B)
2. Replay missing leads from Zapier task history via SF Workbench or n8n DLQ replay
3. Pause Phase B decommission
**Notification:** page on-call RevOps + SF Admin + Kirk DM
**Recovery:** root-cause investigation; document in incidents log; resume only after Kirk + SF Admin explicit go-ahead

### P1 — n8n receiver returning 5xx errors

**Detection:** n8n executions with HTTP 5xx response codes ≥ 5 in any 1h window; `Lead_Inbound_Log__c.Status__c='failed'` rate > 1%
**Severity:** P1
**Action:**
1. Auto-page in `#r360-leads-errors`
2. n8n queue mode keeps queue alive — receiver capacity needs investigation
3. Zapier still firing → no leads lost in this window
**Notification:** Slack auto-page; investigate within 4h business hours
**Recovery:** scale n8n workers; verify Redis health; check upstream API rate limits

### P2 — Reconciliation cron noticed > 5 entries needed replay in 24h

**Detection:** count of `Lead_Inbound_Log__c` rows with `Status__c='replayed'` > 5 in any 24h window
**Severity:** P2
**Action:**
1. Investigate WP webhook config (real-time delivery should be bulletproof; replay is the safety net)
2. Verify WPForms-Webhook addon is active in WP Admin
3. Check WP DB connection from n8n
**Notification:** daily standup mention
**Recovery:** fix WP webhook root cause; reconciliation cron continues catching strays

### P0 — `audit-lead-capture.sh` rate < 99.9% for any 4h window during Phase B

**Detection:** the staged decommission's tighter audit cadence
**Severity:** P0 — automatic Zap re-enable
**Action:** see §8 reactivation safety net

### P1 — Plauti DupCheck blocks > 0 writes that Zapier currently makes

**Detection:** `Lead_Inbound_Log__c.Error_Message__c LIKE '%DUPCHECK%'`
**Severity:** P1
**Action:** verify FLS on `dupcheck__dc3DisableDuplicateCheck__c` for integration user (per pre-cutover §6); Zapier's flow is unaffected
**Recovery:** add FLS Edit to permission set; redeploy; re-test

### P0 — SF daily API limit hit by n8n

**Detection:** SF setup page shows API consumption > 80% of daily limit; n8n receivers begin returning rate-limit errors
**Severity:** P0
**Action:**
1. Implement bulk batching in receivers (use SF Composite API)
2. Re-test load to confirm
3. Increase SF API limit if available (Premier feature)
**Notification:** page Kirk + SF Admin immediately
**Recovery:** root-cause; escalate to Salesforce support if needed

---

## Total parallel-run effort

| Phase | Duration | Effort |
|---|---|---|
| Setup (deploy hourly cron, sales feedback bot) | Day 0 of parallel-run | 4 hours |
| Days 1-3 quiet observation | 3 days | 30 min/day = 1.5 hours |
| Days 4-7 active comparison | 4 days | 1 hour/day = 4 hours |
| Days 8-14 confidence-build | 7 days | 30 min/day = 3.5 hours |
| Days 15-20 staged decommission | 6 days | 2 hours/day = 12 hours |
| Days 21-30 enhanced monitoring | 10 days | 30 min/day = 5 hours |
| Days 31-60 fade-out monitoring | 30 days | 30 min/2-7d ≈ 4 hours total |
| **Total** | **60 days** | **~34 hours of RevOps time** |

This is the price of "everything is running smooth and getting all leads." Cheap insurance vs. one missed enterprise R360 deal.
