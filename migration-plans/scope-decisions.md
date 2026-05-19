# R360/POR Migration — Scope Decisions

Authored: 2026-05-18
Status: Open for IN/OUT-of-scope decisions

## Known minor follow-ups (status as of 2026-05-19)

- **FU-1: EU click ID propagation** — ✅ DONE. R360 + POR resolvers patched to carry gclid/fbc/fbp/msclkid through the Decide-path output. Verified end-to-end: Lead `00QW400000LKdHFMA1` (POR EU) populated with all 4 click IDs.
- **FU-2: R360 writer Plauti-fallback** — ✅ DONE (mirrored from POR). 4-node fallback chain added: Detect → Query Lead by exact email → Build Path-B body → Update. Defensive code — rarely fires today since R360 ContactForm + no-match goes `X_no_record_skipped_contactform` (§5.4), never reaching Create Lead. Active safety net for any future R360 form that exercises Path A4b.
- **FU-3: UAT RTFL Case Flow error** — KNOWN UAT-ONLY. The "RTFL Case After Trigger" Flow in UAT sends an email from an unverified domain → blocks POR Case creates with `email address domain isn't verified`. PROD has the verified domain, so the Flow succeeds there. Workaround in UAT: POR writer's `SF HTTP: Create Case (Path C)` uses `onError: continueRegularOutput` so the writer chain completes (Inbound_Log marked written, Contact updated) even when the Case create errors. No code change needed for prod cutover.



For each item: **what it does, why it matters, build scope, effort, dependencies, risk-if-skipped, recommendation, and clean exclusion path.**

---

## ITEM 1 — Wire POR sub-notify templates

### TL;DR
POR writer emits `template='lead_created_por'/'lead_updated_por'/'contact_AM_por'/'contact_SDR_por'` but `sub-notify` only knows the 5 R360 templates → POR Lead writes happen silently, no AE notification. Adding 4 POR-side template Set nodes + 4 Switch rules closes the gap.

### What it does
When a POR form fill creates/updates a Lead in UAT (shadow), the writer's final-update payload includes a `template` field. The shared `sub-notify` workflow routes on `$json.template`. Right now, POR templates are emitted but unmatched → Switch outputs 0 items → no Slack DM, no Gmail.

### Why it matters
Without notifications, the AE doesn't know a R360-or-POR Lead was just created in their queue. For R360 the channel post fires; POR has the same data ready to fire but sits unrouted. Sales follow-up SLA suffers in shadow comparison (n8n looks slower than Zapier even though n8n already wrote the data).

### Build scope (concrete artifacts)
- 4 new `Set: Template *_por` nodes in `Hx2Zi7z2rKoqKSSE` (sub-notify)
- 4 new rules in `Switch: 5 templates` (rename to `Switch: 9 templates`) — match on `lead_created_por`/`lead_updated_por`/`contact_AM_por`/`contact_SDR_por`
- POR message text: same fields as R360 with POR-specific Salesforce link, "POR Lead" header, region prefix
- Posts to the SAME channel `C06TTMZB3RA` (or a separate POR channel if you want POR/R360 split)
- Gmail recipients from `NotificationEmail` already passed through from POR Assignment Owner code

### Effort
~30 minutes. Pure n8n config — clone R360 templates, search-replace R360 → POR, link template_name → switch rule.

### Dependencies
- None. POR writer already outputs `template` correctly.
- Decision needed: same channel (`C06TTMZB3RA`) or separate POR channel?

### Risk if SKIPPED
- POR writes happen silently. AE only sees the lead when they happen to look at the Lead list.
- Shadow comparison appears "slower" than Zapier (no real-time notification).
- Discoverable via daily LeadOps cron and email lists — but lag is hours not minutes.

### Recommendation
**IN scope.** Tiny build, closes a real observability gap.

### Clean exclusion path
Leave `template='lead_created_por'` etc. orphaned in sub-notify Switch → no error, just silent. POR rows in Inbound_Log still record the would-be template name. Can re-enable later without code changes.

