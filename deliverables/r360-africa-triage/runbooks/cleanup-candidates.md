# Production Cleanup Candidates — Awaiting Kirk's Sign-off

**Status:** Discovery complete · **No deletions or sends have been performed.**

## Part 1 — PROD Salesforce dry-run / test data

Source: `sf-codebase-analyzer` agent audit run 2026-05-26 against the
`PROD` alias (`kirk.bennett@pointofrental.com` / `por.my.salesforce.com`).

### Findings

- **0 test Leads in PROD** ✅
- **3 Contact candidates**, assessed below
- **8 stalled `Lead_Inbound_Log__c` rows** in `Status__c='received'` —
  these are live submissions that didn't complete, NOT test data. Worth a
  separate look in n8n execution logs.

### Contact candidates

| # | Id | Name | Email | CreatedDate | CreatedBy | Recommended action |
|---|---|---|---|---|---|---|
| A | `003an00000cLFEHAA4` | First08142024 Name08142024 | email@test.com | 2026-05-18 05:54 UTC | Kirk Bennett | **STRONG DELETE CANDIDATE** — synthetic date-stamp name + throwaway `@test.com` email. Created by you. |
| B | `003an00000ciBRjAAM` | test test | test@pointofrental.com | 2026-05-20 13:48 UTC | Alan Truett | **CONFIRM WITH ALAN FIRST** — attached to POR's own account. Likely Alan's manual sanity check; not yours to delete unilaterally. |
| C | `003an00000cJqGPAA0` | Christopher Tester | christopher.tester@wringgroup.co.uk | 2026-05-17 20:48 UTC | Kirk Bennett | **DO NOT DELETE** — real person at Wring Group (UK). LeadSource = ZoomInfo+Hunter. "Tester" is his actual surname. |

### Decision options (please mark each)

**Candidate A** (First08142024 / email@test.com): [ ] Delete now  [ ] Keep
**Candidate B** (test test / Alan Truett's): [ ] Ask Alan first  [ ] Delete anyway  [ ] Keep
**Candidate C** (Christopher Tester): leave alone — real prospect

### Stalled log rows (separate workstream)

8 `Lead_Inbound_Log__c` rows with `Status__c='received'` and no resolved
Lead/Contact. n8n execution IDs to inspect: `511510, 502816, 502457, 498487,
492030, 479940, 479522, 479210`. Not test data — these are real submissions
that stalled. Recommend Kirk check execution logs in n8n UI and either:
- Manually replay if the execution errored, or
- Update `Status__c='X_stalled_aborted'` if irrecoverable.

---

## Part 2 — Test-email replies

Source: `gmail-assistant` agent audit run 2026-05-26 against
`kirk.bennett@pointofrental.com`.

### Headline finding

**No confirmed cases of an automated "thanks for your demo request" email
reaching an external form submitter were found in Kirk's mailbox during
the shadow window (2026-05-10 → 2026-05-26).**

Key insight: n8n's `sub-notify` workflow sends **internal Slack DMs to AEs**,
not outbound confirmation emails to leads. External-facing demo confirmations
would originate from Salesforce email alerts, HubSpot, or ActiveCampaign —
not from the n8n migration.

### Candidates to investigate further (med confidence, not high)

| # | Thread | Date | Context | Reason |
|---|---|---|---|---|
| α | `19e4f90b2b33857f` | 2026-05-22 | Stripe webhook delivery issue to n8n live mode | Indicates a webhook delivery failure — IF n8n had a Stripe-triggered email flow, deliveries may have been silently dropped. Worth checking the n8n Stripe node. Not a test-email candidate per se. |
| β | WI-23326 / WI-23327 thread | 2026-05-15 to 2026-05-22 | Thomas Choi confirmed test form fills with WPForms 29710/29712/29714 | If Thomas used a real address on those tests, that recipient may have gotten a downstream notification. **Action: ask Thomas which email address he used in test fills.** |

### Recommended action

Instead of mass-replying, target the actual exposure surface:

1. Ask Thomas Choi which email address he used in the test fills (Asana
   comment on WI-23326 or Slack DM).
2. Check SF Setup → Email Alerts → filter by "RTFL" or "demo" to confirm
   whether any active alert action would have emailed a lead during shadow.
3. Check HubSpot Contacts created 2026-05-10 → 2026-05-26 with source=form,
   for any unintended welcome-sequence enrollments.

**Decision option:** [ ] Defer — no confirmed bad emails were sent from
Kirk's mailbox; the "reply to users they were tests" workstream may be
unnecessary. [ ] Run the 3 investigation steps above and re-evaluate.

---

## Sign-off

**Cleanup Part 1 decisions:**

- Candidate A: _________________
- Candidate B: _________________
- Stalled rows action: _________________

**Cleanup Part 2 decisions:**

- Investigation steps: _________________

Kirk Bennett · ____________________ · ____________
