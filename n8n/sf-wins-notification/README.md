# sf-wins-notification — RCA + fix (2026-06-04)

n8n workflow `fpgmVTqw6CKdY4lg` ("sf-wins-notification"), every 3 min, posts closed-won
opportunities to **#rev-wins** (C06T48V2A0J) when ACV ≥ $1k and Type ≠ Renewal.

## Incident
Reported in group-DM (Andy Clark, 2026-06-04 19:17Z): opp **006an00000dB8DVAA0**
("AS Equipment & Rental", **$16,382.65 ACV, New Business / New-Logo**, owner Jon Hoffer)
closed-won today but **never posted to #rev-wins**. No error fired.

## Root cause (adversarially verified — 3 independent agents, high confidence)
The Salesforce Query node SOQL ended:
```
... WHERE IsWon=TRUE AND IsClosed=TRUE AND CloseDate=TODAY
    AND Annual_Contract_Value_with_Downpayment__c > 0
ORDER BY CreatedDate DESC LIMIT 50
```
- Today had **80 ACV>0 closed-won** opps (month-end renewal/price-increase flood). n8n **honors
  the SOQL LIMIT** (no auto-pagination — execution 729187's node output had exactly 50 rows).
- `ORDER BY CreatedDate DESC` ranks by **record-creation**, not close/modification time. The target
  opp was created 2026-05-05 (old), so it sorted to **row 73 of 80** and was cut off by `LIMIT 50`.
  The pipeline never saw it; the run still reported `status=success` → **silent partial-coverage drop.**
- Confirmed not caused by: dedup ledger (no row for target), Skip-Renewals (New Business),
  Threshold ($16k ≥ $1k), or alert-branch. All would have passed it.
- Recurrence: this silently drops legitimately-closed older-created deals on every high-volume
  close day, not a one-off.

## Fix
SOQL tail → `ORDER BY LastModifiedDate DESC, Id DESC LIMIT 200`
- **LastModifiedDate DESC**: a close bumps LastModifiedDate, so just-closed deals float to the TOP
  (target moved from rank 73 → rank 8). If the cap is ever hit, the dropped rows are the
  *oldest-modified* (least announce-worthy), never a fresh close.
- **LIMIT 200**: ~2.5× headroom over daily volume; returns all of today in one page; governor risk low.
- **, Id DESC**: stable secondary tie-break (removes non-deterministic boundary flip on a future
  >200-close day). Deployed via PUT (HTTP 200, 32/32 nodes preserved, `binaryMode` preserved
  server-side, `active` unchanged).

## Verification (live, in prod)
Next cron run (2026-06-04 21:18Z) posted the backlog the bug had suppressed — **3 legitimate wins,
zero double-posts** (the 9 prior ledger rows untouched; idempotency via the server-side oppId
Wins-Already-Posted gate held):
| Opp | Account | Type | ACV | Result |
|---|---|---|---|---|
| 006an00000dB8DVAA0 | A S Equipment and Rental | New-Logo | $16,382.65 | ✅ posted (the reported deal) |
| 006an00000h4ME7AAM | RP Rents, LLC | Expansion | $7,144.54 | ✅ posted |
| 006an00000gq8UMAAY | Sooke Tools & Equipment (STE) | Expansion | $1,700.90 | ✅ posted |

## Known latent issues (not this incident; logged, not fixed here)
- Dedup data-table lookups (`Lookup Posted Rows`/`Lookup Wins Row`/`Lookup Alert Row`) GET the
  `/rows` endpoint with no `nextCursor` handling. Benign today (ledger = 12 rows, one page); once it
  exceeds a page the coarse `Drop Already-Posted` dump sees a partial set — can only cause a
  *double-post*, never a miss (the authoritative per-channel gate uses a server-side oppId filter).
- `CloseDate = TODAY` is evaluated in the running user's timezone; near midnight America/Chicago a
  TZ mismatch could shift which calendar day counts. Latent boundary risk.

Artifacts: `RCA-evidence.md` (evidence dossier), `workflow-live-backup-pre-rca.json` (pre-change
snapshot), `sf-wins-notification.workflow.json` (deployed definition).