---

## ITEM 2 — Plauti DupCheck-fallback in POR (and R360) writer

### TL;DR
When resolver's SOQL fuzzy match misses an existing record but Salesforce-side Plauti DupCheck blocks the create with "Please use one of the existing records" → writer should catch the error, re-query by email, and Update instead of giving up.

### What it does
Adds a new error-recovery branch after `SF HTTP: Create Lead (38 fields)`. If response is HTTP 400 with `dupcheck__dc3*` error message OR `DuplicateException`:
1. Run a tight SOQL query: `SELECT Id FROM Lead WHERE Email='<exact>' AND IsConverted=false ORDER BY LastModifiedDate DESC LIMIT 1`
2. If found → branch into Path-B-style Update Lead (set `_sf_record_id`, fire `SF HTTP: Update Lead`)
3. If still not found → fall through to current error handler (Inbound_Log Status='failed')

Mirrors original Zap node `253294318` ("Update Lead after Create fail") which the POR Zapier code has but my port omitted.

### Why it matters
Discovered today during POR Path B smoke test: resolver said A4b (no match) but Plauti caught the duplicate → Create errored. Result: Lead never updated, Inbound_Log stuck at 'received'. Real-world impact: Plauti's matching is stricter than our SOQL fuzz, so this WILL happen in production for emails where (a) firstName doesn't appear in existing email's local part, AND (b) Plauti has a phonetic/fuzzy match.

Estimated frequency: probably 5-15% of all submissions based on R360 patterns we've seen.

### Build scope
- New IF node: "IF: Plauti duplicate error" — checks `$('SF HTTP: Create Lead').first().error.description` for `dupcheck__dc3` or `duplicate`
- New SF HTTP node: `Query SF for existing Lead by exact email`
- New IF: "Lead found post-Plauti?"
- New Code node: Build Lead update body (Path B-style)
- New SF HTTP: Update Lead (Path B)
- Reuse downstream CampaignMember + final-update chain
- Apply same to R360 writer (same flaw exists there)

### Effort
~2 hours for POR side, +1 hour to mirror in R360.

### Dependencies
- None — uses existing Plauti error format and existing SF HTTP nodes.

### Risk if SKIPPED
- ~5-15% of resubmissions silently fail with Status='received' (writer errored on Plauti-blocked create).
- These are existing Leads being re-submitted; data IS already in SF but the resubmission data (newer UTMs, region, phone) is lost.
- Original Zapier handled this gracefully — leaving it out is a regression.

### Recommendation
**IN scope** — this is a real bug we just discovered. Without it, we silently drop ~10% of resubmissions on existing-Lead scenarios.

### Clean exclusion path
The current "Status='received' forever" rows are visible via the daily comparison script. Can build a manual cleanup query if not auto-fixing. But it's a data-quality regression vs Zapier, so excluding is a step backward.

---

## ITEM 3 — Verify POR Path B/C/D end-to-end with real existing records

### TL;DR
Path A4b is verified for POR. Path B (update existing Lead), C (update Contact + Case for Customer), D (update Contact for Prospect, no Case) follow the same structure as R360 but with POR-specific bodies — they need empirical verification against real UAT records, not just inherited confidence from the R360 verification.

### What it does
Fire 3 targeted webhook tests against POR receivers:
- Path B: existing UAT Lead matching POR resolver's fuzzy criteria → verify POR_Record__c=true, POR custom fields populated, Lead Most_Recent_Pardot_Form set to "Book A Demo"
- Path C: existing UAT Contact under an `Account.Status__c='Customer'` Account → verify Contact updated AND Case created with POR Case body (Subject = "{region} - Book a Demo - Sales Form Fill", BusinessHoursId, Campaign__c)
- Path D: existing UAT Contact under a non-Customer Account → verify Contact updated with MQL__c=true, dupcheck flag, no Case

