# R360 Africa Triage — Human-in-the-Loop MQL Decision

**Branch:** `feat/r360-africa-triage-branch`
**Owner:** Kirk Bennett · **Created:** 2026-05-26

## What this delivers

When a lead comes in with `formattedRegion = 'Africa'`, instead of auto-routing
into normal MQL assignment, the workflow now:

1. Logs the submission to `Lead_Inbound_Log__c` with `Status__c = 'africa_pending'`.
2. Posts an interactive Slack message with **SF context, lead detail, and two
   action buttons (Continue / Kill)** to Dean Hammond and Kirk Bennett (DMs).
3. Posts a visibility-only notification to `#marketing-lead-errors`.
4. Pauses the n8n execution on a Wait/resume webhook.
5. On click, the resolver resumes:
   - **Continue** → flows back through `Code: Assignment Owner` and into the
     normal writer (Path A4b / B / C / D depending on SF dedup state).
   - **Kill** → terminates. `Lead_Inbound_Log__c.Status__c = 'africa_killed'`.

**Non-Africa regions are not impacted.** The `IF: Africa triage?` FALSE branch
routes directly to the original `Code: Assignment Owner` node, byte-identical
to the pre-patch behavior. Verified by the regression test (`tests/regression-test.mjs`).

## Files

```
deliverables/r360-africa-triage/
├── n8n/
│   └── sub-r360-africa-triage.json     # New sub-workflow
├── tests/
│   └── regression-test.mjs              # 47-assertion regression suite (node ≥ 18)
└── runbooks/
    └── README.md                        # This file
```

The resolver patch (3 new nodes + 1 rewired connection) is in:
`deliverables/r360-n8n-migration/n8n/sub-r360-resolver.json`.

## Deployment steps (UAT first, then PROD)

### 1. Import `sub-r360-africa-triage.json`

```
n8n UI → Workflows → Import from File → select
deliverables/r360-africa-triage/n8n/sub-r360-africa-triage.json
```

After import, capture the new workflow ID. It will look like
`abc123XYZ` (8–16 chars). Replace `AFRICA_TRIAGE_PLACEHOLDER` in two places:

- `meta.id` of the imported workflow (auto-set by n8n)
- The `workflowId` field of `Execute: sub-r360-africa-triage` node in
  `sub-r360-resolver.json` (you'll re-import this in step 3)

### 2. Bind credentials

In the imported `sub-r360-africa-triage` workflow:

- All 3 Salesforce nodes: bind to `[RH] UAT` (UAT) or `[RH] PROD` (prod cutover).
- All 3 HTTP Request nodes (Slack DMs + channel notification): bind to your
  Slack bot credential. The bot needs `chat:write` scope and access to:
  - DM `U0135HAS0KA` (Dean Hammond)
  - DM `U02HR1T6PBK` (Kirk Bennett)
  - Post to `C06TTMZB3RA` (#marketing-lead-errors)

### 3. Re-import the modified resolver

```
n8n UI → Workflows → "R360 Sub: Resolver" → Settings → Import from File →
deliverables/r360-n8n-migration/n8n/sub-r360-resolver.json
```

(n8n overwrite-import preserves existing credentials/env vars.)

Verify the new nodes appear in the visual editor:
- `IF: Africa triage?` between `Code: Merge Find results` and `Code: Assignment Owner`
- `Execute: sub-r360-africa-triage` on the TRUE branch
- `IF: Africa decision continue?` after the Execute node

Edit `Execute: sub-r360-africa-triage`, click the workflow picker, and select
the freshly imported triage workflow (replacing `AFRICA_TRIAGE_PLACEHOLDER`).

### 4. Activate

Activate `sub-r360-africa-triage` FIRST (must be active before the resolver
can call it), then save the resolver (already active).

### 5. Set workflow timeout

`sub-r360-africa-triage` → Settings → Execution Timeout → 24 hours.

After 24h with no click, the execution times out and `Status__c` stays at
`africa_pending`. The reconciliation cron flags stuck rows for manual review.

### 6. Smoke test (UAT)

Send a test WPForm submission with country = "South Africa" through the R360
receiver. Verify:

- Slack DM arrives in Dean's and Kirk's inboxes within ~10s
- Channel notification posts in `#marketing-lead-errors`
- `Lead_Inbound_Log__c` has a row with `Status__c = 'africa_pending'`
- Click "Continue" → execution resumes, normal R360 routing fires
- Repeat with "Kill" → execution terminates, `Status__c = 'africa_killed'`

## Regression validation

```
node deliverables/r360-africa-triage/tests/regression-test.mjs
```

Asserts 47 conditions across 6 sections:
1. Resolver structural integrity (Africa nodes added, originals unchanged)
2. Connection graph (Merge→IF→Execute→IF→Assignment Owner; non-Africa preserved)
3. Assignment Owner output identical to baseline for all 5 regions
4. Africa-triage workflow shape (10 nodes wired correctly)
5. Block Kit message simulation (SF link, name, company, hash, buttons)
6. Decision parser (continue/kill, hash anti-CSRF, invalid input throws)

Exit 0 = clean. Exit 1 = at least one regression detected.

## Known limitations / TODO

- **No Slack user_id capture.** URL-button clicks don't tell n8n who clicked.
  To capture the decider, upgrade to Slack interactivity (value-buttons +
  Slack signing secret verification). See `meta.todo` in the workflow JSON.
- **No 24h escalation.** If neither Dean nor Kirk decides, the execution
  times out and the lead stays parked. Future enhancement: an 8h "still
  waiting" reminder ping.
- **ReQuery sub-tree not yet built** in the resolver. When v1.1 adds it, a
  matching `IF: Africa triage? (ReQuery)` will need to be spliced into the
  re-find sub-path. The researcher flagged this; reserve a node ID.

## Rollback

Revert one commit: the resolver and the triage workflow are both in
`feat/r360-africa-triage-branch`. To roll back in n8n:

1. Deactivate `sub-r360-africa-triage`.
2. Re-import the pre-patch `sub-r360-resolver.json` from the previous git tag.

Behavior reverts to the original AMER/EU/Africa/APAC auto-assignment flow.
