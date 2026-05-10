# R360 n8n Migration — Marketing Setup Scope

**Audience:** Marketing Ops + R360 web team
**Owner:** Kirk Bennett (RevOps)
**Asana home:** *Marketing Ops (Major Initiatives)* — Pending Inputs section
**Status:** Inputs needed before n8n cutover (Day 0)

---

## Why this matters

We're migrating R360 lead capture off Zapier to n8n. RevOps owns the n8n workflows, the Salesforce metadata, and the cutover plan — all in flight. **Marketing owns two things only**, both summarized below. Without these, Day 0 is blocked.

---

## What we need from you

### A. Configure WPForms-Webhooks addon to POST every R360 form submission to n8n

**4 forms, 4 webhook URLs.** Each form fires its own webhook in real-time on submission.

| Form | Form ID | n8n Webhook URL | Purpose |
|---|---|---|---|
| Contact Sales (R360) | **29710** | `https://n8nweb.ec-ops.org/webhook/r360/contact-form` | Full inquiry — name + company + phone + UTMs |
| Watch a Video (R360) | **29712** | `https://n8nweb.ec-ops.org/webhook/r360/watch-video` | Email + click IDs only — gated content |
| Get a Demo (R360) | **29714** | `https://n8nweb.ec-ops.org/webhook/r360/get-demo` | Email + click IDs only — demo request |
| FAQ Form (R360) | **33076** | `https://n8nweb.ec-ops.org/webhook/r360/faq` | FAQ submissions — Google Sheets logging only |

**Step-by-step (per form):**