### Why it matters
POR field bodies differ from R360 in ~15 fields per path. Any typo/inversion could silently misfire (wrong field name, wrong picklist value, FLS issue on POR-specific fields). Currently we've only validated A4b — the other 3 paths are structurally inherited from R360 but with POR-specific code.

### Build scope
- 3 test fires with specific email/name combinations against existing UAT records
- 3 verification SOQL queries (Lead state, Contact state, Case state)
- If any path fails: debug + fix → re-test until green
- Document in test results

### Effort
~45 minutes if all three pass clean. ~2-4 hours if Path C/D hits FLS issues on POR fields (e.g., `Inside_Lead_Sales_Notes__c`, `Discovery_Notes__c`, `Queue_Region__c`) — would require permset additions for those fields.

### Dependencies
- Need existing UAT Leads/Contacts whose email local part matches a submittable first/last name (limitation of resolver fuzzy match — same as R360)
- Need an existing UAT Contact under an `Account.Status__c='Customer'` Account for Path C — Michael Kellum (`003an00000biG8fAAE`) under M & R Equipment Rental fits
- Need an existing UAT Contact under non-Customer Account for Path D — Rachel Ireland (`003an00000bjOTuAAM`) under Fortress Hire fits

### Risk if SKIPPED
- POR paths B/C/D could fail silently in production for ~30-40% of submissions (the majority that match existing records).
- Real-world: shadow looks clean (Inbound_Log shows decisions), but the actual Lead/Contact updates may not be writing all POR custom fields → POR sales reps see incomplete records.
- Could be discovered weeks later when a sales rep complains "where's my POR-specific field data?".

### Recommendation
**IN scope** — verification is mandatory before claiming POR shadow is "complete". 45-min happy-path validation; longer only if FLS gaps surface (and those are 1-line permset additions).

### Clean exclusion path
Mark POR Path B/C/D as "structurally cloned from R360, empirically unverified" and rely on daily comparison + sales team feedback to catch regressions. Acceptable for shadow mode; not acceptable for production cutover.

---

## ITEM 4 — Verify POR EU branch end-to-end

### TL;DR
POR has a region-conditional code path: when `formattedRegion` matches "Europe", the writer applies different IDs (EU Lead RT `0120L00000098ftQAA`, EU click ID fields, EU owner queue `00G0L000004WbEDUA0`, Marcus Sutton as AE). Currently never tested.

### What it does
Fire POR 64681 with `field17='Europe'` → trigger the `isEU=true` branch in the POR resolver's Decide-path code. Verify:
- Lead create: `RecordTypeId='0120L00000098ftQAA'` set
- Lead create: `gclid__c`, `fbc__c`, `fbp__c`, `msclkid__c` populated from fields 41-44
- Lead create: `OwnerId='0054u000008m3w6AAA'` (Marcus Sutton, EU SDR)
- Lead create: `NotificationEmail` includes Marcus + uksdr group
- For Path C (Contact + Customer): Case OwnerId hardcoded to `00G0L000004WbEDUA0` (EU queue)
- Region-aware Assignment Owner mapping (currently uses single switch case for Europe)

### Why it matters
EU has GDPR implications. EU leads should NOT route to NA AEs (compliance/data residency). The current code SHOULD route them correctly, but it's untested. Misrouting EU leads is a real GDPR risk.

### Build scope
- 1 webhook fire with EU region
- SOQL verification of EU-specific field assignments
- Compare to Zap node 253553521 EU behavior (acknowledgment email FROM `noreply@pointofrental.com`, EU click IDs, EU RT)
- If EU branch fails: debug — likely missing `isEU` check, missing EU RT FLS, or wrong queue ID

### Effort
~30 minutes happy path. ~1 hour if EU RT FLS isn't granted to POR Integration user in UAT.

### Dependencies
- An existing UAT Lead with R360_Record__c=true under EU region (use any UAT record), OR fire A4b with new EU email (test creates a fresh EU Lead).
- POR Integration user in UAT needs FLS on Lead.RecordTypeId for EU RT (should be standard — RT is a Lead system field).

