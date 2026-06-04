# RCA Evidence Dossier — sf-wins-notification missed a closed-won deal

**Date:** 2026-06-04 · **Reporter:** group-DM C09QU4G8G10 (kirk/erick/andy/paul)
**Symptom:** Opp `006an00000dB8DVAA0` ("AS Equipment & Rental llc-", $16,382.65 ACV, New
Business / New-Logo, owner Jon Hoffer) closed-won today but never posted to **#rev-wins**
(C06T48V2A0J).

## System under test
- n8n workflow `fpgmVTqw6CKdY4lg` = **sf-wins-notification** (active). Trigger: every 3 min
  (`*/3 * * * *`, America/Chicago).
- Pipeline: Salesforce Query → Lookup Posted Rows → Drop Already-Posted → Skip Renewals →
  (enrich account activity) → Format & Build Blocks → Threshold Gate ($1k) →
  Wins-Already-Posted Gate → Slack Post → Record Wins Post.
- Dedup ledger: n8n data-table `mQ12XpMTIJI9A8Sg`, keyed by `oppId`, cols `winsTs`/`alertTs`.
- Threshold: `meetsThreshold = acvUsd >= 1000`. Skip-Renewals gate drops `Type === 'Renewal'`.
- Full workflow JSON: `/tmp/wf_wins.json` (also backed up in this dir).

## The SOQL (Salesforce Query node) — the suspect
```
... FROM Opportunity
WHERE IsWon = TRUE AND IsClosed = TRUE AND CloseDate = TODAY
  AND Annual_Contract_Value_with_Downpayment__c > 0
ORDER BY CreatedDate DESC
LIMIT 50
```

## Hard evidence (all live-derived)
1. Opp matches the WHERE filter: querying the exact filter returns **80 rows**; target is present
   at **position 73** (ORDER BY CreatedDate DESC). ACV $16,382.65 ≫ $1k floor. Type=New Business
   (≠ Renewal). So it is NOT excluded by ACV, threshold, or Skip-Renewals.
2. Target `CreatedDate = 2026-05-05` (old). The 79 others are mostly created 2026-06-03/04
   (newer) — many small auto-generated "2026 Q2 Price Increase" renewals.
3. n8n execution 729187 (2026-06-04T19:24Z, post-close) — "Salesforce Query" node output:
   **returned exactly 50 rows**, target **ABSENT**, oldest CreatedDate returned = **2026-06-03**.
   Proof: `/tmp/exec_wins.json`. The target (created 2026-05-05) is older than every returned row
   ⇒ truncated by `LIMIT 50`.
4. All recent runs report **status=success** — no error thrown. Silent partial-coverage failure.
5. Blast radius: **80 ACV>0 closed-won today, only top-50-by-CreatedDate ever seen ⇒ 30 dropped
   today.** Of the 30 dropped, 8 are ≥$1k; 6 of those are `Renewal` (would be Skip-Renewals-gated),
   leaving **2 real wins** that should have posted: target ($16,382 New-Logo) and
   `006an00000gq8UMAAY` ("Add User for Equipment Rentals (STE)", $1,700.90, Existing Business/Expansion).

## Root cause (claim to verify/refute)
`ORDER BY CreatedDate DESC LIMIT 50` caps the candidate set at the 50 *newest-created* opps. On a
high-volume close day (today: 89 closed-won / 80 ACV>0), legitimately-closed deals whose
Opportunity record was *created* earlier sink past row 50 and are silently dropped. Ordering by
record-creation rather than close/modification time is the aggravating factor (a freshly-closed
older opp is treated as low-priority). No error fires because the node "succeeds" on the 50-row
subset.

## Proposed fix (to stress-test)
In the Salesforce Query SOQL, change the tail:
`ORDER BY CreatedDate DESC LIMIT 50`  →  `ORDER BY LastModifiedDate DESC LIMIT 200`
- LastModifiedDate DESC: a close updates LastModifiedDate, so just-closed deals are at the TOP and
  are never the ones near any cut; if the cap is ever hit, the dropped rows are the *oldest-
  modified* (least announce-worthy).
- LIMIT 200: ~2.2x headroom over today's 89. Dedup ledger makes re-runs idempotent (no double-post).
- Open questions for verification: (a) governor/response-size risk of LIMIT 200 with the inline
  Tasks(200)/Events(200) subqueries via the REST Query API + n8n pagination; (b) does n8n's
  Salesforce `query` honor SOQL LIMIT or auto-paginate; (c) any interaction with Skip-Renewals,
  Threshold Gate, or the dedup ledger that the fix could break; (d) is LIMIT 200 enough or should
  the limit be removed / the subqueries be deferred until after dedup.