1. WordPress Admin → WPForms → Forms → open the form (e.g., #29710)
2. Settings → Webhooks (left sidebar) → click **Add Webhook**
3. Configure exactly:
   - **Webhook nickname:** `n8n R360 — {form name}` (e.g., `n8n R360 — Contact Form`)
   - **Request URL:** the URL from the table above
   - **Request Method:** `POST`
   - **Request Format:** `JSON`
   - **Secret:** *(leave blank for now — RevOps will add HMAC validation in Phase 2)*
   - **Request Headers:** none required for v1
   - **Request Body:** `Use entire form data` (default — sends all fields)
4. Click **Save**.
5. Repeat steps 1–4 for forms 29712, 29714, 33076.

**Verify (Marketing-side smoke test, takes 5 minutes):**

- Submit a test entry on each form using a test email (e.g., `r360-test-{date}@yourdomain.com`)
- Confirm WPForms shows the webhook fired in: Form → Entries → click entry → "Webhooks" tab → status **200 OK**
- RevOps will confirm in n8n that each test landed in `Lead_Inbound_Log__c`

**WPForms Webhooks addon prerequisite:** This is a paid WPForms addon (Pro plan or higher). If not already activated, Marketing needs to:
- Confirm WPForms license tier in WP Admin → WPForms → Settings → License
- If addon not present: WP Admin → WPForms → Addons → search "Webhooks" → install + activate
- License cost: included in any active Pro/Elite/Agency plan; no separate charge

**Reference docs:** [WPForms Webhooks addon documentation](https://wpforms.com/docs/install-and-use-the-webhooks-addon/)

### B. Slack channels — REUSING existing channels (no new channels needed)

**Decision (2026-05-10):** Per Kirk, don't create new R360-specific channels. Reuse existing channels that already host similar n8n traffic. RevTech Bot is already invited to all three.

| Use case | Channel | Why this one |
|---|---|---|
| Daily R360 lead report (8am Central) | **`C0AHXC6MXH6`** — n8n operational summaries | Already receives ADAT ETL Daily Digest + n8n global error handler posts. R360 daily lead summary fits the same pattern. |
| n8n → SF write failures | **`C02DJ9UVAET`** — `#sf-error-alerts` | Dedicated SF-error channel. Already receives posts from `Sf-Errors-Alert Notification`, `Referral Form Processor`, TrayIO heartbeat, and `R360 Location Rollup`. |
| Parallel-run + SDR/AE missed-lead feedback | **`C06T48V2A0J`** — `#sf-wins` | Sales-team-facing channel. SDRs already monitor it for closed-won deal posts and `Weekly Leaderboards`. R360 missed-lead triage threads land where the team is already looking. |

These channel IDs are baked into the n8n workflows directly — no env-var configuration step needed.

**Marketing's only Slack action:** confirm RevTech Bot is invited to `C06T48V2A0J` (`#sf-wins`) — it should be already, but worth a 30-second check by Marketing Ops since R360 missed-lead triage will start posting there during the parallel-run window.

### C. (Optional) Update WPForms field IDs if any have shifted since 2026-04

The build team relies on these field IDs in form 29710. If Marketing has touched the form recently and any IDs changed, **flag now**:

| Logical field | Form 29710 (Contact) | Form 29712 (Watch Video) | Form 29714 (Get Demo) |
|---|---|---|---|
| BusinessEmail | field13 | field7 | field7 |
| FirstName | field2 | — | — |
| LastName | field3 | — | — |
| CompanyName | field5 | — | — |
| PhoneNumber | field7 | — | — |
| YourIndustry | field6 | — | — |
| YourRegion | field14 | — | — |
| utm_source | field8 | — | — |
| utm_medium | field9 | — | — |
| utm_campaign | field10 | — | — |
| utm_term | field11 | — | — |
| utm_content | field12 | — | — |
| gclid | field17 | field10 | field10 |
| fbc | field18 | field11 | field11 |
| fbp | field19 | field12 | field13 |
| msclkid | field20 | field13 | field14 |
| ROIcalculator | field26 | — | — |

To verify: in WP Admin → WPForms → form → "Field IDs" plugin or via the WPForms preview JSON. Any drift = update RevOps in this Asana task.

---

### D. WordPress MySQL read-only credential

**Why:** real-time webhooks (§A) deliver leads. The DB read-only credential is the *audit* that proves no leads were dropped. n8n queries `wp_wpforms_entries` every 10 minutes, compares against the SF `Lead_Inbound_Log__c` table, and auto-replays any missing entries. Without this, we can't promise 100% lead capture.

**What we need:**
- DB host (e.g., `wp-r360-prod-db.cluster-xyz.us-east-1.rds.amazonaws.com`)
- DB name (typically `wp_r360` or similar)
- A read-only MySQL user with `SELECT` on `wp_wpforms_entries` only — NOT a superuser, NOT write access. Recommend creating a dedicated `n8n_readonly` user.
- Network access from n8n's IP (`n8nweb.ec-ops.org`'s outbound) to the DB host on port 3306. If the DB is in a private VPC, allowlist that IP.

**Scope:** read-only access to ONE table (`wp_wpforms_entries`). Nothing else.

**Where the credential goes:** RevOps adds it as an n8n credential (type: MySQL) — Marketing only needs to share the connection params, not configure n8n.

---

## What's deliberately NOT in this scope

| Item | Why not your problem |
|---|---|
| Salesforce metadata deploy | RevOps deploys to por-uat (validated, staged for prod) |
| n8n workflow imports | RevOps imports + activates the 16 workflows |
| Credentials in n8n (SF, Slack, Perplexity, OpenAI, Anthropic) | All already in n8n, reusing existing credentials |
| WP DB MySQL read-only access | **NOW IN SCOPE — see §D above.** RevOps still owns the n8n credential setup, but Marketing/web team owns the DB user provisioning. |
| Apollo enrichment | Skipped from v1 — Pre-Discovery brief still works with Perplexity-only |
| WHO sends Pre-Discovery webhooks | Salesforce Flow on Opportunity stage change (RevOps-built, separate workstream) |

---

## Timeline

| Day | Action | Owner |
|---|---|---|
| Day -7 | Marketing/web team provisions DB read-only credential (item D) | Marketing/Web |
| Day -7 | Marketing reads this doc, confirms WPForms addon is active, asks RevOps any open questions | Marketing |
| Day -5 | Marketing configures all 4 webhooks (item A) | Marketing |
| Day -5 | Marketing confirms RevTech Bot in `#sf-wins` (`C06T48V2A0J`) — 30-second check | Marketing |
| Day -3 | Marketing fires 4 test submissions (one per form), confirms 200 OK in WPForms | Marketing |
| Day -3 | RevOps confirms test entries in n8n + `Lead_Inbound_Log__c` | RevOps |
| Day -1 | Day 0 readiness gate (RevOps signs off) | RevOps |
| Day 0 | Phase A — production parallel-run begins | RevOps |
| Day 14 | Gate 4 sign-off — Marketing Ops is one of 6 required approvers | Marketing |

---

## Questions / blockers

Reply in this Asana task. Tag `@kirk.bennett@pointofrental.com` for anything ambiguous. RevOps will keep this doc updated as questions resolve.