### Risk if SKIPPED
- EU leads create with R360 default RT (or non-EU default) instead of EU POR RT.
- EU leads owned by Hunter Ellison (NA AE default fallback) instead of Marcus Sutton.
- EU click IDs (gclid/fbc/fbp/msclkid) dropped — attribution data loss for EU campaigns.
- GDPR routing concern: EU lead data accessible to NA AEs via OwnerId fan-out.

### Recommendation
**IN scope.** EU compliance + attribution data warrant at least one happy-path verification.

### Clean exclusion path
Skip until first real EU production submission goes through, then verify post-hoc. Acceptable IF shadow comparison flags EU misrouting within 24h.

---

## ITEM 5 — Extend Daily LeadOps Report cron for POR counts

### TL;DR
The existing R360 cron `4PuQj5mLlt7pXHYl` posts a daily Slack summary at 8am Central with R360 traffic counts. POR submissions don't appear in the digest. Add 3 POR sources to the report's SOQL and breakdown.

### What it does
Modifies the SOQL query in `R360 Cron: Daily LeadOps Report` from:
```
SELECT Source__c, Status__c, COUNT(Id) FROM Lead_Inbound_Log__c
WHERE CreatedDate=YESTERDAY AND Source__c IN ('wpform_29710','wpform_29712','wpform_29714','bot_r360','webhook_pre_discovery')
GROUP BY Source__c, Status__c
```
to also include `wpform_64681`, `wpform_64783`, `bot_por`.

Slack message format becomes:
```
:bar_chart: R360 + POR Daily LeadOps Report — YYYY-MM-DD
─────────────────────────────────────────
R360:
  ContactForm: 12 (10 written, 1 X_skip, 1 received)
  WatchVideo: 5 (3 email_only_tracked, 2 X_skip)
  ...
POR:
  ContactUs: 24 (20 written, 3 received, 1 X_skip)
  CustomerContact: 1 (1 written)
  Bot: 0
```

### Why it matters
RevOps lead's morning visibility. Currently you'd only see R360 numbers; POR submissions are invisible in the digest. With ~5,150 POR 64681 entries lifetime + active production traffic, POR will be the larger volume soon.

### Build scope
- 1 SOQL string change in `Code: Build SOQL` node
- 1 message-format change in `Code: Build Slack message` node (add POR section)
- Optionally: separate R360 and POR into 2 Slack messages (channels differ?), or merge

### Effort
~20 minutes.

### Dependencies
- None.

### Risk if SKIPPED
- POR traffic invisible to morning RevOps standup.
- POR-side trends (sudden traffic drop, sudden spike, X_skip rate climbing) go undetected until they show up in revenue reports.
- Daily comparison script `/tmp/shadow-comparison.sh` already shows POR counts, but you'd have to run it manually.

### Recommendation
**IN scope.** 20-minute fix, real value.

### Clean exclusion path
Run `/tmp/shadow-comparison.sh` manually each morning instead.

---

## ITEM 6 — Verify POR DB reconciliation cron is firing

### TL;DR
POR DB recon cron `tza5WF0jMA8VLia0` runs every 10 minutes pulling from `wp_por.wp_wpforms_entries`. Need one execution-trace confirmation that:
1. SSH command succeeds (key auth works against POR install)
2. mysql query returns rows
3. Parse step extracts entries correctly
4. Diff vs SF Inbound_Log identifies missing
5. Replay HTTP fires correctly to per-form receivers

### What it does
Wait for next scheduled run (≤10 min) and inspect the execution. Or manually trigger via execution API. Validate the round trip pulled real entries (entry 8044, 8045, etc. that already came in today).

### Why it matters
Reconciliation is the safety net for missed webhooks. If a real-time webhook fails (n8n down, network issue), the cron picks it up within 10 min. If the cron itself is broken, we silently lose entries.

### Build scope
- Trigger manually via `POST /workflows/<id>/execute` (or wait)
- Inspect exec trace for SSH/mysql success
- If broken: debug (likely SSH cred path or DB credentials)

### Effort
~15 minutes.

### Dependencies
- POR SSH credential `2FG7uSHOHb43CNMt` — verified earlier with manual SSH
- POR DB user `por` / password — verified earlier with manual query

### Risk if SKIPPED
- Real-time webhook receivers handle the happy case. Recon is failure-mode safety.
- If webhook fails AND recon also broken → entries lost silently.
- Acceptable for v0 shadow IF you trust the real-time webhooks (which work in R360 today).

### Recommendation
**IN scope** — 15-minute verification.

### Clean exclusion path
Disable the cron entirely and rely on real-time webhooks. Accept the risk that webhook failures lose entries until manually replayed.

---

## ITEM 7 — Pre-Discovery webhook (build plan §8)

### TL;DR
The biggest remaining R360 feature. A separate webhook receives `accountId, contactId, ownerEmail` from an external trigger (e.g., new R360 demo scheduled), generates a deep AI research brief (Perplexity + Apollo + ChatGPT 5.1), DMs the AE on Slack, and writes the brief HTML to the Contact's `Record360_AI_Contact_Brief__c` field.

### What it does
1. Webhook receives `{ accountId, contactId, ownerEmail }` (18-char SF IDs + email)
2. Halts on missing input
3. SF lookups: Account (Name/Website/ShippingCountry), Contact (Name/email/phone/MobilePhone), User by ownerEmail (Slack_ID__c)
4. Apollo enrich on Contact → MobilePhone if missing (min confidence 70%)
5. **Perplexity sonar-deep-research** call (128k tokens, 60-120s latency) with R360-branded 14-section research-brief prompt — limited to tech-stack scope (Wynne / Texada / POR / Alert / Infor / CDK / Karmak / Fleetio)
6. **ChatGPT gpt-5.1** call (400k tokens, reasoning: high, web_search_preview: enabled) with 9-section R360 brief template (Damage Disputes, Process Compliance, Recovery & Billing, etc.)
7. Convert ChatGPT Markdown output → HTML for SF rich-text field
8. SF Contact PATCH: `Record360_AI_Contact_Brief__c` (HTML) + `R360_Last_AI_Contact_Brief__c` (timestamp)
9. Slack DM to AE (`SF_User.Slack_ID__c`) + 2 fixed recipients (`U02HR1T6PBK`, `U01B0955NEQ`)

### Async pattern
Must return HTTP 200 immediately (Perplexity alone can hit 120s; HTTP webhooks shouldn't block that long). Implement via n8n queue mode with worker pool.

### Why it matters
This is the AI brief automation that gives R360 AEs deep prospect context before discovery calls. Currently happens manually OR via existing Zapier code (Zap 336544812). It's a high-touch, executive-visible feature.

### Build scope
- 1 new webhook receiver workflow (Pre-Discovery)
- n8n queue mode + Redis + Postgres setup verification (might already be running)
- Perplexity API credential in n8n
- Apollo API credential
- OpenAI API credential (gpt-5.1 access)
- 14-section Perplexity prompt template (verbatim from `spec_pre_discovery_ai_notes.md`)
- 9-section ChatGPT prompt template (verbatim)
- Markdown → HTML conversion code (handle Slack `<URL|Label>` vs HTML href, preserve formatting)
- SF Find User by email → Slack_ID__c lookup
- Slack DM with Block Kit JSON template + 3-recipient list
- Error paths: Perplexity 120s timeout (Apollo continue), Apollo 0-result (continue), GPT token limit (fallback), Slack_ID__c missing (fallback to email)
- 4 new component test cases (per build plan §8.11)

### Effort
~6-10 hours for end-to-end implementation. Significant per-API config + prompt fidelity work.

### Dependencies
- **Perplexity API key** (need account; estimate cost: ~$1-5 per brief at sonar-deep-research)
- **Apollo API key** (need integration plan)
- **OpenAI API key** with gpt-5.1 access (need to verify enterprise tier)
- **n8n queue mode** must be configured (Redis + Postgres + worker pool)
- **2 Slack User IDs** for fixed recipients (already known: `U02HR1T6PBK`, `U01B0955NEQ`)
- **SF Custom field**: `Record360_AI_Contact_Brief__c` (rich text, 131072 chars) — exists?
- **SF Custom field**: `R360_Last_AI_Contact_Brief__c` (DateTime) — exists?

### Risk if SKIPPED
- AEs walk into discovery calls without AI-generated prospect briefs (same as today minus the Zapier version).
- Lose the "executive demonstrability" of having AI-powered R360 sales prep.
- Zapier's existing version stays alive forever (separate decommission concern).

### Recommendation
**OPTIONAL / DEFER to phase 2.** Big build (6-10 hours), 3 paid API dependencies (Perplexity + Apollo + OpenAI), and the existing Zapier version continues to function. Migrating it doesn't unlock new value — it just moves the work. Better to ship R360+POR cutover first, then port Pre-Discovery as a v1.1 feature.

### Clean exclusion path
Leave the existing Zapier Pre-Discovery zap (336544812) running indefinitely. Document it as "out of n8n migration scope; remains in Zapier." Zapier task cost: ~50-200 tasks/month at current volume, well within plan limits.

---

## ITEM 8 — R360 prod cutover

### TL;DR
Per build plan §16, flip n8n shadow workflows from UAT → PROD URLs, then disable Zapier in stages (Watch Video → Get a Demo → Contact Form → Pre-Discovery, 24h between each). 14-day parallel-run validation required first.

### What it does
**Phase A (parallel-run, days 1-14):**
1. Create n8n PROD SF OAuth credential (browser flow as `roberto.hernandez@pointofrental.com`)
2. Run URL-flip script: swap `por--uat.sandbox.my.salesforce.com` → `por.my.salesforce.com` on every HTTP node in resolver/writer/sub-notify/error-handler/crons
3. Swap cred references: `JUyr1xCnPHSkU1tm` ([RH] UAT) → new prod cred ID
4. Activate `R360 Cron: Parallel-Run Reconciliation` (`JlL2dlRxBCEooKO0`, currently inactive)
5. Set up `#r360-leads-parallel-run` Slack channel + SDR/AE feedback loop
6. Run nightly `audit-lead-capture.sh` script (per build plan §15.8)
7. Daily standup green/yellow/red verdict
8. Gate 4 sign-off (Lead-Capture Sign-off — added as new gate in build plan §15.7)

**Phase B (staged decommission, days 15-20):**
- Day 15: Disable Zaps 316698017 (Watch Video) + 316701470 (Get a Demo) — lowest-risk first
- Day 16: Disable Zap 316797350 (Contact Form)
- Day 17: Disable Zap 332679789 R360 path (Bot R360 branch)
- Day 18: Disable Zap 316797554 (central processor)
- Days 19-20: Disable Pre-Discovery + FAQ zaps
- 24-48h monitoring between each, with automatic re-enable trigger if `n8n received-rate < 99.9%`

**Phase C (30-day enhanced monitoring, days 21-30).**

### Why it matters
- This is the actual cutover. Until done, Zapier continues to run + cost money + represent technical debt.
- Single source of truth for R360 lead routing (eliminates dual-write risk).
- Unblocks downstream features: Pre-Discovery brief automation, parallel-run validation closure, deprecated Zap account cancellation.

### Build scope
- URL-flip script (already designed — just runs once cred is created)
- Prod n8n SF OAuth credential creation (browser action by you)
- Parallel-Run Reconciliation cron activation + Zapier API token to pull task history
- Slack channel provisioning
- `audit-lead-capture.sh` script (referenced but probably needs to be written/finalized)
- Gate 4 sign-off checklist artifact
- Staged decommission runbook
- ~34 hours of RevOps operational time over 60 days (per build plan §16 estimate)

### Effort
- Implementation: ~4-6 hours
- Parallel-run validation window: 14 days
- Staged decommission window: 6 days
- Total elapsed time: 20-30 days
- Hands-on time: ~34 hours spread across 60 days

### Dependencies
- **Prod n8n SF OAuth cred** — must be created via browser OAuth flow (you do this; can't be API-only)
- **Zapier API token** — for reconciliation cron to pull task history
- **Slack channel `#r360-leads-parallel-run`** + bot perms
- **Lead-Capture Sign-off** by SF Admin, Sales Ops, Marketing Ops, RevOps lead, SDR Manager, AM Manager
- All previous R360 work shippable (✅ done)
- POR shadow framework operational (✅ done)

### Risk if SKIPPED
- Zapier remains the source of truth forever. n8n is "shadow forever" — wasted infrastructure.
- All the build plan §5-7 work was preparation for this cutover. Skipping = abandoning the migration.
- Zapier task cost continues (~$200-500/month based on volume).

### Recommendation
**IN scope, but timing is yours.** Recommend: 1 week of additional shadow-mode observation to gather signal, then start Phase A on a Monday so the 14-day window doesn't straddle a weekend. Phase B can be kicked off after Lead-Capture Sign-off.

### Clean exclusion path
Stay in indefinite shadow. n8n keeps tracking everything in UAT; Zapier keeps writing to prod. ~$200/month wasted on dual infrastructure, but no migration risk taken.

---

## ITEM 9 — Sunset forms 51987 + 53115

### TL;DR
Two POR WPForms (51987 with 277 entries lifetime, 53115 with 308 lifetime) that the user said to "kill" / "sunset". These are NOT n8n work — they're Marketing config in WPForms admin.

### What it does
- Marketing logs into WPForms WP admin
- Forms 51987 and 53115: either disable the WPForms Webhooks Addon for these forms, OR archive the forms entirely
- No n8n action needed (n8n doesn't have receivers for these form IDs — they're naturally ignored)

### Why it matters
- Stops sending submissions from these forms to webhooks (n8n or Zapier) — clean exit.
- Reduces noise in WPForms admin (archived forms don't clutter active list).
- Confirms intent: these forms are dead for business reasons (probably redundant or replaced by other forms).

### Build scope
- 1 Asana follow-up to Thomas Choi / Marketing
- Verification SOQL post-sunset: confirm no new Lead_Inbound_Log__c rows arrive from these form IDs

### Effort
~10 minutes (mostly the Asana comment).

### Dependencies
- Marketing access to WPForms admin (Thomas).

### Risk if SKIPPED
- Forms continue running. n8n doesn't process them (no receiver). Zapier MAY still process them (depends on Zap setup).
- If Zapier still processes them, they continue creating Leads in prod SF. After n8n cutover, those Leads become orphaned (no n8n equivalent).
- Cleanest path: kill them at the source.

### Recommendation
**IN scope** for cleanliness. Marketing-side action, not n8n work.

### Clean exclusion path
Leave forms running, let Zapier continue handling them, manually clean up the resulting Leads quarterly. Eventually disable when convenient.

---

## ITEM 10 — POR forms not yet in scope

### TL;DR
POR `wp_wpforms_entries` has lifetime entries for many form IDs we haven't wired:
- **52153** (887 entries) — name unknown, mid-volume
- **61711** (347)
- **52760** (151)
- **43036** (134)
- **103125** (108)
- **48887** (56)
- **58710**, **59520**, **53025**, **65985**, **75809**, **53081** (all < 50)
- Several singletons

Plus the wired ones: 64681 (5,150) + 64783 (33).

### What it does
For each form, we'd need to:
1. Confirm what the form is (Marketing knows; we don't)
2. Decide: in-scope (build receiver) or out (silently ignore)
3. If in-scope: sample 1 entry to discover field IDs (they vary per form), build a receiver + Source__c picklist value

### Why it matters
- We agreed to wire `64681` + `64783`. Others go silently to Zapier or nowhere.
- Combined lifetime volume of unwired forms = ~1,800 entries (vs 64681's 5,150).
- Some may be high-traffic in current periods (need recent-volume check, not lifetime).

### Build scope (per form)
- Discover schema (5 min via SSH query)
- Add `wpform_<id>` picklist value (deploy to UAT + prod)
- Clone POR 64681 receiver as template
- Configure Marketing webhook in WPForms admin
- Test end-to-end

~30-45 min per form once Marketing confirms what each one is.

### Effort
- Discovery + Marketing conversation: ~1-2 hours total
- Per-form build: 30-45 min each (~6 hours for 10 forms)

### Dependencies
- Marketing input on which forms are "real" Lead sources vs internal/test forms
- Marketing access to add webhook URLs

### Risk if SKIPPED
- Those forms continue working in Zapier (if wired) or go nowhere.
- After R360 cutover, POR-side stays mixed until decided.

### Recommendation
**DEFERRED / phased in.** Don't block migration on this. Get Marketing's inventory of "active POR forms that produce Leads" first, then prioritize the high-volume ones. Likely 3-4 forms are real; rest are sunset candidates.

### Clean exclusion path
Document "v1.0 POR scope = 64681 + 64783 only" in the build plan. Leave other forms in their current state (Zapier or silent). Decide on a per-form basis as Marketing confirms intent.

---

## Summary Decision Matrix

| # | Feature | Effort | Risk if skipped | Recommendation | Exclude cleanly? |
|---|---|---|---|---|---|
| 1 | POR sub-notify templates | 30 min | Medium (silent POR writes) | IN | Yes — leave template unrouted |
| 2 | Plauti-fallback in writer | 3 hrs | High (~10% submissions silently fail) | IN | Possible — accept regression vs Zapier |
| 3 | POR Path B/C/D verify | 45 min | High (paths unverified empirically) | IN | No — must verify before prod |
| 4 | POR EU branch verify | 30 min | High (GDPR/compliance risk) | IN | Possible — verify post-hoc |
| 5 | Daily LeadOps + POR | 20 min | Medium (POR invisible in digest) | IN | Yes — run manual script |
| 6 | POR DB recon verify | 15 min | Low (real-time webhooks handle happy path) | IN | Yes — disable cron |
| 7 | Pre-Discovery webhook | 6-10 hrs + 3 paid APIs | Low (Zapier version keeps running) | OPTIONAL / DEFER | Yes — leave in Zapier |
| 8 | R360 prod cutover | 4-6 hrs + 60-day operational window | High (n8n stays in shadow forever) | IN (timing yours) | Yes — stay in shadow |
| 9 | Sunset 51987 + 53115 | 10 min (Marketing action) | Low | IN | Yes — manual cleanup quarterly |
| 10 | Other POR forms | 30-45 min/form | Low (forms keep current state) | DEFER | Yes — document scope = 64681 + 64783 only |

## Quick filters for your decision

**Smallest possible scope to declare "shadow mode complete":**
- Items 1, 3, 4 (verifications + observability gap)
- = ~2 hours

**Smallest possible scope to declare "production ready":**
- Items 1, 2, 3, 4, 8 (above + Plauti-fallback + cutover)
- = ~14 hours + 60-day window

**Everything except Pre-Discovery and stray POR forms:**
- Items 1-6, 8, 9
- = ~17 hours + 60-day window

**Hard exclusions (recommended OUT regardless):**
- Item 7 (Pre-Discovery) — too much for v1.0; leave in Zapier
- Item 10 partial (other POR forms beyond 64681/64783) — defer pending Marketing inventory

Let me know which items to include/exclude and I'll execute the included ones.
